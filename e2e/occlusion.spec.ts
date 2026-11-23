import { expect, test, type Page } from '@playwright/test'

/**
 * Head occluder (#155) on `/engine.html`: `filters/fixtures/glasses/` puts glasses shaped like the `glasses` demo on
 * `pesquet-turn`, where the head is turned by 25–45° all along (the person's left side, +x of the unmirrored head
 * frame, towards the camera). Their parts have flat colors: a red front, a green temple on +x, a magenta one on -x.
 * On still frames of the clip (the video paused), the same frame is drawn with the occluded glasses, with glasses
 * that ignore the head, and with the face oval turned blue (a color layer, `region: "face"`), so that:
 * - no pixel of the far temple is over the face oval, though the temple without occlusion crosses it;
 * - the near temple is drawn along most of its length, up to the ear, as without occlusion.
 * Normal and mirrored (`&mirror=1`): mirroring swaps the sides of the face the temples are on (the anchor frame's +x
 * is the screen's right), so the near temple is the magenta one then.
 */

const FIXTURE = '/filters/fixtures/glasses/'
const SHOTS = process.env.SHOTS

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/engine.html?${query}`)
  await page.waitForFunction(() => ((window.ouaf?.stats?.faces ?? 0) > 0 && (window.ouaf?.stats?.trackingHz ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, { timeout: 60_000 })
  expect(await page.evaluate(() => [window.ouaf!.errors, window.ouaf!.warnings])).toEqual([[], []])
}

/** Draws the paused video at `time` again with the given params, and keeps the canvas pixels under `name`. */
async function shot(page: Page, name: string, params: Record<string, boolean>, time: number): Promise<void> {
  await page.evaluate((p) => {
    const filter = window.ouaf!.engine.filters[0]!
    for (const [k, v] of Object.entries(p)) filter.setParam(k, v)
  }, params)
  // Each seek presents the frame again, so the engine tracks and draws it once more, until three tracking results of
  // this still frame have come (`window.ouaf.results`: a result describing a frame presented after the first seek), so
  // that the smoothing settles on it. Seeking a fixed number of times depended on the tracker's latency: the default
  // one (LiteRT.js, #165) answers a live frame a call or two later (its queued frame, the async readback), so the first
  // results after a seek are of a frame shown before.
  const since = await page.evaluate(() => performance.now() / 1000)
  let fresh = 0
  for (let i = 0; i < 12 && fresh < 3; i++) {
    const count = await page.evaluate(() => window.ouaf!.results.count)
    await page.evaluate(
      (t) =>
        new Promise<void>((resolve) => {
          const video = document.getElementById('video') as HTMLVideoElement
          video.pause()
          video.addEventListener('seeked', () => resolve(), { once: true })
          setTimeout(resolve, 3000) // in case the seek never completes
          video.currentTime = t
        }),
      time + (i % 3) * 0.001, // the same frame of the clip, but a new seek each time
    )
    // This seek's result (of this frame or an earlier one), then its rendering.
    await page.waitForFunction((n) => window.ouaf!.results.count > n, count, { timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(150)
    if (await page.evaluate((s) => window.ouaf!.results.time >= s, since)) fresh++
  }
  const png = await page.locator('#canvas').screenshot(SHOTS ? { path: `${SHOTS}/occlusion-${time.toFixed(2)}-${name}.png` } : {})
  await page.evaluate(
    async ([bytes, key]) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))]))
      const c = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = c.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const w = window as unknown as { shots?: Record<string, ImageData> }
      w.shots ??= {}
      w.shots[key] = ctx.getImageData(0, 0, c.width, c.height)
    },
    [png.toString('base64'), name] as const,
  )
}

interface Temples {
  /** Pixels of the far temple over the face oval: occluded, and without occlusion. */
  farOverFace: number
  farOverFacePlain: number
  /** How far the near temple reaches from its hinge along the screen x (pixels): occluded, and without occlusion. */
  nearReach: number
  nearReachPlain: number
  /** Pixels of the face oval (blue). */
  face: number
}

/** Compares the shots `occluded`, `plain` and `face` of one still frame. */
function analyse(page: Page, nearIsGreen: boolean): Promise<Temples> {
  return page.evaluate((nearGreen) => {
    const { occluded, plain, face } = (window as unknown as { shots: Record<string, ImageData> }).shots
    const W = occluded!.width
    const H = occluded!.height
    const at = (img: ImageData, i: number) => [img.data[i * 4]!, img.data[i * 4 + 1]!, img.data[i * 4 + 2]!] as const
    const red = ([r, g, b]: readonly number[]) => r! > 180 && g! < 70 && b! < 70
    const green = ([r, g, b]: readonly number[]) => g! > 180 && r! < 90 && b! < 90
    const magenta = ([r, g, b]: readonly number[]) => r! > 180 && b! > 180 && g! < 90
    const blue = ([r, g, b]: readonly number[]) => b! > 180 && r! < 70 && g! < 70
    const near = nearGreen ? green : magenta
    const far = nearGreen ? magenta : green

    let farOverFace = 0
    let farOverFacePlain = 0
    let faceCount = 0
    // The front's centroid, to find the hinge of the near temple.
    let fx = 0
    let fy = 0
    let fn = 0
    for (let i = 0; i < W * H; i++) {
      const inFace = blue(at(face!, i))
      if (inFace) faceCount++
      if (inFace && far(at(occluded!, i))) farOverFace++
      if (inFace && far(at(plain!, i))) farOverFacePlain++
      if (red(at(plain!, i))) {
        fx += i % W
        fy += Math.floor(i / W)
        fn++
      }
    }
    fx /= fn
    fy /= fn
    // Hinge: the near temple's pixel (without occlusion) closest to the front's centroid; reach: the farthest one.
    const nearPixels = (img: ImageData) => {
      const out: Array<[number, number]> = []
      for (let i = 0; i < W * H; i++) if (near(at(img, i))) out.push([i % W, Math.floor(i / W)])
      return out
    }
    const plainNear = nearPixels(plain!)
    const occludedNear = nearPixels(occluded!)
    let hinge: [number, number] = [fx, fy]
    let best = Infinity
    for (const p of plainNear) {
      const d = Math.hypot(p[0] - fx, p[1] - fy)
      if (d < best) {
        best = d
        hinge = p
      }
    }
    // Along the screen x, within a band of rows around the hinge: the straight part of the temple, not the end that
    // bends down behind the ear.
    const band = 0.02 * H
    const reach = (pixels: Array<[number, number]>) => pixels.reduce((m, p) => (Math.abs(p[1] - hinge[1]) <= band ? Math.max(m, Math.abs(p[0] - hinge[0])) : m), 0)
    return { farOverFace, farOverFacePlain, nearReach: reach(occludedNear), nearReachPlain: reach(plainNear), face: faceCount }
  }, nearIsGreen)
}

for (const mirror of [false, true]) {
  test(`glasses on a turned head: the far temple is hidden over the face, the near one shows up to the ear${mirror ? ' (mirrored)' : ''}`, async ({ page }) => {
    await open(page, `source=pesquet-turn&autostart${mirror ? '&mirror=1' : ''}&filter=${FIXTURE}`)
    // Still frames where the head is turned (the tracker finds no face before 0.8 s), until five are usable: a face
    // found, and the far temple crossing the face without occlusion (else hiding it proves nothing).
    const samples: Temples[] = []
    // A first shot, not analysed: right after the clip stops playing, the smoothing still carries its motion.
    await shot(page, 'warm-up', { occluded: true, plain: false, face: false }, 0.85 + 1 / 60)
    for (let t = 0.85 + 1 / 60; t < 2.3 && samples.length < 5; t += 0.2) {
      await shot(page, 'occluded', { occluded: true, plain: false, face: false }, t)
      await shot(page, 'plain', { occluded: false, plain: true, face: false }, t)
      await shot(page, 'face', { occluded: false, plain: false, face: true }, t)
      const s = await analyse(page, !mirror)
      if (s.face > 2000 && s.farOverFacePlain > 50 && s.nearReachPlain > 20) samples.push(s)
      else console.log(`t=${t.toFixed(2)} not usable: ${JSON.stringify(s)}`)
    }
    expect(samples.length).toBeGreaterThanOrEqual(3)
    const details = JSON.stringify(samples)
    // The ellipsoid that came before (#21) showed 11 to 17 pixels of the far temple over the face on 3 of these frames.
    expect(samples.map((s) => s.farOverFace), details).toEqual(samples.map(() => 0))
    // The straight part of the near temple, compared with the same temple drawn without occlusion: 0.8 to 1 of it,
    // 0.92 on average, with the temples opening to ±1.2 face units and `DEPTH_TOLERANCE` 0.2 (#150); 0.69 at least
    // with 0.15, 0.6 with 0, where its end near the ear is cut. Before #150 (temples ±1.04, tolerance 0.35): 0.67 to
    // 0.91, 0.83 on average; with the ellipsoid (#21), 0.51 to 0.65, 0.6 on average.
    const ratios = samples.map((s) => s.nearReach / s.nearReachPlain)
    expect(Math.min(...ratios), details).toBeGreaterThan(0.75)
    expect(ratios.reduce((a, b) => a + b, 0) / ratios.length, details).toBeGreaterThan(0.85)
  })
}
