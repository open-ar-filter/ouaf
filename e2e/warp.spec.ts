import { expect, test, type Page } from '@playwright/test'

/**
 * Warp layer (#22) on `/engine.html`: a swirl between the eyes of each face (`filters/fixtures/warp-eyes/`), one face
 * unit in radius, with a green dot of 0.3 units on the same anchor. The dot is drawn after the warp (objects stage),
 * so it marks the centre and gives the face unit in pixels. The image changes inside the radius and not outside,
 * for every face and with a mirrored source.
 */

const FIXTURE = '/filters/fixtures/warp-eyes/'
const DOT_SIZE = 0.3

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/engine.html?${query}`)
  await page.waitForFunction(() => ((window.ouaf?.stats?.faces ?? 0) > 0 && (window.ouaf?.stats?.trackingHz ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, { timeout: 60_000 })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
}

/**
 * Sets the swirl strength, redraws the paused video at `time` (each seek presents the frame again, so the engine
 * tracks and draws it once more), and keeps the canvas pixels as displayed under `name`.
 */
async function shot(page: Page, name: string, strength: number, time: number): Promise<void> {
  await page.evaluate((s) => window.ouaf!.engine.filters[0]!.setParam('strength', s), strength)
  // Each seek presents the frame again; while a seek runs, the engine keeps drawing the last frame it uploaded
  // (before #32 it drew a black frame then, and this test had to retry).
  for (let i = 0; i < 3; i++) {
    await page.evaluate(
      (t) =>
        new Promise<void>((resolve) => {
          const video = document.getElementById('video') as HTMLVideoElement
          video.pause()
          video.addEventListener('seeked', () => resolve(), { once: true })
          setTimeout(resolve, 3000) // in case the seek never completes
          video.currentTime = t
        }),
      time + i * 0.001, // the same frame of the clip (mid-frame), but a new seek each time
    )
    await page.waitForTimeout(300)
  }
  const png = await page.locator('#canvas').screenshot()
  const mean = await page.evaluate(
    async ([bytes, key]) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
      const c = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = c.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const w = window as unknown as { shots?: Record<string, ImageData> }
      w.shots ??= {}
      const image = ctx.getImageData(0, 0, c.width, c.height)
      w.shots[key] = image
      let red = 0
      for (let i = 0; i < image.data.length; i += 4) red += image.data[i]!
      return red / (image.data.length / 4)
    },
    [[...png], name] as const,
  )
  expect(mean, `shot ${name} shows the video`).toBeGreaterThan(10)
}

interface FaceDiff {
  /** Centre of the dot (pixels) and the face unit in pixels, from the dot's area. */
  x: number
  y: number
  unit: number
  /** Mean absolute difference per channel, inside the swirl (0.35–0.8 units) and outside every swirl (> 1.6 units). */
  inside: { warp: number; motion: number }
  outside: { warp: number; motion: number }
}

/**
 * Compares the shots `off1`, `on`, `off2` (strength 0, 1, 0): `warp` = |on − off1|, `motion` = |off2 − off1| (what
 * the video itself changed over the same time). Dots are found in the top and bottom halves (stacked faces).
 */
async function analyse(page: Page): Promise<FaceDiff[]> {
  return page.evaluate((dotSize) => {
    const { off1, on, off2 } = (window as unknown as { shots: Record<string, ImageData> }).shots
    const W = on!.width
    const H = on!.height
    const green = (d: Uint8ClampedArray, i: number) => d[i + 1]! > 180 && d[i]! < 120 && d[i + 2]! < 120
    const faces: Array<{ x: number; y: number; unit: number }> = []
    for (const [y0, y1] of [[0, H / 2], [H / 2, H]] as const) {
      let n = 0
      let sx = 0
      let sy = 0
      for (let y = Math.floor(y0); y < y1; y++) {
        for (let x = 0; x < W; x++) {
          if (green(on!.data, (y * W + x) * 4)) {
            n++
            sx += x
            sy += y
          }
        }
      }
      if (n > 30) faces.push({ x: sx / n, y: sy / n, unit: (2 * Math.sqrt(n / Math.PI)) / dotSize })
    }
    const diff = (a: ImageData, b: ImageData, i: number) =>
      (Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!)) / 3
    const out = faces.map((f) => ({ ...f, inside: { warp: 0, motion: 0, n: 0 }, outside: { warp: 0, motion: 0, n: 0 } }))
    const outside = { warp: 0, motion: 0, n: 0 }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        if (green(off1!.data, i) || green(on!.data, i) || green(off2!.data, i)) continue
        let far = true
        for (const f of out) {
          const r = Math.hypot(x - f.x, y - f.y) / f.unit
          if (r < 1.6) far = false
          if (r > 0.35 && r < 0.8) {
            f.inside.warp += diff(on!, off1!, i)
            f.inside.motion += diff(off2!, off1!, i)
            f.inside.n++
          }
        }
        if (far) {
          outside.warp += diff(on!, off1!, i)
          outside.motion += diff(off2!, off1!, i)
          outside.n++
        }
      }
    }
    return out.map((f) => ({
      x: f.x,
      y: f.y,
      unit: f.unit,
      inside: { warp: f.inside.warp / f.inside.n, motion: f.inside.motion / f.inside.n },
      outside: { warp: outside.warp / outside.n, motion: outside.motion / outside.n },
    }))
  }, DOT_SIZE)
}

for (const mirror of [false, true]) {
  test(`a warp deforms the image around its anchor of each face, and only there${mirror ? ' (mirrored)' : ''}`, async ({ page }) => {
    await open(page, `source=two-faces-stacked&autostart&maxFaces=2${mirror ? '&mirror=1' : ''}&filter=${FIXTURE}`)
    let faces: FaceDiff[] = []
    // The same still frame three times (the video paused), so only the swirl changes the image. Polled over a few
    // moments of the clip, in case the tracker misses a face on one of them.
    let time = 0.5 + 1 / 60
    await expect
      .poll(
        async () => {
          await shot(page, 'off1', 0, time)
          await shot(page, 'on', 1, time)
          await shot(page, 'off2', 0, time)
          time = (time + 0.7) % 3
          faces = await analyse(page)
          const ok = faces.length === 2 && faces.every((f) => f.inside.warp > 3 * f.inside.motion + 8 && f.outside.warp < 2 * f.outside.motion + 2)
          if (!ok) console.log('sample', JSON.stringify(faces))
          return ok
        },
        { timeout: 90_000, intervals: [500] },
      )
      .toBe(true)
    // The radius is in face units: about one eye distance on screen (the faces are 20–40 % of the width).
    for (const f of faces) expect(f.unit).toBeGreaterThan(20)
  })
}

test('every warp kind loads and runs', async ({ page }) => {
  await open(page, 'source=pesquet-closeup&autostart&filter=/filters/fixtures/warp-kinds/')
  await page.waitForTimeout(1000)
  expect(await page.evaluate(() => [window.ouaf!.errors, window.ouaf!.warnings])).toEqual([[], []])
})
