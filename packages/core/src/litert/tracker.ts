/**
 * Face tracker on our own pipeline on LiteRT.js, in a dedicated worker (docs/decisions/face-runtime.md,
 * tracking-worker.md). Page side: each `track` captures the frame (`VideoFrame`, or `ImageBitmap` where `VideoFrame`
 * is missing), transfers it to the worker with a result buffer and resolves when the worker sends the buffer back;
 * the engine runs it eagerly on the newest frame, one frame in flight (`TrackingHub`). The main thread only pays the
 * capture and the copy of the result (≈ 0.1 ms on desktop).
 *
 * One face (`maxFaces` > 1: MediaPipe, until multi-face lands, #165). Landmarks and blendshapes in the `FaceFrame`
 * layout of the MediaPipe tracker; the facial transformation matrix is fitted to the landmarks on the main thread
 * (`estimateFacePose`, MediaPipe's geometry pipeline). Blendshapes are skipped while the engine does not want them
 * (`TrackerConfig.blendshapes`). The analysis resolution is ignored: the crops are taken from the full frame on the
 * GPU, whose cost does not depend on its size.
 *
 * Files, under `assetsBaseUrl`: `litert/wasm/litert_wasm_internal.{js,wasm}` (or the `_compat_` build where relaxed
 * SIMD is missing) from `@litertjs/core/wasm`, and `models/face_detector.tflite`, `models/face_landmarks_detector.tflite`,
 * `models/face_blendshapes.tflite` (extracted from `face_landmarker.task`). Nothing else is fetched (docs/privacy.md).
 */
import { estimateFacePose } from '../anchoring/face-pose.ts'
import { BLENDSHAPES_STRIDE, LANDMARKS_STRIDE, MATRIX_STRIDE, type FaceFrame, type TrackerInput } from '../face.ts'
import { trackerInputHeight, trackerInputWidth } from '../face-tracker.ts'
import type { FaceTrackerImpl, FrameTracker, TrackerConfig, TrackerEnv } from '../engine/plugin.ts'
import type { Crop, StageTimings } from './pipeline.ts'
import { RESULT_FLOATS, type FromWorker, type ReadyMessage, type ResultMessage, type ToWorker } from './protocol.ts'

export type FrameTransfer = 'videoframe' | 'bitmap'

export interface LiteRtTrackerOptions {
  /** Crops on WebGL2 (`gpu`, default, with a 2D-canvas fallback) or on a 2D canvas (`canvas`, to test the fallback). */
  crop?: Crop
  /** How frames reach the worker: `videoframe` (default, `ImageBitmap` where missing) or `bitmap`. */
  transfer?: FrameTransfer
  /** Starts the worker. Default: the module worker `face.worker.ts` next to this file. Tests pass a fake. */
  createWorker?: () => Worker
}

/** Time allowed for the worker to load the runtime and the models. */
const INIT_TIMEOUT_MS = 60_000

/**
 * Starts the LiteRT.js face tracker's worker (default `createWorker`). Bundlers that do not emit workers from this
 * pattern (Rolldown, esbuild) bundle `@ouaf/core/face-worker` themselves and pass `createWorker` (`ouaf preview` does).
 */
export function createLiteRtWorker(): Worker {
  // Vite and webpack 5 emit the worker as a separate script from this pattern.
  return new Worker(new URL('./face.worker.ts', import.meta.url), { type: 'module', name: 'ouaf-face-tracker' })
}

