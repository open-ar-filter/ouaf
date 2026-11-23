/**
 * Face tracker on our own pipeline on LiteRT.js, in a dedicated worker (docs/decisions/face-runtime.md,
 * tracking-worker.md). Page side: frames are captured (`VideoFrame`, or `ImageBitmap` where `VideoFrame` is missing)
 * and transferred to the worker with a result buffer, which comes back filled. The main thread only pays the capture
 * and the copy of the result (≈ 0.1 ms on desktop).
 *
 * Scheduling: the engine calls `track` on the newest frame once the previous call has completed, and `offer`s the
 * frames that come meanwhile (eager tracker, `TrackingHub`). An offered frame is posted at once: the worker queues the
 * newest one (dropping an older one) and starts it as soon as its run ends, without waiting for the result to reach
 * the page and the page to answer with a frame, a round trip of ≈ 25 ms on a busy main thread. The next `track` on the
 * same source then takes that frame's result (`FaceFrame.mediaTime` says which frame it is), or its run in progress.
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
import type { Capability } from '../engine/governor.ts'
import type { Crop, Readback } from './pipeline.ts'
import { RESULT_FLOATS, type FromWorker, type ReadyMessage, type ResultMessage, type ToWorker } from './protocol.ts'

export type FrameTransfer = 'videoframe' | 'bitmap'

export interface LiteRtTrackerOptions {
  /** Crops on WebGL2 (`gpu`, default, with a 2D-canvas fallback) or on a 2D canvas (`canvas`, to test the fallback). */
  crop?: Crop
  /**
   * WebGL2 crops: `async` (default) readback, the crop read back while the landmark model runs on the previous
   * frame (results one frame late, see `PipelineOptions.readback`), or `sync`.
   */
  readback?: Readback
  /** How frames reach the worker: `videoframe` (default, `ImageBitmap` where missing) or `bitmap`. */
  transfer?: FrameTransfer
  /**
   * Camera frames: `track` (default) reads them in the worker straight from the camera's track (a
   * `MediaStreamTrackProcessor`'s stream, transferred), where available and when they match the video element;
   * `element` captures them from the `<video>` like other sources. Converting a `<video>`'s frame in the worker
   * waits for the page's main thread: 17 ms on an idle desktop, ≈ 60 ms with its main thread throttled 4×.
   */
  frames?: 'track' | 'element'
  /**
   * Post the frames `offer`ed while the worker runs (default true). `false`: one frame at a time, the next one only
   * once the page has the previous result (to measure what the queue gains).
   */
  queue?: boolean
  /** Starts the worker. Default: the module worker `face.worker.ts` next to this file. Tests pass a fake. */
  createWorker?: () => Worker
}

/** Time allowed for the worker to load the runtime and the models. */
const INIT_TIMEOUT_MS = 60_000
/** Weight of a new result in the moving averages of `timings` (≈ the last 8 results). */
const TIMING_WEIGHT = 1 / 8

/**
 * Mean time per result of each step (ms, moving average over ≈ 8 results): `captureMs` (`VideoFrame` /
 * `ImageBitmap`, main thread), `toWorkerMs` (message hand-off), `queueMs` (waiting in the worker for the run before),
 * `idleMs` (the worker without a frame before this run: it waits for the page), `workerMs` (the run), of which
 * `detectMs`, `cropMs`, `landmarksMs`, `blendshapesMs` (0 when a stage did not run; `uploadMs`, the frame's upload
 * to the GPU, is part of the first of detect or crop; `readMs` and `convertMs` are the crop's readback and its
 * conversion to the model's floats), `toPageMs` (hand-off back),
 * `resultMs` (copying the result and fitting the matrix, main thread), `totalMs` (capture to result).
 */
export type LiteRtTimings = {
  captureMs: number
  toWorkerMs: number
  queueMs: number
  idleMs: number
  workerMs: number
  detectMs: number
  uploadMs: number
  cropMs: number
  readMs: number
  convertMs: number
  landmarksMs: number
  blendshapesMs: number
  toPageMs: number
  resultMs: number
  totalMs: number
}

