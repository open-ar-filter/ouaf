/**
 * Our own face pipeline on LiteRT.js (docs/decisions/face-runtime.md): MediaPipe's three TFLite models (from
 * `face_landmarker.task`) run without MediaPipe, with the geometry of `geometry.ts`. Runs in the tracking worker
 * (`face.worker.ts`); no DOM access.
 *
 * Per frame: one ROI per tracked face, predicted from its previous landmarks, and the detector (letterboxed 128×128
 * input) while fewer faces than asked are tracked, its new faces added to those (MediaPipe's face landmarker does the
 * same: detections overlapping a tracked face are dropped, `geometry.ts` `dedupeRois`); per face, a rotated crop to
 * 256×256, the landmark model (478 points and a face presence score), and the blendshapes model on 146 of the points
 * when asked.
 *
 * Crops on WebGL2 (`gpu-crop.ts`: only the crop is read back) or on a 2D canvas (the whole frame goes through the
 * CPU: slow on phones, the fallback where a worker has no WebGL2, see docs/decisions/webkit-compat.md).
 *
 * Single-threaded wasm build of LiteRT.js: no cross-origin isolation needed, and faster than 4 threads in a worker on
 * both phones measured (face-runtime.md).
 */
import { loadAndCompile, loadLiteRt, Tensor, type CompiledModel } from '@litertjs/core'
import { BLENDSHAPES_STRIDE, LANDMARK_COUNT, LANDMARKS_STRIDE } from '../face.ts'
import {
  BLENDSHAPE_LANDMARKS,
  DETECTOR_SIZE,
  LANDMARKS_SIZE,
  ROI_SAME,
  decodeDetections,
  dedupeRois,
  detectionToRoi,
  landmarksToRoi,
  letterbox,
  projectLandmarks,
  roiOverlap,
  type Detection,
  type Roi,
} from './geometry.ts'
import { createGpuCropper, type GpuCropper } from './gpu-crop.ts'

/** What a run accepts: a frame transferred to the worker. */
export type FrameSource = VideoFrame | ImageBitmap

/** Below this presence score the face is lost, and the detector runs again on the next frame. */
export const MIN_PRESENCE = 0.5

/** Faces a run tracks at most (the engine's `maxFaces` limit). */
export const MAX_FACES = 16

/** Model files, under `<assetsBaseUrl>models/` (extracted from `face_landmarker.task` by `npm run fetch-models`). */
export const LITERT_MODELS = ['face_detector', 'face_landmarks_detector', 'face_blendshapes'] as const

export type Crop = 'gpu' | 'canvas'

export interface PipelineOptions {
  /** Absolute URL the assets resolve against: `litert/wasm/` and `models/`. */
  assetsBaseUrl: string
  /** `gpu`: WebGL2 crops (falls back to `canvas` when unavailable). */
  crop: Crop
  /** The LiteRT.js script to load (default: the single-threaded build chosen by LiteRT.js under `litert/wasm/`). */
  liteRtUrl?: string
  /**
   * GPU crops only. `async` (the tracker's default): the crops of frame N are read back into pixel buffers while the
   * landmark model runs on frame N − 1, so that the worker does not stall on the GPU (Redmi Note 11S's Mali-G57: the
   * readback 15–16 → 5–6 ms, 17.5 → 20 Hz). Costs: results one frame late, and frame N's ROIs come from frame N − 2's
   * landmarks (extrapolated from N − 3). `sync` (default here): each frame's crops are read back (`readPixels`) before
   * their landmark model runs.
   */
  readback?: Readback
}

export type Readback = 'sync' | 'async'

/** Per-stage timings of the last run (ms; NaN when the stage did not run), summed over its faces. */
export interface StageTimings {
  /** Detector stage: letterbox, model, decoding. */
  detectMs: number
  /** Frame upload to the GPU crops' texture (`texImage2D`; part of `detectMs` or `cropMs`). */
  uploadMs: number
  /** Landmark crops: drawing and reading them back (`readPixels`, or waiting for the pixel buffers), then `convertMs`. */
  cropMs: number
  readMs: number
  /** RGBA bytes → the model's float input. */
  convertMs: number
  landmarksMs: number
  blendshapesMs: number
}

