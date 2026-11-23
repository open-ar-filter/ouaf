import { expect, test, type Page } from '@playwright/test'

/**
 * Public engine API (#11) on `/engine.html`: `engine.send` reaches every filter's script, `engine.on('filter:<name>')`
 * reports which filter emitted, `on('stats')` reports the rates, and `dispose()` releases everything (script
 * sandboxes, GPU context, listeners) and is idempotent.
 */

const FILTER = '/filters/fixtures/script-grade/'
const POLL = { timeout: 30_000, intervals: [250, 500, 1000] }

declare global {
  interface Window {
    engineEvents?: Array<{ key: number; same: boolean; data: unknown }>
  }
}

/** The page with two instances of the script fixture, both scripts started, and a collector of `filter:tinted`. */
async function open(page: Page): Promise<void> {
  await page.goto(`/engine.html?source=pesquet-talk&autostart&filter=${FILTER}`)
  await page.waitForFunction(() => ((window.ouaf?.frames ?? 0) > 0 && (window.ouaf?.engine.filters.length ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, {
    timeout: 60_000,
  })
  await page.evaluate(async (url) => {
    const { engine } = window.ouaf!
    await engine.addFilter(url)
    window.engineEvents = []
    engine.on('filter:tinted', (e) => window.engineEvents!.push({ key: e.filter.key, same: engine.filters.includes(e.filter), data: e.data }))
  }, FILTER)
  // Both sandboxes are up once both scripts have run `setup` (each emits `ready`; wait for their iframes).
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('iframe[title="ouaf script sandbox"]').length), POLL).toBe(2)
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
}

const keys = (page: Page) => page.evaluate(() => window.ouaf!.engine.filters.map((f) => f.key))

test('engine.send reaches every filter; engine.on("filter:<name>") says which one emitted', async ({ page }) => {
  await open(page)
  const [a, b] = await keys(page)
  await page.evaluate(() => window.ouaf!.engine.send('tint', '#ff0000'))
  await expect.poll(() => page.evaluate(() => window.engineEvents!.map((e) => e.key).sort()), POLL).toEqual([a, b].sort())
  expect(await page.evaluate(() => window.engineEvents!.every((e) => e.same && e.data === 1))).toBe(true)

  // handle.send targets one filter only.
  await page.evaluate(() => window.ouaf!.engine.filters[1]!.send('tint', '#00ff00'))
  await expect.poll(() => page.evaluate(() => window.engineEvents!.length), POLL).toBe(3)
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.engineEvents!.slice(2))).toEqual([{ key: b, same: true, data: 2 }])
})

test('send refuses bad names, data that cannot be cloned and data over 64 KB, at the call; the scripts keep running', async ({ page }) => {
  await open(page)
  const codes = await page.evaluate(() => {
    const { engine, core } = window.ouaf!
    const codeOf = (fn: () => void) => {
      try {
        fn()
        return 'no error'
      } catch (e) {
        return e instanceof core.OuafError ? e.code : String(e)
      }
    }
    return {
      name: codeOf(() => engine.send('not a name', 1)),
      fn: codeOf(() => engine.send('tint', { f: () => 1 })),
      handle: codeOf(() => engine.filters[0]!.send('tint', document.body)),
      big: codeOf(() => engine.send('tint', 'x'.repeat(40_000))),
    }
  })
  expect(codes).toEqual({ name: 'invalid-message', fn: 'invalid-message', handle: 'invalid-message', big: 'invalid-message' })
  await page.evaluate(() => window.ouaf!.engine.send('tint', '#ff0000'))
  await expect.poll(() => page.evaluate(() => window.engineEvents!.length), POLL).toBe(2)
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})

