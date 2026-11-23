/**
 * Our own face pipeline on LiteRT.js (docs/decisions/face-runtime.md): MediaPipe's three TFLite models (from
 * `face_landmarker.task`) run without MediaPipe, with the geometry of `geometry.ts`. Runs in the tracking worker
 * (`face.worker.ts`); no DOM access.
 *
 * Per frame: the detector only when no face is tracked (letterboxed 128×128 input), otherwise the ROI predicted from
 * the previous landmarks; rotated crop to 256×256; landmark model (478 points and a face presence score); the
 * blendshapes model on 146 of the points when asked. One face.
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
import { createGpuCropper, type GpuCropper } from './gpu-crop.ts'

/** What a run accepts: a frame transferred to the worker. */
export type FrameSource = VideoFrame | ImageBitmap

/** Below this presence score the face is lost, and the detector runs again on the next frame. */
export const MIN_PRESENCE = 0.5

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
}

/** Per-stage timings of the last run (ms; NaN when the stage did not run). */
export interface StageTimings {
  /** Detector stage: letterbox, model, decoding. */
  detectMs: number
  /** Frame upload to the GPU crops' texture (`texImage2D`; part of `detectMs` or `cropMs`). */
  uploadMs: number
  cropMs: number
  landmarksMs: number
  blendshapesMs: number
}

export interface PipelineResult {
  found: boolean
  presence: number
  /**
   * `x, y, z` per landmark as in `FaceFrame.landmarks`: x and y normalized to the frame, z in the scale of x
   * (MediaPipe's convention).
   */
  landmarks: Float32Array
  /** Blendshape scores in `BLENDSHAPE_NAMES` order; left at 0 when not computed. */
  blendshapes: Float32Array
  /** Blendshapes were computed for this result. */
  hasBlendshapes: boolean
}

export interface Pipeline {
  readonly crop: Crop
  readonly timings: StageTimings
  run(source: FrameSource, width: number, height: number, blendshapes: boolean, out: PipelineResult): Promise<void>
  /** Forgets the tracked face: the next run starts with the detector. */
  reset(): void
  dispose(): void
}

export function createPipelineResult(): PipelineResult {
  return {
    found: false,
    presence: 0,
    landmarks: new Float32Array(LANDMARK_COUNT * 3),
    blendshapes: new Float32Array(BLENDSHAPE_COUNT),
    hasBlendshapes: false,
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
  const gpuDetectorCrop = new Uint8Array(DETECTOR_SIZE * DETECTOR_SIZE * 4)
  const detectorInput = new Float32Array(DETECTOR_SIZE * DETECTOR_SIZE * 3)
  const landmarksInput = new Float32Array(LANDMARKS_SIZE * LANDMARKS_SIZE * 3)
  const blendshapesInput = new Float32Array(BLENDSHAPE_LANDMARKS.length * 2)
  const regressors = new Float32Array(896 * 16)
  const scores = new Float32Array(896)
  const raw = new Float32Array(LANDMARK_COUNT * 3)
  const presence = new Float32Array(1)
  const pixels = new Float32Array(LANDMARK_COUNT * 3)
  const timings: StageTimings = { detectMs: NaN, uploadMs: NaN, cropMs: NaN, landmarksMs: NaN, blendshapesMs: NaN }
  let tracked: Roi | undefined
  let uploaded = false

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

  async function detect(source: FrameSource, width: number, height: number): Promise<Roi | undefined> {
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
    const best = decodeDetections(regressors, scores, box)[0]
    timings.detectMs = performance.now() - t
    return best ? detectionToRoi(best) : undefined
  }

  function crop(source: FrameSource, width: number, height: number, roi: Roi): void {
    const g = gpuCropper()
    if (g) {
      upload(g, source, width, height)
      g.crop(roi, LANDMARKS_SIZE, gpuCrop)
      toFloats(gpuCrop, landmarksInput, 0, 1)
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
    toFloats(ctx.getImageData(0, 0, LANDMARKS_SIZE, LANDMARKS_SIZE).data, landmarksInput, 0, 1)
  }

  return {
    get crop() {
      return gpu ? 'gpu' : 'canvas'
    },
    timings,
    reset() {
      tracked = undefined
    },
    async run(source, width, height, withBlendshapes, out) {
      timings.detectMs = timings.uploadMs = timings.cropMs = timings.landmarksMs = timings.blendshapesMs = NaN
      uploaded = false
      out.found = false
      out.presence = 0
      out.hasBlendshapes = false
      const roi = tracked ?? (await detect(source, width, height))
      tracked = undefined
      if (!roi) return

      let t = performance.now()
      crop(source, width, height, roi)
      timings.cropMs = performance.now() - t

      t = performance.now()
      await runModel(landmarker, landmarksInput, [1, LANDMARKS_SIZE, LANDMARKS_SIZE, 3], [raw, presence])
      timings.landmarksMs = performance.now() - t
      out.presence = 1 / (1 + Math.exp(-(presence[0] ?? -Infinity)))
      if (!(out.presence >= MIN_PRESENCE)) return
      out.found = true
      projectLandmarks(raw, roi, LANDMARK_COUNT, pixels)
      tracked = landmarksToRoi(pixels, LANDMARK_COUNT)
      // Normalized like MediaPipe's: x and z by the width, y by the height.
      const L = out.landmarks
      for (let i = 0; i < LANDMARK_COUNT * 3; i += 3) {
        L[i] = pixels[i]! / width
        L[i + 1] = pixels[i + 1]! / height
        L[i + 2] = pixels[i + 2]! / width
      }

      if (withBlendshapes) {
        t = performance.now()
        // The blendshapes model reads x, y in frame pixels.
        for (let i = 0; i < BLENDSHAPE_LANDMARKS.length; i++) {
          const index = BLENDSHAPE_LANDMARKS[i]!
          blendshapesInput[i * 2] = pixels[index * 3]!
          blendshapesInput[i * 2 + 1] = pixels[index * 3 + 1]!
        }
        await runModel(blendshaper, blendshapesInput, [1, BLENDSHAPE_LANDMARKS.length, 2], [out.blendshapes])
        out.hasBlendshapes = true
        timings.blendshapesMs = performance.now() - t
      }
    },
    dispose() {
      detector.delete()
      landmarker.delete()
      blendshaper.delete()
      gpu?.dispose()
    },
  }
}
