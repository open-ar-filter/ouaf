import type { FaceLandmarkerOptions, FaceLandmarkerResult } from '@mediapipe/tasks-vision'
import {
  BLENDSHAPE_NAMES,
  BLENDSHAPES_STRIDE,
  LANDMARK_COUNT,
  LANDMARKS_STRIDE,
  MATRIX_STRIDE,
  type Delegate,
  type FaceFrame,
  type FaceTracker,
} from './face.ts'

/**
 * MediaPipe FaceLandmarker integration (VIDEO mode).
 *
 * Assets are self-hosted: nothing is fetched from a CDN. The host serves the `wasm/` directory of
 * `@mediapipe/tasks-vision` (only `vision_wasm_internal.js` and `vision_wasm_internal.wasm` are used) and the
 * `face_landmarker.task` model, and passes their URLs.
 *
 * Privacy: MediaPipe Tasks (1.2.x) unconditionally posts usage metrics (task type, delegate, latencies; no image
 * data) to `https://odml.pa.googleapis.com/v1/log` every minute, with no API to turn it off. Hosts block it with a
 * `connect-src` Content-Security-Policy that excludes that origin; MediaPipe then stops trying after one failure.
 * See docs/privacy.md.
 *
 * Delegate selection: the GPU delegate is tried first. Creating it **and** running one warm-up inference on a blank
 * frame must both succeed; otherwise the GPU landmarker is closed and a CPU one is created instead. The decision is
 * final once the promise resolves: `delegate` never changes afterwards, and errors thrown later by `detect` are
 * propagated to the caller (the `FrameScheduler` reports them through its `onError`).
 */
export interface FaceTrackerOptions {
  /** Maximum number of faces to track (MediaPipe `numFaces`). Default: 1. */
  maxFaces?: number
  /**
   * URL of the directory that holds the MediaPipe wasm files (`vision_wasm_internal.js` and
   * `vision_wasm_internal.wasm`, copied from `@mediapipe/tasks-vision/wasm`). Relative URLs resolve against the page.
   */
  wasmBaseUrl: string
  /** URL of the `face_landmarker.task` model. */
  modelUrl: string
  /** Preferred delegate. Default: `'GPU'`, with automatic fallback to CPU. `'CPU'` skips the GPU attempt. */
  delegate?: Delegate
  /** Receives non-fatal problems (GPU fallback, unexpected blendshape layout). Default: `console.warn`. */
  onWarning?: (message: string, cause?: unknown) => void
}

/** The part of MediaPipe's `FaceLandmarker` the tracker relies on (replaced by a fake in unit tests). */
export interface Landmarker {
  detectForVideo(frame: TexImageSource, timestampMs: number): FaceLandmarkerResult
  close(): void
}

/** How the tracker reaches MediaPipe. The default implementation loads `@mediapipe/tasks-vision` lazily. */
export interface LandmarkerBackend {
  /** Downloads the model once, so a CPU fallback does not download it again. */
  loadModel(url: string): Promise<Uint8Array>
  createLandmarker(wasmBaseUrl: string, options: FaceLandmarkerOptions): Promise<Landmarker>
  /** Small blank frame used for the warm-up inference that validates the delegate. */
  warmupFrame(): TexImageSource
}

/** Timestamp of the warm-up inference; real frames are shifted above it if needed (see `detect`). */
const WARMUP_TIMESTAMP_MS = 0

const mediapipeBackend: LandmarkerBackend = {
  async loadModel(url) {
    let res: Response
    try {
      res = await fetch(url)
    } catch (err) {
      throw new Error(`Could not download the face model from ${url}.`, { cause: err })
    }
    if (!res.ok) throw new Error(`Could not download the face model from ${url}: HTTP ${res.status}.`)
    // Dev servers with an SPA fallback answer missing files with the index page.
    if (res.headers.get('content-type')?.includes('text/html')) {
      throw new Error(`Could not download the face model from ${url}: the server returned an HTML page (missing file?).`)
    }
    return new Uint8Array(await res.arrayBuffer())
  },
  async createLandmarker(wasmBaseUrl, options) {
    // Loaded on demand: the MediaPipe bundle is only fetched when face tracking is requested.
    const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
    const fileset = await FilesetResolver.forVisionTasks(wasmBaseUrl.replace(/\/+$/, ''))
    return FaceLandmarker.createFromOptions(fileset, options)
  },
  warmupFrame() {
    return new ImageData(64, 64)
  },
}

