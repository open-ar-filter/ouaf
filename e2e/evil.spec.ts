import { expect, test, type APIRequestContext, type Page } from './fixtures.ts'
import { zipBombs } from '../filters/evil/zip-bombs.ts'
import { GPU_STALL_MS } from '../packages/core/src/engine/gpu-watchdog.ts'

/**
 * Malicious filters (#27, `filters/evil/`): each one attacks the engine from inside a filter (the script sandbox, the
 * package reader, the GPU) and must fail, on Chromium, Firefox and WebKit (`npm run test:security`). CI fails if any
 * of them succeeds.
 *
 * The host page loses its own Content-Security-Policy here (`open`): the sandbox must hold by itself, as on a host
 * page without a CSP. Requests are watched twice: in the browser (every request of the context that got a response,
 * workers included; every request to another origin is answered as a willing accomplice would) and on the dev server, whose sink
 * records every request that reaches `/__evil__/` (apps/playground/vite.config.ts).
 */

const POLL = { timeout: 30_000, intervals: [250, 500, 1000] }

declare global {
  interface Window {
    received?: Array<[string, unknown]>
  }
}

interface Watch {
  /**
   * Every URL of the browser context that got a response since `open`. A request the sandbox CSP blocks may still be
   * reported as a request (Chromium does, with the failure `csp`), but it never gets a response.
   */
  answered: string[]
  /** Unique to the test: the attacks' URLs contain it. */
  token: string
  /** The attacks' targets: the host's origin (the dev server's sink) and another origin. */
  targets: string[]
}

/** Opens the engine page on a clip with `filter`, without the page's own CSP, and records the requests. */
async function open(page: Page, filter: string, events: string[] = []): Promise<Watch> {
  const token = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const watch: Watch = { answered: [], token, targets: [] }
  page.context().on('requestfinished', (r) => watch.answered.push(r.url()))
  // Another origin: answered 200 to any origin, so that a request that gets out would also succeed.
  await page.context().route(/^https?:\/\/evil\.invalid\//, (route) =>
    route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/javascript' }, body: 'export default 1\n' }),
  )
  await page.route((url) => url.pathname === '/engine.html', async (route) => {
    const response = await route.fetch()
    const headers = Object.fromEntries(Object.entries(response.headers()).filter(([name]) => name.toLowerCase() !== 'content-security-policy'))
    const body = (await response.text()).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    expect(body).not.toContain('Content-Security-Policy')
    await route.fulfill({ response, headers, body })
  })
  await start(page, `/engine.html?source=pesquet-talk&autostart&filter=${filter}`, true)
  const origin = new URL(page.url()).origin
  watch.targets = [`${origin}/__evil__/${token}/same-origin`, `https://evil.invalid/__evil__/${token}/other-origin`]
  await page.evaluate((events) => {
    window.received = []
    const handle = window.ouaf!.engine.filters[0]!
    for (const name of events) handle.on(`filter:${name}`, (data) => window.received!.push([name, data]))
  }, events)
  return watch
}

/**
 * Opens `url` and waits for its first rendered frame (and its filter, with `filter`), or an engine error. The page is
 * loaded again once if it renders nothing within 30 s: WebKit's playback of the clip sometimes stalls at its first
 * frame on CI runners, before any filter code has run. Only the start is retried, never an attack.
 */
async function start(page: Page, url: string, filter = false): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await page.goto(url)
    const started = await page
      .waitForFunction(
        (filter) => ((window.ouaf?.frames ?? 0) > 0 && (!filter || (window.ouaf?.engine.filters.length ?? 0) > 0)) || (window.ouaf?.errors.length ?? 0) > 0,
        filter,
        { timeout: 30_000 },
      )
      .then(() => true, (error: unknown) => (attempt < 2 ? false : Promise.reject(error)))
    if (started) return
  }
}

const send = (page: Page, name: string, data?: unknown) =>
  page.evaluate(([name, data]) => window.ouaf!.engine.filters[0]!.send(name as string, data), [name, data] as const)

const received = (page: Page, name: string) => page.evaluate((name) => window.received!.filter(([n]) => n === name).map(([, d]) => d), name)

const errors = (page: Page) => page.evaluate(() => window.ouaf!.errors)

