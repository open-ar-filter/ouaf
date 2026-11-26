import { expect, test, type Page } from './fixtures.ts'

/**
 * Shader layer (#24) on `/engine.html`, with the fixtures `filters/fixtures/shader-*`: uniforms bound to params,
 * textures, compile errors with the author's line numbers, the inputs (anchors, face size, face mask, previous
 * frame), the three stages, and GPU context loss. Also the acceptance test of the stage pipeline (#17): a face-stage
 * shader and a warp give the same image in both stack orders.
 */

const F = '/filters/fixtures'
const POLL = { timeout: 30_000, intervals: [250, 500, 1000] }

async function open(page: Page, query: string, face: boolean): Promise<void> {
  await page.goto(`/engine.html?${query}`)
  await page.waitForFunction(
    (face) => (face ? (window.ouaf?.stats?.faces ?? 0) > 0 : (window.ouaf?.frames ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0,
    face,
    { timeout: 60_000 },
  )
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
}

function check<T>(sample: T, test: (s: T) => boolean): boolean {
  const ok = test(sample)
  if (!ok) console.log('sample', JSON.stringify(sample))
  return ok
}

/** Mean color of each region of the canvas as displayed; regions are [x0, y0, x1, y1] in 0–1, y down. */
async function means(page: Page, regions: Array<[number, number, number, number]>): Promise<Array<{ r: number; g: number; b: number; chroma: number }>> {
  const png = await page.locator('#canvas').screenshot()
  return page.evaluate(
    async ([bytes, regions]) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))]))
      const c = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = c.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      return regions.map(([x0, y0, x1, y1]) => {
        let r = 0
        let g = 0
        let b = 0
        let chroma = 0
        let n = 0
        for (let y = Math.floor(y0 * c.height); y < Math.floor(y1 * c.height); y++) {
          for (let x = Math.floor(x0 * c.width); x < Math.floor(x1 * c.width); x++) {
            const i = (y * c.width + x) * 4
            r += d[i]!
            g += d[i + 1]!
            b += d[i + 2]!
            chroma += Math.max(d[i]!, d[i + 1]!, d[i + 2]!) - Math.min(d[i]!, d[i + 1]!, d[i + 2]!)
            n++
          }
        }
        return { r: r / n, g: g / n, b: b / n, chroma: chroma / n }
      })
    },
    [png.toString('base64'), regions] as const,
  )
}

const ALL: [number, number, number, number] = [0, 0, 1, 1]

test('a post shader mixes a color uniform bound to params, and samples its texture upright', async ({ page }) => {
  await open(page, `source=pesquet-talk&autostart&filter=${F}/shader-post/`, false)
  // amount 1: the whole image is the tint.
  await expect.poll(async () => check((await means(page, [ALL]))[0]!, (s) => s.r > 240 && s.g < 15 && s.b > 240), POLL).toBe(true)
  await page.evaluate(() => window.ouaf!.engine.filters[0]!.setParam('tint', '#00ff00', { transition: 0 }))
  await expect.poll(async () => check((await means(page, [ALL]))[0]!, (s) => s.g > 240 && s.r < 15 && s.b < 15), POLL).toBe(true)
  // amount 0: the video; with the texture, its red half above its blue half in the bottom-left quarter.
  await page.evaluate(() => window.ouaf!.engine.filters[0]!.setParams({ amount: 0, showTexture: true }, { transition: 0 }))
  await expect
    .poll(async () => {
      const [top, bottom, right] = await means(page, [[0.05, 0.52, 0.45, 0.73], [0.05, 0.77, 0.45, 0.98], [0.55, 0.05, 0.95, 0.95]])
      return check({ top, bottom, right }, (s) => s.top!.r > 240 && s.top!.b < 15 && s.bottom!.b > 240 && s.bottom!.r < 15 && s.right!.chroma > 5)
    }, POLL)
    .toBe(true)
  expect(await page.evaluate(() => window.ouaf!.warnings)).toEqual([])
})

test('a shader that does not compile rejects its filter with the line in the author file', async ({ page }) => {
  await open(page, 'source=pesquet-talk&autostart', false)
  const error = await page.evaluate(async (url) => {
    try {
      await window.ouaf!.engine.addFilter(url)
      return null
    } catch (e) {
      const err = e as { name: string; code: string; message: string; details: Array<{ line?: number; message: string }> }
      return { name: err.name, code: err.code, message: err.message, details: err.details }
    }
  }, `${F}/shader-error/`)
  expect(error).toMatchObject({ name: 'ShaderCompileError', code: 'shader' })
  expect(error!.details[0]).toMatchObject({ line: 4 })
  expect(error!.details[0]!.message).toContain('notDeclared')
  expect(error!.message).toContain('line 4')
  expect(await page.evaluate(() => window.ouaf!.engine.filters.length)).toBe(0)
})

