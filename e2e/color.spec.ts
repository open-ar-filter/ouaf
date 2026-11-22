import { expect, test, type Page } from '@playwright/test'

/**
 * Color layer (#23) on `/engine.html`: a built-in LUT (`builtin:lut/noir`, served under `<base>builtins/`), chaining
 * across the stack in stack order, and `region: "face"` with a LUT from the filter package.
 */

const NOIR = '/filters/fixtures/color-noir/'
const GRADE = '/filters/fixtures/color-grade/'
const FACE = '/filters/fixtures/color-face/'

async function open(page: Page, query: string, face: boolean): Promise<void> {
  await page.goto(`/engine.html?${query}`)
  await page.waitForFunction(
    (face) => (face ? (window.ouaf?.stats?.faces ?? 0) > 0 : (window.ouaf?.frames ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0,
    face,
    { timeout: 60_000 },
  )
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
}

const POLL = { timeout: 30_000, intervals: [250, 500, 1000] }

function check<T>(sample: T, test: (s: T) => boolean): boolean {
  const ok = test(sample)
  if (!ok) console.log('sample', JSON.stringify(sample))
  return ok
}

interface Sample {
  /** Mean of each channel. */
  r: number
  g: number
  b: number
  /** Mean chroma (max − min of the channels): 0 for a black and white image. */
  chroma: number
  /** Share of pure-green pixels, and the share of the width and height their bounding box spans. */
  green: number
  greenWidth: number
  greenHeight: number
}

/** Statistics of the canvas as displayed (screenshot decoded by the browser). */
async function sample(page: Page): Promise<Sample> {
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
    let green = 0
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (let i = 0; i < d.length; i += 4) {
      const [pr, pg, pb] = [d[i]!, d[i + 1]!, d[i + 2]!]
      r += pr
      g += pg
      b += pb
      chroma += Math.max(pr, pg, pb) - Math.min(pr, pg, pb)
      if (pg > 230 && pr < 30 && pb < 30) {
        green++
        const x = (i / 4) % c.width
        const y = Math.floor(i / 4 / c.width)
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
    }
    const n = d.length / 4
    return {
      r: r / n,
      g: g / n,
      b: b / n,
      chroma: chroma / n,
      green: green / n,
      greenWidth: green ? (x1 - x0 + 1) / c.width : 0,
      greenHeight: green ? (y1 - y0 + 1) / c.height : 0,
    }
  }, [...png])
}

test('a built-in LUT grades the image, mixed by its intensity', async ({ page }) => {
  await open(page, `source=pesquet-talk&autostart&filter=${NOIR}`, false)
  await expect.poll(async () => check(await sample(page), (s) => s.chroma < 2), POLL).toBe(true)
  await page.evaluate(() => window.ouaf!.engine.filters[0]!.setParam('intensity', 0, { transition: 0 }))
  await expect.poll(async () => check(await sample(page), (s) => s.chroma > 8), POLL).toBe(true)
})

test('intensity weakens the LUT only: the other adjustments of the layer still apply', async ({ page }) => {
  await open(page, `source=pesquet-talk&autostart&filter=${NOIR}`, false)
  // Black and white, then an orange tint (blue × 0): orange image.
  await page.evaluate(() => window.ouaf!.engine.filters[0]!.setParam('tint', '#ff8000', { transition: 0 }))
  await expect.poll(async () => check(await sample(page), (s) => s.r > s.g + 10 && s.g > s.b + 10 && s.b < 5), POLL).toBe(true)
  // Without the LUT the colors come back, still tinted: no blue left. (When intensity mixed the whole grade, this
  // showed the untouched image.)
  await page.evaluate(() => window.ouaf!.engine.filters[0]!.setParam('intensity', 0, { transition: 0 }))
  await expect.poll(async () => check(await sample(page), (s) => s.chroma > 8 && s.b < 5), POLL).toBe(true)
})

test('color layers chain in stack order', async ({ page }) => {
  await open(page, `source=pesquet-talk&autostart&filter=${NOIR}&filter=${GRADE}`, false)
  // Black and white, then an orange tint: orange image.
  await page.evaluate(() => window.ouaf!.engine.filters[1]!.setParam('tint', '#ff8000', { transition: 0 }))
  await expect.poll(async () => check(await sample(page), (s) => s.r > s.g + 10 && s.g > s.b + 10 && s.b < 5), POLL).toBe(true)
  // Tint first, then black and white: no color left.
  await page.evaluate(() => window.ouaf!.engine.filters[1]!.moveTo(0))
  await expect.poll(async () => check(await sample(page), (s) => s.chroma < 2), POLL).toBe(true)
  expect(await page.evaluate(() => window.ouaf!.engine.filters.map((f) => f.id))).toEqual(['color-grade', 'color-noir'])
})

test('region "face" grades the face oval only', async ({ page }) => {
  await open(page, `source=pesquet-closeup&autostart&filter=${FACE}`, true)
  // The face turns pure green (a few % of the frame at least), the rest of the image does not.
  await expect.poll(async () => check(await sample(page), (s) => s.green > 0.01 && s.greenWidth < 0.8 && s.greenHeight < 0.6), POLL).toBe(true)
  await page.evaluate(() => window.ouaf!.engine.filters[0]!.setParam('amount', 0, { transition: 0 }))
  await expect.poll(async () => check(await sample(page), (s) => s.green < 0.001), POLL).toBe(true)
})