const frames = (page: Page) => page.evaluate(() => window.ouaf!.frames)

/** Nothing got out: no request with the test's token got an answer, and the dev server's sink saw none. */
async function expectNoLeak(watch: Watch, request: APIRequestContext): Promise<void> {
  expect(watch.answered.filter((u) => u.includes(watch.token) || u.includes('evil.invalid'))).toEqual([])
  const hits = await (await request.get(`/__evil-sink__?token=${watch.token}`)).json()
  expect(hits).toEqual([])
}

/** The report of an attack: every attempt must say 'blocked'. */
async function report(page: Page): Promise<Record<string, string>> {
  await expect.poll(() => received(page, 'report'), { ...POLL, timeout: 90_000 }).toHaveLength(1)
  const [result] = (await received(page, 'report')) as Array<Record<string, string>>
  return result!
}

const opened = (result: Record<string, string>) => Object.entries(result).filter(([, v]) => v !== 'blocked')

test.describe('the script sandbox', () => {
  test('evil-network: no network API of the Worker sends anything out', async ({ page, request }) => {
    test.slow()
    const watch = await open(page, '/filters/evil/network/', ['report'])
    const before = await page.evaluate(() => window.ouaf!.frames)
    await send(page, 'attack', { targets: watch.targets })
    const result = await report(page)
    expect(opened(result)).toEqual([])
    expect(Object.keys(result).length).toBeGreaterThanOrEqual(40)
    await expectNoLeak(watch, request)
    // Attacks are the script's business: the page kept rendering meanwhile, without an error.
    await expect.poll(() => frames(page), POLL).toBeGreaterThan(before + 30)
    expect(await errors(page)).toEqual([])
  })

  test('evil-globals: the removed globals stay removed, and the host page is out of reach', async ({ page, request }) => {
    const watch = await open(page, '/filters/evil/globals/', ['report'])
    await send(page, 'attack', { target: watch.targets[0] })
    const result = await report(page)
    expect(opened(result)).toEqual([])
    expect(Object.keys(result).length).toBeGreaterThanOrEqual(18)
    await expectNoLeak(watch, request)
    expect(await errors(page)).toEqual([])
  })

  test('evil-forge: forged answers on the runtime port are checked, and change nothing in the page', async ({ page, request }) => {
    const watch = await open(page, '/filters/evil/forge/', ['stolen', 'spam'])
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    const start = Date.now()
    await send(page, 'tamper')
    await send(page, 'flood')
    const before = await frames(page)
    await expect.poll(() => frames(page), POLL).toBeGreaterThan(before + 60)
    const state = await page.evaluate(() => ({
      polluted: (({}) as Record<string, unknown>).polluted ?? (Object.prototype as unknown as Record<string, unknown>).polluted ?? null,
      warnings: window.ouaf!.warnings.length,
      longest: Math.max(0, ...window.ouaf!.warnings.map((w) => w.length)),
    }))
    // No prototype pollution, no oversized emit delivered, at most 60 emits a second, and a bounded number of short
    // warnings. Nothing stopped the script: it only sent what the host ignores.
    expect(state.polluted).toBeNull()
    expect(await received(page, 'stolen')).toEqual([])
    expect((await received(page, 'spam')).length).toBeLessThanOrEqual(60 * Math.ceil((Date.now() - start) / 1000 + 1))
    expect(await errors(page)).toEqual([])
    expect(state.warnings).toBeLessThan(100)
    expect(state.longest).toBeLessThan(2000)
    expect(pageErrors).toEqual([])

    // Swallowing the frames: the watchdog stops the script, and rendering goes on.
    await send(page, 'swallow')
    await expect.poll(() => errors(page), POLL).toEqual([expect.stringMatching(/script was stopped/)])
    const stopped = await frames(page)
    await expect.poll(() => frames(page), POLL).toBeGreaterThan(stopped + 30)
    await expectNoLeak(watch, request)
  })
})

/** The script was stopped by the watchdog, and the page goes on rendering with the filter's layers. */
async function expectStoppedAndRendering(page: Page): Promise<void> {
  await expect.poll(() => errors(page), POLL).toEqual([expect.stringMatching(/script was stopped/)])
  const stopped = await frames(page)
  await expect.poll(() => frames(page), POLL).toBeGreaterThan(stopped + 30)
  expect(await page.evaluate(() => window.ouaf!.engine.filters.length)).toBe(1)
}