const SHEDS: readonly Capability[] = ['blendshapes']
/** Frames posted to the worker and not back yet: the one running and one waiting. */
const MAX_FLIGHTS = 2

/** A time comparable across the page and its worker (each has its own `performance.timeOrigin`). */
const wallNow = (): number => performance.timeOrigin + performance.now()

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
      worker.postMessage({ type: 'init', assetsBaseUrl, crop: options.crop ?? 'gpu', readback: options.readback ?? 'async' } satisfies ToWorker)
    })
  } catch (err) {
    worker.terminate()
    throw err
  }
  for (const w of ready.warnings) env.warn(w)
  if (config.maxFaces > 1) env.warn(`The LiteRT.js face tracker tracks one face (${config.maxFaces} asked).`)
  const tracker = new LiteRtFrameTracker(worker, ready.crop, transfer, config, env, options.queue ?? true, options.frames ?? 'track')
  tracker.readback = ready.readback
  return tracker
}

/** A frame posted to the worker, until its result comes back. */
interface Flight {
  readonly id: number
  /** What it was captured from: a call takes the result of a frame of its own source only. */
  readonly input: TrackerInput
  readonly mediaTime: number
  readonly width: number
  readonly height: number
  /** `performance.now()` when the capture started, and `wallNow()` when it was posted. */
  readonly capturedAt: number
  /** A file source's frame: its own result, no async readback. */
  readonly exact: boolean
  captureMs: number
  sentAt: number
}

/** The engine's call in flight: it gets the result of frame `id`. */
interface Claim {
  id: number
  readonly out: FaceFrame
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

/** `FrameTracker` side of the worker. */
export class LiteRtFrameTracker implements FrameTracker {
  readonly crop: Crop
  readonly transfer: FrameTransfer
  /** WebGL2 crops' readback in use (`LiteRtTrackerOptions.readback`). */
  readback: Readback = 'sync'
  /** Media time and size of the recent frames: an async readback's result describes an earlier frame. */
  readonly #recent = new Map<number, { mediaTime: number; width: number; height: number }>()
  /** Mean time per result of each step (`LiteRtTimings`). */
  readonly timings: LiteRtTimings = {
    captureMs: 0,
    toWorkerMs: 0,
    queueMs: 0,
    idleMs: 0,
    workerMs: 0,
    detectMs: 0,
    uploadMs: 0,
    cropMs: 0,
    readMs: 0,
    convertMs: 0,
    landmarksMs: 0,
    blendshapesMs: 0,
    toPageMs: 0,
    resultMs: 0,
    totalMs: 0,
  }
  /** This result's steps, folded into `timings`. */
  readonly #step: LiteRtTimings = { ...this.timings }
  #results = 0
  readonly #worker: Worker
  readonly #env: TrackerEnv
  readonly #queue: boolean
  #config: TrackerConfig
  /** Free result buffers, transferred back and forth. */
  readonly #free: ArrayBuffer[] = [new ArrayBuffer(RESULT_FLOATS * 4), new ArrayBuffer(RESULT_FLOATS * 4)]
  readonly #flights = new Map<number, Flight>()
  /** The newest frame posted (0: none since the last reset): the one a call takes. */
  #latest = 0
  #claim: Claim | undefined
  /** The result of the newest frame, come before a call took it. */
  #ready: { flight: Flight; msg: ResultMessage } | undefined
  #nextId = 0
  #reset = false
  /** The camera track whose frames the worker reads (`frames: 'track'`), and whether that is off for good. */
  #streamTrack: MediaStreamTrack | undefined
  #streamOff: boolean
  #failed: Error | undefined
  #disposed = false
  readonly #warned = new Set<string>()