/** Starts the worker and waits until its models are loaded. */
export async function openLiteRtTracker(config: TrackerConfig, env: TrackerEnv, options: LiteRtTrackerOptions = {}): Promise<LiteRtFrameTracker> {
  if (typeof Worker !== 'function') throw new Error('Web Workers are not available here.')
  let transfer = options.transfer ?? 'videoframe'
  if (transfer === 'videoframe' && typeof VideoFrame !== 'function') transfer = 'bitmap'
  const worker = (options.createWorker ?? createLiteRtWorker)()
  let ready: ReadyMessage
  try {
    ready = await new Promise<ReadyMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The LiteRT.js face tracker did not start in time.')), INIT_TIMEOUT_MS)
      worker.onerror = (e) => {
        clearTimeout(timer)
        e.preventDefault?.()
        reject(new Error(`The LiteRT.js face tracker's worker failed to load${e.message ? `: ${e.message}` : ''}.`))
      }
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const msg = e.data
        if (msg.type === 'ready') {
          clearTimeout(timer)
          resolve(msg)
        } else if (msg.type === 'error') {
          clearTimeout(timer)
          reject(new Error(`The LiteRT.js face tracker could not start: ${msg.message}`))
        }
      }
      const assetsBaseUrl = new URL(env.assetsBaseUrl, typeof location === 'undefined' ? undefined : location.href).href
      worker.postMessage({ type: 'init', assetsBaseUrl, crop: options.crop ?? 'gpu' } satisfies ToWorker)
    })
  } catch (err) {
    worker.terminate()
    throw err
  }
  for (const w of ready.warnings) env.warn(w)
  if (config.maxFaces > 1) env.warn(`The LiteRT.js face tracker tracks one face (${config.maxFaces} asked).`)
  return new LiteRtFrameTracker(worker, ready.crop, transfer, config, env)
}

interface Pending {
  id: number
  out: FaceFrame
  resolve(): void
  reject(error: Error): void
}

/** `FrameTracker` side of the worker. */
export class LiteRtFrameTracker implements FrameTracker {
  readonly crop: Crop
  readonly transfer: FrameTransfer
  /** Stage timings of the last result (worker clock, ms). */
  readonly timings: StageTimings = { detectMs: NaN, cropMs: NaN, landmarksMs: NaN, blendshapesMs: NaN }
  readonly #worker: Worker
  readonly #env: TrackerEnv
  #config: TrackerConfig
  /** Free result buffers, transferred back and forth. */
  readonly #free: ArrayBuffer[] = [new ArrayBuffer(RESULT_FLOATS * 4), new ArrayBuffer(RESULT_FLOATS * 4)]
  #pending: Pending | undefined
  #nextId = 0
  #reset = false
  #failed: Error | undefined
  #disposed = false
  readonly #warned = new Set<string>()

