/**
 * The two tracking variants compared by the #6 spike, behind one interface:
 *
 * - `main`: MediaPipe on the main thread, `detect` inside the frame callback (as on the main playground page);
 * - `worker`: MediaPipe in a module worker (`tracker.worker.ts`); the page captures the frame, transfers it with a
 *   result buffer from a pool, and renders the latest results it has. At most one frame is in flight: frames that
 *   arrive while the worker is busy are not sent (counted in the `dropped` column).
 */
import {
  copyFaceFrame,
  createFaceTracker,
  faceFrameByteLength,
  faceFrameView,
  type Delegate,
  type FaceFrame,
  type FaceTracker,
  type VideoFrameInfo,
} from '@ouaf/core'
import type { SampleExtras } from './metrics.ts'
import { HEADER_ERROR, HEADER_FRAME_ID, HEADER_INFERENCE_MS, HEADER_WORKER_MS, type FromWorker, type ToWorker } from './protocol.ts'

/** Self-hosted assets, served by the `ouaf-self-hosted-assets` plugin (vite.config.ts). */
const WASM_BASE_URL = 'mediapipe/wasm/'
const MODEL_URL = 'models/face_landmarker.task'

export type Mode = 'main' | 'worker'
/** How a camera frame is handed to the worker. */
export type Transfer = 'videoframe' | 'bitmap'

export interface TrackingVariant {
  readonly mode: Mode
  readonly delegate: Delegate
  /** Frame transfer actually used (worker mode). */
  readonly transfer: Transfer | undefined
  /** `now` of the frame whose results are in `faces`; `NaN` before the first result. */
  readonly resultFrameNow: number
  /**
   * Handles a camera frame: tracks it (main) or sends it to the worker (worker; results are written into `faces`
   * when they come back, between frames). Fills the spike columns of `extras` and returns the main-thread time
   * spent on tracking for this frame (ms).
   */
  frame(video: HTMLVideoElement, info: VideoFrameInfo, faces: FaceFrame, extras: SampleExtras): number
  dispose(): void
}

export interface VariantOptions {
  maxFaces: number
  delegate: Delegate
  /** Worker mode: requested frame transfer. */
  transfer: Transfer
  /** Non-fatal problems (GPU fallback, transfer fallback, worker errors). */
  onWarning: (message: string) => void
  /** Worker mode: what happened to MediaPipe's usage-metrics request inside the worker (docs/privacy.md). */
  onTelemetry: (outcome: string, detail: string) => void
}

/** The assets live at the playground root; spike pages are one level down (`/spikes/…`). */
const absolute = (path: string) => new URL(`../${path}`, location.href).href
const errorText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

export function createVariant(mode: Mode, options: VariantOptions): Promise<TrackingVariant> {
  return mode === 'worker' ? WorkerVariant.create(options) : MainVariant.create(options)
}

// ---------------------------------------------------------------------------------------------------------------
// Main thread
// ---------------------------------------------------------------------------------------------------------------

class MainVariant implements TrackingVariant {
  readonly mode = 'main'
  readonly transfer = undefined
  resultFrameNow = NaN
  readonly #tracker: FaceTracker

  private constructor(tracker: FaceTracker) {
    this.#tracker = tracker
  }

  static async create(options: VariantOptions): Promise<TrackingVariant> {
    const tracker = await createFaceTracker({
      maxFaces: options.maxFaces,
      delegate: options.delegate,
      wasmBaseUrl: absolute(WASM_BASE_URL),
      modelUrl: absolute(MODEL_URL),
      onWarning: (message, cause) => options.onWarning(cause ? `${message} (${errorText(cause)})` : message),
    })
    return new MainVariant(tracker)
  }

  get delegate(): Delegate {
    return this.#tracker.delegate
  }