test.describe('denial of service', () => {
  test('evil-loop-setup: a setup that never returns is stopped after 1 s', async ({ page }) => {
    await open(page, '/filters/evil/loop-setup/')
    await expectStoppedAndRendering(page)
  })

  for (const mode of ['sync', 'microtasks']) {
    test(`evil-loop (${mode}): a script that never answers again is stopped, rendering goes on`, async ({ page }) => {
      await open(page, '/filters/evil/loop/')
      await send(page, mode)
      await expectStoppedAndRendering(page)
    })
  }

  for (const mode of ['heap', 'buffers']) {
    test(`evil-memory (${mode}): a script that exhausts its memory is stopped, the page survives`, async ({ page, browser, browserName }) => {
      test.slow()
      let crashed = false
      page.on('crash', () => (crashed = true))
      await open(page, '/filters/evil/memory/')
      if (browserName === 'chromium') {
        // On Chromium only a process of its own saves the page (#181): a Worker that reaches V8's heap limit takes down
        // its renderer process, and stopping it takes Blink about 2 s, long enough for a fast machine to get there.
        // Desktop Chrome isolates the sandbox iframe (its own target here); Playwright's default headless shell does not,
        // hence `channel: 'chromium'` (playwright.config.ts).
        const cdp = await browser.newBrowserCDPSession()
        const { targetInfos } = await cdp.send('Target.getTargets')
        await cdp.detach()
        expect(targetInfos.filter((t) => t.type === 'iframe').map((t) => t.url)).toContain('about:srcdoc')
      }
      await send(page, mode)
      await expectStoppedAndRendering(page)
      expect(crashed).toBe(false)
    })
  }

  test('evil-memory (emit): oversized messages to the host are dropped', async ({ page }) => {
    await open(page, '/filters/evil/memory/', ['bomb', 'done'])
    await send(page, 'emit')
    await expect.poll(() => received(page, 'done'), POLL).toHaveLength(1)
    expect(await received(page, 'bomb')).toEqual([])
    expect(await page.evaluate(() => window.ouaf!.warnings.join('\n'))).toMatch(/larger than 64 KB; dropped/)
    expect(await errors(page)).toEqual([])
  })
})