  constructor(worker: Worker, crop: Crop, transfer: FrameTransfer, config: TrackerConfig, env: TrackerEnv, queue = true, frames: 'track' | 'element' = 'track') {
    this.#streamOff = frames === 'element'
    this.#worker = worker
    this.crop = crop
    this.transfer = transfer
    this.#config = config
    this.#env = env
    this.#queue = queue
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
    const frames = this.#streamTrack ? 'camera track' : this.transfer === 'videoframe' ? 'VideoFrame' : 'ImageBitmap'
    const crops = this.crop === 'gpu' ? (this.readback === 'async' ? 'WebGL2 crops read back async' : 'WebGL2 crops') : '2D-canvas crops'
    return `LiteRT.js wasm in a worker, ${crops}, ${frames}${this.#queue ? '' : ', no queue'}`
  }

  /** Runs on the newest frame as soon as the previous run completes: the main thread is not blocked meanwhile. */
  get eager(): boolean {
    return true
  }

  /** Only blendshapes make it faster when dropped: one face, and crops from the full frame whatever its resolution. */
  get sheds(): readonly Capability[] {
    return SHEDS
  }

  /** The worker died or failed: every call fails from now on. */
  get broken(): boolean {
    return this.#failed !== undefined
  }

  configure(config: TrackerConfig): void {
    this.#config = config
  }