export interface PipelineResult {
  /** Faces found: the first `count` slices of `landmarks` and `blendshapes` are valid. */
  count: number
  /**
   * `LANDMARKS_STRIDE` floats per face, `x, y, z` per landmark as in `FaceFrame.landmarks`: x and y normalized to the
   * frame, z in the scale of x (MediaPipe's convention).
   */
  landmarks: Float32Array
  /** `BLENDSHAPES_STRIDE` floats per face, scores in `BLENDSHAPE_NAMES` order; left at 0 when not computed. */
  blendshapes: Float32Array
  /** Blendshapes were computed for this result. */
  hasBlendshapes: boolean
  /** The frame this result describes (`run`'s `frame`): an earlier one with `readback: 'async'`. */
  frame: number
}

export interface RunOptions {
  /** Run the blendshapes model on each face. */
  blendshapes: boolean
  /** Faces to track at most (1 to `MAX_FACES`). */
  maxFaces: number
  /** The frame's id, reported in `PipelineResult.frame`. */
  frame?: number
  /** The result must be this frame's (file source): no readback in flight across frames. */
  exact?: boolean
}

export interface Pipeline {
  readonly crop: Crop
  readonly timings: StageTimings
  readonly readback: Readback
  /** Tracks a frame of `width`×`height`; `out.frame` says which frame the result describes. */
  run(source: FrameSource, width: number, height: number, options: RunOptions, out: PipelineResult): Promise<void>
  /** Forgets the tracked faces: the next run starts with the detector. */
  reset(): void
  dispose(): void
}

export function createPipelineResult(maxFaces = MAX_FACES): PipelineResult {
  return {
    count: 0,
    landmarks: new Float32Array(maxFaces * LANDMARKS_STRIDE),
    blendshapes: new Float32Array(maxFaces * BLENDSHAPES_STRIDE),
    hasBlendshapes: false,
    frame: 0,
  }
}

/**
 * The landmark model declares a dynamic batch (`shape_signature` [-1, 256, 256, 3]) and LiteRT.js only accepts input
 * tensors of exactly the declared shape, which a `-1` never matches. Rewrites that signature to a batch of 1 in the
 * model bytes (the int32 vector `[4, -1, 256, 256, 3]` of the flatbuffer); other models are returned unchanged.
 */
export function fixDynamicBatch(model: Uint8Array, dims: readonly number[]): Uint8Array {
  const pattern = new Uint8Array(Int32Array.from([dims.length + 1, -1, ...dims]).buffer)
  outer: for (let i = 0; i + pattern.length <= model.length; i += 4) {
    for (let j = 0; j < pattern.length; j++) if (model[i + j] !== pattern[j]) continue outer
    const fixed = model.slice()
    new DataView(fixed.buffer).setInt32(i + 4, 1, true)
    return fixed
  }
  return model
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  let res: Response
  try {
    res = await fetch(url)
  } catch (err) {
    throw new Error(`Could not download ${url}.`, { cause: err })
  }
  // Dev servers with an SPA fallback answer missing files with the index page.
  if (!res.ok || res.headers.get('content-type')?.includes('text/html')) throw new Error(`Could not download ${url}: HTTP ${res.status}.`)
  return new Uint8Array(await res.arrayBuffer())
}

/** Runs a model and copies its float outputs into `outputs` (CPU tensors: wasm accelerator). */
async function runModel(model: CompiledModel, input: Float32Array, shape: number[], outputs: Float32Array[]): Promise<void> {
  const tensor = new Tensor(input, shape)
  let results: Tensor[]
  try {
    results = await model.run([tensor])
  } finally {
    tensor.delete()
  }
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    const data = r.toTypedArray() as Float32Array
    const out = outputs[i]
    if (out) out.set(data.length > out.length ? data.subarray(0, out.length) : data)
    r.delete()
  }
}

let liteRt: Promise<unknown> | undefined

/** Loads the single-threaded LiteRT.js wasm once. */
function ensureLiteRt(options: PipelineOptions): Promise<unknown> {
  liteRt ??= loadLiteRt(options.liteRtUrl ?? new URL('litert/wasm/', options.assetsBaseUrl).href, { threads: false, jspi: false })
  return liteRt
}

