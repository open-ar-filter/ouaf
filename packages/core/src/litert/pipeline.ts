/**
 * Our own face pipeline on LiteRT.js (docs/decisions/face-runtime.md): MediaPipe's three TFLite models (from
 * `face_landmarker.task`) run without MediaPipe, with the geometry of `geometry.ts`. Runs in the tracking worker
 * (`face.worker.ts`); no DOM access.
 *
 * Per frame: each tracked face is cropped at the ROI from its previous landmarks (all faces at once: rotated 256×256
 * crops side by side, one readback); landmark model per face (478 points and a face presence score); the blendshapes
 * model on 146 of the points when asked. The detector (letterboxed 128×128 input) looks for the faces missing: on
 * every frame while none is tracked, at most every `DETECT_INTERVAL_MS` while some are (`slots.ts`, multi-face: one
 * slot per face, a face lost frees its slot, two ROIs on one face are merged).
 *
 * Crops on WebGL2 (`gpu-crop.ts`: only the crop is read back) or on a 2D canvas (the whole frame goes through the
 * CPU: slow on phones, the fallback where a worker has no WebGL2, see docs/decisions/webkit-compat.md).
 *
 * Single-threaded wasm build of LiteRT.js: no cross-origin isolation needed, and faster than 4 threads in a worker on
 * both phones measured (face-runtime.md).
 */
import { loadAndCompile, loadLiteRt, Tensor, type CompiledModel } from '@litertjs/core'
import { BLENDSHAPE_COUNT, LANDMARK_COUNT } from '../face.ts'
import {
  BLENDSHAPE_LANDMARKS,
  DETECTOR_SIZE,
  LANDMARKS_SIZE,
  decodeDetections,
  detectionToRoi,
  landmarksToRoi,
  letterbox,
  projectLandmarks,
  type Roi,
} from './geometry.ts'
import { createGpuCropper, cropPixel, type GpuCropper } from './gpu-crop.ts'
import { DetectorSchedule, FaceSlots, type FaceSlot } from './slots.ts'

/** What a run accepts: a frame transferred to the worker. */
export type FrameSource = VideoFrame | ImageBitmap

/** Below this presence score the face is lost, and its slot freed. */
export const MIN_PRESENCE = 0.5
/**
 * While some faces are tracked but fewer than wanted (`maxFaces` > the faces in view, the usual case), the detector
 * runs at most this often (ms), so that an empty slot does not add its cost to every result; a face that comes into
 * view is found within this delay.
 */
export const DETECT_INTERVAL_MS = 500

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
   * GPU crops only. `async` (the tracker's default): the crop of frame N is read back into a pixel buffer while the
   * landmark model runs on frame N − 1, so that the worker does not stall on the GPU (Redmi Note 11S's Mali-G57: the
   * readback 15–16 → 5–6 ms, 17.5 → 20 Hz). Costs: results one frame late, and frame N's ROI comes from frame N − 2's
   * landmarks (extrapolated from N − 3). `sync` (default here): each frame's crop is read back (`readPixels`) before
   * its landmark model runs.
   */
  readback?: Readback
  /** Faces tracked at most (the engine's `maxFaces`). Default 1. */
  maxFaces?: number
  /** `DETECT_INTERVAL_MS` (tests). */
  detectIntervalMs?: number
}

export type Readback = 'sync' | 'async'

/** Per-stage timings of the last run (ms; NaN when the stage did not run). */
export interface StageTimings {
  /** Detector stage: letterbox, model, decoding. */
  detectMs: number
  /** Frame upload to the GPU crops' texture (`texImage2D`; part of `detectMs` or `cropMs`). */
  uploadMs: number
  /** Landmark crop: drawing and reading it back (`readPixels`, or waiting for the pixel buffer), then `convertMs`. */
  cropMs: number
  readMs: number
  /** RGBA bytes → the model's float input. */
  convertMs: number
  /** Landmark and blendshapes models: the sum over the faces. */
  landmarksMs: number
  blendshapesMs: number
}