/** Creates a MediaPipe face tracker. Rejects when neither the GPU nor the CPU delegate can be initialized. */
export function createFaceTracker(options: FaceTrackerOptions): Promise<FaceTracker> {
  return createFaceTrackerWith(options, mediapipeBackend)
}

/** `createFaceTracker` with an explicit backend. Internal: used by the unit tests with a fake landmarker. */
export async function createFaceTrackerWith(options: FaceTrackerOptions, backend: LandmarkerBackend): Promise<FaceTracker> {
  const maxFaces = options.maxFaces ?? 1
  if (!Number.isInteger(maxFaces) || maxFaces < 1) throw new RangeError(`maxFaces must be a positive integer, got ${maxFaces}`)
  const warn = options.onWarning ?? ((message: string, cause?: unknown) => console.warn(`[ouaf] ${message}`, cause ?? ''))
  const model = await backend.loadModel(options.modelUrl)

  const open = async (delegate: Delegate): Promise<FaceTracker> => {
    const landmarker = await backend.createLandmarker(options.wasmBaseUrl, {
      baseOptions: { modelAssetBuffer: model, delegate },
      runningMode: 'VIDEO',
      numFaces: maxFaces,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    })
    try {
      // A GPU landmarker can be created and still fail on its first inference (missing WebGL features, driver
      // bugs): validate it now, while falling back is still possible. Also moves shader compilation out of the
      // first camera frame.
      landmarker.detectForVideo(backend.warmupFrame(), WARMUP_TIMESTAMP_MS)
    } catch (err) {
      closeQuietly(landmarker)
      throw err
    }
    return new MediaPipeFaceTracker(landmarker, delegate, maxFaces, warn)
  }

  if ((options.delegate ?? 'GPU') === 'GPU') {
    try {
      return await open('GPU')
    } catch (err) {
      warn('GPU delegate unavailable, falling back to CPU face tracking.', err)
    }
  }
  return open('CPU')
}

function closeQuietly(landmarker: Landmarker): void {
  try {
    landmarker.close()
  } catch {
    // Already broken; nothing else to release.
  }
}

class MediaPipeFaceTracker implements FaceTracker {
  readonly delegate: Delegate
  readonly maxFaces: number
  #landmarker: Landmarker | undefined
  #warn: (message: string, cause?: unknown) => void
  /** Last timestamp given to MediaPipe, and the shift applied to the caller's timestamps to keep them increasing. */
  #lastTimestamp = WARMUP_TIMESTAMP_MS
  #timestampShift = 0
  /** MediaPipe blendshape index → index in `BLENDSHAPE_NAMES` (-1: unknown), built from the first result. */
  #blendshapeMap: Int8Array | undefined

  constructor(landmarker: Landmarker, delegate: Delegate, maxFaces: number, warn: (message: string, cause?: unknown) => void) {
    this.#landmarker = landmarker
    this.delegate = delegate
    this.maxFaces = maxFaces
    this.#warn = warn
  }

