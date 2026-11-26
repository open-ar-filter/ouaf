import { expect, test, type Page } from './fixtures.ts'

/**
 * Text layer (#19) on `/engine.html` with the `filters/fixtures/text/` fixture: built-in fonts loaded through the
 * font loader, a green label anchored above the head, a magenta score in the screen overlay, and params driving the
 * text and its opacity.
 */

const FIXTURE = '/filters/fixtures/text/'
const POLL = { timeout: 30_000, intervals: [250, 500, 1000] }

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/engine.html?${query}`)
  await page.waitForFunction(() => ((window.ouaf?.stats?.faces ?? 0) > 0 && (window.ouaf?.stats?.trackingHz ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, { timeout: 60_000 })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
}

interface Sample {
  /** Pure green pixels (the label), and where they are (mean y in [0, 1], 0 = top). */
  green: number
  greenY: number
  /** Pure magenta pixels (the score), and their mean y. */
  magenta: number
  magentaY: number
}

/** Counts the label's and the score's pixels in the canvas as displayed (screenshot decoded by the browser). */
async function sample(page: Page): Promise<Sample> {
  const png = await page.locator('#canvas').screenshot()
  return page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))]))
    const c = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let green = 0
    let greenY = 0
    let magenta = 0
    let magentaY = 0
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]!
      const g = d[i + 1]!
      const b = d[i + 2]!
      const y = Math.floor(i / 4 / c.width) / c.height
      if (g > 200 && r < 80 && b < 80) {
        green++
        greenY += y
      }
      if (r > 200 && b > 200 && g < 80) {
        magenta++
        magentaY += y
      }
    }
    return { green, greenY: green ? greenY / green : 0, magenta, magentaY: magenta ? magentaY / magenta : 0 }
  }, png.toString('base64'))
}

function check(s: Sample, test: (s: Sample) => boolean): boolean {
  const ok = test(s)
  if (!ok) console.log('sample', JSON.stringify(s))
  return ok
}

test('text layers are drawn with the built-in fonts, anchored and on the overlay', async ({ page }) => {
  await open(page, `source=pesquet-closeup&autostart&filter=${FIXTURE}`)
  expect(await page.evaluate(() => window.ouaf!.warnings)).toEqual([])
  // The built-in fonts were registered by the font loader.
  const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight}`).sort())
  expect(fonts).toEqual(['Ouaf Handwritten 500', 'Ouaf Mono 400', 'Ouaf Sans 700'])

  // The label is above the head (the face is in the lower half of this clip), the score near the bottom of the screen.
  await expect.poll(async () => check(await sample(page), (s) => s.green > 300 && s.greenY < 0.55 && s.magenta > 30 && s.magentaY > 0.8), POLL).toBe(true)

  // The text param redraws the label: empty text hides it; the score stays.
  await page.evaluate(() => window.ouaf!.engine.filters[0]!.setParam('label', ''))
  await expect.poll(async () => check(await sample(page), (s) => s.green < 20 && s.magenta > 30), POLL).toBe(true)
  await page.evaluate(() => window.ouaf!.engine.filters[0]!.setParam('label', 'A much longer label'))
  await expect.poll(async () => check(await sample(page), (s) => s.green > 300), POLL).toBe(true)

  // Opacity is applied without redrawing: at 0 the label disappears.
  await page.evaluate(() => window.ouaf!.engine.filters[0]!.setParam('fade', 0, { transition: 0 }))
  await expect.poll(async () => check(await sample(page), (s) => s.green < 20), POLL).toBe(true)
})