test('a shader that is not closed is reported on the last line of the author file', async ({ page }) => {
  await open(page, 'source=pesquet-talk&autostart', false)
  const details = await page.evaluate(async (url) => {
    try {
      await window.ouaf!.engine.addFilter(url)
      return null
    } catch (e) {
      return (e as { details: Array<{ line?: number; message: string }> }).details
    }
  }, `${F}/shader-error-eof/`)
  expect(details).toEqual([{ severity: 'error', line: 5, message: expect.stringContaining('a "}"') }])
})

/** Centroid and area (px) of pure red and pure green pixels in the top and bottom halves (stacked faces). */
async function discs(page: Page): Promise<Array<{ red: { x: number; y: number; n: number }; green: { x: number; y: number; n: number } }>> {
  const png = await page.locator('#canvas').screenshot()
  return page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))]))
    const c = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    const out = []
    for (const [y0, y1] of [[0, c.height / 2], [c.height / 2, c.height]] as const) {
      const red = { x: 0, y: 0, n: 0 }
      const green = { x: 0, y: 0, n: 0 }
      for (let y = Math.floor(y0); y < y1; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4
          const [r, g, b] = [d[i]!, d[i + 1]!, d[i + 2]!]
          const t = r > 220 && g < 40 && b < 40 ? red : g > 220 && r < 40 && b < 40 ? green : undefined
          if (!t) continue
          t.x += x
          t.y += y
          t.n++
        }
      }
      for (const t of [red, green]) if (t.n) Object.assign(t, { x: t.x / t.n, y: t.y / t.n })
      out.push({ red, green })
    }
    return out
  }, png.toString('base64'))
}

for (const mirror of [false, true]) {
  test(`ouaf_anchor_<name> and ouaf_faceSize place a disc on the anchor of each face${mirror ? ' (mirrored)' : ''}`, async ({ page }) => {
    await open(page, `source=two-faces-stacked&autostart&maxFaces=2${mirror ? '&mirror=1' : ''}&filter=${F}/shader-anchors/`, true)
    // The shader's red disc (0.3 units across) sits inside the dot (0.6 units, drawn under it by the objects stage).
    await expect
      .poll(async () => {
        const faces = await discs(page)
        return check(faces, (fs) =>
          fs.every((f) => {
            const total = f.red.n + f.green.n
            const diameter = 2 * Math.sqrt(total / Math.PI)
            return f.red.n > 30 && f.green.n > 30 && Math.hypot(f.red.x - f.green.x, f.red.y - f.green.y) < 0.15 * diameter && f.red.n / total > 0.12 && f.red.n / total < 0.45
          }),
        )
      }, { timeout: 60_000, intervals: [500] })
      .toBe(true)
  })
}

test('ouaf_prevFrame is the shader output of the previous frame', async ({ page }) => {
  await open(page, `source=pesquet-talk&autostart&filter=${F}/shader-feedback/`, false)
  // +1/16 per frame from black: white after 16 frames, whatever the video.
  await expect.poll(async () => check((await means(page, [ALL]))[0]!, (s) => s.r > 250 && s.g > 250 && s.b > 250), POLL).toBe(true)
})

test('ouaf_faceMask covers the face and nothing else', async ({ page }) => {
  await open(page, `source=pesquet-closeup&autostart&filter=${F}/shader-mask/`, true)
  await expect
    .poll(async () => {
      // (The top-left corner is under the page's log text.)
      const [all, corner] = await means(page, [ALL, [0.85, 0.9, 1, 1]])
      // Blue = the mask: a face's worth of the image, a black corner, nothing in red or green.
      return check({ all, corner }, (s) => s.all!.b > 3 && s.all!.b < 160 && s.corner!.b < 1 && s.all!.r < 2 && s.all!.g < 2)
    }, POLL)
    .toBe(true)
})

test('a second background filter is ignored with a warning; the video covers the background', async ({ page }) => {
  await open(page, `source=pesquet-talk&autostart&filter=${F}/shader-background/&filter=${F}/shader-background/`, false)
  await expect.poll(() => page.evaluate(() => window.ouaf!.warnings.some((w) => w.includes('Several filters draw a background'))), POLL).toBe(true)
  const [s] = await means(page, [ALL])
  expect(s!.chroma).toBeGreaterThan(5)
  expect(s!.r).toBeLessThan(200)
})

// --- Stage order (#17): a face-stage shader and a warp, in both stack orders ----------------------------------------

