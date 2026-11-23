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
  type RunningMode,
  type TrackerInput,
} from './face.ts'

/**
 * MediaPipe FaceLandmarker integration: VIDEO mode for video frames, IMAGE mode for still images (`detectImage`).
 *
 * Assets are self-hosted: nothing is fetched from a CDN. The host serves the `wasm/` directory of
 * `@mediapipe/tasks-vision` (only `vision_wasm_internal.js` and `vision_wasm_internal.wasm` are used, or their
 * `vision_wasm_module_internal.*` counterparts with `wasmLoader: 'module'`) and the `face_landmarker.task` model,
 * and passes their URLs.
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
  /**
   * Compute the 52 blendshapes (a second model run on every frame). Default: true. When false, `FaceFrame.blendshapes`
   * stays at 0; turn it off when no active filter uses expressions, to save time on slow devices.
   */
  blendshapes?: boolean
  /** Receives non-fatal problems (GPU fallback, unexpected blendshape layout). Default: `console.warn`. */
  onWarning?: (message: string, cause?: unknown) => void
  /**
   * Which MediaPipe wasm loader to use. `'classic'` (default) loads `vision_wasm_internal.js` with a `<script>` tag
   * (page) or `importScripts` (classic worker). Module workers have no `importScripts`: use `'module'`, which loads
   * `vision_wasm_module_internal.js` (and its `.wasm`) with `import()`; the host serves those two files too.
   */
  wasmLoader?: WasmLoader
  /**
   * Canvas MediaPipe creates its WebGL context on. Default: MediaPipe's choice (an `OffscreenCanvas` where supported,
   * a detached `<canvas>` otherwise, which does not exist in a worker: pass an `OffscreenCanvas` there).
   */
  canvas?: HTMLCanvasElement | OffscreenCanvas
}

export type WasmLoader = 'classic' | 'module'

/** The part of MediaPipe's `FaceLandmarker` the tracker relies on (replaced by a fake in unit tests). */
export interface Landmarker {
  detectForVideo(frame: TexImageSource, timestampMs: number): FaceLandmarkerResult
  /** IMAGE mode. */
  detect(image: TexImageSource): FaceLandmarkerResult
  setOptions(options: FaceLandmarkerOptions): Promise<void>
  close(): void
}