  frame(video: HTMLVideoElement, info: VideoFrameInfo, faces: FaceFrame, extras: SampleExtras): number {
    const t0 = performance.now()
    this.#tracker.detect(video, info.now, info.mediaTime, faces)
    const t1 = performance.now()
    this.resultFrameNow = info.now
    extras.set('inferenceMs', t1 - t0)
    extras.set('latencyMs', t1 - info.now)
    if (info.captureTime !== undefined) extras.set('cameraLatencyMs', t1 - info.captureTime)
    extras.set('dropped', 0)
    return t1 - t0
  }

  dispose(): void {
    this.#tracker.dispose()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------------------------------------------

/** Result buffers: one in flight, one spare. Each is transferred to the worker with a frame and comes back filled. */
const POOL_SIZE = 2
const INIT_TIMEOUT_MS = 60_000

interface InFlight {
  id: number
  now: number
  captureTime: number | undefined
}

class WorkerVariant implements TrackingVariant {
  readonly mode = 'worker'
  readonly transfer: Transfer
  readonly delegate: Delegate
  resultFrameNow = NaN
  readonly #worker: Worker
  readonly #maxFaces: number
  readonly #free: ArrayBuffer[] = []
  readonly #onWarning: (message: string) => void
  readonly #onTelemetry: (outcome: string, detail: string) => void
  #inFlight: InFlight | undefined
  #nextId = 0
  #disposed = false
  /** Where results are copied when they arrive, and the sample columns they fill (set by the first `frame`). */
  #faces: FaceFrame | undefined
  #extras: SampleExtras | undefined
  /** Reused message object (its fields are overwritten before each post). */
  readonly #message: Extract<ToWorker, { type: 'frame' }>

  private constructor(worker: Worker, delegate: Delegate, transfer: Transfer, options: VariantOptions) {
    this.#worker = worker
    this.delegate = delegate
    this.transfer = transfer
    this.#maxFaces = options.maxFaces
    this.#onWarning = options.onWarning
    this.#onTelemetry = options.onTelemetry
    for (let i = 0; i < POOL_SIZE; i++) this.#free.push(new ArrayBuffer(faceFrameByteLength(options.maxFaces)))
    this.#message = { type: 'frame', frame: undefined as unknown as VideoFrame, buffer: new ArrayBuffer(0), id: 0, timestampMs: 0, mediaTime: 0 }
    worker.onmessage = (e: MessageEvent<FromWorker>) => this.#onMessage(e.data)
    worker.onerror = (e) => options.onWarning(`worker error: ${e.message}`)
  }

  static async create(options: VariantOptions): Promise<TrackingVariant> {
    let transfer = options.transfer
    if (transfer === 'videoframe' && typeof VideoFrame !== 'function') {
      options.onWarning('VideoFrame is not supported here: using createImageBitmap instead.')
      transfer = 'bitmap'
    }
    // A module worker, bundled by Vite (`worker.format: 'es'` in vite.config.ts).
    const worker = new Worker(new URL('./tracker.worker.ts', import.meta.url), { type: 'module', name: 'ouaf-tracker' })
    try {
      const ready = await new Promise<Extract<FromWorker, { type: 'ready' }>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The tracking worker did not start in time.')), INIT_TIMEOUT_MS)
        worker.onerror = (e) => {
          clearTimeout(timer)
          // A module worker that fails to load (unsupported module workers, network error) only gives an event.
          reject(new Error(`The tracking worker failed to load${e.message ? `: ${e.message}` : ''}.`))
        }
        worker.onmessage = (e: MessageEvent<FromWorker>) => {
          const msg = e.data
          if (msg.type === 'ready') {
            clearTimeout(timer)
            resolve(msg)
          } else if (msg.type === 'error' && msg.fatal) {
            clearTimeout(timer)
            reject(new Error(msg.message))
          } else if (msg.type === 'telemetry') options.onTelemetry(msg.outcome, msg.detail)
        }
        const init: ToWorker = {
          type: 'init',
          maxFaces: options.maxFaces,
          delegate: options.delegate,
          wasmBaseUrl: absolute(WASM_BASE_URL),
          modelUrl: absolute(MODEL_URL),
        }
        worker.postMessage(init)
      })
      for (const w of ready.warnings) options.onWarning(w)
      return new WorkerVariant(worker, ready.delegate, transfer, options)
    } catch (err) {
      worker.terminate()
      throw err
    }
  }

