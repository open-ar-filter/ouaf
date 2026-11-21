/**
 * Our own face pipeline on LiteRT.js (#83 spike): MediaPipe's three TFLite models (extracted from
 * `face_landmarker.task` by `npm run fetch-models`) run without MediaPipe, with the geometry of `geometry.ts`.
 *
 * Per frame: detector only when no face is tracked (letterboxed 128×128 input), otherwise the ROI predicted from the
 * previous landmarks; rotated crop to 256×256 on a 2D canvas (CPU readback of the crop); landmark model (478 points
 * and a face presence score); optionally the blendshapes model on 146 of the points. One face.
 * `crop: 'gpu'` does the rotated crop on WebGL2 instead (gpu-crop.ts), reading back only the 256×256 crop;
 * `detectorCrop: 'gpu'` does the same for the detector letterbox (128×128 read back).
 *
 * Runs on the main thread or in a worker (`litert.worker.ts`): no DOM access, asset URLs come from `assetBase`.
 */
import { loadAndCompile, loadLiteRt, supportsFeature, Tensor, type CompiledModel } from '@litertjs/core'
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

/** What a run accepts: the video element on the main thread, a transferred frame in the worker. */
export type FrameSource = HTMLVideoElement | VideoFrame | ImageBitmap

export const LANDMARKS = 478
const BLENDSHAPES = 52
/** Below this presence score the face is considered lost and the detector runs again on the next frame. */
const MIN_PRESENCE = 0.5

export type Accelerator = 'wasm' | 'webgpu'

export interface LiteRtOptions {
  accelerator: Accelerator
  /** wasm: XNNPACK threads. 1 loads the single-threaded build; more needs a cross-origin isolated page. */
  threads: number
  blendshapes: boolean
  /** `always`: run the detector on every frame (its cost), instead of only when no face is tracked. */
  detect: 'track' | 'always'
  /** Landmark crop: `canvas` (2D canvas, whole frame read back to the CPU) or `gpu` (WebGL2, only the crop read back). */
  crop: Crop
  /** Detector letterbox (128×128), same choice as `crop`. */
  detectorCrop: Crop
  /** Absolute URL of the playground root (`litert/wasm/`, `models/` are resolved against it). */
  assetBase: string
}

export type Crop = 'canvas' | 'gpu'

/** Per-stage timings of the last `run` (ms, NaN when the stage did not run). */
export interface StageTimings {
  /** Detector stage: letterbox, model, decoding. */
  detectMs: number
  /** Detector letterbox alone (part of `detectMs`): drawing, readback, float conversion. */
  detectCropMs: number
  cropMs: number
  landmarksMs: number
  blendshapesMs: number
  /** Copying results back to JavaScript (GPU → CPU with WebGPU). Included in the stage timings above too. */
  readMs: number
}

export interface FaceResult {
  found: boolean
  /** `x, y, z` per landmark, frame pixels. */
  landmarks: Float32Array
  blendshapes: Float32Array
  presence: number
  roi: Roi | undefined
}

export interface LiteRtPipeline {
  readonly description: string
  readonly timings: StageTimings
  run(source: FrameSource, width: number, height: number, out: FaceResult): Promise<void>
  /** Forgets the tracked face (the next run starts with the detector). */
  reset(): void
  dispose(): void
}

export function createFaceResult(): FaceResult {
  return { found: false, landmarks: new Float32Array(LANDMARKS * 3), blendshapes: new Float32Array(BLENDSHAPES), presence: 0, roi: undefined }
}

let loaded: Promise<unknown> | undefined

/**
 * Loads the LiteRT.js wasm once per page: the threaded build for several wasm threads, the JSPI build for WebGPU
 * (without JSPI, reading a WebGPU tensor back fails with "Asyncify is not defined" in LiteRT.js 2.6.0, and models the
 * GPU delegate only partly supports cannot fall back to wasm per operation), the plain build otherwise.
 */
function ensureLiteRt(assetBase: string, build: { threads: boolean; jspi: boolean }): Promise<unknown> {
  loaded ??= loadLiteRt(new URL('litert/wasm/', assetBase).href, build)
  return loaded
}

/** Copies a CPU float buffer into a new tensor on the accelerator the model runs on. */
async function input(data: Float32Array, shape: number[], accelerator: Accelerator): Promise<Tensor> {
  const t = new Tensor(data, shape)
  return accelerator === 'webgpu' ? t.moveTo('webgpu') : t
}