  /**
   * Copies MediaPipe's results into `out` without allocating on our side (MediaPipe itself allocates its result
   * objects on every call; its FaceLandmarker has no callback variant).
   *
   * - A disposed tracker, or a video without a frame yet, yields `count = 0`.
   * - MediaPipe throws on non-increasing timestamps: when `timestampMs` does not increase, every timestamp from then
   *   on is shifted so MediaPipe sees `previous + 1 ms` and the following intervals are preserved.
   * - `count` is set to 0 before inference, so an exception leaves a consistent (empty) frame.
   */
  detect(video: HTMLVideoElement, timestampMs: number, mediaTime: number, out: FaceFrame): void {
    out.count = 0
    out.mediaTime = mediaTime
    out.width = video.videoWidth
    out.height = video.videoHeight
    const landmarker = this.#landmarker
    if (!landmarker || out.width === 0 || out.height === 0) return
    if (!Number.isFinite(timestampMs)) throw new RangeError(`timestampMs must be a finite number, got ${timestampMs}`)

    let ts = timestampMs + this.#timestampShift
    if (!(ts > this.#lastTimestamp)) {
      this.#timestampShift += this.#lastTimestamp + 1 - ts
      ts = this.#lastTimestamp + 1
    }
    this.#lastTimestamp = ts

    const result = landmarker.detectForVideo(video, ts)
    const faces = result.faceLandmarks
    const blendshapes = result.faceBlendshapes
    const matrices = result.facialTransformationMatrixes
    const n = Math.min(faces.length, this.maxFaces, out.maxFaces)
    const L = out.landmarks
    const B = out.blendshapes
    const M = out.matrices

    for (let f = 0; f < n; f++) {
      // Landmarks: x, y, z per point; missing points (model without irises) are zeroed.
      const lBase = f * LANDMARKS_STRIDE
      const lEnd = lBase + LANDMARKS_STRIDE
      let k = lBase
      const points = faces[f]
      if (points) {
        const pointCount = Math.min(points.length, LANDMARK_COUNT)
        for (let i = 0; i < pointCount; i++) {
          const p = points[i]!
          L[k++] = p.x
          L[k++] = p.y
          L[k++] = p.z
        }
      }
      if (k < lEnd) L.fill(0, k, lEnd)

      // Blendshapes, placed by MediaPipe category index through the map checked on the first result.
      const bBase = f * BLENDSHAPES_STRIDE
      B.fill(0, bBase, bBase + BLENDSHAPES_STRIDE)
      const categories = blendshapes?.[f]?.categories
      if (categories) {
        const map = (this.#blendshapeMap ??= this.#buildBlendshapeMap(categories))
        for (let i = 0; i < categories.length; i++) {
          const c = categories[i]!
          const j = map[c.index] ?? -1
          if (j >= 0) B[bBase + j] = c.score
        }
      }

      // Facial transformation matrix: MediaPipe's data is already column-major (as three.js `Matrix4.fromArray`).
      const mBase = f * MATRIX_STRIDE
      const data = matrices?.[f]?.data
      if (data && data.length >= MATRIX_STRIDE) {
        for (let i = 0; i < MATRIX_STRIDE; i++) M[mBase + i] = data[i]!
      } else {
        M.fill(0, mBase, mBase + MATRIX_STRIDE)
        M[mBase] = M[mBase + 5] = M[mBase + 10] = M[mBase + 15] = 1
      }
    }
    out.count = n
  }

  /** Runs once, on the first result with blendshapes. */
  #buildBlendshapeMap(categories: FaceLandmarkerResult['faceBlendshapes'][number]['categories']): Int8Array {
    let size: number = BLENDSHAPE_NAMES.length
    for (const c of categories) size = Math.max(size, c.index + 1)
    const map = new Int8Array(size).fill(-1)
    const names: readonly string[] = BLENDSHAPE_NAMES
    let identity = categories.length === BLENDSHAPE_NAMES.length
    for (const c of categories) {
      const j = names.indexOf(c.categoryName)
      if (c.index >= 0) map[c.index] = j
      if (j !== c.index) identity = false
    }
    if (!identity) {
      const missing = names.filter((name) => !categories.some((c) => c.categoryName === name))
      this.#warn(
        `MediaPipe blendshapes differ from BLENDSHAPE_NAMES; mapping them by name.${missing.length ? ` Missing (left at 0): ${missing.join(', ')}.` : ''}`,
      )
    }
    return map
  }

  /** Closes the MediaPipe landmarker. Idempotent; `detect` then yields empty frames. */
  dispose(): void {
    const landmarker = this.#landmarker
    this.#landmarker = undefined
    if (landmarker) closeQuietly(landmarker)
  }
}
