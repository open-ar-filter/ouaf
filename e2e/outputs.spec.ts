import { expect, test, type Page } from './fixtures.ts'

/**
 * Outputs (#33) on `/engine.html` with `filters/fixtures/capture/` on the `no-face` clip: a yellow overlay square on
 * the left and a magenta one on the right marked `excludeFromCapture`. The canvas shows both; the snapshot, the output
 * stream and the recording show the yellow one only, with and without a color pass (both compositor paths). Also run
 * on Firefox (CI's Firefox job): with a GPU it swapped red and blue in the snapshot and the export while the capture
 * surface was a `<canvas>` (#137).
 */

type RGB = [number, number, number]

const LEFT = [-0.2, 0] as const
const RIGHT = [0.2, 0] as const
const YELLOW: RGB = [255, 255, 0]
const MAGENTA: RGB = [255, 0, 255]
const near = (c: RGB, expected: RGB, tolerance: number) => c.every((v, i) => Math.abs(v - expected[i]!) <= tolerance)

/** Installs `window.sampleImage(image, points)`: colors at points of the screen frame (spec §5.2), 3 × 3 averages. */
async function installSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as unknown as { sampleImage: unknown }).sampleImage = (image: CanvasImageSource & { width?: number; height?: number; videoWidth?: number; videoHeight?: number }, points: Array<[number, number]>) => {
      const width = image.videoWidth ?? (image.width as number)
      const height = image.videoHeight ?? (image.height as number)
      const c = new OffscreenCanvas(width, height)
      const ctx = c.getContext('2d')!
      ctx.drawImage(image, 0, 0)
      const d = ctx.getImageData(0, 0, width, height).data
      const colors = points.map(([x, y]) => {
        const px = Math.round(width / 2 + x * height)
        const py = Math.round(height / 2 - y * height)
        const sum = [0, 0, 0]
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const i = ((py + dy) * width + (px + dx)) * 4
            for (let k = 0; k < 3; k++) sum[k]! += d[i + k]!
          }
        }
        return sum.map((v) => Math.round(v / 9))
      })
      return { width, height, colors }
    }
  })
}

type Sampled = { width: number; height: number; colors: RGB[] }

/** The canvas as displayed (screenshot), at `LEFT` and `RIGHT`. */
async function screen(page: Page): Promise<Sampled> {
  const png = await page.locator('#canvas').screenshot()
  return page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))]))
    const sample = (window as unknown as { sampleImage: (i: CanvasImageSource, p: number[][]) => Sampled }).sampleImage
    return sample(bitmap, [[-0.2, 0], [0.2, 0]])
  }, png.toString('base64'))
}

async function snapshot(page: Page): Promise<Sampled & { type: string; canvas: [number, number] }> {
  return page.evaluate(async () => {
    const { engine } = window.ouaf!
    const blob = await engine.snapshot()
    const bitmap = await createImageBitmap(blob)
    const sample = (window as unknown as { sampleImage: (i: CanvasImageSource, p: number[][]) => Sampled }).sampleImage
    const canvas = engine.canvas
    return { ...sample(bitmap, [[-0.2, 0], [0.2, 0]]), type: blob.type, canvas: [canvas.width, canvas.height] as [number, number] }
  })
}

