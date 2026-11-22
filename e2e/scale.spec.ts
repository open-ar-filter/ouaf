import { expect, test, type Page } from '@playwright/test'

/**
 * `scale` of the text, sticker and canvas layers (spec §6.2, #116) on `/engine.html`: `filters/fixtures/scale/` lays
 * a green text, a magenta sticker and a cyan canvas out on the screen at `scale: 2` (no face needed, so they are found
 * by color on the `no-face` clip); its script sets and animates their `scale` on host messages (spec §12.4).
 */

const FILTER = '/filters/fixtures/scale/'
const POLL = { timeout: 30_000, intervals: [250, 500, 1000] }
const LAYERS = ['text', 'sticker', 'canvas'] as const
type Layer = (typeof LAYERS)[number]
/** Width and height (px) of each layer's pixels on screen. */
type Sizes = Record<Layer, { w: number; h: number }>

/** Bounding boxes of the green, magenta and cyan pixels of the canvas as displayed. */
async function sizes(page: Page): Promise<Sizes> {
  const png = await page.locator('#canvas').screenshot()
  return page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
    const c = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    const box = () => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
    const boxes = { text: box(), sticker: box(), canvas: box() }
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]! > 200
      const g = d[i + 1]! > 200
      const b = d[i + 2]! > 200
      const low = (v: number) => d[i + v]! < 80
      const layer = g && low(0) && low(2) ? 'text' : r && b && low(1) ? 'sticker' : g && b && low(0) ? 'canvas' : undefined
      if (!layer) continue
      const x = (i / 4) % c.width
      const y = Math.floor(i / 4 / c.width)
      const k = boxes[layer]
      k.x0 = Math.min(k.x0, x)
      k.x1 = Math.max(k.x1, x)
      k.y0 = Math.min(k.y0, y)
      k.y1 = Math.max(k.y1, y)
    }
    const size = (k: ReturnType<typeof box>) => (k.x1 < k.x0 ? { w: 0, h: 0 } : { w: k.x1 - k.x0 + 1, h: k.y1 - k.y0 + 1 })
    return { text: size(boxes.text), sticker: size(boxes.sticker), canvas: size(boxes.canvas) }
  }, [...png])
}

const send = (page: Page, name: string, data?: unknown) =>
  page.evaluate(([name, data]) => window.ouaf!.engine.filters[0]!.send(name as string, data), [name, data] as const)

/** Whether every layer's size is `sx` × `sy` times its size in `base`, within 12 %. */
function scaled(now: Sizes, base: Sizes, sx: number, sy: number): boolean {
  const ok = LAYERS.every((l) => Math.abs(now[l].w / base[l].w / sx - 1) < 0.12 && Math.abs(now[l].h / base[l].h / sy - 1) < 0.12)
  if (!ok) console.log('sizes', JSON.stringify(now), 'base', JSON.stringify(base), sx, sy)
  return ok
}

test('scale multiplies the size of text, sticker and canvas layers; a script sets and animates it', async ({ page }) => {
  await page.goto(`/engine.html?source=no-face&autostart&filter=${FILTER}`)
  await page.waitForFunction(() => ((window.ouaf?.engine.filters.length ?? 0) > 0 && (window.ouaf?.frames ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, {
    timeout: 60_000,
  })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])

  // The manifest's scale 2: every layer is drawn (the canvas once the script has drawn it).
  await expect.poll(async () => {
    const s = await sizes(page)
    return LAYERS.every((l) => s[l].w > 20 && s[l].h > 10)
  }, POLL).toBe(true)
  const doubled = await sizes(page)

  // set({ scale: 1 }) halves every layer.
  await send(page, 'set', 1)
  await expect.poll(async () => scaled(await sizes(page), doubled, 0.5, 0.5), POLL).toBe(true)
  const base = await sizes(page)

  // animate({ scale: [1, 1.5, 1] }) stretches them vertically only.
  await send(page, 'animate', [1, 1.5, 1])
  await expect.poll(async () => scaled(await sizes(page), base, 1, 1.5), POLL).toBe(true)

  // set({ scale: null }) restores the manifest value.
  await send(page, 'set', null)
  await expect.poll(async () => scaled(await sizes(page), base, 2, 2), POLL).toBe(true)
  expect(await page.evaluate(() => [window.ouaf!.errors, window.ouaf!.warnings])).toEqual([[], []])
})
