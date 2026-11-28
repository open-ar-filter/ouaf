import { expect, test, type Page } from './fixtures.ts'
import { SANDBOX_HEADERS, SANDBOX_PROTOCOL, sandboxDocument } from '../packages/core/src/script/sandbox-document.ts'

/**
 * The script sandbox served from another site (#181, `EngineOptions.sandboxUrl`): the engine page's `?sandbox=cross`
 * loads `/sandbox.html` from the other loopback name (`localhost` ↔ `127.0.0.1`). The script runs there as in the
 * default `srcdoc` sandbox, the iframe gets a process of its own on desktop Chromium (an out-of-process iframe target;
 * not on Chrome Android, SECURITY.md), and its start
 * costs about as much: both are measured here, from the iframe's insertion to the sandbox's `ouaf:started`.
 */

const FILTER = '/filters/fixtures/script-grade/'
/** Starts measured per kind of sandbox (the first one, cold, is reported apart). */
const RUNS = 12

declare global {
  interface Window {
    /** Start times of the sandboxes (ms), from the iframe's insertion to `ouaf:started`. */
    sandboxStarts?: number[]
  }
}

async function open(page: Page, sandbox: 'default' | 'cross'): Promise<void> {
  await page.goto(`/engine.html?source=pesquet-talk&autostart${sandbox === 'cross' ? '&sandbox=cross' : ''}`)
  await page.waitForFunction(() => (window.ouaf?.frames ?? 0) > 0 || (window.ouaf?.errors.length ?? 0) > 0, undefined, { timeout: 60_000 })
  // Times every sandbox the engine opens: its iframe is inserted, then it posts `ouaf:started` to the page.
  await page.evaluate(() => {
    window.sandboxStarts = []
    const inserted = new Map<Window, number>()
    new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node instanceof HTMLIFrameElement && node.title === 'ouaf script sandbox') inserted.set(node.contentWindow!, performance.now())
        }
      }
    }).observe(document.body, { childList: true })
    addEventListener('message', (e) => {
      const at = inserted.get(e.source as Window)
      if (at !== undefined && (e.data as { t?: unknown } | null)?.t === 'ouaf:started') window.sandboxStarts!.push(performance.now() - at)
    })
  })
}

/** Adds the script fixture and waits for its `setup` (`ready`), then removes it. */
async function cycle(page: Page): Promise<void> {
  await page.evaluate(async (filter) => {
    const handle = await window.ouaf!.engine.addFilter(filter)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready: ${window.ouaf!.errors.join('; ')}`)), 20_000)
      handle.on('filter:ready', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    handle.remove()
  }, FILTER)
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

test('a sandbox from another site runs the script in a process of its own', async ({ page, browser, browserName, baseURL }) => {
  await open(page, 'cross')
  await page.evaluate(async (filter) => {
    const handle = await window.ouaf!.engine.addFilter(filter)
    await new Promise<void>((resolve) => handle.on('filter:ready', () => resolve()))
  }, FILTER)
  const sandboxUrl = `https://127.0.0.1:${new URL(baseURL!).port}/sandbox.html`
  expect(await page.locator('iframe[title="ouaf script sandbox"]').getAttribute('src')).toBe(sandboxUrl)
  if (browserName === 'chromium') {
    const cdp = await browser.newBrowserCDPSession()
    const { targetInfos } = await cdp.send('Target.getTargets')
    await cdp.detach()
    expect(targetInfos.filter((t) => t.type === 'iframe').map((t) => t.url)).toContain(sandboxUrl)
  }
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})

test('an outdated sandbox document is refused with an error that says so', async ({ page }) => {
  await page.context().route(/\/sandbox\.html$/, (route) =>
    route.fulfill({ status: 200, headers: { ...SANDBOX_HEADERS }, body: sandboxDocument().replace(`v: ${SANDBOX_PROTOCOL} `, `v: ${SANDBOX_PROTOCOL - 1} `) }),
  )
  await open(page, 'cross')
  await page.evaluate((filter) => window.ouaf!.engine.addFilter(filter), FILTER)
  await expect
    .poll(() => page.evaluate(() => window.ouaf!.errors), { timeout: 15_000 })
    .toEqual([expect.stringMatching(`is of another version \\(${SANDBOX_PROTOCOL - 1}, expected ${SANDBOX_PROTOCOL}\\)`)])
  // The rest of the filter keeps working.
  expect(await page.evaluate(() => window.ouaf!.engine.filters.length)).toBe(1)
})

test('a sandbox from another site starts about as fast as the srcdoc one', async ({ page }, info) => {
  test.slow()
  const results: Record<string, { cold: number; median: number; max: number }> = {}
  for (const sandbox of ['default', 'cross'] as const) {
    await open(page, sandbox)
    for (let i = 0; i < RUNS; i++) await cycle(page)
    const starts = await page.evaluate(() => window.sandboxStarts!)
    expect(starts).toHaveLength(RUNS)
    const warm = starts.slice(1)
    results[sandbox] = { cold: Math.round(starts[0]!), median: Math.round(median(warm)), max: Math.round(Math.max(...warm)) }
  }
  const summary = Object.entries(results).map(([k, r]) => `${k}: cold ${r.cold} ms, median ${r.median} ms, max ${r.max} ms`).join('; ')
  console.log(`sandbox start (${RUNS} runs): ${summary}`)
  info.annotations.push({ type: 'sandbox start', description: summary })
  // A loose bound: the cross-site sandbox is fetched and gets a new process, but must stay far below the 10 s timeout.
  expect(results.cross!.median).toBeLessThan(2000)
})
