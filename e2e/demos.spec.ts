import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

/**
 * Demo filters (#37): each one, rendered on its test clip (`filters/demos.json`), matches its reference image
 * (`e2e/demos.spec.ts-snapshots/<id>.jpeg`).
 *
 * Frame-exact rendering: the clip is decoded with `OfflineVideoSource` and every frame from `reference.from` to
 * `reference.time` is given to `engine.pushFrame` (file regime, spec §12.1): each frame waits for its own tracking
 * result, time is the media time and seeds are fixed, so the image does not depend on the machine's speed.
 *
 * Scripts: the engine waits for a script's answer to frame N before rendering frame N + 1 (spec §12.1). The run ends
 * by rendering the last frame again a few times, 1 ms apart, so that the script's answers to the last frames are
 * applied; the reference frames are chosen where the script's output is stable (no animation running).
 *
 * Comparison: Playwright's image comparison, with a per-pixel tolerance and a share of pixels allowed to differ
 * (`MAX_DIFF`), since tracking (GPU or CPU inference), video decoding and font rasterization differ slightly
 * between machines. To keep that tolerance meaningful, each test also checks that the demo changes much more of the
 * image than the tolerance allows (`changed` against the raw frame): a missing layer fails the comparison.
 *
 * `npx playwright test demos --update-snapshots=all` rewrites the references (plain `--update-snapshots` only those
 * outside the tolerance); `OUAF_DEMO_SHOTS=<dir>` also writes each rendered image there.
 */

interface Demo {
  id: string
  clip: string
  maxFaces: number
  /**
   * The frames rendered (media time in s, from `from` to `time`) and the part of the image compared: `crop`
   * [x, y, width, height] as fractions of the image (origin top left), the whole image without it.
   */
  reference: { from: number; time: number; crop?: [number, number, number, number] }
}

const { demos } = JSON.parse(readFileSync(new URL('../filters/demos.json', import.meta.url), 'utf8')) as { demos: Demo[] }

/** Scale of the compared images: the whole image is 270 × 480, 3/8 of the clips' size, enough to see every layer. */
const WIDTH = 270
const HEIGHT = 480
/** Share of the pixels allowed to differ from the reference (beyond the per-pixel `THRESHOLD`). */
const MAX_DIFF = 0.01
/** Per-pixel color tolerance of the comparison (0–1, Playwright's YIQ distance). */
const THRESHOLD = 0.2

interface Rendered {
  /** The compared image, JPEG (small files; its artefacts are far below the comparison's tolerance). */
  jpeg: string
  /** Share of pixels that differ clearly (more than 24/255 on a channel) from the raw frame. */
  changed: number
  errors: string[]
  warnings: string[]
}

for (const demo of demos) {
  test(`demo ${demo.id} matches its reference image`, async ({ page }) => {
    await page.goto(`/engine.html?maxFaces=${demo.maxFaces}`)
    await page.waitForFunction(() => !!window.ouaf)
    const result: Rendered = await page.evaluate(
      async ([demo, width, height]) => {
        const { engine, core } = window.ouaf!
        await engine.addFilter(`/filters/${demo.id}/`)
        const source = await core.OfflineVideoSource.open(`/test-media/${demo.clip}.mp4`)
        const eps = 1e-4
        let last: Awaited<ReturnType<typeof source.read>> = null
        for (;;) {
          const frame = await source.read()
          if (!frame) break
          if (frame.time < demo.reference.from - eps) {
            frame.close()
            continue
          }
          if (frame.time > demo.reference.time + eps) {
            frame.close()
            break
          }
          await engine.pushFrame(frame.image, frame.time)
          last?.close()
          last = frame
        }
        if (!last) throw new Error(`no frame of ${demo.clip} between ${demo.reference.from} and ${demo.reference.time} s`)
        // The same frame again, 1 ms later each time: the script's last answers are applied.
        for (let i = 1; i <= 5; i++) await engine.pushFrame(last.image, last.time + i / 1000)
        // The compared part, read in the same task as the render (the drawing buffer is not preserved).
        const [cx, cy, cw, ch] = demo.reference.crop ?? [0, 0, 1, 1]
        const w = Math.round(cw * width)
        const h = Math.round(ch * height)
        const read = (image: CanvasImageSource, iw: number, ih: number) => {
          const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!
          ctx.drawImage(image, cx * iw, cy * ih, cw * iw, ch * ih, 0, 0, w, h)
          return ctx
        }
        const out = read(engine.canvas, engine.canvas.width, engine.canvas.height)
        const rendered = out.getImageData(0, 0, w, h).data
        const size = last.image instanceof VideoFrame ? [last.image.displayWidth, last.image.displayHeight] : [last.image.width, last.image.height]
        const raw = read(last.image, size[0]!, size[1]!).getImageData(0, 0, w, h).data
        last.close()
        source.dispose()
        let changed = 0
        for (let i = 0; i < rendered.length; i += 4) {
          if (Math.max(Math.abs(rendered[i]! - raw[i]!), Math.abs(rendered[i + 1]! - raw[i + 1]!), Math.abs(rendered[i + 2]! - raw[i + 2]!)) > 24) changed++
        }
        const blob = await (out.canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality: 0.9 })
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        return {
          jpeg: btoa(binary),
          changed: changed / (w * h),
          errors: window.ouaf!.errors,
          warnings: window.ouaf!.warnings,
        }
      },
      [demo, WIDTH, HEIGHT] as const,
    )
    const jpeg = Buffer.from(result.jpeg, 'base64')
    if (process.env.OUAF_DEMO_SHOTS) {
      mkdirSync(process.env.OUAF_DEMO_SHOTS, { recursive: true })
      writeFileSync(`${process.env.OUAF_DEMO_SHOTS}/${demo.id}.jpeg`, jpeg)
    }
    console.log(`${demo.id}: ${(result.changed * 100).toFixed(1)} % of the pixels changed by the filter`)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    // The demo is visible: much more than the comparison's tolerance.
    expect(result.changed).toBeGreaterThan(3 * MAX_DIFF)
    expect(jpeg).toMatchSnapshot(`${demo.id}.jpeg`, { maxDiffPixelRatio: MAX_DIFF, threshold: THRESHOLD })
  })
}