export interface PipelineResult {
  /** Faces found, in slot order (a face keeps its slot from result to result). */
  count: number
  /** Face presence (0–1) per face. */
  presence: Float32Array
  /**
   * `x, y, z` per landmark, `LANDMARK_COUNT × 3` floats per face, as in `FaceFrame.landmarks`: x and y normalized to
   * the frame, z in the scale of x (MediaPipe's convention).
   */
  landmarks: Float32Array
  /** Blendshape scores in `BLENDSHAPE_NAMES` order, `BLENDSHAPE_COUNT` per face; 0 when not computed. */
  blendshapes: Float32Array
  /** Blendshapes were computed for this result. */
  hasBlendshapes: boolean
  /** The frame this result describes (`run`'s `frame`): an earlier one with `readback: 'async'`. */
  frame: number
}

export interface Pipeline {
  /** Faces it can track (`PipelineOptions.maxFaces`). */
  readonly capacity: number
  readonly crop: Crop
  readonly timings: StageTimings
  readonly readback: Readback
  /**
   * Tracks `frame` (an id) of `width`×`height`, at most `maxFaces` faces (≤ `capacity`; fewer while the governor has
   * dropped the extra faces); `out.frame` says which frame the result describes.
   */
  run(
    source: FrameSource,
    width: number,
    height: number,
    blendshapes: boolean,
    out: PipelineResult,
    frame?: number,
    exact?: boolean,
    maxFaces?: number,
  ): Promise<void>
  /** Forgets the tracked faces: the next run starts with the detector. */
  reset(): void
  dispose(): void
}