  frame(video: HTMLVideoElement, info: VideoFrameInfo, faces: FaceFrame, extras: SampleExtras): number {
    this.#faces = faces
    this.#extras = extras
    const buffer = this.#inFlight ? undefined : this.#free.pop()
    if (!buffer) {
      extras.set('dropped', 1)
      return extras.sum('captureMs', 'postMs', 'receiveMs')
    }
    extras.set('dropped', 0)
    const id = ++this.#nextId
    this.#inFlight = { id, now: info.now, captureTime: info.captureTime }
    const msg = this.#message
    msg.buffer = buffer
    msg.id = id
    msg.timestampMs = info.now
    msg.mediaTime = info.mediaTime

    if (this.transfer === 'videoframe') {
      const t0 = performance.now()
      let frame: VideoFrame
      try {
        frame = new VideoFrame(video, { timestamp: Math.round(info.mediaTime * 1e6) })
      } catch (err) {
        this.#abort(buffer, `new VideoFrame(video) failed: ${errorText(err)}`)
        return extras.sum('captureMs', 'postMs', 'receiveMs')
      }
      const t1 = performance.now()
      msg.frame = frame
      this.#worker.postMessage(msg, [frame, buffer])
      const t2 = performance.now()
      extras.set('captureMs', t1 - t0)
      extras.set('postMs', t2 - t1)
    } else {
      const t0 = performance.now()
      const pending = createImageBitmap(video)
      extras.set('captureMs', performance.now() - t0)
      pending.then(
        (bitmap) => {
          if (this.#disposed || this.#inFlight?.id !== id) {
            bitmap.close()
            return
          }
          // Sent when the bitmap is ready, between frames: the post time goes to the next sample.
          const t = performance.now()
          msg.frame = bitmap
          this.#worker.postMessage(msg, [bitmap, buffer])
          this.#extras?.addNext('postMs', performance.now() - t)
        },
        (err: unknown) => this.#abort(buffer, `createImageBitmap(video) failed: ${errorText(err)}`),
      )
    }
    return extras.sum('captureMs', 'postMs', 'receiveMs')
  }

  /** The frame could not be captured: nothing is in flight any more. */
  #abort(buffer: ArrayBuffer, message: string): void {
    this.#inFlight = undefined
    this.#free.push(buffer)
    this.#onWarning(message)
  }

  #onMessage(msg: FromWorker): void {
    if (msg.type === 'error') {
      this.#onWarning(`worker: ${msg.message}`)
      return
    }
    if (msg.type === 'telemetry') {
      this.#onTelemetry(msg.outcome, msg.detail)
      return
    }
    if (msg.type !== 'result' || this.#disposed) return
    const arrived = performance.now()
    const view = faceFrameView(msg.buffer, this.#maxFaces)
    const flight = this.#inFlight
    this.#inFlight = undefined
    const extras = this.#extras
    if (flight && view.header[HEADER_FRAME_ID] === flight.id && this.#faces && extras) {
      if (view.header[HEADER_ERROR] !== 1) {
        copyFaceFrame(view, this.#faces)
        this.resultFrameNow = flight.now
      }
      extras.setNext('inferenceMs', view.header[HEADER_INFERENCE_MS] as number)
      extras.setNext('workerMs', view.header[HEADER_WORKER_MS] as number)
      extras.setNext('latencyMs', arrived - flight.now)
      if (flight.captureTime !== undefined) extras.setNext('cameraLatencyMs', arrived - flight.captureTime)
    }
    this.#free.push(msg.buffer)
    extras?.addNext('receiveMs', performance.now() - arrived)
  }

  dispose(): void {
    this.#disposed = true
    this.#worker.terminate()
    this.#free.length = 0
  }
}
