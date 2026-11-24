/**
 * The page of `ouaf preview`, bundled with `@ouaf/core` and run in headless Chromium (`preview.ts`). It renders a
 * filter stack on reference frames the way the browser tests do (`e2e/demos.spec.ts`): the file regime (spec §12.1),
 * every frame pushed with `engine.pushFrame`, each one waiting for its own tracking result, with media time and a
 * fixed seed, so that the image does not depend on the machine's speed.
 *
 * Scripts: with file sources the engine waits for a script's answer to frame N before rendering frame N + 1 (spec
 * §12.1). As in the browser tests, the run ends by rendering the last frame again a few times, 1 ms apart, so that the
 * script's answers to the last frames are applied.
 *
 * Browser code only: no Node API. Talks to Node through `window.ouafPreview` (`protocol.ts`).
 */
import { OfflineVideoSource, createDefaultFaceTracker, createEngine, type EngineStats, type FrameImage, type OuafPlugin } from '@ouaf/core'
import type { PreviewJob, PreviewPageOutcome, PreviewTiming } from './protocol.ts'

/** Media time step between the copies of a still image (s). */
const IMAGE_STEP = 1 / 30
/** Settling frames: the last frame again, 1 ms of media time apart. */
const SETTLE_FRAMES = 4
/** A pixel "changed" by the filter differs from the raw frame by more than this on a channel (0–255). */
const CHANGED = 24
/** Matching the engine's frame times: frames are kept from `from - EPS` to `time + EPS`. */
const EPS = 1e-4

/** The built-in face tracker, its LiteRT.js worker loaded from the bundle's own entry (`face-worker.js`, preview.ts). */
const facePlugin: OuafPlugin = {
  name: 'preview-face',
  version: '1.0.0',
  setup(api) {
    const createWorker = () => new Worker(new URL('./face-worker.js', document.baseURI), { type: 'module', name: 'ouaf-face-tracker' })
    api.registerTracker(createDefaultFaceTracker({ liteRt: { createWorker } }))
  },
}

function timing(values: number[]): PreviewTiming {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number) => {
    if (!sorted.length) return 0
    const pos = (sorted.length - 1) * p
    const lo = Math.floor(pos)
    return sorted[lo]! + ((sorted[Math.min(lo + 1, sorted.length - 1)]! - sorted[lo]!) * (pos - lo))
  }
  const round = (v: number) => Math.round(v * 100) / 100
  return {
    mean: round(sorted.reduce((s, v) => s + v, 0) / Math.max(1, sorted.length)),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? 0),
  }
}