/** Runs a model and returns its outputs as CPU float arrays (copied), timing the readback separately. */
async function runModel(model: CompiledModel, inputs: Tensor[], timings: StageTimings): Promise<Float32Array[]> {
  const outputs = await model.run(inputs)
  for (const t of inputs) t.delete()
  const t = performance.now()
  const arrays: Float32Array[] = []
  for (const o of outputs) {
    const cpu = o.accelerator === 'wasm' ? o : await o.moveTo('wasm')
    arrays.push(Float32Array.from(cpu.toTypedArray() as Float32Array))
    cpu.delete()
  }
  timings.readMs = (Number.isNaN(timings.readMs) ? 0 : timings.readMs) + performance.now() - t
  return arrays
}

/**
 * The landmark model declares a dynamic batch (`shape_signature` [-1, 256, 256, 3]) and LiteRT.js only accepts input
 * tensors of exactly the declared shape, which a `-1` never matches. Rewrites that signature to a batch of 1 in the
 * model bytes (the int32 vector `[4, -1, 256, 256, 3]` of the flatbuffer, found once in the file); other models are
 * returned unchanged.
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

async function fetchModel(assetBase: string, name: string): Promise<Uint8Array> {
  const url = new URL(`models/${name}.tflite`, assetBase).href
  const res = await fetch(url)
  if (!res.ok || res.headers.get('content-type')?.includes('text/html')) throw new Error(`${url}: HTTP ${res.status}, run \`npm run fetch-models\``)
  return fixDynamicBatch(new Uint8Array(await res.arrayBuffer()), [LANDMARKS_SIZE, LANDMARKS_SIZE, 3])
}

export async function createLiteRtPipeline(options: LiteRtOptions): Promise<LiteRtPipeline> {
  const threaded = options.accelerator === 'wasm' && options.threads > 1
  if (threaded && !globalThis.crossOriginIsolated) throw new Error('threads need a cross-origin isolated page (COOP/COEP headers); open without ?coi=0')
  const jspi = options.accelerator === 'webgpu'
  if (jspi && !(await supportsFeature('jspi'))) throw new Error('WebGPU needs JSPI (WebAssembly JavaScript Promise Integration), missing in this browser')
  await ensureLiteRt(options.assetBase, { threads: threaded, jspi })
  const compile = async (name: string) =>
    loadAndCompile(await fetchModel(options.assetBase, name), {
      accelerator: options.accelerator,
      ...(options.accelerator === 'wasm' ? { cpuOptions: { numThreads: options.threads } } : {}),
    })
  let detector: CompiledModel
  let landmarker: CompiledModel
  let blendshaper: CompiledModel | undefined
  try {
    detector = await compile('face_detector')
    landmarker = await compile('face_landmarks_detector')
    if (options.blendshapes) blendshaper = await compile('face_blendshapes')
  } catch (err) {
    throw new Error(`model compilation failed (${options.accelerator}): ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }

  // Crops are drawn on 2D canvases and read back (`getImageData`): the only CPU image path common to every backend.
  const detectorCanvas = new OffscreenCanvas(DETECTOR_SIZE, DETECTOR_SIZE)
  const detectorCtx = detectorCanvas.getContext('2d', { willReadFrequently: true })!
  const cropCanvas = new OffscreenCanvas(LANDMARKS_SIZE, LANDMARKS_SIZE)
  const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true })!
  // One WebGL2 context for both crops: the frame is uploaded once per run, whichever crop needs it first.
  const gpuCropper: GpuCropper | undefined = options.crop === 'gpu' || options.detectorCrop === 'gpu' ? createGpuCropper(LANDMARKS_SIZE) : undefined
  const gpuCrop = new Uint8Array(LANDMARKS_SIZE * LANDMARKS_SIZE * 4)
  const gpuDetectorCrop = new Uint8Array(DETECTOR_SIZE * DETECTOR_SIZE * 4)
  let uploaded = false
  const upload = (source: FrameSource, width: number, height: number) => {
    if (uploaded) return
    gpuCropper!.upload(source, width, height)
    uploaded = true
  }
  const detectorInput = new Float32Array(DETECTOR_SIZE * DETECTOR_SIZE * 3)
  const landmarksInput = new Float32Array(LANDMARKS_SIZE * LANDMARKS_SIZE * 3)
  const blendshapesInput = new Float32Array(BLENDSHAPE_LANDMARKS.length * 2)
  const timings: StageTimings = { detectMs: NaN, detectCropMs: NaN, cropMs: NaN, landmarksMs: NaN, blendshapesMs: NaN, readMs: NaN }
  let tracked: Roi | undefined

  /** RGBA bytes → RGB floats in [lo, hi]. */
  const toFloats = (rgba: Uint8Array | Uint8ClampedArray, out: Float32Array, lo: number, hi: number) => {
    const k = (hi - lo) / 255
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      out[j] = rgba[i]! * k + lo
      out[j + 1] = rgba[i + 1]! * k + lo
      out[j + 2] = rgba[i + 2]! * k + lo
    }
  }

  async function detect(source: FrameSource, width: number, height: number): Promise<Roi | undefined> {
    const t = performance.now()
    const box = letterbox(width, height)
    if (options.detectorCrop === 'gpu') {
      upload(source, width, height)
      // The letterbox is the unrotated square crop of side the frame's long side, centred on the frame.
      gpuCropper!.crop({ cx: width / 2, cy: height / 2, size: Math.max(width, height), rotation: 0 }, DETECTOR_SIZE, gpuDetectorCrop)
      toFloats(gpuDetectorCrop, detectorInput, -1, 1)
    } else {
      detectorCtx.fillStyle = '#000'
      detectorCtx.fillRect(0, 0, DETECTOR_SIZE, DETECTOR_SIZE)
      detectorCtx.drawImage(source, box.offsetX, box.offsetY, width * box.scale, height * box.scale)
      toFloats(detectorCtx.getImageData(0, 0, DETECTOR_SIZE, DETECTOR_SIZE).data, detectorInput, -1, 1)
    }
    timings.detectCropMs = performance.now() - t
    const [regressors, scores] = await runModel(detector, [await input(detectorInput, [1, DETECTOR_SIZE, DETECTOR_SIZE, 3], options.accelerator)], timings)
    const detections = decodeDetections(regressors!, scores!, box)
    timings.detectMs = performance.now() - t
    const best = detections[0]
    return best ? detectionToRoi(best) : undefined
  }

  return {
    description: `LiteRT.js ${options.accelerator}${options.accelerator === 'wasm' ? `, ${options.threads} thread${options.threads > 1 ? 's' : ''}` : ''}, crop ${options.crop}, detector crop ${options.detectorCrop}`,
    timings,
    reset() {
      tracked = undefined
    },
    async run(source, width, height, out) {
      timings.detectMs = timings.detectCropMs = timings.cropMs = timings.landmarksMs = timings.blendshapesMs = timings.readMs = NaN
      uploaded = false
      const fromDetector = !tracked || options.detect === 'always'
      const roi = fromDetector ? await detect(source, width, height) : tracked
      out.roi = roi
      if (!roi) {
        out.found = false
        out.presence = 0
        tracked = undefined
        return
      }

      let t = performance.now()
      if (options.crop === 'gpu') {
        upload(source, width, height)
        gpuCropper!.crop(roi, LANDMARKS_SIZE, gpuCrop)
        toFloats(gpuCrop, landmarksInput, 0, 1)
      } else {
        cropCtx.setTransform(1, 0, 0, 1, 0, 0)
        cropCtx.fillStyle = '#000'
        cropCtx.fillRect(0, 0, LANDMARKS_SIZE, LANDMARKS_SIZE)
        // Frame → crop: inverse of the ROI placement (projectLandmarks does the forward mapping).
        cropCtx.translate(LANDMARKS_SIZE / 2, LANDMARKS_SIZE / 2)
        cropCtx.scale(LANDMARKS_SIZE / roi.size, LANDMARKS_SIZE / roi.size)
        cropCtx.rotate(-roi.rotation)
        cropCtx.translate(-roi.cx, -roi.cy)
        cropCtx.drawImage(source, 0, 0, width, height)
        toFloats(cropCtx.getImageData(0, 0, LANDMARKS_SIZE, LANDMARKS_SIZE).data, landmarksInput, 0, 1)
      }
      timings.cropMs = performance.now() - t

      t = performance.now()
      const [raw, presenceLogit] = await runModel(landmarker, [await input(landmarksInput, [1, LANDMARKS_SIZE, LANDMARKS_SIZE, 3], options.accelerator)], timings)
      timings.landmarksMs = performance.now() - t
      out.presence = 1 / (1 + Math.exp(-(presenceLogit![0] ?? -Infinity)))
      out.found = out.presence >= MIN_PRESENCE
      if (!out.found) {
        tracked = undefined
        return
      }
      projectLandmarks(raw!, roi, LANDMARKS, out.landmarks)
      tracked = landmarksToRoi(out.landmarks, LANDMARKS)

      if (blendshaper) {
        t = performance.now()
        BLENDSHAPE_LANDMARKS.forEach((index, i) => {
          blendshapesInput[i * 2] = out.landmarks[index * 3]!
          blendshapesInput[i * 2 + 1] = out.landmarks[index * 3 + 1]!
        })
        const [scores] = await runModel(blendshaper, [await input(blendshapesInput, [1, BLENDSHAPE_LANDMARKS.length, 2], options.accelerator)], timings)
        out.blendshapes.set(scores!.subarray(0, BLENDSHAPES))
        timings.blendshapesMs = performance.now() - t
      }
    },
    dispose() {
      detector.delete()
      landmarker.delete()
      blendshaper?.delete()
      gpuCropper?.dispose()
    },
  }
}