/** Loads the runtime and the three models. `warn` receives the fallbacks taken. */
export async function createPipeline(options: PipelineOptions, warn: (message: string) => void): Promise<Pipeline> {
  await ensureLiteRt(options)
  const compile = async (name: (typeof LITERT_MODELS)[number]) => {
    const bytes = await fetchBytes(new URL(`models/${name}.tflite`, options.assetsBaseUrl).href)
    try {
      return await loadAndCompile(fixDynamicBatch(bytes, [LANDMARKS_SIZE, LANDMARKS_SIZE, 3]), { accelerator: 'wasm' })
    } catch (err) {
      throw new Error(`Could not compile the face model ${name}.tflite.`, { cause: err })
    }
  }
  // One after the other: the wasm runtime is single-threaded anyway.
  const detector = await compile('face_detector')
  const landmarker = await compile('face_landmarks_detector')
  const blendshaper = await compile('face_blendshapes')

  let gpu: GpuCropper | undefined
  if (options.crop === 'gpu') {
    try {
      gpu = createGpuCropper(LANDMARKS_SIZE)
    } catch (err) {
      warn(`Face crops on a 2D canvas (slower): ${err instanceof Error ? err.message : String(err)}.`)
    }
  }
  // 2D canvases, created on first use (only without WebGL2, or after a WebGL context loss).
  let detectorCtx: OffscreenCanvasRenderingContext2D | undefined
  let cropCtx: OffscreenCanvasRenderingContext2D | undefined
  const context2d = (size: number) => {
    const ctx = new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Neither WebGL2 nor a 2D context on an OffscreenCanvas: the face tracker cannot crop frames here.')
    return ctx
  }

  const gpuCrop = new Uint8Array(LANDMARKS_SIZE * LANDMARKS_SIZE * 4)
  /** Async readback: the crops read back from the pixel buffers, one per face (created on first use). */
  const asyncCrops: Uint8Array[] = []
  const gpuDetectorCrop = new Uint8Array(DETECTOR_SIZE * DETECTOR_SIZE * 4)
  const detectorInput = new Float32Array(DETECTOR_SIZE * DETECTOR_SIZE * 3)
  const landmarksInput = new Float32Array(LANDMARKS_SIZE * LANDMARKS_SIZE * 3)
  const blendshapesInput = new Float32Array(BLENDSHAPE_LANDMARKS.length * 2)
  const regressors = new Float32Array(896 * 16)
  const scores = new Float32Array(896)
  const raw = new Float32Array(LANDMARK_COUNT * 3)
  const presence = new Float32Array(1)
  const pixels = new Float32Array(LANDMARK_COUNT * 3)
  const timings: StageTimings = { detectMs: NaN, uploadMs: NaN, cropMs: NaN, readMs: NaN, convertMs: NaN, landmarksMs: NaN, blendshapesMs: NaN }
  /** Adds to a stage's time of this run (summed over the faces). */
  const time = (stage: keyof StageTimings, ms: number) => {
    timings[stage] = (Number.isNaN(timings[stage]) ? 0 : timings[stage]) + ms
  }
  /** The tracked faces, oldest first. */
  let tracks: Track[] = []
  let uploaded = false
  const asyncReadback = options.readback === 'async'
  /** Async readback: the crops read back for the next run (one pixel buffer per entry), and the frame they are of. */
  let pending: { entries: Pending[]; width: number; height: number; frame: number } | undefined
  /** The last result, repeated while the pipe fills (async readback). */
  const last = createPipelineResult()

  /** RGBA bytes → RGB floats in [lo, hi]. */
  const toFloats = (rgba: Uint8Array | Uint8ClampedArray, out: Float32Array, lo: number, hi: number) => {
    const k = (hi - lo) / 255
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      out[j] = rgba[i]! * k + lo
      out[j + 1] = rgba[i + 1]! * k + lo
      out[j + 2] = rgba[i + 2]! * k + lo
    }
  }

  /** The GPU cropper, if usable: after a context loss, crops go to the 2D canvas for good. */
  const gpuCropper = (): GpuCropper | undefined => {
    if (gpu?.lost) {
      warn('The face tracker lost its WebGL context: face crops on a 2D canvas from now on (slower).')
      gpu.dispose()
      gpu = undefined
    }
    return gpu
  }

  const upload = (g: GpuCropper, source: FrameSource, width: number, height: number) => {
    if (uploaded) return
    const t = performance.now()
    g.upload(source, width, height)
    timings.uploadMs = performance.now() - t
    uploaded = true
  }

  /** The detector's faces in this frame, best first. */
  async function detect(source: FrameSource, width: number, height: number): Promise<Detection[]> {
    const t = performance.now()
    const box = letterbox(width, height)
    const g = gpuCropper()
    if (g) {
      upload(g, source, width, height)
      g.crop({ cx: width / 2, cy: height / 2, size: Math.max(width, height), rotation: 0 }, DETECTOR_SIZE, gpuDetectorCrop)
      toFloats(gpuDetectorCrop, detectorInput, -1, 1)
    } else {
      const ctx = (detectorCtx ??= context2d(DETECTOR_SIZE))
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, DETECTOR_SIZE, DETECTOR_SIZE)
      ctx.drawImage(source, box.offsetX, box.offsetY, width * box.scale, height * box.scale)
      toFloats(ctx.getImageData(0, 0, DETECTOR_SIZE, DETECTOR_SIZE).data, detectorInput, -1, 1)
    }
    await runModel(detector, detectorInput, [1, DETECTOR_SIZE, DETECTOR_SIZE, 3], [regressors, scores])
    const found = decodeDetections(regressors, scores, box)
    timings.detectMs = performance.now() - t
    return found
  }

  /**
   * Adds the faces the detector finds in this frame to `tracks` while there are fewer than `max`, skipping those that
   * overlap a face already there (`rois`: its ROIs for this frame). Returns the new tracks.
   */
  async function addDetected(source: FrameSource, width: number, height: number, max: number, rois: Roi[]): Promise<Track[]> {
    const added: Track[] = []
    for (const d of await detect(source, width, height)) {
      if (tracks.length >= max) break
      const roi = detectionToRoi(d)
      if (rois.some((r) => roiOverlap(r, roi) > ROI_SAME)) continue
      const track: Track = { roi, before: undefined, detected: true }
      tracks.push(track)
      rois.push(roi)
      added.push(track)
    }
    return added
  }

  function crop(source: FrameSource, width: number, height: number, roi: Roi): void {
    const g = gpuCropper()
    if (g) {
      upload(g, source, width, height)
      let t = performance.now()
      g.crop(roi, LANDMARKS_SIZE, gpuCrop)
      time('readMs', performance.now() - t)
      t = performance.now()
      toFloats(gpuCrop, landmarksInput, 0, 1)
      time('convertMs', performance.now() - t)
      return
    }
    const ctx = (cropCtx ??= context2d(LANDMARKS_SIZE))
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, LANDMARKS_SIZE, LANDMARKS_SIZE)
    // Frame → crop: inverse of the ROI placement (projectLandmarks does the forward mapping).
    ctx.translate(LANDMARKS_SIZE / 2, LANDMARKS_SIZE / 2)
    ctx.scale(LANDMARKS_SIZE / roi.size, LANDMARKS_SIZE / roi.size)
    ctx.rotate(-roi.rotation)
    ctx.translate(-roi.cx, -roi.cy)
    ctx.drawImage(source, 0, 0, width, height)
    let t = performance.now()
    const data = ctx.getImageData(0, 0, LANDMARKS_SIZE, LANDMARKS_SIZE).data
    time('readMs', performance.now() - t)
    t = performance.now()
    toFloats(data, landmarksInput, 0, 1)
    time('convertMs', performance.now() - t)
  }

  /**
   * Landmark model on `landmarksInput` (the crop of `roi` in a `width`×`height` frame), then blendshapes, written as
   * face `out.count` of `out`. Returns the face's ROI for the next frame, undefined when there is no face in the crop.
   */
  async function infer(roi: Roi, width: number, height: number, withBlendshapes: boolean, out: PipelineResult): Promise<Roi | undefined> {
    let t = performance.now()
    await runModel(landmarker, landmarksInput, [1, LANDMARKS_SIZE, LANDMARKS_SIZE, 3], [raw, presence])
    time('landmarksMs', performance.now() - t)
    const score = 1 / (1 + Math.exp(-(presence[0] ?? -Infinity)))
    if (!(score >= MIN_PRESENCE)) return undefined
    projectLandmarks(raw, roi, LANDMARK_COUNT, pixels)
    const face = out.count++
    // Normalized like MediaPipe's: x and z by the width, y by the height.
    const L = out.landmarks
    const o = face * LANDMARKS_STRIDE
    for (let i = 0; i < LANDMARK_COUNT * 3; i += 3) {
      L[o + i] = pixels[i]! / width
      L[o + i + 1] = pixels[i + 1]! / height
      L[o + i + 2] = pixels[i + 2]! / width
    }
    if (withBlendshapes) {
      t = performance.now()
      // The blendshapes model reads x, y in frame pixels.
      for (let i = 0; i < BLENDSHAPE_LANDMARKS.length; i++) {
        const index = BLENDSHAPE_LANDMARKS[i]!
        blendshapesInput[i * 2] = pixels[index * 3]!
        blendshapesInput[i * 2 + 1] = pixels[index * 3 + 1]!
      }
      await runModel(blendshaper, blendshapesInput, [1, BLENDSHAPE_LANDMARKS.length, 2], [out.blendshapes.subarray(face * BLENDSHAPES_STRIDE, (face + 1) * BLENDSHAPES_STRIDE)])
      out.hasBlendshapes = true
      time('blendshapesMs', performance.now() - t)
    }
    return landmarksToRoi(pixels, LANDMARK_COUNT)
  }

  /** A face found again at `roi` (from its landmarks). */
  function follow(track: Track, roi: Roi): void {
    // From the landmarks only: a detection's ROI is not where the landmarks would put the face.
    track.before = track.detected ? undefined : track.roi
    track.roi = roi
    track.detected = false
  }

  /** The ROI of a face in the next frame, extrapolated from its last two (async readback: they are one frame older). */
  function predict(track: Track): Roi {
    const a = track.roi
    const b = track.before
    if (!b) return a
    return { cx: 2 * a.cx - b.cx, cy: 2 * a.cy - b.cy, size: a.size, rotation: a.rotation }
  }

  function remember(out: PipelineResult): void {
    last.count = out.count
    last.hasBlendshapes = out.hasBlendshapes
    last.frame = out.frame
    last.landmarks.set(out.landmarks.subarray(0, out.count * LANDMARKS_STRIDE))
    last.blendshapes.set(out.blendshapes.subarray(0, out.count * BLENDSHAPES_STRIDE))
  }

  function repeat(out: PipelineResult): void {
    out.count = Math.min(last.count, out.landmarks.length / LANDMARKS_STRIDE)
    out.hasBlendshapes = last.hasBlendshapes
    out.frame = last.frame
    out.landmarks.set(last.landmarks.subarray(0, out.count * LANDMARKS_STRIDE))
    out.blendshapes.set(last.blendshapes.subarray(0, out.count * BLENDSHAPES_STRIDE))
  }

  /** Each frame's crops read back before its models run. */
  async function runSync(source: FrameSource, width: number, height: number, max: number, withBlendshapes: boolean, out: PipelineResult): Promise<void> {
    if (tracks.length < max) await addDetected(source, width, height, max, tracks.map((t) => t.roi))
    const kept: Track[] = []
    for (const track of tracks) {
      if (out.count >= max) break
      const t = performance.now()
      crop(source, width, height, track.roi)
      time('cropMs', performance.now() - t)
      const roi = await infer(track.roi, width, height, withBlendshapes, out)
      if (!roi) continue
      follow(track, roi)
      kept.push(track)
    }
    tracks = kept
    remember(out)
  }

  /**
   * Async readback: reads the crops of the previous frame, starts this frame's, then runs the models on the former
   * (results one frame late). The detector, when it runs, runs on this frame: its faces are cropped with the others.
   */
  async function runAsync(g: GpuCropper, source: FrameSource, width: number, height: number, max: number, withBlendshapes: boolean, frame: number, out: PipelineResult): Promise<void> {
    const previous = pending
    pending = undefined
    let have = previous !== undefined
    if (previous) {
      const t = performance.now()
      for (let i = 0; i < previous.entries.length && have; i++) have = await g.read((asyncCrops[i] ??= new Uint8Array(LANDMARKS_SIZE * LANDMARKS_SIZE * 4)), i)
      const read = performance.now() - t
      time('readMs', read)
      time('cropMs', read)
    }
    // This frame's crops: the tracked faces where they should be now, and the detector's new ones.
    let t = performance.now()
    const entries: Pending[] = tracks.slice(0, max).map((track) => ({ track, roi: predict(track) }))
    // A face lost since its crop of the previous frame was started is not lost yet: that crop may find it again.
    let inFlight = 0
    for (const e of previous?.entries ?? []) if (!tracks.includes(e.track)) inFlight++
    if (entries.length + inFlight < max) {
      const detectStart = performance.now()
      for (const track of await addDetected(source, width, height, max, entries.map((e) => e.roi))) entries.push({ track, roi: track.roi })
      t += performance.now() - detectStart // counted in `detectMs`
    }
    if (entries.length > 0) {
      upload(g, source, width, height)
      for (let i = 0; i < entries.length; i++) g.cropAsync(entries[i]!.roi, LANDMARKS_SIZE, i)
      pending = { entries, width, height, frame }
    }
    time('cropMs', performance.now() - t)
    if (!previous || !have) {
      repeat(out) // the pipe fills: the last result once more
      return
    }
    out.frame = previous.frame
    for (let i = 0; i < previous.entries.length && out.count < max; i++) {
      const { track, roi: used } = previous.entries[i]!
      t = performance.now()
      toFloats(asyncCrops[i]!, landmarksInput, 0, 1)
      const convert = performance.now() - t
      time('convertMs', convert)
      time('cropMs', convert)
      const roi = await infer(used, previous.width, previous.height, withBlendshapes, out)
      const at = tracks.indexOf(track)
      if (!roi) {
        if (at >= 0) tracks.splice(at, 1)
        continue
      }
      follow(track, roi)
      // Lost meanwhile (an older crop of it found no face), found again here.
      if (at < 0) tracks.push(track)
    }
    remember(out)
  }

  return {
    get crop() {
      return gpu ? 'gpu' : 'canvas'
    },
    get readback() {
      return asyncReadback && gpu ? 'async' : 'sync'
    },
    timings,
    reset() {
      tracks = []
      pending = undefined
      last.count = 0
    },
    async run(source, width, height, { blendshapes: withBlendshapes, maxFaces, frame = 0, exact = false }, out) {
      timings.detectMs = timings.uploadMs = timings.cropMs = timings.readMs = timings.convertMs = timings.landmarksMs = timings.blendshapesMs = NaN
      uploaded = false
      out.count = 0
      out.hasBlendshapes = false
      out.frame = frame
      const max = Math.max(1, Math.min(MAX_FACES, Math.trunc(maxFaces), out.landmarks.length / LANDMARKS_STRIDE))
      // Two tracks that came onto the same face (faces crossing): the older one stays.
      dedupeRois(tracks, (track) => track.roi)
      if (tracks.length > max) tracks.length = max
      // A file source's frame gets its own result: no readback in flight across frames.
      if (exact) pending = undefined
      const g = asyncReadback && !exact ? gpuCropper() : undefined
      if (g && (tracks.length > 0 || pending)) return runAsync(g, source, width, height, max, withBlendshapes, frame, out)
      return runSync(source, width, height, max, withBlendshapes, out)
    },
    dispose() {
      detector.delete()
      landmarker.delete()
      blendshaper.delete()
      gpu?.dispose()
    },
  }
}

/** A tracked face. */
interface Track {
  /** Its ROI: from its last landmarks, or from the detection that found it (`detected`). */
  roi: Roi
  /** The ROI from its landmarks before `roi`, to extrapolate; undefined when `roi` is its first from landmarks. */
  before: Roi | undefined
  detected: boolean
}

/** A crop read back for the next run (async readback): of `track`, at `roi`. */
interface Pending {
  readonly track: Track
  readonly roi: Roi
}
