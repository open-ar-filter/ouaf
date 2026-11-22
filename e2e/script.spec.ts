import { expect, test, type Page } from '@playwright/test'

/**
 * Scripts (#26) on `/engine.html`, in the real sandbox (sandboxed iframe, CSP, Worker): host messages reach the
 * script, its `.set()` / `.animate()` drive a color layer, `f.emit` reaches the host, the sandbox blocks the ways out,
 * and an endless loop is stopped by the watchdog while rendering goes on.
 */

const FILTER = '/filters/fixtures/script-grade/'
const POLL = { timeout: 30_000, intervals: [250, 500, 1000] }

declare global {
  interface Window {
    received?: Array<[string, unknown]>
  }
}

async function open(page: Page): Promise<void> {
  await page.goto(`/engine.html?source=pesquet-talk&autostart&filter=${FILTER}`)
  await page.waitForFunction(() => ((window.ouaf?.frames ?? 0) > 0 && (window.ouaf?.engine.filters.length ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, {
    timeout: 60_000,
  })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
  // Collect what the script emits.
  await page.evaluate(() => {
    window.received = []
    const handle = window.ouaf!.engine.filters[0]!
    for (const name of ['ready', 'tinted', 'probed']) handle.on(`filter:${name}`, (data) => window.received!.push([name, data]))
  })
}

const send = (page: Page, name: string, data?: unknown) =>
  page.evaluate(([name, data]) => window.ouaf!.engine.filters[0]!.send(name as string, data), [name, data] as const)

const received = (page: Page, name: string) => page.evaluate((name) => window.received!.filter(([n]) => n === name).map(([, d]) => d), name)

/** Mean channels of the canvas as displayed. */
async function sample(page: Page): Promise<{ r: number; g: number; b: number; chroma: number }> {
  const png = await page.locator('#canvas').screenshot()
  return page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
    const c = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let r = 0
    let g = 0
    let b = 0
    let chroma = 0
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]!
      g += d[i + 1]!
      b += d[i + 2]!
      chroma += Math.max(d[i]!, d[i + 1]!, d[i + 2]!) - Math.min(d[i]!, d[i + 1]!, d[i + 2]!)
    }
    const n = d.length / 4
    return { r: r / n, g: g / n, b: b / n, chroma: chroma / n }
  }, [...png])
}

test('host messages reach the script, whose set and animate drive the layers, and f.emit reaches the host', async ({ page }) => {
  await open(page)
  // Before any message: the color layer is neutral, the image keeps its colors.
  await expect.poll(async () => (await sample(page)).chroma > 8, POLL).toBe(true)

  await send(page, 'tint', '#ff0000')
  // Black and white, then a red tint (green and blue × 0): a red image.
  await expect.poll(async () => {
    const s = await sample(page)
    return s.r > 20 && s.g < 3 && s.b < 3
  }, POLL).toBe(true)
  await expect.poll(() => received(page, 'tinted'), POLL).toEqual([1])

  // Fading the layer's opacity out brings the original image back.
  await send(page, 'fade', 300)
  await expect.poll(async () => (await sample(page)).chroma > 8, POLL).toBe(true)
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})

test('the sandbox blocks every way out, and makes no request', async ({ page }) => {
  await open(page)
  const requests: string[] = []
  page.on('request', (r) => requests.push(r.url()))
  await send(page, 'probe')
  await expect.poll(() => received(page, 'probed'), POLL).toHaveLength(1)
  const [results] = (await received(page, 'probed')) as Array<Record<string, string>>
  expect(Object.entries(results!).filter(([, v]) => v !== 'blocked')).toEqual([])
  expect(Object.keys(results!)).toHaveLength(12)
  // The probes' requests never left the sandbox (the page itself keeps playing the clip: ignore media ranges).
  expect(requests.filter((u) => !u.includes('/test-media/'))).toEqual([])
})

test('an endless loop is stopped by the watchdog; rendering never stops', async ({ page }) => {
  await open(page)
  await send(page, 'tint', '#ff0000')
  await expect.poll(() => received(page, 'tinted'), POLL).toEqual([1])
  const before = await page.evaluate(() => window.ouaf!.frames)
  await send(page, 'loop')
  await expect.poll(() => page.evaluate(() => window.ouaf!.errors), POLL).toEqual([expect.stringMatching(/script was stopped: it did not answer a frame within 1000 ms/)])
  // The page kept rendering (stats count frames every second), and the layer keeps what the script set.
  await expect.poll(() => page.evaluate(() => window.ouaf!.frames), POLL).toBeGreaterThan(before + 30)
  const s = await sample(page)
  expect(s.r > 20 && s.g < 3 && s.b < 3).toBe(true)
  // The script stays stopped: messages are ignored.
  await send(page, 'tint', '#00ff00')
  await page.waitForTimeout(500)
  expect(await received(page, 'tinted')).toEqual([1])
})