  track(input: TrackerInput, _timestampMs: number, mediaTime: number, out: FaceFrame, exact = false): void | Promise<void> {
    out.count = 0
    out.mediaTime = mediaTime
    out.width = trackerInputWidth(input)
    out.height = trackerInputHeight(input)
    if (this.#failed) throw this.#failed
    if (this.#disposed) return
    if (this.#claim) throw new Error('A LiteRT.js face tracking call is already in flight.')
    // The newest frame offered from this source: its result, or its run in progress.
    const ready = this.#ready
    if (!exact && ready && ready.flight.id === this.#latest && ready.flight.input === input) {
      this.#ready = undefined
      this.#write(ready.flight, ready.msg, out)
      this.#free.push(ready.msg.buffer)
      // The worker is idle: start it on the current frame for the next call.
      this.offer(input, 0, mediaTime)
      return
    }
    const latest = this.#flights.get(this.#latest)
    if (!exact && latest && latest.input === input) return this.#claimFlight(latest.id, out)
    if (out.width === 0 || out.height === 0) return
    const id = this.#send(input, mediaTime, out.width, out.height, exact)
    return id === undefined ? undefined : this.#claimFlight(id, out)
  }

  /** A frame that came while a call is in flight: posted now, so that the worker starts it as soon as it is free. */
  offer(input: TrackerInput, _timestampMs: number, mediaTime: number): void {
    // One frame waiting behind the run at most: more would only pile up (the worker reads its messages between runs)
    // and hold decoded video frames.
    if (!this.#queue || this.#failed || this.#disposed || this.#flights.size >= MAX_FLIGHTS) return
    const width = trackerInputWidth(input)
    const height = trackerInputHeight(input)
    if (width === 0 || height === 0) return
    this.#send(input, mediaTime, width, height)
  }

  trackImage(input: TrackerInput, mediaTime: number, out: FaceFrame): void | Promise<void> {
    // A still image: from the detector, nothing carried over.
    this.reset()
    return this.track(input, 0, mediaTime, out, true)
  }

  reset(): void {
    // Frames in flight belong to the previous run: their results are dropped.
    this.#reset = true
    this.#latest = 0
    if (this.#ready) this.#free.push(this.#ready.msg.buffer)
    this.#ready = undefined
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#worker.terminate()
    const claim = this.#claim
    this.#claim = undefined
    claim?.resolve() // the engine drops results of a disposed tracker
  }

  #claimFlight(id: number, out: FaceFrame): Promise<void> {
    return new Promise<void>((resolve, reject) => (this.#claim = { id, out, resolve, reject }))
  }

  /**
   * Whether the worker reads `input`'s frames from its camera track (`frames: 'track'`): a `<video>` playing a live
   * `MediaStream`, where `MediaStreamTrackProcessor` exists. Opens the stream on a new track.
   */
  #fromTrack(input: TrackerInput): boolean {
    if (this.#streamOff || typeof HTMLVideoElement === 'undefined' || !(input instanceof HTMLVideoElement)) return false
    const source = input.srcObject
    if (typeof MediaStream === 'undefined' || !(source instanceof MediaStream)) return false
    const track = source.getVideoTracks()[0]
    if (!track || track.readyState !== 'live') return false
    if (track === this.#streamTrack) return true
    const Processor = (globalThis as { MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor
    if (typeof Processor !== 'function') {
      this.#streamOff = true
      return false
    }
    try {
      const { readable } = new Processor({ track })
      this.#worker.postMessage({ type: 'stream', readable } satisfies ToWorker, [readable as unknown as Transferable])
    } catch (err) {
      this.#streamOff = true
      this.#warnOnce(`The face tracker reads the camera through the video element: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
    this.#streamTrack = track
    return true
  }

  /** Captures and posts a frame; returns its id, undefined when it could not be captured. */
  #send(input: TrackerInput, mediaTime: number, width: number, height: number, exact = false): number | undefined {
    const capturedAt = performance.now()
    const id = ++this.#nextId
    const flight: Flight = { id, input, mediaTime, width, height, capturedAt, exact, captureMs: 0, sentAt: Number.NaN }
    this.#flights.set(id, flight)
    this.#latest = id
    this.#recent.set(id, { mediaTime, width, height })
    this.#recent.delete(id - 8)
    // A camera: the worker takes its newest frame from the track itself.
    if (this.#fromTrack(input)) {
      this.#post(flight, undefined)
      return id
    }
    // Synchronous capture where possible: the frame is the one current now, not a later one.
    const frame = this.transfer === 'videoframe' ? captureVideoFrame(input, mediaTime) : undefined
    if (frame) this.#post(flight, frame)
    else {
      // `new Promise` so that a synchronous throw (no `createImageBitmap`) is handled like a rejection.
      new Promise<ImageBitmap>((resolve) => resolve(createImageBitmap(input))).then(
        (bitmap) => this.#post(flight, bitmap),
        (err: unknown) => {
          // A frame that cannot be read (a video between two sources): no face this time.
          this.#warnOnce(`The face tracker could not capture a frame: ${err instanceof Error ? err.message : String(err)}`)
          this.#lost(flight)
        },
      )
    }
    return id
  }

  #post(flight: Flight, frame: VideoFrame | ImageBitmap | undefined): void {
    if (this.#disposed || !this.#flights.has(flight.id)) {
      frame?.close()
      return
    }
    const buffer = this.#free.pop() ?? new ArrayBuffer(RESULT_FLOATS * 4)
    const reset = this.#reset
    this.#reset = false
    flight.captureMs = performance.now() - flight.capturedAt
    flight.sentAt = wallNow()
    const message: ToWorker = {
      type: 'frame',
      id: flight.id,
      ...(frame ? { frame } : {}),
      width: flight.width,
      height: flight.height,
      blendshapes: this.#config.blendshapes,
      reset,
      ...(flight.exact ? { exact: true } : {}),
      buffer,
      sentAt: flight.sentAt,
    }
    try {
      this.#worker.postMessage(message, frame ? [frame, buffer] : [buffer])
    } catch (err) {
      frame?.close()
      this.#free.push(buffer)
      this.#fail(new Error('Could not send a frame to the LiteRT.js face tracker.', { cause: err }))
    }
  }

  /** A frame that never ran (not captured, or dropped by the worker for a newer one). */
  #lost(flight: Flight): void {
    this.#flights.delete(flight.id)
    const claim = this.#claim
    if (claim?.id !== flight.id) return
    // The call takes the newer frame that replaced it, or ends without a face.
    const newer = this.#flights.get(this.#latest)
    if (newer && newer.id !== flight.id) claim.id = newer.id
    else {
      this.#claim = undefined
      claim.resolve()
    }
  }

  #onResult(msg: ResultMessage): void {
    const receivedAt = performance.now()
    const receivedWall = wallNow()
    for (const w of msg.warnings) this.#env.warn(w)
    const flight = this.#flights.get(msg.id)
    if (!flight) {
      this.#free.push(msg.buffer)
      return
    }
    if (msg.dropped) {
      this.#free.push(msg.buffer)
      this.#lost(flight)
      return
    }
    if (msg.streamUnusable) {
      // From now on frames are captured from the video element; this one is lost.
      this.#streamOff = true
      this.#streamTrack = undefined
      this.#warnOnce(`The face tracker reads the camera through the video element: ${msg.streamUnusable}.`)
      this.#free.push(msg.buffer)
      this.#lost(flight)
      return
    }
    this.#flights.delete(msg.id)
    if (msg.error) this.#warnOnce(`LiteRT.js face tracking failed on a frame: ${msg.error}`)
    const s = this.#step
    s.captureMs = flight.captureMs
    s.toWorkerMs = msg.receivedAt - flight.sentAt
    s.queueMs = msg.startedAt - msg.receivedAt
    s.idleMs = msg.idleMs
    s.workerMs = msg.postedAt - msg.startedAt
    s.detectMs = msg.timings.detectMs || 0
    s.uploadMs = msg.timings.uploadMs || 0
    s.cropMs = msg.timings.cropMs || 0
    s.readMs = msg.timings.readMs || 0
    s.convertMs = msg.timings.convertMs || 0
    s.landmarksMs = msg.timings.landmarksMs || 0
    s.blendshapesMs = msg.timings.blendshapesMs || 0
    s.toPageMs = receivedWall - msg.postedAt
    const claim = this.#claim
    if (claim?.id === msg.id) {
      this.#claim = undefined
      this.#write(flight, msg, claim.out)
      this.#free.push(msg.buffer)
      this.#fold(receivedAt, flight)
      claim.resolve()
    } else if (msg.id === this.#latest) {
      // Ahead of the engine's call: kept for it.
      if (this.#ready) this.#free.push(this.#ready.msg.buffer)
      this.#ready = { flight, msg }
      this.#fold(receivedAt, flight)
    } else this.#free.push(msg.buffer) // superseded by a newer frame, or from before a reset
  }

  /** Writes the result of `flight` into `out` (of an earlier frame with the async readback: its time and size). */
  #write(flight: Flight, msg: ResultMessage, out: FaceFrame): void {
    const frame = (msg.frame !== flight.id && this.#recent.get(msg.frame)) || flight
    out.count = 0
    out.mediaTime = frame.mediaTime
    out.width = frame.width
    out.height = frame.height
    if (!msg.found) return
    const data = new Float32Array(msg.buffer, 0, RESULT_FLOATS)
    out.landmarks.set(data.subarray(0, LANDMARKS_STRIDE), 0)
    if (msg.hasBlendshapes) out.blendshapes.set(data.subarray(LANDMARKS_STRIDE, LANDMARKS_STRIDE + BLENDSHAPES_STRIDE), 0)
    else out.blendshapes.fill(0, 0, BLENDSHAPES_STRIDE)
    if (!estimateFacePose(out, 0, out.matrices, 0)) out.matrices.fill(0, 0, MATRIX_STRIDE)
    out.count = 1
  }

  /** Adds this result's steps to the moving averages (the first result sets them). */
  #fold(receivedAt: number, flight: Flight): void {
    const now = performance.now()
    this.#step.resultMs = now - receivedAt
    this.#step.totalMs = now - flight.capturedAt
    const k = this.#results++ === 0 ? 1 : TIMING_WEIGHT
    const t = this.timings as Record<string, number>
    const c = this.#step as Record<string, number>
    for (const key in t) {
      const v = c[key]!
      if (Number.isFinite(v)) t[key] = t[key]! + (v - t[key]!) * k
    }
  }

  /** The worker is gone: the call in flight and every later one fail. */
  #fail(error: Error): void {
    if (this.#disposed) return
    this.#failed ??= error
    const claim = this.#claim
    this.#claim = undefined
    claim?.reject(error)
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
