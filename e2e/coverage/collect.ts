import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergeScriptCovs, type ScriptCov } from '@bcoe/v8-coverage'
import type { Page, TestInfo } from '@playwright/test'
import { RAW_DIR, SOURCES_DIR, type FunctionCoverage, type RawScript, type RawSource } from './paths.ts'

/**
 * V8 coverage of the engine while a browser test runs (`OUAF_COVERAGE=1`, Chromium only), read over the DevTools
 * protocol: nothing is instrumented, the page runs the same code as in a plain run.
 *
 * Playwright's own `page.coverage` only sees the page. Half of the browser-only code runs in the tracking worker, so
 * this attaches to the page's workers too, and holds each one at its first statement until its counters are on.
 *
 * A worker that ends takes its counts with it, and nothing announces the end (the tracker's worker stops with the
 * clip): each worker is therefore read once a second, and at worst loses its last second.
 */

/** Scripts worth recording: the sources of the workspace packages, as the dev server names them (`/@fs/…`). */
const PACKAGE_SOURCE = /\/packages\/[^/]+\/src\//

/** Counts rather than flags: reading the counters resets them, and successive readings of a worker are added up. */
const COVERAGE = { callCount: true, detailed: true }

/** How often a worker's counters are read. */
const WORKER_POLL_MS = 1000

/** How long a worker has to answer a command before it is taken for gone. */
const WORKER_TIMEOUT_MS = 5000

interface ScriptCoverage {
  url: string
  functions: FunctionCoverage[]
}

/** Starts recording on `page`; the returned function stops and writes what the test covered. */
export async function startCoverage(page: Page): Promise<(testInfo: TestInfo) => Promise<void>> {
  const session = await page.context().newCDPSession(page)
  const workers = new Set<string>()
  const readings: ScriptCoverage[] = []
  const pending = new Map<number, (result: unknown) => void>()
  let nextId = 1

  /** A command for a worker, through the page's session. Resolves with `undefined` when the worker is gone. */
  function sendTo(sessionId: string, method: string, params: object = {}): Promise<unknown> {
    const id = nextId++
    return new Promise((resolve) => {
      pending.set(id, resolve)
      const drop = (): void => {
        if (pending.delete(id)) resolve(undefined)
      }
      setTimeout(drop, WORKER_TIMEOUT_MS)
      session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(drop)
    })
  }

  async function readWorker(sessionId: string): Promise<void> {
    const reply = (await sendTo(sessionId, 'Profiler.takePreciseCoverage')) as { result?: ScriptCoverage[] } | undefined
    for (const script of reply?.result ?? []) if (PACKAGE_SOURCE.test(script.url)) readings.push(script)
  }
  const poll = setInterval(() => {
    for (const id of workers) void readWorker(id)
  }, WORKER_POLL_MS)

  session.on('Target.receivedMessageFromTarget', ({ message }) => {
    const reply = JSON.parse(message) as { id?: number; result?: unknown }
    if (reply.id === undefined) return
    pending.get(reply.id)?.(reply.result)
    pending.delete(reply.id)
  })
  session.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    if (targetInfo.type === 'worker') {
      workers.add(sessionId)
      void sendTo(sessionId, 'Profiler.enable')
      void sendTo(sessionId, 'Profiler.startPreciseCoverage', COVERAGE)
    }
    // Every target attached here waits for this, worker or not.
    void sendTo(sessionId, 'Runtime.runIfWaitingForDebugger')
  })
  session.on('Target.detachedFromTarget', ({ sessionId }) => workers.delete(sessionId))

  await session.send('Profiler.enable')
  await session.send('Profiler.startPreciseCoverage', COVERAGE)
  await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false })

  return async (testInfo) => {
    clearInterval(poll)
    try {
      const fromWorkers = [...workers].map(readWorker)
      const { result } = await session.send('Profiler.takePreciseCoverage')
      await Promise.all(fromWorkers)
      for (const script of result) if (PACKAGE_SOURCE.test(script.url)) readings.push(script)
    } catch {
      // The test closed its page: what the page covered is lost, the test itself is not affected.
    }
    const byUrl = new Map<string, ScriptCov[]>()
    for (const { url, functions } of readings) {
      if (!byUrl.has(url)) byUrl.set(url, [])
      byUrl.get(url)!.push({ scriptId: '0', url, functions })
    }
    const scripts: RawScript[] = []
    for (const covs of byUrl.values()) {
      const { url, functions } = mergeScriptCovs(covs)!
      const source = await saveSource(page, url, functions)
      if (source) scripts.push({ url, source, functions })
    }
    mkdirSync(RAW_DIR, { recursive: true })
    writeFileSync(join(RAW_DIR, `${testInfo.testId}-${testInfo.retry}.json`), JSON.stringify({ test: testInfo.titlePath.join(' › '), scripts }))
    await session.detach().catch(() => {})
  }
}

/**
 * Stores the code of a script once per run, fetched again from the dev server, and returns its name in `SOURCES_DIR`.
 * The offsets of the coverage only mean something in the exact text V8 compiled: its length is the end of the range
 * of the module itself, which starts at 0, and a response of another length is refused (`undefined`). A later reading
 * of a worker leaves that range out (V8 omits what did not run since the last one); the merged readings have it.
 */
async function saveSource(page: Page, url: string, functions: FunctionCoverage[]): Promise<string | undefined> {
  const length = Math.max(-1, ...functions.map((f) => f.ranges[0]!).filter((r) => r.startOffset === 0).map((r) => r.endOffset))
  if (length < 0) return undefined
  const name = `${createHash('sha1').update(`${url}\n${length}`).digest('hex')}.json`
  const file = join(SOURCES_DIR, name)
  if (existsSync(file)) return name
  const response = await page.context().request.get(url).catch(() => undefined)
  if (!response?.ok()) return undefined
  const code = await response.text()
  if (code.length !== length) return undefined
  mkdirSync(SOURCES_DIR, { recursive: true })
  writeFileSync(file, JSON.stringify({ url, code } satisfies RawSource))
  return name
}