function rendererName(): string | null {
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2')
  if (!gl) return null
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  return typeof name === 'string' ? name : null
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** A pushed frame: the image, its media time, and how to free it. */
interface Frame {
  image: FrameImage
  time: number
  close(): void
}

/** The frames of the job, in order, read lazily (a clip is decoded as it is rendered). */
async function* frames(job: PreviewJob): AsyncGenerator<Frame> {
  const f = job.frames
  if (f.kind === 'image') {
    const response = await fetch(f.url)
    if (!response.ok) throw new Error(`${f.url}: HTTP ${response.status}`)
    const bitmap = await createImageBitmap(await response.blob())
    // The same bitmap every time: only the last copy closes it.
    for (let i = 0; i < f.frames; i++) {
      yield { image: bitmap, time: i * IMAGE_STEP, close: i === f.frames - 1 ? () => bitmap.close() : () => {} }
    }
    return
  }
  const source = await OfflineVideoSource.open(f.url)
  try {
    for (;;) {
      const frame = await source.read()
      if (!frame) break
      if (frame.time < f.from - EPS) {
        frame.close()
        continue
      }
      if (frame.time > f.time + EPS) {
        frame.close()
        break
      }
      yield { image: frame.image, time: frame.time, close: () => frame.close() }
    }
  } finally {
    source.dispose()
  }
}

async function render(job: PreviewJob): Promise<PreviewPageOutcome> {
  const warnings: string[] = []
  const errors: string[] = []
  const canvas = document.getElementById('canvas') as HTMLCanvasElement
  const engine = createEngine({
    canvas,
    assetsBaseUrl: new URL('./', document.baseURI).href,
    maxFaces: job.maxFaces,
    plugins: [facePlugin],
    ...(job.seed === undefined ? {} : { seed: job.seed }),
  })
  let stats: EngineStats | undefined
  engine.on('stats', (s) => (stats = s))
  engine.on('warning', (w) => warnings.push(w.filter ? `${w.filter}: ${w.message}` : w.message))
  engine.on('error', (e) => errors.push(e.message))

  let last: Frame | undefined
  try {
    const loadStart = performance.now()
    for (const url of job.filters) {
      const handle = await engine.addFilter(url)
      for (const w of handle.warnings) warnings.push(`${handle.id}: ${w}`)
    }
    const loadMs = performance.now() - loadStart
    const top = engine.filters.at(-1)
    // Faces present: those that entered minus those that left (expression events of the top filter).
    let faces = 0
    top?.on('expression', (e) => {
      if (e.name === 'faceEnter') faces++
      else if (e.name === 'faceLeave') faces--
    })

    const frameMs: number[] = []
    let pushed = 0
    const push = async (image: FrameImage, time: number) => {
      const start = performance.now()
      await engine.pushFrame(image, time)
      frameMs.push(performance.now() - start)
      pushed++
    }
    for await (const frame of frames(job)) {
      await push(frame.image, frame.time)
      if (last && last.image !== frame.image) last.close()
      last = frame
    }
    if (!last) {
      const f = job.frames
      throw new Error(f.kind === 'video' ? `No frame of ${f.url} between ${f.from} and ${f.time} s.` : `No frame in ${f.url}.`)
    }
    for (let i = 1; i <= SETTLE_FRAMES + 1; i++) await push(last.image, last.time + i / 1000)

    // Read in the same task as the render: the drawing buffer is not preserved.
    const sw = engine.canvas.width
    const sh = engine.canvas.height
    const scale = job.maxSize ? Math.min(1, job.maxSize / Math.max(sw, sh)) : 1
    const w = Math.max(1, Math.round(sw * scale))
    const h = Math.max(1, Math.round(sh * scale))
    const read = (image: CanvasImageSource, iw: number, ih: number) => {
      const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(image, 0, 0, iw, ih, 0, 0, w, h)
      return ctx
    }
    const out = read(engine.canvas, sw, sh)
    const rendered = out.getImageData(0, 0, w, h).data
    const image = last.image
    const size = image instanceof VideoFrame ? [image.displayWidth, image.displayHeight] : [image.width, image.height]
    const raw = read(image, size[0]!, size[1]!).getImageData(0, 0, w, h).data
    const time = last.time
    last.close()
    last = undefined

    let changed = 0
    for (let i = 0; i < rendered.length; i += 4) {
      const d = (c: number) => Math.abs(rendered[i + c]! - raw[i + c]!)
      if (Math.max(d(0), d(1), d(2)) > CHANGED) changed++
    }
    const pixelsSha256 = hex(await crypto.subtle.digest('SHA-256', rendered))
    const png = new Uint8Array(await (await (out.canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' })).arrayBuffer())
    return {
      ok: true,
      png: base64(png),
      width: w,
      height: h,
      pixelsSha256,
      changed: Math.round((changed / (w * h)) * 10000) / 10000,
      faces,
      framesRendered: pushed,
      time,
      filters: engine.filters.map((f) => f.id),
      warnings,
      errors,
      perf: {
        loadMs: Math.round(loadMs),
        firstFrameMs: Math.round(frameMs[0] ?? 0),
        frameMs: timing(frameMs.slice(1)),
        engineFrameMs: stats ? Math.round(stats.frameMs * 100) / 100 : null,
        tracker: stats?.tracker ?? null,
        renderWidth: sw,
        renderHeight: sh,
        renderer: rendererName(),
      },
    }
  } catch (error) {
    last?.close()
    return { ok: false, error: error instanceof Error ? error.message : String(error), warnings, errors }
  } finally {
    engine.dispose()
  }
}

window.ouafPreview = { render }
