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
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))]))
    const c = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    // Pure colors only (the layers are flat #00ff00, #ff00ff, #00ffff), and a pixel counts only with a neighbour of the
    // same layer on its right and below: a stray video pixel of that color must not stretch a bounding box.
    const W = c.width
    const H = c.height
    const kind = new Uint8Array(W * H)
    for (let p = 0; p < W * H; p++) {
      const i = p * 4
      const hi = (v: number) => d[i + v]! > 235
      const lo = (v: number) => d[i + v]! < 40
      kind[p] = hi(1) && lo(0) && lo(2) ? 1 : hi(0) && hi(2) && lo(1) ? 2 : hi(1) && hi(2) && lo(0) ? 3 : 0
    }
    const box = () => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
    const boxes = [box(), box(), box()]
    for (let y = 0; y < H - 1; y++) {
      for (let x = 0; x < W - 1; x++) {
        const k = kind[y * W + x]!
        if (!k || kind[y * W + x + 1] !== k || kind[(y + 1) * W + x] !== k) continue
        const b = boxes[k - 1]!
        b.x0 = Math.min(b.x0, x)
        b.x1 = Math.max(b.x1, x + 1)
        b.y0 = Math.min(b.y0, y)
        b.y1 = Math.max(b.y1, y + 1)
      }
    }
    const size = (k: ReturnType<typeof box>) => (k.x1 < k.x0 ? { w: 0, h: 0 } : { w: k.x1 - k.x0 + 1, h: k.y1 - k.y0 + 1 })
    return { text: size(boxes[0]!), sticker: size(boxes[1]!), canvas: size(boxes[2]!) }
  }, png.toString('base64'))
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
