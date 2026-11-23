import { expect, test, type Page } from '@playwright/test'

/**
 * The LiteRT.js face tracker in a worker (#165, docs/decisions/face-runtime.md) on `/engine.html`: forced with
 * `?backend=litert`, its fallbacks (`?crop=canvas`, `?transfer=bitmap`), and its landmarks, blendshapes and matrix
 * against MediaPipe's on frames of the test clips.
 */

const POLL = { timeout: 60_000, intervals: [250, 500, 1000] }

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/engine.html?${query}`)
  await page.waitForFunction(() => ((window.ouaf?.stats?.faces ?? 0) > 0 && (window.ouaf?.stats?.trackingHz ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, { timeout: 60_000 })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
}

const stats = (page: Page) => page.evaluate(() => window.ouaf!.stats!)

test('forced LiteRT.js: tracks the clip in a worker, WebGL2 crops read back async, VideoFrame transfer', async ({ page }) => {
  await open(page, 'source=pesquet-closeup&autostart&backend=litert&filter=/filters/fixtures/dot-tint/')
  await expect.poll(async () => (await stats(page)).tracker, POLL).toBe('LiteRT.js wasm in a worker, WebGL2 crops read back async, VideoFrame (forced)')
  // Tracking keeps up with the clip on a desktop, with ≈ nothing on the main thread.
  await page.waitForTimeout(3000)
  const s = await stats(page)
  console.log(`LiteRT.js: ${s.trackingHz.toFixed(1)} Hz, ${s.fps.toFixed(1)} fps, main-thread tracking ${s.trackMs.toFixed(2)} ms/frame`)
  expect(s.faces).toBe(1)
  expect(s.trackingHz).toBeGreaterThan(3) // how fast depends on the machine: ≈ 10 Hz on a 2-vCPU CI runner
  expect(s.trackMs).toBeLessThan(2)
  expect(await page.evaluate(() => window.ouaf!.warnings)).toEqual([])
})

test('LiteRT.js fallbacks: 2D-canvas crops and ImageBitmap transfer', async ({ page }) => {
  await open(page, 'source=pesquet-closeup&autostart&backend=litert&crop=canvas&transfer=bitmap&filter=/filters/fixtures/dot-tint/')
  await expect.poll(async () => (await stats(page)).tracker, POLL).toBe('LiteRT.js wasm in a worker, 2D-canvas crops, ImageBitmap (forced)')
  expect((await stats(page)).faces).toBe(1)
})

test('sync readback (?readback=sync): each crop read back before its landmark model', async ({ page }) => {
  await open(page, 'source=pesquet-closeup&autostart&backend=litert&readback=sync&filter=/filters/fixtures/dot-tint/')
  await expect.poll(async () => (await stats(page)).tracker, POLL).toBe('LiteRT.js wasm in a worker, WebGL2 crops, VideoFrame (forced)')
  await page.waitForTimeout(2000)
  const s = await stats(page)
  expect(s.faces).toBe(1)
  // It runs; how fast depends on the machine (9.6 Hz on a 2-vCPU CI runner).
  expect(s.trackingHz).toBeGreaterThan(3)
  expect(await page.evaluate(() => window.ouaf!.warnings)).toEqual([])
})

test('with maxFaces > 1, LiteRT.js tracks every face (no more MediaPipe only)', async ({ page }) => {
  await open(page, 'source=two-faces-stacked&autostart&maxFaces=2&filter=/filters/fixtures/dot-tint/')
  await expect.poll(async () => (await stats(page)).tracker, POLL).toMatch(/^LiteRT\.js wasm in a worker/)
  await expect.poll(async () => (await stats(page)).faces, POLL).toBe(2)
})

test('the governor drops the extra faces of LiteRT.js (it can shed them)', async ({ page }) => {
  // One face in view, up to four wanted: the detector looks for the others every 500 ms. Dropping the extra faces
  // (spec §16.2: the faces tracked at that moment are kept) stops that: the tracker then asks its worker for one face
  // (unit test). Main thread throttled (CDP, 8×): the rate falls below the drop level; blendshapes go first, then the
  // extra faces.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 8 })
  await page.goto('/engine.html?source=pesquet-closeup&autostart&backend=litert&maxFaces=4&adapt=1&filter=/filters/fixtures/dot-tint/')
  await expect.poll(() => page.evaluate(() => window.ouaf?.performance.map((e) => e.dropped.join(',')) ?? []), { timeout: 90_000, intervals: [500, 1000] }).toContain('blendshapes,extraFaces')
  // One face tracked (a stats sample may catch it lost for a moment under this throttling).
  await expect.poll(async () => (await stats(page)).faces, POLL).toBe(1)
})

test('nothing is fetched from another origin by the LiteRT.js tracker (docs/privacy.md)', async ({ page, baseURL }) => {
  const urls: string[] = []
  page.on('request', (r) => void urls.push(r.url()))
  await open(page, 'source=pesquet-closeup&autostart&backend=litert&filter=/filters/fixtures/dot-tint/')
  await page.waitForTimeout(1000)
  expect(urls.filter((u) => !u.startsWith(baseURL!) && !u.startsWith('data:') && !u.startsWith('blob:'))).toEqual([])
  // Its own files were loaded (the worker's requests are the page's in Chromium).
  expect(urls.some((u) => u.includes('/models/face_landmarks_detector.tflite'))).toBe(true)
  expect(urls.some((u) => u.includes('/litert/wasm/litert_wasm'))).toBe(true)
})

test('the governor drops only what LiteRT.js can shed: blendshapes, never the analysis resolution', async ({ page }) => {
  // A slow main thread (CDP, 8×) slows the hand-offs to and from the worker: the rate falls below the drop level.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 8 })
  await page.goto('/engine.html?source=pesquet-talk&autostart&backend=litert&adapt=1&filter=/filters/fixtures/dot-tint/')
  await expect.poll(() => page.evaluate(() => window.ouaf?.performance.length ?? 0), { timeout: 90_000, intervals: [500, 1000] }).toBeGreaterThan(0)
  await page.waitForTimeout(6000)
  const events = await page.evaluate(() => window.ouaf!.performance.map((e) => e.dropped.join(',')))
  expect(events[0]).toBe('blendshapes')
  expect(events.filter((e) => e.includes('resolution'))).toEqual([])
  // Blendshapes dropped: the worker skips their model.
  await expect.poll(async () => (await stats(page)).trackerTimings?.blendshapesMs ?? -1, POLL).toBeLessThan(0.1)
})

/**
 * Same results as MediaPipe (VIDEO mode, CPU) on frames of four clips, decoded frame-exactly, each of our results
 * compared with MediaPipe's of the frame it describes: on the frames where both find the face, landmarks within a few %
 * of the face size (the spike measured 0.6–2.5 % mean on frontal frames), blendshapes within a few hundredths, the
 * transformation matrix (fitted to our landmarks by `estimateFacePose`, MediaPipe's own geometry pipeline) within a
 * few degrees and centimetres; and both find a face on mostly the same frames.
 *
 * Two variants, same limits. Sync readback on every third frame: our ROI comes from the previous result, as
 * MediaPipe's. Async readback (the default) on every second frame (15 Hz, about the phone's rate): frame N's ROI comes
 * from frame N − 2's landmarks (extrapolated), one frame older. With every third frame instead (a 200 ms old ROI),
 * fast head turns lose the face more often (same frames as MediaPipe 78–82 % on `pesquet-talk` and `pesquet-walk`).
 */
const LIMITS = { agree: 0.85, median: 2, p90: 4, blendshapes: 0.04, rotationDeg: 3, translationCm: 1.5 }
const VARIANTS = [
  { name: 'sync readback, every 3rd frame', readback: 'sync', step: 3, limits: LIMITS },
  { name: 'async readback, every 2nd frame', readback: 'async', step: 2, limits: LIMITS },
] as const
for (const variant of VARIANTS) {
test(`landmarks, blendshapes and matrix match MediaPipe on the test clips: ${variant.name}`, async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto('/engine.html')
  await page.waitForFunction(() => !!window.ouaf)
  const results = await page.evaluate(async ({ readback, step }) => {
    const core = window.ouaf!.core
    const warnings: string[] = []
    const env = { assetsBaseUrl: new URL('./', document.baseURI).href, warn: (m: string) => void warnings.push(m) }
    const config = { maxFaces: 1, blendshapes: true, analysisScale: 1 }
    const quantile = (values: number[], p: number) => [...values].sort((x, y) => x - y)[Math.min(values.length - 1, Math.floor(p * values.length))] ?? Number.NaN
    const out: Record<string, { frames: number; agree: number; both: number; landmarks: number[]; blendshapes: number; rotationDeg: number; translationCm: number }> = {}
    for (const clip of ['pesquet-talk', 'pesquet-closeup', 'pesquet-turn', 'pesquet-walk']) {
      const ours = await core.createLiteRtFaceTracker({ readback }).create(config, env)
      const mediaPipe = await core.mediaPipeFaceTracker.create(config, { ...env, backend: 'CPU' })
      const a = core.createFaceFrame(1)
      const source = await core.OfflineVideoSource.open(`/test-media/${clip}.mp4`, { rate: Infinity })
      const landmarks: number[] = []
      const blendshapes: number[] = []
      const rotations: number[] = []
      const translations: number[] = []
      // MediaPipe's results by media time: ours may describe an earlier frame (async readback, one frame late).
      const theirs = new Map<number, ReturnType<typeof core.createFaceFrame>>()
      let frames = 0
      let agree = 0
      for (let k = 0; ; k++) {
        const frame = await source.read()
        if (!frame) break
        try {
          if (k % step) continue
          const ts = frame.time * 1000 + 1
          const mp = core.createFaceFrame(1)
          await mediaPipe.track(frame.image, ts, frame.time, mp)
          theirs.set(frame.time, mp)
          await ours.track(frame.image, ts, frame.time, a)
        } finally {
          frame.close()
        }
        const b = theirs.get(a.mediaTime)
        if (!b) continue
        frames++
        if ((a.count > 0) === (b.count > 0)) agree++
        if (!a.count || !b.count) continue
        const w = a.width
        const h = a.height
        // Face size: the long side of MediaPipe's landmark box, in pixels.
        let x0 = Infinity
        let x1 = -Infinity
        let y0 = Infinity
        let y1 = -Infinity
        for (let i = 0; i < 478; i++) {
          const x = b.landmarks[i * 3]! * w
          const y = b.landmarks[i * 3 + 1]! * h
          x0 = Math.min(x0, x)
          x1 = Math.max(x1, x)
          y0 = Math.min(y0, y)
          y1 = Math.max(y1, y)
        }
        const size = Math.max(x1 - x0, y1 - y0)
        let sum = 0
        for (let i = 0; i < 478; i++) sum += Math.hypot((a.landmarks[i * 3]! - b.landmarks[i * 3]!) * w, (a.landmarks[i * 3 + 1]! - b.landmarks[i * 3 + 1]!) * h)
        landmarks.push((100 * sum) / 478 / size)
        let bs = 0
        for (let i = 1; i < 52; i++) bs += Math.abs(a.blendshapes[i]! - b.blendshapes[i]!)
        blendshapes.push(bs / 51)
        const ma = a.matrices
        const mb = b.matrices
        translations.push(Math.hypot(ma[12]! - mb[12]!, ma[13]! - mb[13]!, ma[14]! - mb[14]!))
        // Angle of the relative rotation, from the normalized columns.
        let trace = 0
        for (let c = 0; c < 3; c++) {
          const na = Math.hypot(ma[c * 4]!, ma[c * 4 + 1]!, ma[c * 4 + 2]!)
          const nb = Math.hypot(mb[c * 4]!, mb[c * 4 + 1]!, mb[c * 4 + 2]!)
          trace += (ma[c * 4]! * mb[c * 4]! + ma[c * 4 + 1]! * mb[c * 4 + 1]! + ma[c * 4 + 2]! * mb[c * 4 + 2]!) / (na * nb)
        }
        rotations.push((Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI)
      }
      source.dispose()
      ours.dispose()
      mediaPipe.dispose()
      out[clip] = {
        frames,
        agree,
        both: landmarks.length,
        landmarks: [quantile(landmarks, 0.5), quantile(landmarks, 0.9)],
        blendshapes: quantile(blendshapes, 0.5),
        rotationDeg: quantile(rotations, 0.5),
        translationCm: quantile(translations, 0.5),
      }
    }
    return { out, warnings }
  }, { readback: variant.readback, step: variant.step })
  for (const [clip, r] of Object.entries(results.out)) console.log(clip, JSON.stringify(r))
  expect(results.warnings).toEqual([])
  const t = variant.limits
  for (const [clip, r] of Object.entries(results.out)) {
    expect(r.both, clip).toBeGreaterThan(15)
    expect(r.agree / r.frames, clip).toBeGreaterThan(t.agree)
    // Landmark distance, % of the face size: median and 90th percentile.
    expect(r.landmarks[0], clip).toBeLessThan(t.median)
    expect(r.landmarks[1], clip).toBeLessThan(t.p90)
    expect(r.blendshapes, clip).toBeLessThan(t.blendshapes)
    expect(r.rotationDeg, clip).toBeLessThan(t.rotationDeg)
    expect(r.translationCm, clip).toBeLessThan(t.translationCm)
  }
})
}

/**
 * Several faces (#165, second PR): on `two-faces-stacked` (2) and `four-faces-grid` (4), every second frame, each of
 * our faces is matched with MediaPipe's nearest (landmark centroids) on the frame it describes, and compared with the
 * limits of the single face. Faces stay in their slots (a face's centroid is nearest its own previous one: no swap),
 * and the number of faces does not flicker more than MediaPipe's.
 */
for (const [clip, maxFaces] of [
  ['two-faces-stacked', 2],
  ['four-faces-grid', 4],
] as const) {
  test(`several faces match MediaPipe's, in stable slots: ${clip}`, async ({ page }) => {
    test.setTimeout(240_000)
    await page.goto('/engine.html')
    await page.waitForFunction(() => !!window.ouaf)
    const r = await page.evaluate(
      async ({ clip, maxFaces }) => {
        const core = window.ouaf!.core
        const warnings: string[] = []
        const env = { assetsBaseUrl: new URL('./', document.baseURI).href, warn: (m: string) => void warnings.push(m) }
        const config = { maxFaces, blendshapes: true, analysisScale: 1 }
        const quantile = (values: number[], p: number) => [...values].sort((x, y) => x - y)[Math.min(values.length - 1, Math.floor(p * values.length))] ?? Number.NaN
        const ours = await core.createLiteRtFaceTracker().create(config, env)
        const mediaPipe = await core.mediaPipeFaceTracker.create(config, { ...env, backend: 'CPU' })
        const a = core.createFaceFrame(maxFaces)
        const theirs = new Map<number, ReturnType<typeof core.createFaceFrame>>()
        const source = await core.OfflineVideoSource.open(`/test-media/${clip}.mp4`, { rate: Infinity })
        const N = 478
        const centroid = (f: ReturnType<typeof core.createFaceFrame>, i: number) => {
          let x = 0
          let y = 0
          for (let k = 0; k < N; k++) {
            x += f.landmarks[(i * N + k) * 3]! * f.width
            y += f.landmarks[(i * N + k) * 3 + 1]! * f.height
          }
          return [x / N, y / N] as const
        }
        const landmarks: number[] = []
        const blendshapes: number[] = []
        const rotations: number[] = []
        const translations: number[] = []
        let frames = 0
        let agree = 0
        let swaps = 0
        let ourChanges = 0
        let theirChanges = 0
        let ourPrevCount = -1
        let theirPrevCount = -1
        let prev: Array<readonly [number, number]> = []
        for (let k = 0; ; k++) {
          const frame = await source.read()
          if (!frame) break
          try {
            if (k % 2) continue
            const ts = frame.time * 1000 + 1
            const mp = core.createFaceFrame(maxFaces)
            await mediaPipe.track(frame.image, ts, frame.time, mp)
            theirs.set(frame.time, mp)
            await ours.track(frame.image, ts, frame.time, a)
          } finally {
            frame.close()
          }
          const b = theirs.get(a.mediaTime)
          if (!b) continue
          frames++
          if (a.count === b.count) agree++
          if (ourPrevCount >= 0 && a.count !== ourPrevCount) ourChanges++
          if (theirPrevCount >= 0 && b.count !== theirPrevCount) theirChanges++
          ourPrevCount = a.count
          theirPrevCount = b.count
          // Slots: each face nearest its own previous centroid.
          const now = Array.from({ length: a.count }, (_, i) => centroid(a, i))
          if (prev.length === now.length && now.length > 1) {
            for (let i = 0; i < now.length; i++) {
              const d = prev.map((p) => Math.hypot(p[0] - now[i]![0], p[1] - now[i]![1]))
              if (d.indexOf(Math.min(...d)) !== i) swaps++
            }
          }
          prev = now
          // Match each of our faces with MediaPipe's nearest one not taken.
          const taken = new Set<number>()
          const w = a.width
          const h = a.height
          for (let i = 0; i < a.count; i++) {
            const c = now[i]!
            let best = -1
            let bestD = Infinity
            for (let j = 0; j < b.count; j++) {
              if (taken.has(j)) continue
              const cj = centroid(b, j)
              const d = Math.hypot(cj[0] - c[0], cj[1] - c[1])
              if (d < bestD) {
                bestD = d
                best = j
              }
            }
            if (best < 0) continue
            taken.add(best)
            let x0 = Infinity
            let x1 = -Infinity
            let y0 = Infinity
            let y1 = -Infinity
            for (let k2 = 0; k2 < N; k2++) {
              const x = b.landmarks[(best * N + k2) * 3]! * w
              const y = b.landmarks[(best * N + k2) * 3 + 1]! * h
              x0 = Math.min(x0, x)
              x1 = Math.max(x1, x)
              y0 = Math.min(y0, y)
              y1 = Math.max(y1, y)
            }
            const size = Math.max(x1 - x0, y1 - y0)
            let sum = 0
            for (let k2 = 0; k2 < N; k2++) {
              const p = (i * N + k2) * 3
              const q = (best * N + k2) * 3
              sum += Math.hypot((a.landmarks[p]! - b.landmarks[q]!) * w, (a.landmarks[p + 1]! - b.landmarks[q + 1]!) * h)
            }
            landmarks.push((100 * sum) / N / size)
            let bs = 0
            for (let s = 1; s < 52; s++) bs += Math.abs(a.blendshapes[i * 52 + s]! - b.blendshapes[best * 52 + s]!)
            blendshapes.push(bs / 51)
            const ma = a.matrices.subarray(i * 16, i * 16 + 16)
            const mb = b.matrices.subarray(best * 16, best * 16 + 16)
            translations.push(Math.hypot(ma[12]! - mb[12]!, ma[13]! - mb[13]!, ma[14]! - mb[14]!))
            let trace = 0
            for (let c2 = 0; c2 < 3; c2++) {
              const na = Math.hypot(ma[c2 * 4]!, ma[c2 * 4 + 1]!, ma[c2 * 4 + 2]!)
              const nb = Math.hypot(mb[c2 * 4]!, mb[c2 * 4 + 1]!, mb[c2 * 4 + 2]!)
              trace += (ma[c2 * 4]! * mb[c2 * 4]! + ma[c2 * 4 + 1]! * mb[c2 * 4 + 1]! + ma[c2 * 4 + 2]! * mb[c2 * 4 + 2]!) / (na * nb)
            }
            rotations.push((Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI)
          }
        }
        source.dispose()
        ours.dispose()
        mediaPipe.dispose()
        return {
          warnings,
          frames,
          agree,
          swaps,
          ourChanges,
          theirChanges,
          faces: landmarks.length,
          landmarks: [quantile(landmarks, 0.5), quantile(landmarks, 0.9)],
          blendshapes: quantile(blendshapes, 0.5),
          rotationDeg: quantile(rotations, 0.5),
          translationCm: quantile(translations, 0.5),
        }
      },
      { clip, maxFaces },
    )
    console.log(clip, JSON.stringify(r))
    expect(r.warnings).toEqual([])
    expect(r.faces).toBeGreaterThan(20)
    expect(r.agree / r.frames).toBeGreaterThan(0.85)
    expect(r.swaps).toBe(0)
    expect(r.ourChanges).toBeLessThanOrEqual(r.theirChanges + 2)
    expect(r.landmarks[0]).toBeLessThan(LIMITS.median)
    expect(r.landmarks[1]).toBeLessThan(LIMITS.p90)
    expect(r.blendshapes).toBeLessThan(LIMITS.blendshapes)
    expect(r.rotationDeg).toBeLessThan(LIMITS.rotationDeg)
    expect(r.translationCm).toBeLessThan(LIMITS.translationCm)
  })
}