test('snapshot, outputStream and record leave out the excludeFromCapture overlay', async ({ page }) => {
  await page.goto('/engine.html?source=no-face&autostart&filter=/filters/fixtures/capture/')
  await page.waitForFunction(() => ((window.ouaf?.engine.filters.length ?? 0) > 0 && (window.ouaf?.frames ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, { timeout: 60_000 })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
  expect(await page.evaluate(() => window.ouaf!.warnings)).toEqual([])
  await installSampler(page)

  // The screen shows both squares.
  await expect.poll(async () => {
    const s = await screen(page)
    return near(s.colors[0]!, YELLOW, 12) && near(s.colors[1]!, MAGENTA, 12)
  }, { timeout: 30_000 }).toBe(true)

  // Snapshot, without then with a pass (the color stage), at the render size.
  for (const pass of [false, true]) {
    if (pass) await page.evaluate(() => window.ouaf!.engine.addFilter('/filters/fixtures/color-noir/').then(() => {}))
    const shot = await snapshot(page)
    expect([shot.type, shot.width, shot.height]).toEqual(['image/png', ...shot.canvas])
    expect(near(shot.colors[0]!, YELLOW, 12), `snapshot (pass: ${pass}) left: ${shot.colors[0]}`).toBe(true)
    expect(near(shot.colors[1]!, MAGENTA, 80), `snapshot (pass: ${pass}) right: ${shot.colors[1]}`).toBe(false)
    const s = await screen(page)
    expect(near(s.colors[1]!, MAGENTA, 12), `screen (pass: ${pass}) right: ${s.colors[1]}`).toBe(true)
  }

  // Output stream, played in a <video>.
  const streamed = await page.evaluate(async () => {
    const { engine } = window.ouaf!
    const stream = engine.outputStream()
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = stream
    await video.play()
    // A few frames in: the first one can predate the stream's first capture.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => video.requestVideoFrameCallback(resolve))
    const sample = (window as unknown as { sampleImage: (i: CanvasImageSource, p: number[][]) => Sampled }).sampleImage
    const result = { ...sample(video, [[-0.2, 0], [0.2, 0]]), tracks: stream.getTracks().map((t) => t.kind), canvas: [engine.canvas.width, engine.canvas.height] }
    for (const t of stream.getTracks()) t.stop()
    video.srcObject = null
    return result
  })
  expect(streamed.tracks).toEqual(['video'])
  expect([streamed.width, streamed.height]).toEqual(streamed.canvas)
  expect(near(streamed.colors[0]!, YELLOW, 40), `stream left: ${streamed.colors[0]}`).toBe(true)
  expect(near(streamed.colors[1]!, MAGENTA, 80), `stream right: ${streamed.colors[1]}`).toBe(false)

  // Recording: 1.5 s, decoded back.
  const recorded = await page.evaluate(async () => {
    const { engine } = window.ouaf!
    const recording = engine.record()
    const mimeType = recording.mimeType
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const blob = await recording.stop()
    const video = document.createElement('video')
    video.muted = true
    video.src = URL.createObjectURL(blob)
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve
      video.onerror = () => reject(new Error(`cannot decode the recording (${blob.type})`))
    })
    // A frame played back (drawing at `loadeddata` gives black in headless Chromium). The recording may hold few
    // frames on a slow machine: stop at the end too.
    let ended = false
    video.onended = () => (ended = true)
    await video.play()
    for (let i = 0; i < 3 && !ended; i++) {
      await new Promise((resolve) => {
        video.requestVideoFrameCallback(resolve)
        video.addEventListener('ended', resolve, { once: true })
        setTimeout(resolve, 2000)
      })
    }
    video.pause()
    const sample = (window as unknown as { sampleImage: (i: CanvasImageSource, p: number[][]) => Sampled }).sampleImage
    const result = { ...sample(video, [[-0.2, 0], [0.2, 0]]), mimeType, type: blob.type, size: blob.size, state: recording.state, canvas: [engine.canvas.width, engine.canvas.height] }
    URL.revokeObjectURL(video.src)
    return result
  })
  // Chromium: H.264 MP4 or WebM VP9; Firefox: WebM VP8 (its MediaRecorder has no VP9).
  expect(recorded.mimeType).toMatch(/^video\/(mp4;codecs=avc1|webm;codecs=vp9|webm;codecs=vp8)/)
  expect(recorded.type).toMatch(/^video\/(mp4|webm)/)
  expect(recorded.state).toBe('inactive')
  expect(recorded.size).toBeGreaterThan(1000)
  expect([recorded.width, recorded.height]).toEqual(recorded.canvas)
  expect(near(recorded.colors[0]!, YELLOW, 50), `recording left: ${recorded.colors[0]}`).toBe(true)
  expect(near(recorded.colors[1]!, MAGENTA, 80), `recording right: ${recorded.colors[1]}`).toBe(false)

  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})
