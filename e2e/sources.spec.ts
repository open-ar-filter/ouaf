import { expect, test, type Page } from '@playwright/test'

/**
 * Sources (#32) on `/engine.html`, driven through the public API: an offline video (every frame, exact timestamps,
 * the same result on every run), `pushFrame`, a still image (IMAGE mode), a live canvas, the seeds (spec §12.5) and
 * the explicit errors. The `probe` fixture records what layers see on every frame (`window.ouafProbe`).
 */

const PROBE = '/filters/fixtures/probe/'
const CLIP = '/test-media/pesquet-closeup-360.mp4'
/** Frames of the clip (ffprobe: 93 frames at 30 fps, B-frames). */
const FRAMES = 93

interface Sample {
  time: number
  dt: number
  faces: number
  x: number
  y: number
  random: number
}

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/engine.html${query}`)
  await page.waitForFunction(() => !!window.ouaf)
  await page.evaluate(async (probe) => {
    await window.ouaf!.engine.addFilter(probe)
  }, PROBE)
}

async function errors(page: Page): Promise<string[]> {
  return page.evaluate(() => window.ouaf!.errors)
}

test('an offline video renders every frame at its exact time, with the same result on every run', async ({ page }) => {
  await open(page)
  const runs = await page.evaluate(
    async ([clip]) => {
      const { engine, core } = window.ouaf!
      const source = await core.OfflineVideoSource.open(clip!, { rate: Infinity })
      const run = async () => {
        window.ouafProbe = []
        const end = new Promise<{ frames: number; time: number }>((resolve) => {
          const off = engine.on('sourceEnd', (e) => (off(), resolve(e)))
        })
        await engine.setSource(source)
        const e = await end
        return { end: e, regime: engine.regime, samples: window.ouafProbe.slice() }
      }
      return { info: { codec: source.codec, frames: source.frameCount, width: source.width, height: source.height }, a: await run(), b: await run() }
    },
    [CLIP],
  )
  expect(await errors(page)).toEqual([])
  expect(runs.info).toEqual({ codec: 'avc1.4d401e', frames: FRAMES, width: 360, height: 640 })
  const { a, b } = runs
  expect(a.regime).toBe('file')
  expect(a.end.frames).toBe(FRAMES)
  expect(a.samples).toHaveLength(FRAMES)
  // Every frame, in order, at its own media time; the frame step is the media time step, not the clock.
  a.samples.forEach((s: Sample, i: number) => {
    expect(s.time).toBeCloseTo(i / 30, 9)
    expect(s.dt).toBeCloseTo(i === 0 ? 0 : 1000 / 30, 6)
  })
  // Each frame waits for its own tracking result: a face on every frame of this close-up.
  expect(a.samples.filter((s: Sample) => s.faces === 1)).toHaveLength(FRAMES)
  // The second run gives the same faces (the tracker starts afresh; inference may differ by a float ULP) and the
  // same seeded draws.
  expect(b.samples).toHaveLength(FRAMES)
  b.samples.forEach((s: Sample, i: number) => {
    const r = a.samples[i]!
    expect(s.time).toBe(r.time)
    expect(s.random).toBe(r.random)
    expect(Math.abs(s.x - r.x)).toBeLessThan(1e-5)
    expect(Math.abs(s.y - r.y)).toBeLessThan(1e-5)
  })
})

test('pushFrame renders each frame before resolving, the same way on every run', async ({ page }) => {
  await open(page)
  const result = await page.evaluate(
    async ([clip]) => {
      const { engine, core } = window.ouaf!
      const source = await core.OfflineVideoSource.open(clip!)
      const W = 90
      const H = 160
      const ctx = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!
      const run = async (count: number) => {
        source.restart()
        window.ouafProbe = []
        const pixels: Uint8ClampedArray[] = []
        for (let i = 0; i < count; i++) {
          const frame = (await source.read())!
          await engine.pushFrame(frame.image, frame.time)
          frame.close() // the engine is done with it once the promise resolves
          // The frame is drawn when the promise resolves: read the canvas in the same task.
          ctx.drawImage(engine.canvas, 0, 0, W, H)
          pixels.push(ctx.getImageData(0, 0, W, H).data)
        }
        return pixels
      }
      const a = await run(30)
      const b = await run(30)
      let worst = 0
      for (let f = 0; f < a.length; f++) {
        let sum = 0
        for (let i = 0; i < a[f]!.length; i++) sum += Math.abs(a[f]![i]! - b[f]![i]!)
        worst = Math.max(worst, sum / a[f]!.length)
      }
      const green = (d: Uint8ClampedArray) => {
        let n = 0
        for (let i = 0; i < d.length; i += 4) if (d[i + 1]! > 200 && d[i]! < 80 && d[i + 2]! < 80) n++
        return n
      }
      const probe = window.ouafProbe ?? []
      return { worst, frames: probe.length, faces: probe.filter((s) => s.faces === 1).length, green: green(a[29]!), regime: engine.regime }
    },
    [CLIP],
  )
  expect(await errors(page)).toEqual([])
  expect(result.regime).toBe('file')
  expect(result.frames).toBe(30)
  expect(result.faces).toBe(30)
  expect(result.green).toBeGreaterThan(5) // the nose dot is drawn (about 14 pixels at this size)
  expect(result.worst).toBeLessThan(0.5) // same images (mean difference per channel, 0–255)
})

/** Draws frame `time` of the clip into a new canvas (an image of the licensed clip, no other picture). */
async function clipFrame(page: Page, time: number): Promise<void> {
  await page.evaluate(
    async ([clip, t]) => {
      const video = document.createElement('video')
      video.muted = true
      video.src = clip as string
      await new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }))
      video.currentTime = t as number
      await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }))
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d')!.drawImage(video, 0, 0)
      ;(window as unknown as { clipCanvas: HTMLCanvasElement }).clipCanvas = canvas
    },
    [CLIP, time] as const,
  )
}

test('a still image is tracked in IMAGE mode and keeps rendering, with time going on', async ({ page }) => {
  await open(page)
  await clipFrame(page, 1)
  const result = await page.evaluate(async () => {
    const { engine } = window.ouaf!
    const bitmap = await createImageBitmap((window as unknown as { clipCanvas: HTMLCanvasElement }).clipCanvas)
    window.ouafProbe = []
    await engine.setSource(bitmap)
    await new Promise((resolve) => setTimeout(resolve, 4000)) // switching the tracker to IMAGE mode takes ~2 s on SwiftShader
    return { regime: engine.regime, samples: window.ouafProbe.slice() }
  })
  expect(await errors(page)).toEqual([])
  expect(result.regime).toBe('file')
  const tracked = result.samples.filter((s: Sample) => s.faces === 1)
  expect(tracked.length).toBeGreaterThan(5)
  expect(result.samples.at(-1)!.time).toBeGreaterThan(0.5)
  // Tracked once: the face does not move on a still image.
  expect(new Set(tracked.map((s: Sample) => s.x)).size).toBe(1)
})

test('a canvas is read directly on every animation frame, as a live source', async ({ page }) => {
  await open(page)
  const result = await page.evaluate(async (clip) => {
    const { engine } = window.ouaf!
    const video = document.createElement('video')
    video.muted = true
    video.loop = true
    video.src = clip
    await video.play()
    const canvas = document.createElement('canvas')
    canvas.width = 360
    canvas.height = 640
    const ctx = canvas.getContext('2d')!
    let drawing = true
    const draw = () => {
      ctx.drawImage(video, 0, 0)
      if (drawing) requestAnimationFrame(draw)
    }
    draw()
    window.ouafProbe = []
    await engine.setSource(canvas)
    await new Promise((resolve) => setTimeout(resolve, 3000))
    drawing = false
    return { regime: engine.regime, samples: window.ouafProbe.slice() }
  }, CLIP)
  expect(await errors(page)).toEqual([])
  expect(result.regime).toBe('live')
  const tracked = result.samples.filter((s: Sample) => s.faces === 1)
  expect(tracked.length).toBeGreaterThan(5)
  // The canvas changes: the face moves.
  expect(new Set(tracked.map((s: Sample) => s.x)).size).toBeGreaterThan(1)
})

test('the last setSource wins over one that is still loading its image; clearSource cancels it', async ({ page }) => {
  await open(page)
  const result = await page.evaluate(async () => {
    const { engine } = window.ouaf!
    const canvas = document.createElement('canvas')
    canvas.getContext('2d')!.fillRect(0, 0, 10, 10)
    /** An image that is not decoded yet: `setSource` waits for it. */
    const image = () => {
      const img = new Image()
      img.src = canvas.toDataURL()
      return img
    }
    const slow = engine.setSource(image())
    await engine.setSource(canvas)
    await slow
    await new Promise((resolve) => setTimeout(resolve, 200))
    const afterCanvas = engine.regime
    // A cleared source stays cleared: nothing is rendered once the image is ready.
    const cleared = engine.setSource(image())
    engine.clearSource()
    await cleared
    window.ouafProbe = []
    await new Promise((resolve) => setTimeout(resolve, 300))
    return { afterCanvas, rendered: window.ouafProbe.length }
  })
  expect(await errors(page)).toEqual([])
  expect(result).toEqual({ afterCanvas: 'live', rendered: 0 })
})

/** First seeded draws of the probe layer after setting a live canvas source, for two successive sources. */
async function liveDraws(page: Page): Promise<number[][]> {
  return page.evaluate(async () => {
    const { engine } = window.ouaf!
    const canvas = document.createElement('canvas')
    canvas.getContext('2d')!.fillRect(0, 0, 10, 10)
    const draws: number[][] = []
    for (let run = 0; run < 2; run++) {
      window.ouafProbe = []
      await engine.setSource(canvas)
      await new Promise((resolve) => setTimeout(resolve, 300))
      draws.push(window.ouafProbe.slice(0, 3).map((s) => s.random))
    }
    engine.clearSource()
    return draws
  })
}

test('random draws are seeded: random when live, fixed for file sources, or the host seed', async ({ page }) => {
  await open(page)
  const live = await liveDraws(page)
  expect(live[0]).toHaveLength(3)
  expect(live[0]).not.toEqual(live[1])

  await open(page, '?seed=42')
  const seeded = await liveDraws(page)
  expect(seeded[0]).toHaveLength(3)
  expect(seeded[0]).toEqual(seeded[1])
  await open(page, '?seed=42')
  expect(await liveDraws(page)).toEqual(seeded)

  // A file source without a host seed: the same draws on every page load.
  const fileDraws = async () => {
    await open(page)
    return page.evaluate(async () => {
      const { engine } = window.ouaf!
      const canvas = new OffscreenCanvas(8, 8)
      canvas.getContext('2d')!.fillRect(0, 0, 8, 8)
      window.ouafProbe = []
      for (let i = 0; i < 3; i++) await engine.pushFrame(canvas, i / 30)
      return window.ouafProbe.map((s) => s.random)
    })
  }
  const first = await fileDraws()
  expect(first).toHaveLength(3)
  expect(await fileDraws()).toEqual(first)
  expect(first).not.toEqual(seeded[0])
})

test('explicit errors: the engine canvas, a tainted canvas, an image without pixels', async ({ page, baseURL }) => {
  await open(page)
  // Another origin (127.0.0.1 instead of localhost), loaded without CORS: drawing it taints the canvas.
  const foreign = new URL('/filters/fixtures/sticker/assets/disc.png', baseURL!.replace('localhost', '127.0.0.1')).href
  const result = await page.evaluate(async (url) => {
    const { engine } = window.ouaf!
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn()
        return 'ok'
      } catch (error) {
        const e = error as { name: string; code?: string; message: string }
        return `${e.name}:${e.code}:${e.message}`
      }
    }
    const img = new Image()
    img.src = url
    await img.decode()
    const tainted = document.createElement('canvas')
    tainted.getContext('2d')!.drawImage(img, 0, 0)
    const empty = document.createElement('canvas')
    empty.width = 0
    return {
      output: await attempt(() => engine.setSource(engine.canvas)),
      outputPush: await attempt(() => engine.pushFrame(engine.canvas, 0)),
      tainted: await attempt(() => engine.setSource(tainted)),
      taintedImage: await attempt(() => engine.setSource(img)),
      taintedPush: await attempt(() => engine.pushFrame(tainted, 0)),
      empty: await attempt(() => engine.setSource(empty)),
      time: await attempt(() => engine.pushFrame(empty, Number.NaN)),
    }
  }, foreign)
  expect(result.output).toMatch(/^IncompatibleSourceError:incompatible-source:.*its own output/)
  expect(result.outputPush).toMatch(/^IncompatibleSourceError:incompatible-source:.*its own output/)
  expect(result.tainted).toMatch(/^IncompatibleSourceError:incompatible-source:.*tainted/)
  expect(result.taintedImage).toMatch(/^IncompatibleSourceError:incompatible-source:.*tainted/)
  expect(result.taintedPush).toMatch(/^IncompatibleSourceError:incompatible-source:.*tainted/)
  expect(result.empty).toMatch(/^IncompatibleSourceError:incompatible-source:.*no pixels/)
  expect(result.time).toMatch(/^RangeError:/)
})