test.describe('the GPU', () => {
  test('evil-heavy-shader: a shader that keeps the GPU busy for seconds is disabled, rendering resumes', async ({ page }) => {
    test.slow()
    await start(page, '/engine.html?source=pesquet-talk&autostart')
    // A loop that takes seconds a frame, whatever the GPU: from a few thousand rounds a pixel (seconds on a software
    // renderer, as in CI), more and more while the frames are still fast, until the engine disables the filter. The
    // filter's default (a million) would hold a software renderer for minutes, during which no page script runs.
    await page.evaluate(() => window.ouaf!.engine.addFilter('/filters/evil/heavy-shader/', { iterations: 3000 }))
    const disabled = /"evil-heavy-shader" was disabled: (its shader kept the GPU busy|the GPU context was lost)/
    let iterations = 3000
    let slowWindows = 0
    for (;;) {
      await page.evaluate(() => ((window as unknown as { statsBefore: unknown }).statsBefore = window.ouaf!.stats))
      const done = await expect
        .poll(() => errors(page), { timeout: 20_000, intervals: [1000] })
        .toEqual([expect.stringMatching(disabled)])
        .then(() => true, () => false)
      if (done) break
      // Disabled by the engine's GPU watchdog, or after the browser reset the GPU (context loss): either way reported.
      // Time between two frames now, from the engine's stats (one report a second, at a frame): none since the window
      // started means that a frame takes about as long as the window.
      const frameMs = await page.evaluate(() => {
        const stats = window.ouaf!.stats
        return stats === (window as unknown as { statsBefore: unknown }).statsBefore || !stats ? Infinity : 1000 / stats.fps
      })
      // Frames that slow are the watchdog's: it needs `GPU_STALL_FRAMES` of them in a row, which may take longer than
      // this window. Wait for it: a heavier shader then (as this test asked for, every 20 s) makes each frame last
      // minutes on a slow runner, with the page blocked, until the test times out. Twice the watchdog's limit, as the
      // time between frames is an upper bound of the GPU's.
      if (frameMs > 2 * GPU_STALL_MS) {
        // No frame at all may also be the clip that stopped playing: WebKit's playback sometimes stalls on CI runners
        // (see `start`), and with no frame to draw there is nothing for the watchdog to time. The clip is started
        // again then; its state goes into the failure message, to tell a stalled clip from a shader never stopped.
        const clip = await page.evaluate(async () => {
          const video = document.getElementById('video') as HTMLVideoElement
          const before = video.currentTime
          await new Promise((resolve) => setTimeout(resolve, 1000))
          const state = { playing: video.currentTime !== before, paused: video.paused, ended: video.ended, readyState: video.readyState }
          if (!state.playing) await video.play().catch(() => {})
          return state
        })
        const what = `a frame takes ${Math.round(frameMs)} ms at ${iterations} iterations, but the filter was never disabled`
        expect(++slowWindows, `${what} (the clip: ${JSON.stringify(clip)})`).toBeLessThan(8)
        continue
      }
      slowWindows = 0
      expect(iterations, 'the filter was never disabled').toBeLessThan(1_000_000)
      // Four times more while frames are quick, twice once they take over a second, a quarter more once they take as
      // long as the watchdog's limit: the frames that follow stay within reach of the watchdog, which needs two of
      // them in a row. The time of a frame is far from linear on WebKit's software renderer: after frames of 3.9 s at
      // 12000 rounds, 48000 rounds held the page for more than 100 s a frame (3 min 30 before the filter was disabled
      // on one run, never within the 160 s of the slow windows on another).
      const step = frameMs > GPU_STALL_MS ? 1.25 : frameMs > 1000 ? 2 : 4
      iterations = Math.min(Math.round(iterations * step), 1_000_000)
      await page.evaluate((n) => window.ouaf!.engine.filters[0]!.setParam('iterations', n), iterations)
      console.log(`evil-heavy-shader: ${Math.round(frameMs)} ms between frames, now ${iterations} iterations`)
    }
    expect(await page.evaluate(() => window.ouaf!.engine.filters[0]!.enabled)).toBe(false)
    // The page renders at its pace again.
    const before = await frames(page)
    await expect.poll(() => frames(page), POLL).toBeGreaterThan(before + 30)
  })
})

test.describe('packages', () => {
  const bombs = zipBombs()

  test('zip bombs and unsafe archives are refused with a typed error, and nothing is loaded', async ({ page }) => {
    test.slow()
    let crashed = false
    page.on('crash', () => (crashed = true))
    await page.route((url) => url.pathname.startsWith('/__bombs__/'), (route) => {
      const name = new URL(route.request().url()).pathname.slice('/__bombs__/'.length).replace(/\.ouaf$/, '')
      return route.fulfill({ status: 200, contentType: 'application/zip', body: Buffer.from(bombs[name]!.bytes) })
    })
    await page.goto('/engine.html')
    await page.waitForFunction(() => !!window.ouaf)
    const results = await page.evaluate(async (names) => {
      const { engine } = window.ouaf!
      const out: Record<string, { name?: string; reason?: string; cause?: { name?: string; reason?: string } } | 'loaded'> = {}
      for (const name of names) {
        out[name] = await engine.addFilter(`/__bombs__/${name}.ouaf`).then(
          () => 'loaded' as const,
          (e: Error & { reason?: string; cause?: Error & { reason?: string } }) => ({ name: e.name, reason: e.reason, cause: e.cause && { name: e.cause.name, reason: e.cause.reason } }),
        )
      }
      return { out, filters: engine.filters.length }
    }, Object.keys(bombs))
    for (const [name, bomb] of Object.entries(bombs)) {
      const r = results.out[name]
      // The package error itself, or the cause of the asset error of the file that could not be read.
      const error = r !== 'loaded' && r?.name === 'AssetError' ? r.cause : r
      expect({ name, error }).toEqual({ name, error: expect.objectContaining({ name: 'PackageError', reason: bomb.reason }) })
    }
    expect(results.filters).toBe(0)
    expect(crashed).toBe(false)
  })
})
