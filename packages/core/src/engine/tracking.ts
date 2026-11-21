/**
 * Face tracking shared by the whole stack (spec §7): started only when an active filter needs it (spec §4.1),
 * configured with the union of the filters' needs, and run eagerly on the newest frame (one frame in flight).
 *
 * Results are double-buffered: the tracker writes into the back `FaceFrame`; when the call completes, the buffers
 * swap and the new front is what layers read from the next rendered frame on. The tracking rate (completed results
 * per second over a sliding window, spec §16.1) is measured here.
 */
import { createFaceFrame, type FaceFrame, type TrackerInput } from '../face.ts'
import type { FaceTrackerImpl, FrameTracker, LandmarkModifier, TrackerConfig, TrackerEnv } from './plugin.ts'

/** Sliding window of the tracking rate (spec §16.1: "a few seconds"). */
export const TRACKING_RATE_WINDOW_MS = 3000
const RATE_CAPACITY = 256

export interface TrackingNeeds {
  face: boolean
  blendshapes: boolean
}

export class TrackingHub {
  readonly maxFaces: number
  #impl: FaceTrackerImpl | undefined
  #env: TrackerEnv
  #modifiers: readonly LandmarkModifier[]
  #tracker: FrameTracker | undefined
  #starting: Promise<FrameTracker> | undefined
  #config: TrackerConfig
  #front: FaceFrame
  #back: FaceFrame
  #empty: FaceFrame
  #busy = false
  #needed = false
  #disposed = false
  /** Completion times of recent results (ring buffer). */
  #times = new Float64Array(RATE_CAPACITY)
  #timesStart = 0
  #timesCount = 0
  #lastNow = 0
  #results = 0
  #onError: (error: unknown) => void
  #onResult = (): void => this.#complete()
  #onFailure = (error: unknown): void => {
    this.#busy = false
    this.#onError(error)
  }

  constructor(options: {
    impl: FaceTrackerImpl | undefined
    env: TrackerEnv
    maxFaces: number
    modifiers: readonly LandmarkModifier[]
    onError: (error: unknown) => void
  }) {
    this.maxFaces = options.maxFaces
    this.#impl = options.impl
    this.#env = options.env
    this.#modifiers = options.modifiers
    this.#onError = options.onError
    this.#config = { maxFaces: options.maxFaces, blendshapes: false }
    this.#front = createFaceFrame(options.maxFaces)
    this.#back = createFaceFrame(options.maxFaces)
    this.#empty = createFaceFrame(1)
  }

  /** The latest result (`count = 0` while tracking is off or before the first result). Do not retain it. */
  get faces(): FaceFrame {
    return this.#needed && this.#tracker ? this.#front : this.#empty
  }

  get description(): string | undefined {
    return this.#tracker?.description
  }

  /** Total completed results since the tracker started. */
  get results(): number {
    return this.#results
  }

  /** Tracking rate in Hz over the sliding window ending at the last `submit` (spec §16.1). */
  get rateHz(): number {
    const cutoff = this.#lastNow - TRACKING_RATE_WINDOW_MS
    let n = 0
    let first = Infinity
    for (let i = 0; i < this.#timesCount; i++) {
      const t = this.#times[(this.#timesStart + i) % RATE_CAPACITY]!
      if (t >= cutoff) {
        n++
        if (t < first) first = t
      }
    }
    if (n < 2) return 0
    // Rate over the span actually covered, so it is right from the first second on.
    const span = Math.max(this.#lastNow - first, 1)
    return ((n - 1) * 1000) / span
  }

  /** Starts, reconfigures or stops tracking for the union of the active filters' needs. */
  async setNeeds(needs: TrackingNeeds): Promise<void> {
    if (this.#disposed) return
    this.#needed = needs.face
    if (!needs.face) return // the tracker is kept warm: turning a face filter back on is instant
    const config: TrackerConfig = { maxFaces: this.maxFaces, blendshapes: needs.blendshapes }
    const changed = config.blendshapes !== this.#config.blendshapes
    this.#config = config
    if (this.#tracker) {
      if (changed) this.#tracker.configure(config)
      return
    }
    if (!this.#impl) {
      throw new Error('A filter requires face tracking but no face tracker plugin is installed.')
    }
    this.#starting ??= this.#impl.create(config, this.#env).then((tracker) => {
      if (this.#disposed) {
        tracker.dispose()
        return tracker
      }
      this.#tracker = tracker
      // The needs may have changed while it started.
      if (this.#config.blendshapes !== config.blendshapes) tracker.configure(this.#config)
      return tracker
    })
    try {
      await this.#starting
    } catch (error) {
      this.#starting = undefined
      throw error
    }
  }

  /** Submits the current frame when tracking is needed and the tracker is idle. Allocation-free for sync trackers. */
  submit(input: TrackerInput, now: number, mediaTime: number): void {
    this.#lastNow = now
    const tracker = this.#tracker
    if (!this.#needed || !tracker || this.#busy) return
    this.#busy = true
    try {
      const pending = tracker.track(input, now, mediaTime, this.#back)
      if (pending) pending.then(this.#onResult, this.#onFailure)
      else this.#complete()
    } catch (error) {
      this.#onFailure(error)
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#tracker?.dispose()
    this.#tracker = undefined
  }

  #complete(): void {
    this.#busy = false
    if (this.#disposed) return
    const done = this.#back
    for (let i = 0; i < this.#modifiers.length; i++) this.#modifiers[i]!.modify(done)
    this.#back = this.#front
    this.#front = done
    this.#results++
    const t = performance.now()
    if (this.#timesCount < RATE_CAPACITY) {
      this.#times[(this.#timesStart + this.#timesCount) % RATE_CAPACITY] = t
      this.#timesCount++
    } else {
      this.#times[this.#timesStart] = t
      this.#timesStart = (this.#timesStart + 1) % RATE_CAPACITY
    }
  }
}