  constructor(worker: Worker, crop: Crop, transfer: FrameTransfer, config: TrackerConfig, env: TrackerEnv) {
    this.#worker = worker
    this.crop = crop
    this.transfer = transfer
    this.#config = config
    this.#env = env
    worker.onerror = (e) => {
      e.preventDefault?.()
      this.#fail(new Error(`The LiteRT.js face tracker's worker failed${e.message ? `: ${e.message}` : ''}.`))
    }
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data
      if (msg.type === 'result') this.#onResult(msg)
      else if (msg.type === 'error') this.#fail(new Error(`The LiteRT.js face tracker failed: ${msg.message}`))
    }
  }

  get description(): string {
    return `LiteRT.js wasm in a worker, ${this.crop === 'gpu' ? 'WebGL2' : '2D-canvas'} crops, ${this.transfer === 'videoframe' ? 'VideoFrame' : 'ImageBitmap'}`
  }

  /** Runs on the newest frame as soon as the previous run completes: the main thread is not blocked meanwhile. */
  get eager(): boolean {
    return true
  }

  /** The worker died or failed: every call fails from now on. */
  get broken(): boolean {
    return this.#failed !== undefined
  }

  configure(config: TrackerConfig): void {
    this.#config = config
  }

  track(input: TrackerInput, _timestampMs: number, mediaTime: number, out: FaceFrame): void | Promise<void> {
    out.count = 0
    out.mediaTime = mediaTime
    out.width = trackerInputWidth(input)
    out.height = trackerInputHeight(input)
    if (this.#failed) throw this.#failed
    if (this.#disposed || out.width === 0 || out.height === 0) return
    if (this.#pending) throw new Error('A LiteRT.js face tracking call is already in flight.')
    const buffer = this.#free.pop() ?? new ArrayBuffer(RESULT_FLOATS * 4)
    const done = new Promise<void>((resolve, reject) => (this.#pending = { id: ++this.#nextId, out, resolve, reject }))
    const id = this.#nextId
    // Synchronous capture where possible: the frame is the one current now, not a later one.
    const frame = this.transfer === 'videoframe' ? captureVideoFrame(input, mediaTime) : undefined
    if (frame) this.#post(id, frame, buffer, out)
    else {
      // `new Promise` so that a synchronous throw (no `createImageBitmap`) is handled like a rejection.
      new Promise<ImageBitmap>((resolve) => resolve(createImageBitmap(input))).then(
        (bitmap) => this.#post(id, bitmap, buffer, out),
        (err: unknown) => {
          this.#free.push(buffer)
          const p = this.#pending
          if (p?.id !== id) return
          this.#pending = undefined
          // A frame that cannot be read (a video between two sources): no face this time.
          this.#warnOnce(`The face tracker could not capture a frame: ${err instanceof Error ? err.message : String(err)}`)
          p.resolve()
        },
      )
    }
    return done
  }

  trackImage(input: TrackerInput, mediaTime: number, out: FaceFrame): void | Promise<void> {
    // A still image: from the detector, nothing carried over.
    this.#reset = true
    return this.track(input, 0, mediaTime, out)
  }

  reset(): void {
    this.#reset = true
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#worker.terminate()
    const p = this.#pending
    this.#pending = undefined
    p?.resolve() // the engine drops results of a disposed tracker
  }

  #post(id: number, frame: VideoFrame | ImageBitmap, buffer: ArrayBuffer, out: FaceFrame): void {
    if (this.#disposed || this.#pending?.id !== id) {
      frame.close()
      this.#free.push(buffer)
      return
    }
    const reset = this.#reset
    this.#reset = false
    const message: ToWorker = { type: 'frame', id, frame, width: out.width, height: out.height, blendshapes: this.#config.blendshapes, reset, buffer }
    try {
      this.#worker.postMessage(message, [frame, buffer])
    } catch (err) {
      frame.close()
      this.#free.push(buffer)
      this.#fail(new Error('Could not send a frame to the LiteRT.js face tracker.', { cause: err }))
    }
  }

  #onResult(msg: ResultMessage): void {
    for (const w of msg.warnings) this.#env.warn(w)
    Object.assign(this.timings, msg.timings)
    const p = this.#pending
    if (!p || p.id !== msg.id) {
      this.#free.push(msg.buffer)
      return
    }
    this.#pending = undefined
    if (msg.error) this.#warnOnce(`LiteRT.js face tracking failed on a frame: ${msg.error}`)
    const out = p.out
    if (msg.found) {
      const data = new Float32Array(msg.buffer, 0, RESULT_FLOATS)
      out.landmarks.set(data.subarray(0, LANDMARKS_STRIDE), 0)
      if (msg.hasBlendshapes) out.blendshapes.set(data.subarray(LANDMARKS_STRIDE, LANDMARKS_STRIDE + BLENDSHAPES_STRIDE), 0)
      else out.blendshapes.fill(0, 0, BLENDSHAPES_STRIDE)
      if (!estimateFacePose(out, 0, out.matrices, 0)) out.matrices.fill(0, 0, MATRIX_STRIDE)
      out.count = 1
    }
    this.#free.push(msg.buffer)
    p.resolve()
  }

  /** The worker is gone: the call in flight and every later one fail. */
  #fail(error: Error): void {
    if (this.#disposed) return
    this.#failed ??= error
    const p = this.#pending
    this.#pending = undefined
    p?.reject(error)
  }

  #warnOnce(message: string): void {
    if (this.#warned.has(message)) return
    this.#warned.add(message)
    this.#env.warn(message)
  }
}

/** A `VideoFrame` of `input` to transfer (a copy for a `VideoFrame`: the caller owns it); undefined when unsupported. */
function captureVideoFrame(input: TrackerInput, mediaTime: number): VideoFrame | undefined {
  try {
    if (input instanceof VideoFrame) return input.clone()
    // The timestamp only labels the frame (required for images and canvases).
    return new VideoFrame(input, { timestamp: Math.round(mediaTime * 1e6) })
  } catch {
    return undefined // e.g. an `<img>` not decoded yet: `createImageBitmap` reports why
  }
}

/** Face tracker on LiteRT.js in a worker, alone (no benchmark, no fallback): `createEngine({ plugins: [...] })`. */
export function createLiteRtFaceTracker(options: LiteRtTrackerOptions = {}): FaceTrackerImpl {
  return {
    id: 'litert',
    cost: { typicalMs: 15 },
    create: (config, env) => openLiteRtTracker(config, env, options),
  }
}