export function createPipelineResult(capacity = 1): PipelineResult {
  return {
    count: 0,
    presence: new Float32Array(capacity),
    landmarks: new Float32Array(capacity * LANDMARK_COUNT * 3),
    blendshapes: new Float32Array(capacity * BLENDSHAPE_COUNT),
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
  const capacity = Math.max(1, Math.trunc(options.maxFaces ?? 1))
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
      gpu = createGpuCropper(LANDMARKS_SIZE, capacity)
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

  const CROP_BYTES = LANDMARKS_SIZE * LANDMARKS_SIZE * 4
  /** The landmark crops of a run, side by side (`cropPixel`), from the GPU or the 2D canvas. */
  const crops = new Uint8Array(CROP_BYTES * capacity)
  const gpuDetectorCrop = new Uint8Array(DETECTOR_SIZE * DETECTOR_SIZE * 4)
  const detectorInput = new Float32Array(DETECTOR_SIZE * DETECTOR_SIZE * 3)
  const landmarksInput = new Float32Array(LANDMARKS_SIZE * LANDMARKS_SIZE * 3)
  const blendshapesInput = new Float32Array(BLENDSHAPE_LANDMARKS.length * 2)
  const regressors = new Float32Array(896 * 16)
  const scores = new Float32Array(896)
  const raw = new Float32Array(LANDMARK_COUNT * 3)
  const presence = new Float32Array(1)
  const pixels = new Float32Array(LANDMARK_COUNT * 3)
  const scoresOut = new Float32Array(BLENDSHAPE_COUNT)
  const timings: StageTimings = { detectMs: NaN, uploadMs: NaN, cropMs: NaN, readMs: NaN, convertMs: NaN, landmarksMs: NaN, blendshapesMs: NaN }
  const slots = new FaceSlots(capacity)
  const schedule = new DetectorSchedule(options.detectIntervalMs ?? DETECT_INTERVAL_MS)
  let uploaded = false
  const asyncReadback = options.readback === 'async'
  /** Async readback: the crops read back for the next run (slot by slot), and the last result, repeated while the pipe fills. */
  let pending: { slots: FaceSlot[]; rois: Roi[]; width: number; height: number; frame: number } | undefined
  const last = createPipelineResult(capacity)

  /** Crop `tile` of `tiles` in `crops` → the landmark model's floats in [0, 1]. */
  const loadInput = (tile: number, tiles: number) => {
    const k = 1 / 255
    let j = 0
    for (let y = 0; y < LANDMARKS_SIZE; y++) {
      let i = cropPixel(tile, tiles, LANDMARKS_SIZE, 0, y)
      for (let x = 0; x < LANDMARKS_SIZE; x++, i += 4, j += 3) {
        landmarksInput[j] = crops[i]! * k
        landmarksInput[j + 1] = crops[i + 1]! * k
        landmarksInput[j + 2] = crops[i + 2]! * k
      }
    }
  }

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

  /** Every face the detector finds in the frame, best first, as ROIs. */
  async function detect(source: FrameSource, width: number, height: number): Promise<Roi[]> {
    const t = performance.now()
    const box = letterbox(width, height)
    const g = gpuCropper()
    if (g) {
      upload(g, source, width, height)
      g.crop([{ cx: width / 2, cy: height / 2, size: Math.max(width, height), rotation: 0 }], DETECTOR_SIZE, gpuDetectorCrop)
      toFloats(gpuDetectorCrop, detectorInput, -1, 1)
    } else {
      const ctx = (detectorCtx ??= context2d(DETECTOR_SIZE))
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, DETECTOR_SIZE, DETECTOR_SIZE)
      ctx.drawImage(source, box.offsetX, box.offsetY, width * box.scale, height * box.scale)
      toFloats(ctx.getImageData(0, 0, DETECTOR_SIZE, DETECTOR_SIZE).data, detectorInput, -1, 1)
    }
    await runModel(detector, detectorInput, [1, DETECTOR_SIZE, DETECTOR_SIZE, 3], [regressors, scores])
    const rois = decodeDetections(regressors, scores, box).map(detectionToRoi)
    timings.detectMs = performance.now() - t
    return rois
  }

  /** The landmark crops of `rois` into `crops`, at once (one readback for every face on the GPU). */
  function crop(source: FrameSource, width: number, height: number, rois: readonly Roi[]): void {
    const g = gpuCropper()
    if (g) {
      upload(g, source, width, height)
      const t = performance.now()
      g.crop(rois, LANDMARKS_SIZE, crops)
      timings.readMs = performance.now() - t
      return
    }
    // 2D canvas: one face after the other, copied into its tile.
    const ctx = (cropCtx ??= context2d(LANDMARKS_SIZE))
    let read = 0
    for (let tile = 0; tile < rois.length; tile++) {
      const roi = rois[tile]!
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, LANDMARKS_SIZE, LANDMARKS_SIZE)
      // Frame → crop: inverse of the ROI placement (projectLandmarks does the forward mapping).
      ctx.translate(LANDMARKS_SIZE / 2, LANDMARKS_SIZE / 2)
      ctx.scale(LANDMARKS_SIZE / roi.size, LANDMARKS_SIZE / roi.size)
      ctx.rotate(-roi.rotation)
      ctx.translate(-roi.cx, -roi.cy)
      ctx.drawImage(source, 0, 0, width, height)
      const t = performance.now()
      const data = ctx.getImageData(0, 0, LANDMARKS_SIZE, LANDMARKS_SIZE).data
      read += performance.now() - t
      const rowBytes = LANDMARKS_SIZE * 4
      for (let y = 0; y < LANDMARKS_SIZE; y++) {
        crops.set(data.subarray(y * rowBytes, (y + 1) * rowBytes), cropPixel(tile, rois.length, LANDMARKS_SIZE, 0, y))
      }
    }
    timings.readMs = read
  }

  const add = (key: 'landmarksMs' | 'blendshapesMs' | 'convertMs', ms: number) => {
    timings[key] = (Number.isNaN(timings[key]) ? 0 : timings[key]) + ms
  }

  /**
   * Landmark model on crop `tile` of `tiles` (the crop of `roi` in a `width`×`height` frame), then blendshapes; writes
   * face `face` of `out` and returns the face's next ROI, or undefined when there is no face there.
   */
  async function infer(tile: number, tiles: number, roi: Roi, width: number, height: number, withBlendshapes: boolean, out: PipelineResult, face: number): Promise<Roi | undefined> {
    let t = performance.now()
    loadInput(tile, tiles)
    add('convertMs', performance.now() - t)
    t = performance.now()
    await runModel(landmarker, landmarksInput, [1, LANDMARKS_SIZE, LANDMARKS_SIZE, 3], [raw, presence])
    add('landmarksMs', performance.now() - t)
    const p = 1 / (1 + Math.exp(-(presence[0] ?? -Infinity)))
    if (!(p >= MIN_PRESENCE)) return undefined
    out.presence[face] = p
    projectLandmarks(raw, roi, LANDMARK_COUNT, pixels)
    // Normalized like MediaPipe's: x and z by the width, y by the height.
    const L = out.landmarks
    const base = face * LANDMARK_COUNT * 3
    for (let i = 0; i < LANDMARK_COUNT * 3; i += 3) {
      L[base + i] = pixels[i]! / width
      L[base + i + 1] = pixels[i + 1]! / height
      L[base + i + 2] = pixels[i + 2]! / width
    }
    const bBase = face * BLENDSHAPE_COUNT
    if (withBlendshapes) {
      t = performance.now()
      // The blendshapes model reads x, y in frame pixels.
      for (let i = 0; i < BLENDSHAPE_LANDMARKS.length; i++) {
        const index = BLENDSHAPE_LANDMARKS[i]!
        blendshapesInput[i * 2] = pixels[index * 3]!
        blendshapesInput[i * 2 + 1] = pixels[index * 3 + 1]!
      }
      await runModel(blendshaper, blendshapesInput, [1, BLENDSHAPE_LANDMARKS.length, 2], [scoresOut])
      out.blendshapes.set(scoresOut, bBase)
      add('blendshapesMs', performance.now() - t)
    } else out.blendshapes.fill(0, bBase, bBase + BLENDSHAPE_COUNT)
    return landmarksToRoi(pixels, LANDMARK_COUNT)
  }

  /**
   * Runs the landmark model on the crops of `list` (tile `i` for `list[i]`, cropped at `rois[i]`), in slot order;
   * updates the slots and writes the faces found into `out`, then frees the slots that converged on the same face.
   */
  async function inferAll(
    list: readonly FaceSlot[],
    rois: readonly Roi[],
    fresh: ReadonlySet<FaceSlot>,
    width: number,
    height: number,
    withBlendshapes: boolean,
    out: PipelineResult,
    skip: readonly FaceSlot[] = [],
  ): Promise<void> {
    const outSlots: FaceSlot[] = []
    for (let i = 0; i < list.length; i++) {
      const slot = list[i]!
      // Its face dropped meanwhile (extra faces): its crop is not used. A slot whose face was lost meanwhile is: its
      // crop (async readback, one frame later, at the ROI before the loss) often finds the face again.
      if (skip.includes(slot)) continue
      const face = outSlots.length
      const next = await infer(i, list.length, rois[i]!, width, height, withBlendshapes, out, face)
      slots.track(slot, next, next ? out.presence[face]! : 0, !fresh.has(slot))
      if (next) outSlots.push(slot)
    }
    // Two ROIs on one face: keep the more confident, and drop the other's result.
    const freed = slots.dedup()
    let count = outSlots.length
    if (freed.length) {
      let k = 0
      for (let f = 0; f < outSlots.length; f++) {
        if (freed.includes(outSlots[f]!)) continue
        if (k !== f) {
          out.landmarks.copyWithin(k * LANDMARK_COUNT * 3, f * LANDMARK_COUNT * 3, (f + 1) * LANDMARK_COUNT * 3)
          out.blendshapes.copyWithin(k * BLENDSHAPE_COUNT, f * BLENDSHAPE_COUNT, (f + 1) * BLENDSHAPE_COUNT)
          out.presence[k] = out.presence[f]!
        }
        k++
      }
      count = k
    }
    out.count = count
    out.hasBlendshapes = withBlendshapes && count > 0
  }

  function remember(out: PipelineResult): void {
    last.count = out.count
    last.hasBlendshapes = out.hasBlendshapes
    last.frame = out.frame
    last.presence.set(out.presence)
    last.landmarks.set(out.landmarks)
    last.blendshapes.set(out.blendshapes)
  }

  function repeat(out: PipelineResult): void {
    out.count = last.count
    out.hasBlendshapes = last.hasBlendshapes
    out.frame = last.frame
    out.presence.set(last.presence)
    out.landmarks.set(last.landmarks)
    out.blendshapes.set(last.blendshapes)
  }

  return {
    capacity,
    get crop() {
      return gpu ? 'gpu' : 'canvas'
    },
    get readback() {
      return asyncReadback && gpu ? 'async' : 'sync'
    },
    timings,
    reset() {
      slots.reset()
      schedule.reset()
      pending = undefined
      last.count = 0
    },
    async run(source, width, height, withBlendshapes, out, frame = 0, exact = false, maxFaces = capacity) {
      timings.detectMs = timings.uploadMs = timings.cropMs = timings.readMs = timings.convertMs = timings.landmarksMs = timings.blendshapesMs = NaN
      uploaded = false
      out.count = 0
      out.hasBlendshapes = false
      out.frame = frame
      const wanted = Math.max(1, Math.min(capacity, Math.trunc(maxFaces)))
      // Extra faces dropped (spec §16.2): the faces beyond `wanted` are no longer tracked.
      const dropped = slots.limit(wanted)
      const now = performance.now()
      // Every face lost, but a crop in flight (async readback): run the model on it first, which often finds the face
      // again (its ROI is better than a detection's), as the single-face pipeline did; the detector comes next frame.
      const draining = asyncReadback && !exact && slots.count === 0 && pending !== undefined
      const detecting = !draining && schedule.due(slots.count, wanted, now)
      // A file source's frame gets its own result: no readback in flight across frames. So does a frame the detector
      // runs on: its new faces need this frame's crops.
      if (exact || detecting) pending = undefined
      const g = asyncReadback && !exact && !detecting ? gpuCropper() : undefined
      if (g && (slots.count > 0 || pending)) {
        // Async readback: read the crops of the previous frame, start this frame's, then run the model on the former.
        const previous = pending
        pending = undefined
        let t = performance.now()
        const have = previous !== undefined && (await g.read(crops))
        timings.readMs = performance.now() - t
        const list = slots.active
        if (list.length) {
          t = performance.now()
          upload(g, source, width, height)
          const rois = list.map((s) => slots.predict(s)!)
          g.cropAsync(rois, LANDMARKS_SIZE)
          timings.cropMs = performance.now() - t + (Number.isNaN(timings.readMs) ? 0 : timings.readMs)
          pending = { slots: list, rois, width, height, frame }
        }
        if (have && previous) {
          out.frame = previous.frame
          await inferAll(previous.slots, previous.rois, NO_SLOTS, previous.width, previous.height, withBlendshapes, out, dropped)
          remember(out)
        } else repeat(out) // the pipe fills: the last result once more
        return
      }
      const fresh = new Set<FaceSlot>()
      if (detecting) for (const slot of slots.addDetections(await detect(source, width, height), wanted)) fresh.add(slot)
      const list = slots.active
      if (!list.length) {
        if (detecting) schedule.ran(now)
        last.count = 0
        return
      }
      const rois = list.map((s) => s.roi!)
      const t = performance.now()
      crop(source, width, height, rois)
      timings.cropMs = performance.now() - t
      await inferAll(list, rois, fresh, width, height, withBlendshapes, out)
      // A new face the landmark model did not confirm: the detector looks again on the next frames.
      if (detecting) schedule.ran(now, [...fresh].some((slot) => !slot.roi))
      remember(out)
    },
    dispose() {
      detector.delete()
      landmarker.delete()
      blendshaper.delete()
      gpu?.dispose()
    },
  }
}

const NO_SLOTS: ReadonlySet<FaceSlot> = new Set()
