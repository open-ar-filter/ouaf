import { expect, test, type Page } from './fixtures.ts'

/**
 * Text resolution (#147): the `text` layer rasterizes at a resolution that follows its size on screen, so a large
 * `size` is as sharp as a small one, and a lasting `scale` too once it settles. A white "I" (screen anchor, overlay)
 * on a black canvas source; the sharpness is the width of its edges in the snapshot: pixels between dark and bright
 * per edge crossed by the rows through the glyph (about 1 px when sharp, about the upscaling factor when blurry).
 */

interface Glyph {
  /** Height of the bright part, in pixels of the snapshot. */
  height: number
  /** Mean width of an edge, in pixels. */
  edge: number
}

async function open(page: Page): Promise<void> {
  await page.goto('/engine.html')
  await page.waitForFunction(() => window.ouaf !== undefined, undefined, { timeout: 60_000 })
  await page.evaluate(async () => {
    const { engine, memorySource } = window.ouaf!
    const canvas = document.createElement('canvas')
    canvas.width = 1280
    canvas.height = 720
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, 1280, 720)
    await engine.setSource(canvas)
    await engine.setFilters([])
    await engine.addFilter(
      memorySource({
        manifest: {
          ouaf: '1', id: 'text-resolution', name: 'text resolution', version: '1.0.0', license: 'CC0-1.0', requires: {},
          params: {
            size: { type: 'number', default: 0.08, min: 0.01, max: 1 },
            scale: { type: 'number', default: 1, min: 0.1, max: 10 },
          },
          layers: [{ type: 'text', text: 'I', anchor: 'screen', overlay: true, color: '#ffffff', size: { param: 'size' }, scale: { param: 'scale' } }],
        },
        files: {},
      }),
    )
  })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
}

/** Sets the params, waits for the resolution to settle (HOLD, SETTLE), then measures the glyph in a snapshot. */
async function glyph(page: Page, size: number, scale: number): Promise<Glyph> {
  return page.evaluate(
    async ([size, scale]) => {
      const { engine } = window.ouaf!
      const filter = engine.filters[0]!
      filter.setParam('size', size!, { transition: 0 })
      filter.setParam('scale', scale!, { transition: 0 })
      await new Promise((resolve) => setTimeout(resolve, 800))
      const bitmap = await createImageBitmap(await engine.snapshot())
      const c = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = c.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
      const lum = (x: number, y: number) => data[(y * width + x) * 4]!
      let top = height
      let bottom = -1
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (lum(x, y) > 128) {
            top = Math.min(top, y)
            bottom = Math.max(bottom, y)
            break
          }
        }
      }
      // Rows through the middle half of the glyph: ramp pixels (neither dark nor bright) over edges crossed.
      let ramp = 0
      let edges = 0
      const from = Math.round(top + (bottom - top) * 0.25)
      const to = Math.round(top + (bottom - top) * 0.75)
      for (let y = from; y <= to; y++) {
        let bright = false
        for (let x = 0; x < width; x++) {
          const v = lum(x, y)
          if (v > 25 && v < 230) ramp++
          if (v > 128 !== bright) {
            bright = !bright
            edges++
          }
        }
      }
      return { height: bottom - top + 1, edge: edges > 0 ? ramp / edges : Infinity }
    },
    [size, scale] as const,
  )
}

test('a large size is as sharp as a small one, and a lasting scale too', async ({ page }) => {
  await open(page)
  const small = await glyph(page, 0.08, 1)
  const large = await glyph(page, 0.6, 1)
  const scaled = await glyph(page, 0.15, 4)
  const base = await glyph(page, 0.15, 1)
  test.info().annotations.push({ type: 'edge px', description: `small ${small.edge.toFixed(2)}, large ${large.edge.toFixed(2)}, scale 4 ${scaled.edge.toFixed(2)}` })
  expect(large.height).toBeGreaterThan(small.height * 6)
  expect(small.edge).toBeLessThan(2.5)
  expect(large.edge, JSON.stringify({ small, large })).toBeLessThan(small.edge + 0.75)
  // `scale` keeps working: four times as tall, and sharp once settled.
  expect(scaled.height / base.height).toBeCloseTo(4, 0)
  expect(scaled.edge, JSON.stringify({ base, scaled })).toBeLessThan(base.edge + 0.75)
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})