/** Redraws the paused video at `time` (each seek presents the frame again) and keeps the canvas pixels as `name`. */
async function shot(page: Page, name: string, time: number): Promise<void> {
  // A frame drawn while a seek completes can miss the video (#116): seek and shoot again then.
  for (let attempt = 0; attempt < 5; attempt++) {
    for (let i = 0; i < 3; i++) {
      await page.evaluate(
        (t) =>
          new Promise<void>((resolve) => {
            const video = document.getElementById('video') as HTMLVideoElement
            video.pause()
            video.addEventListener('seeked', () => resolve(), { once: true })
            setTimeout(resolve, 3000)
            video.currentTime = t
          }),
        time + i * 0.001,
      )
      await page.waitForTimeout(300)
    }
    const png = await page.locator('#canvas').screenshot()
    const black = await page.evaluate(
      async ([bytes, key]) => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))]))
        const c = new OffscreenCanvas(bitmap.width, bitmap.height)
        const ctx = c.getContext('2d')!
        ctx.drawImage(bitmap, 0, 0)
        const w = window as unknown as { shots?: Record<string, ImageData> }
        w.shots ??= {}
        const image = ctx.getImageData(0, 0, c.width, c.height)
        w.shots[key] = image
        // Share of pure black pixels: the whole image but the face (whose stripes are pure black and white) for a
        // frame without the video; a dim video frame has no large pure black area.
        let black = 0
        for (let i = 0; i < image.data.length; i += 4) if (image.data[i]! + image.data[i + 1]! + image.data[i + 2]! === 0) black++
        return black / (image.data.length / 4)
      },
      [png.toString('base64'), name] as const,
    )
    if (black < 0.5) return
    console.log(`shot ${name}: black frame, again`)
  }
  throw new Error(`shot ${name}: black frame after 5 attempts`)
}

/** Mean absolute difference per channel between two shots. */
function diff(page: Page, a: string, b: string): Promise<number> {
  return page.evaluate(
    ([a, b]) => {
      const shots = (window as unknown as { shots: Record<string, ImageData> }).shots
      const x = shots[a]!.data
      const y = shots[b]!.data
      let sum = 0
      for (let i = 0; i < x.length; i += 4) sum += Math.abs(x[i]! - y[i]!) + Math.abs(x[i + 1]! - y[i + 1]!) + Math.abs(x[i + 2]! - y[i + 2]!)
      return sum / ((x.length / 4) * 3)
    },
    [a, b] as const,
  )
}

test('stage order (#17): a face-stage shader and a warp give the same image in both stack orders', async ({ page }) => {
  await open(page, `source=pesquet-closeup&autostart&filter=${F}/shader-face/&filter=${F}/warp-nose/`, true)
  const setOrder = (ids: string[]) =>
    page.evaluate((ids) => {
      const engine = window.ouaf!.engine
      ids.forEach((id, i) => engine.filters.find((f) => f.id === id)!.moveTo(i))
      return engine.filters.map((f) => f.id)
    }, ids)
  const set = (id: string, param: string, value: number) =>
    page.evaluate(([id, param, value]) => window.ouaf!.engine.filters.find((f) => f.id === id)!.setParam(param, value, { transition: 0 }), [id, param, value] as const)
  let time = 1 + 1 / 60
  await expect
    .poll(
      async () => {
        await set('shader-face', 'strength', 1)
        await set('warp-nose', 'strength', 0.8)
        expect(await setOrder(['shader-face', 'warp-nose'])).toEqual(['shader-face', 'warp-nose'])
        await shot(page, 'faceThenWarp', time)
        expect(await setOrder(['warp-nose', 'shader-face'])).toEqual(['warp-nose', 'shader-face'])
        await shot(page, 'warpThenFace', time)
        expect(await setOrder(['shader-face', 'warp-nose'])).toEqual(['shader-face', 'warp-nose'])
        await shot(page, 'faceThenWarp2', time)
        // References: the warp deforms the stripes (warp off), and the stripes are drawn (shader off).
        await set('warp-nose', 'strength', 0)
        await shot(page, 'noWarp', time)
        await set('shader-face', 'strength', 0)
        await shot(page, 'nothing', time)
        time = (time + 0.4) % 3
        const s = {
          orders: await diff(page, 'faceThenWarp', 'warpThenFace'),
          noise: await diff(page, 'faceThenWarp', 'faceThenWarp2'),
          warp: await diff(page, 'faceThenWarp', 'noWarp'),
          stripes: await diff(page, 'noWarp', 'nothing'),
        }
        // Whole-image means: the face is a small part of the close-up.
        return check(s, (s) => s.stripes > 2 && s.warp > 0.5 && s.warp > 4 * s.noise && s.orders <= 2 * s.noise + 0.1)
      },
      { timeout: 90_000, intervals: [500] },
    )
    .toBe(true)
})