test('stats report the rendering and tracking rates', async ({ page }) => {
  await open(page)
  const stats = await page.evaluate(
    () =>
      new Promise<Record<string, unknown>>((resolve) => {
        const off = window.ouaf!.engine.on('stats', (s) => (off(), resolve({ ...s })))
      }),
  )
  expect(Object.keys(stats).sort()).toEqual(['faces', 'fps', 'frameMs', 'frameMsMax', 'height', 'trackMs', 'tracker', 'trackingHz', 'width'])
  expect(stats.frameMsMax).toBeGreaterThanOrEqual(stats.frameMs as number)
  expect(stats.trackMs).toBeGreaterThanOrEqual(0)
  expect(stats.fps).toBeGreaterThan(0)
  expect(stats.frameMs).toBeGreaterThanOrEqual(0)
  expect(stats.width).toBeGreaterThan(0)
  expect(stats.height).toBeGreaterThan(0)
  expect(typeof stats.faces).toBe('number')
  expect(typeof stats.trackingHz).toBe('number')
})

test('a throwing listener becomes a warning; a throwing warning listener does not loop and rendering goes on', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    const { engine } = window.ouaf!
    const warnings: string[] = []
    ;(window as unknown as { listenerWarnings: string[] }).listenerWarnings = warnings
    engine.on('warning', (w) => {
      warnings.push(w.message)
      throw new Error('warning listener')
    })
    const off = engine.on('stats', () => {
      off()
      throw new Error('stats listener')
    })
  })
  const warnings = () => page.evaluate(() => (window as unknown as { listenerWarnings: string[] }).listenerWarnings)
  // The next `stats` (about once per second) throws: one warning for it.
  await expect.poll(async () => (await warnings()).filter((m) => m.includes('stats listener')).length, POLL).toBe(1)
  // Before the fix, the warning listener's own error was reported as a warning to itself, thousands of times.
  expect((await warnings()).filter((m) => m.includes('warning listener'))).toEqual([])
  // Rendering goes on. `ouaf.frames` only grows with each `stats` event (about once per second): poll, no fixed wait.
  const before = await page.evaluate(() => window.ouaf!.frames)
  await expect.poll(() => page.evaluate(() => window.ouaf!.frames), POLL).toBeGreaterThan(before)
  expect((await warnings()).filter((m) => m.includes('stats listener'))).toHaveLength(1)
})

test('dispose releases the sandboxes, the GPU context and the listeners, and is idempotent', async ({ page }) => {
  await open(page)
  const result = await page.evaluate(async (url) => {
    const { engine, core } = window.ouaf!
    const handles = engine.filters
    let statsAfter = 0
    engine.on('stats', () => statsAfter++)
    const pending = engine.addFilter(url).then(
      () => 'no error',
      (e) => (e instanceof core.OuafError ? e.code : String(e)),
    )
    engine.dispose()
    engine.dispose()
    const lateOff = engine.on('stats', () => statsAfter++)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const errorOf = async (fn: () => unknown) => {
      try {
        await fn()
        return 'no error'
      } catch (e) {
        return e instanceof core.OuafError ? e.code : String(e)
      }
    }
    const gl = (engine.canvas as HTMLCanvasElement).getContext('webgl2')
    return {
      disposed: engine.disposed,
      filters: engine.filters.length,
      removed: handles.map((h) => h.removed),
      sandboxes: document.querySelectorAll('iframe[title="ouaf script sandbox"]').length,
      contextLost: gl?.isContextLost() ?? true,
      statsAfter,
      lateOff: typeof lateOff,
      pending: await pending,
      send: await errorOf(() => engine.send('tint', '#ff0000')),
      handleSend: await errorOf(() => handles[0]!.send('tint', '#ff0000')),
      addFilter: await errorOf(() => engine.addFilter(url)),
      setSource: await errorOf(() => engine.setSource(document.createElement('canvas'))),
    }
  }, FILTER)
  expect(result).toEqual({
    disposed: true,
    filters: 0,
    removed: [true, true],
    sandboxes: 0,
    contextLost: true,
    statsAfter: 0,
    lateOff: 'function',
    pending: 'disposed',
    send: 'disposed',
    handleSend: 'no error',
    addFilter: 'disposed',
    setSource: 'disposed',
  })
})
