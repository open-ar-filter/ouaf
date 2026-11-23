/**
 * Face tracking shared by the whole stack (spec §7): started only when an active filter needs it (spec §4.1),
 * configured with the union of the filters' needs, and run eagerly on the newest frame (one frame in flight).
 *
 * Results are double-buffered: the tracker writes into the back `FaceFrame`; when the call completes, the buffers
 * swap and the new front is what layers read from the next rendered frame on. The tracking rate (completed results
 * per second over a sliding window, spec §16.1) is measured here.
 *
 * Two ways to run it (spec §12.1): `submit` for live sources (never waits: the frame is rendered with the latest
 * result), `track` for file sources (image, offline video, `pushFrame`: the frame waits for its own result, so every
 * run gives the same faces).
 */
import { createFaceFrame, type FaceFrame, type TrackerInput } from '../face.ts'
import type { BackendInfo, FaceTrackerImpl, FrameTracker, LandmarkModifier, TrackerConfig, TrackerEnv } from './plugin.ts'

/** Sliding window of the tracking rate (spec §16.1: "a few seconds"). */
export const TRACKING_RATE_WINDOW_MS = 3000
const RATE_CAPACITY = 256

export interface TrackingNeeds {
  face: boolean
  blendshapes: boolean
  /** Faces to look for (spec §16.2, extra faces dropped); default and at most: the engine's `maxFaces`. */
  maxFaces?: number
  /** Analysis resolution relative to the frame (spec §16.2); default 1. */
  analysisScale?: number
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
  /** Settles (never rejects) when the call in flight completes. */
  #inflight: Promise<void> | undefined
  /** Incremented by `clear`: a result of an older generation is dropped. */
  #generation = 0
  #submitted = 0
  #configVersion = 0
  #needed = false
  #disposed = false
  #benchmarked = false
  /** Completion times of recent results (ring buffer). */
  #times = new Float64Array(RATE_CAPACITY)
  /** Time from submit to completion of the same results (ms). */
  #durations = new Float64Array(RATE_CAPACITY)
  #submittedAt = 0
  #timesStart = 0
  #timesCount = 0
  #lastNow = 0
  /** Results completed before this time are left out of the rate (`restartRate`). */
  #rateFrom = -Infinity
  #results = 0
  #onError: (error: unknown) => void
  #onResult = (): void => {
    this.#inflight = undefined
    this.#complete()
  }
  #onFailure = (error: unknown): void => {
    this.#inflight = undefined
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
    this.#config = { maxFaces: options.maxFaces, blendshapes: false, analysisScale: 1 }
    this.#front = createFaceFrame(options.maxFaces)
    this.#back = createFaceFrame(options.maxFaces)
    this.#empty = createFaceFrame(1)
  }

  /** The latest result (`count = 0` while tracking is off or before the first result). Do not retain it. */
  get faces(): FaceFrame {
    return this.#needed && this.#tracker ? this.#front : this.#empty
  }

  /** Tracking runs: a filter needs it and the tracker has started. */
  get active(): boolean {
    return this.#needed && this.#tracker !== undefined
  }

  get description(): string | undefined {
    return this.#tracker?.description
  }

  /** The tracker's backend and how it was chosen (spec §16.4), when it says. */
  get backend(): BackendInfo | undefined {
    return this.#tracker?.backend
  }

  /** The tracker is measuring its backends: the tracking rate is not representative meanwhile. */
  get measuring(): boolean {
    return this.#tracker?.measuring ?? false
  }

  /** Total completed results since the tracker started (`clear` counts as one: an empty result). */
  get results(): number {
    return this.#results
  }

  /**
   * Changes whenever the tracker starts or is reconfigured: a still image tracked once is tracked again when it
   * changes (blendshapes turned on by a new filter).
   */
  get configVersion(): number {
    return this.#configVersion
  }

  /** The tracker is starting for a filter that needs it: settles once it runs (or failed, reported by `setNeeds`). */
  get starting(): Promise<unknown> | undefined {
    return this.#needed && !this.#tracker && this.#starting ? this.#starting : undefined
  }

  /** The configuration the tracker runs with (or will, once started). */
  get config(): Readonly<TrackerConfig> {
    return this.#config
  }

  /**
   * Tracking rate in Hz over the sliding window ending at the last `submit` (spec §16.1), or since the last
   * `restartRate` when that is more recent.
   */
  get rateHz(): number {
    const cutoff = Math.max(this.#lastNow - TRACKING_RATE_WINDOW_MS, this.#rateFrom)
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

  /**
   * Mean time from a frame's submission to its result (ms) over the same window as `rateHz`: what one result costs,
   * whatever the frame rate (NaN before the first result). The tracking rate cannot exceed `1000 / pipelineMs`.
   */
  get pipelineMs(): number {
    const cutoff = Math.max(this.#lastNow - TRACKING_RATE_WINDOW_MS, this.#rateFrom)
    let n = 0
    let sum = 0
    for (let i = 0; i < this.#timesCount; i++) {
      const k = (this.#timesStart + i) % RATE_CAPACITY
      if (this.#times[k]! >= cutoff) {
        n++
        sum += this.#durations[k]!
      }
    }
    return n > 0 ? sum / n : Number.NaN
  }

  /**
   * Restarts the rate window at `now` (same clock as `submit`): the rate then only counts the results completed
   * since, e.g. after the configuration changed (spec §16.2) or after a pause of frames.
   */
  restartRate(now: number): void {
    this.#rateFrom = now
  }

  /** Starts, reconfigures or stops tracking for the union of the active filters' needs. */
  async setNeeds(needs: TrackingNeeds): Promise<void> {
    if (this.#disposed) return
    this.#needed = needs.face
    if (!needs.face) return // the tracker is kept warm: turning a face filter back on is instant
    const config: TrackerConfig = {
      maxFaces: Math.max(1, Math.min(this.maxFaces, Math.trunc(needs.maxFaces ?? this.maxFaces))),
      blendshapes: needs.blendshapes,
      analysisScale: Math.max(0.1, Math.min(1, needs.analysisScale ?? 1)),
    }
    const changed = !sameConfig(config, this.#config)
    this.#config = config
    if (this.#tracker) {
      if (changed) {
        this.#tracker.configure(config)
        this.#configVersion++
      }
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
      this.#configVersion++
      // The needs may have changed while it started.
      if (!sameConfig(this.#config, config)) tracker.configure(this.#config)
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
    // Live frames: the tracker may measure its backends on them (spec §16.4), once.
    if (!this.#benchmarked) {
      this.#benchmarked = true
      tracker.benchmark?.()
    }
    this.#busy = true
    this.#submitted = this.#generation
    this.#submittedAt = performance.now()
    try {
      const pending = tracker.track(input, now, mediaTime, this.#back)
      if (pending) this.#inflight = pending.then(this.#onResult, this.#onFailure)
      else this.#complete()
    } catch (error) {
      this.#onFailure(error)
    }
  }

  /**
   * Tracks this frame and resolves once its result is the front one (file sources, spec §12.1): waits for a tracker
   * that is starting and for the call in flight. `still`: a still image (`FrameTracker.trackImage`). Failures are
   * reported to `onError` and leave the previous result; it never rejects.
   */
  async track(input: TrackerInput, now: number, mediaTime: number, still = false): Promise<void> {
    this.#lastNow = now
    const starting = this.starting
    if (starting) await starting.catch(() => {})
    while (this.#inflight) await this.#inflight
    const tracker = this.#tracker
    if (!this.#needed || !tracker || this.#disposed) return
    this.#busy = true
    this.#submitted = this.#generation
    this.#submittedAt = performance.now()
    try {
      const pending = still && tracker.trackImage ? tracker.trackImage(input, mediaTime, this.#back) : tracker.track(input, now, mediaTime, this.#back)
      if (pending) {
        const done = pending.then(this.#onResult, this.#onFailure)
        this.#inflight = done
        await done
      } else this.#complete()
    } catch (error) {
      this.#onFailure(error)
    }
  }

  /** Resets the tracker's temporal state before the first frame of a file source run (`FrameTracker.reset`). */
  async resetTracker(): Promise<void> {
    const starting = this.starting
    if (starting) await starting.catch(() => {})
    while (this.#inflight) await this.#inflight
    try {
      await this.#tracker?.reset?.()
    } catch (error) {
      this.#onError(error)
    }
  }

  /** Forgets the current result (new source): layers see no face until the next one; a call in flight is dropped. */
  clear(): void {
    this.#generation++
    this.#front.count = 0
    this.#results++
    // A benchmark aborted by a file source may run on the next live one (`FrameTracker.benchmark` runs it once).
    this.#benchmarked = false
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#tracker?.dispose()
    this.#tracker = undefined
  }

  #complete(): void {
    this.#busy = false
    if (this.#disposed || this.#submitted !== this.#generation) return
    const done = this.#back
    for (let i = 0; i < this.#modifiers.length; i++) this.#modifiers[i]!.modify(done)
    this.#back = this.#front
    this.#front = done
    this.#results++
    const t = performance.now()
    if (this.#timesCount < RATE_CAPACITY) {
      const k = (this.#timesStart + this.#timesCount) % RATE_CAPACITY
      this.#times[k] = t
      this.#durations[k] = t - this.#submittedAt
      this.#timesCount++
    } else {
      this.#times[this.#timesStart] = t
      this.#durations[this.#timesStart] = t - this.#submittedAt
      this.#timesStart = (this.#timesStart + 1) % RATE_CAPACITY
    }
  }
}

function sameConfig(a: TrackerConfig, b: TrackerConfig): boolean {
  return a.maxFaces === b.maxFaces && a.blendshapes === b.blendshapes && a.analysisScale === b.analysisScale
}