// --- GPU context loss -------------------------------------------------------------------------------------------

async function loseContext(page: Page, restoreAfterMs: number): Promise<void> {
  await page.evaluate((ms) => {
    const gl = (window.ouaf!.engine.canvas as HTMLCanvasElement).getContext('webgl2')!
    const ext = gl.getExtension('WEBGL_lose_context')!
    ext.loseContext()
    setTimeout(() => ext.restoreContext(), ms)
  }, restoreAfterMs)
}

test('a context loss while a shader draws disables its filter; rendering resumes after the restore, and the filter draws again once re-enabled', async ({ page }) => {
  await open(page, `source=pesquet-talk&autostart&filter=${F}/shader-post/`, false)
  await expect.poll(async () => check((await means(page, [ALL]))[0]!, (s) => s.r > 240 && s.g < 15), POLL).toBe(true)
  await loseContext(page, 500)
  await expect.poll(() => page.evaluate(() => window.ouaf!.errors), POLL).toEqual([expect.stringContaining('"shader-post" was disabled')])
  expect(await page.evaluate(() => window.ouaf!.engine.filters[0]!.enabled)).toBe(false)
  await expect.poll(() => page.evaluate(() => window.ouaf!.engine.contextLost), POLL).toBe(false)
  // The video again, without the tint.
  await expect.poll(async () => check((await means(page, [ALL]))[0]!, (s) => s.chroma > 5 && s.g > 15), POLL).toBe(true)
  // Re-enabled by the host: three.js rebuilt the program and the texture, the tint is back.
  await page.evaluate(() => (window.ouaf!.engine.filters[0]!.enabled = true))
  await expect.poll(async () => check((await means(page, [ALL]))[0]!, (s) => s.r > 240 && s.g < 15), POLL).toBe(true)
})

test('a context loss without author shaders disables nothing; layers render again after the restore', async ({ page }) => {
  await open(page, `source=pesquet-talk&autostart&filter=${F}/color-noir/`, false)
  await expect.poll(async () => check((await means(page, [ALL]))[0]!, (s) => s.chroma < 2 && s.r > 10), POLL).toBe(true)
  await loseContext(page, 500)
  await expect.poll(() => page.evaluate(() => window.ouaf!.warnings.some((w) => w.includes('GPU context was lost'))), POLL).toBe(true)
  await expect.poll(() => page.evaluate(() => window.ouaf!.engine.contextLost), POLL).toBe(false)
  expect(await page.evaluate(() => [window.ouaf!.errors, window.ouaf!.engine.filters[0]!.enabled])).toEqual([[], true])
  // The LUT and the render targets are rebuilt: black and white video again.
  await expect.poll(async () => check((await means(page, [ALL]))[0]!, (s) => s.chroma < 2 && s.r > 10), POLL).toBe(true)
})

// --- File regime (#32): pushFrame ---------------------------------------------------------------------------------

test('in the file regime, ouaf_time and ouaf_dt follow the media time, and ouaf_prevFrame each pushed frame', async ({ page }) => {
  await page.goto('/engine.html')
  await page.waitForFunction(() => !!window.ouaf)
  const run = (filter: string, times: number[]) =>
    page.evaluate(
      async ([filter, times]) => {
        const { engine } = window.ouaf!
        for (const f of engine.filters) f.remove()
        await engine.addFilter(filter)
        // A synthetic frame: flat green 200.
        const canvas = new OffscreenCanvas(64, 64)
        const c = canvas.getContext('2d')!
        c.fillStyle = 'rgb(0, 200, 0)'
        c.fillRect(0, 0, 64, 64)
        const out = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!
        const pixels: number[][] = []
        for (const t of times) {
          await engine.pushFrame(canvas, t)
          // Drawn when the promise resolves: read the canvas in the same task.
          out.drawImage(engine.canvas, 0, 0, 1, 1)
          pixels.push([...out.getImageData(0, 0, 1, 1).data.slice(0, 3)])
        }
        return pixels
      },
      [filter, times] as const,
    )
  const time = await run(`${F}/shader-time/`, [0.25, 0.75, 0.875])
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 2)
  expect(time.map((p, i) => near(p, [[64, 0, 200], [191, 128, 200], [223, 32, 200]][i]!)), JSON.stringify(time)).toEqual([true, true, true])
  // +1/16 per frame from black: one step per pushed frame, whatever the wall clock.
  const feedback = await run(`${F}/shader-feedback/`, [0, 1 / 30, 2 / 30])
  expect(feedback.map((p) => Math.round(p[0]! / 16))).toEqual([1, 2, 3])
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})