/** How the tracker reaches MediaPipe. The default implementation loads `@mediapipe/tasks-vision` lazily. */
export interface LandmarkerBackend {
  /** Downloads the model once, so a CPU fallback does not download it again. */
  loadModel(url: string): Promise<Uint8Array>
  createLandmarker(wasmBaseUrl: string, options: FaceLandmarkerOptions, loader: WasmLoader): Promise<Landmarker>
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
  async createLandmarker(wasmBaseUrl, options, loader) {
    // Loaded on demand: the MediaPipe bundle is only fetched when face tracking is requested.
    const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
    const fileset = await FilesetResolver.forVisionTasks(wasmBaseUrl.replace(/\/+$/, ''), loader === 'module')
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
    const landmarker = await backend.createLandmarker(
      options.wasmBaseUrl,
      {
        baseOptions: { modelAssetBuffer: model, delegate },
        runningMode: 'VIDEO',
        numFaces: maxFaces,
        outputFaceBlendshapes: options.blendshapes ?? true,
        outputFacialTransformationMatrixes: true,
        ...(options.canvas ? { canvas: options.canvas } : {}),
      },
      options.wasmLoader ?? 'classic',
    )
    try {
      // A GPU landmarker can be created and still fail on its first inference (missing WebGL features, driver
      // bugs): validate it now, while falling back is still possible. Also moves shader compilation out of the
      // first camera frame.
      landmarker.detectForVideo(backend.warmupFrame(), WARMUP_TIMESTAMP_MS)
    } catch (err) {
      closeQuietly(landmarker)
      throw err
    }
    return new MediaPipeFaceTracker(landmarker, delegate, maxFaces, options.blendshapes ?? true, warn)
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

/** Width in pixels of a tracker input: `videoWidth` (video), `displayWidth` (`VideoFrame`), `naturalWidth`, `width`. */
export function trackerInputWidth(source: TrackerInput): number {
  if ('videoWidth' in source) return source.videoWidth
  if ('displayWidth' in source) return source.displayWidth
  if ('naturalWidth' in source) return source.naturalWidth
  return source.width
}

/** Height in pixels of a tracker input (see `trackerInputWidth`). */
export function trackerInputHeight(source: TrackerInput): number {
  if ('videoHeight' in source) return source.videoHeight
  if ('displayHeight' in source) return source.displayHeight
  if ('naturalHeight' in source) return source.naturalHeight
  return source.height
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
  #mode: RunningMode = 'VIDEO'
  #switching: Promise<void> | undefined
  /** MediaPipe blendshape index → index in `BLENDSHAPE_NAMES` (-1: unknown), built from the first result. */
  #blendshapeMap: Int8Array | undefined
  /** Current `numFaces` and blendshapes output (`reconfigure`). */
  #numFaces: number
  #blendshapes: boolean

  constructor(landmarker: Landmarker, delegate: Delegate, maxFaces: number, blendshapes: boolean, warn: (message: string, cause?: unknown) => void) {
    this.#landmarker = landmarker
    this.delegate = delegate
    this.maxFaces = maxFaces
    this.#numFaces = maxFaces
    this.#blendshapes = blendshapes
    this.#warn = warn
  }

  get numFaces(): number {
    return this.#numFaces
  }

  get blendshapes(): boolean {
    return this.#blendshapes
  }

  async reconfigure(options: { numFaces?: number; blendshapes?: boolean }): Promise<void> {
    while (this.#switching) await this.#switching
    const landmarker = this.#landmarker
    if (!landmarker) return
    const numFaces = Math.max(1, Math.min(this.maxFaces, Math.trunc(options.numFaces ?? this.#numFaces)))
    const blendshapes = options.blendshapes ?? this.#blendshapes
    if (numFaces === this.#numFaces && blendshapes === this.#blendshapes) return
    this.#switching = landmarker.setOptions({ numFaces, outputFaceBlendshapes: blendshapes, runningMode: this.#mode }).then(() => {
      this.#numFaces = numFaces
      this.#blendshapes = blendshapes
    })
    try {
      await this.#switching
    } finally {
      this.#switching = undefined
    }
  }

  /**
   * Copies MediaPipe's results into `out` without allocating on our side (MediaPipe itself allocates its result
   * objects on every call; its FaceLandmarker has no callback variant).
   *
   * - A disposed tracker, or a video without a frame yet, yields `count = 0`. The frame size is read from
   *   `videoWidth`/`videoHeight` (video), `displayWidth`/`displayHeight` (`VideoFrame`) or `width`/`height`.
   * - MediaPipe throws on non-increasing timestamps: when `timestampMs` does not increase, every timestamp from then
   *   on is shifted so MediaPipe sees `previous + 1 ms` and the following intervals are preserved.
   * - `count` is set to 0 before inference, so an exception leaves a consistent (empty) frame.
   */
  detect(source: TrackerInput, timestampMs: number, mediaTime: number, out: FaceFrame): void {
    const landmarker = this.#begin(source, mediaTime, out)
    if (!landmarker) return
    if (!Number.isFinite(timestampMs)) throw new RangeError(`timestampMs must be a finite number, got ${timestampMs}`)
    if (this.#mode !== 'VIDEO') throw new Error('The face tracker is in IMAGE mode: call setRunningMode("VIDEO") before detect().')

    let ts = timestampMs + this.#timestampShift
    if (!(ts > this.#lastTimestamp)) {
      this.#timestampShift += this.#lastTimestamp + 1 - ts
      ts = this.#lastTimestamp + 1
    }
    this.#lastTimestamp = ts
    this.#write(landmarker.detectForVideo(source, ts), out)
  }

  get runningMode(): RunningMode {
    return this.#mode
  }

  async setRunningMode(mode: RunningMode): Promise<void> {
    while (this.#switching) await this.#switching
    const landmarker = this.#landmarker
    if (mode === this.#mode || !landmarker) return
    this.#switching = landmarker.setOptions({ runningMode: mode }).then(() => {
      this.#mode = mode
    })
    try {
      await this.#switching
    } finally {
      this.#switching = undefined
    }
  }

  async resetState(): Promise<void> {
    while (this.#switching) await this.#switching
    // MediaPipe rebuilds its graph on every setOptions, which drops the regions tracked from the previous frames.
    await this.#landmarker?.setOptions({ runningMode: this.#mode })
  }

  async detectImage(source: TrackerInput, mediaTime: number, out: FaceFrame): Promise<void> {
    out.count = 0
    await this.setRunningMode('IMAGE')
    const landmarker = this.#begin(source, mediaTime, out)
    if (!landmarker) return
    this.#write(landmarker.detect(source), out)
  }

  /** Resets `out` for `source`; returns the landmarker when there is something to track. */
  #begin(source: TrackerInput, mediaTime: number, out: FaceFrame): Landmarker | undefined {
    out.count = 0
    out.mediaTime = mediaTime
    out.width = trackerInputWidth(source)
    out.height = trackerInputHeight(source)
    const landmarker = this.#landmarker
    if (!landmarker || out.width === 0 || out.height === 0) return undefined
    return landmarker
  }

  #write(result: FaceLandmarkerResult, out: FaceFrame): void {
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
