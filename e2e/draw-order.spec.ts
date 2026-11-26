import { expect, test } from './fixtures.ts'

/**
 * Draw order of objects on one anchor (#150, spec §7) on `/engine.html` with `filters/fixtures/draw-order/`: two red
 * bubble stickers on the forehead, each with a text 0.02 in front of it, off its centre (green: towards the bubble's
 * right, blue: its left), all facing the screen, the texts first in the layer list. While the head turns
 * (`pesquet-turn`), one text's centre or the other gets deeper than its bubble's: depth-sorted, it would go behind the
 * bubble. Ordered by their offset z, both stay in front on every frame where the bubbles are shown.
 */

interface Counts {
  red: number
  green: number
  blue: number
}

test('texts in front of stickers on the same anchor stay in front while the head turns', async ({ page }) => {
  await page.goto('/engine.html?source=pesquet-turn&autostart&filter=/filters/fixtures/draw-order/')
  await page.waitForFunction(() => ((window.ouaf?.stats?.faces ?? 0) > 0 && (window.ouaf?.stats?.trackingHz ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, { timeout: 60_000 })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
  expect(await page.evaluate(() => window.ouaf!.warnings)).toEqual([])

  // Every animation frame, counted in the page (a screenshot each time would miss most of the turn): pure red, green
  // and blue pixels of the canvas at a quarter of its size.
  const counts = await page.evaluate(async () => {
    const canvas = document.getElementById('canvas') as HTMLCanvasElement
    const video = document.getElementById('video') as HTMLVideoElement
    const out: Array<Counts & { t: number }> = []
    const scratch = new OffscreenCanvas(1, 1)
    const ctx = scratch.getContext('2d', { willReadFrequently: true })!
    // At least 6 s (the 2.4 s clip loops: more than two turns) and 40 frames with the bubbles shown, whatever the
    // machine's frame rate (a slow CI runner renders few frames in 6 s), within 30 s.
    const start = performance.now()
    let shownFrames = 0
    while (performance.now() - start < 30_000 && (performance.now() - start < 6000 || shownFrames < 40)) {
      await new Promise((r) => requestAnimationFrame(r))
      const w = (scratch.width = canvas.width / 4)
      const h = (scratch.height = canvas.height / 4)
      ctx.drawImage(canvas, 0, 0, w, h)
      const d = ctx.getImageData(0, 0, w, h).data
      let red = 0
      let green = 0
      let blue = 0
      for (let i = 0; i < d.length; i += 4) {
        const [r, g, b] = [d[i]!, d[i + 1]!, d[i + 2]!]
        if (r > 200 && g < 60 && b < 60) red++
        else if (g > 200 && r < 60 && b < 60) green++
        else if (b > 200 && r < 60 && g < 60) blue++
      }
      if (red > 600) shownFrames++
      out.push({ red, green, blue, t: video.currentTime })
    }
    return out
  })
  // Both bubbles shown (the clip's logos have a little pure red too).
  const shown = counts.filter((c) => c.red > 600)
  expect(shown.length).toBeGreaterThan(30)
  const hidden = shown.filter((c) => c.green < 8 || c.blue < 8)
  if (hidden.length) console.log(`${hidden.length} of ${shown.length} frames with a text hidden`, JSON.stringify(hidden.slice(0, 10)))
  expect(hidden).toEqual([])
})
