/**
 * Measurements of the #6 spike (tracking in a worker vs on the main thread), recorded as extra columns of the
 * performance session (`SessionRecorderOptions.columns`, see docs/perf/session-format.md).
 */
import { summarizeInto, type Distribution } from '@ouaf/core'

/**
 * Extra per-frame columns. One sample = one camera frame handled by the page (frame callback). Values that belong
 * to an asynchronous event (a worker result, a long task…) are attributed to the next sample.
 */
export const COLUMNS = [
  /** `FaceTracker.detect` time (ms) of the result first rendered in this sample; worker clock in worker mode. */
  'inferenceMs',
  /** Worker: frame message received → result posted (ms, worker clock): inference plus the worker's overhead. */
  'workerMs',
  /** Worker: main-thread time to capture the frame (`new VideoFrame(video)` or the `createImageBitmap` call). */
  'captureMs',
  /** Worker: main-thread time of the `postMessage` call sending the frame. */
  'postMs',
  /** Worker: main-thread time handling the result message (buffer view and copy into the rendered frame). */
  'receiveMs',
  /** Frame callback (`now`) → results available on the main thread (ms). */
  'latencyMs',
  /** Camera capture time (`requestVideoFrameCallback` `captureTime`, when reported) → results on the main thread. */
  'cameraLatencyMs',
  /** Age of the results drawn in this frame: this frame's `now` minus the `now` of the frame they were computed on. */
  'resultAgeMs',
  /** Worker: 1 when the frame was not sent because the worker was still busy, 0 when sent. Always 0 in main mode. */
  'dropped',
  /** Camera frames presented without a frame callback since the previous sample (`presentedFrames` gap). */
  'missed',
  /** Largest event-loop lag measured by the probe since the previous sample (ms). */
  'lagMs',
  /** Total duration of the long tasks reported since the previous sample (ms; `null` where unsupported). */
  'longTaskMs',
] as const

export type Column = (typeof COLUMNS)[number]

/**
 * The extra values of one sample (`FrameSample.extra`), plus the values of asynchronous events waiting for the
 * next sample. Allocation-free after construction.
 */
export class SampleExtras {
  /** Values of the current sample, passed as `FrameSample.extra`. `NaN` = no value. */
  readonly values: Record<Column, number>
  readonly #pending: Record<Column, number>

  constructor() {
    this.values = blank()
    this.#pending = blank()
  }

  /** Starts a sample: takes the pending asynchronous values, and clears them. */
  begin(): void {
    for (const c of COLUMNS) {
      this.values[c] = this.#pending[c]
      this.#pending[c] = NaN
    }
  }

  /** Sets the value of the current sample. */
  set(column: Column, value: number): void {
    this.values[column] = value
  }

  /** Asynchronous value for the next sample: replaces the pending one. */
  setNext(column: Column, value: number): void {
    this.#pending[column] = value
  }

  /** Asynchronous value for the next sample: summed with the pending one. */
  addNext(column: Column, value: number): void {
    const p = this.#pending[column]
    this.#pending[column] = Number.isNaN(p) ? value : p + value
  }

  /** Asynchronous value for the next sample: the largest one is kept. */
  maxNext(column: Column, value: number): void {
    const p = this.#pending[column]
    this.#pending[column] = Number.isNaN(p) ? value : Math.max(p, value)
  }

  /** Sum of the current values of `columns`, missing values counting as 0. */
  sum(...columns: Column[]): number {
    let total = 0
    for (const c of columns) {
      const v = this.values[c]
      if (!Number.isNaN(v)) total += v
    }
    return total
  }
}

function blank(): Record<Column, number> {
  const r = {} as Record<Column, number>
  for (const c of COLUMNS) r[c] = NaN
  return r
}

// ---------------------------------------------------------------------------------------------------------------
// Main-thread availability
// ---------------------------------------------------------------------------------------------------------------

/** Probe period (ms). */
const PROBE_MS = 20

/**
 * Event-loop lag probe: every `PROBE_MS`, a timer posts a `MessageChannel` message; the lag is the time between
 * when the timer was due and when the message is handled. An idle main thread answers within about a millisecond
 * (plus timer jitter); a busy one delays both the timer and the message by the length of the task in the way.
 */
export function startLagProbe(onLag: (lagMs: number) => void): () => void {
  const channel = new MessageChannel()
  let due = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  channel.port1.onmessage = () => {
    if (stopped) return
    onLag(Math.max(0, performance.now() - due))
    arm()
  }
  const arm = () => {
    due = performance.now() + PROBE_MS
    timer = setTimeout(() => channel.port2.postMessage(0), PROBE_MS)
  }
  arm()
  return () => {
    stopped = true
    clearTimeout(timer)
    channel.port1.close()
  }
}

/** Long tasks (> 50 ms) of the main thread, where `PerformanceObserver` supports them (Chromium). */
export function observeLongTasks(onTask: (durationMs: number) => void): (() => void) | undefined {
  if (typeof PerformanceObserver !== 'function' || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return undefined
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) onTask(entry.duration)
  })
  observer.observe({ type: 'longtask' })
  return () => observer.disconnect()
}

/** Busy-waits `ms` milliseconds: synthetic host work (`?load=N`). */
export function busyWait(ms: number): void {
  if (!(ms > 0)) return
  const end = performance.now() + ms
  while (performance.now() < end) {
    // Spin.
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Live statistics for the on-screen panel
// ---------------------------------------------------------------------------------------------------------------

/** Rolling statistics of the extra columns over the last `windowMs`, for the live display. */
export class RollingExtras {
  readonly #windowMs: number
  readonly #capacity: number
  readonly #now: Float64Array
  readonly #values: Float64Array[]
  readonly #scratch: Float64Array
  #head = 0
  #size = 0

  constructor(windowMs = 2000, capacity = 256) {
    this.#windowMs = windowMs
    this.#capacity = capacity
    this.#now = new Float64Array(capacity)
    this.#values = COLUMNS.map(() => new Float64Array(capacity))
    this.#scratch = new Float64Array(capacity)
  }

  record(now: number, values: Readonly<Record<Column, number>>): void {
    const i = this.#head
    this.#now[i] = now
    for (let c = 0; c < COLUMNS.length; c++) (this.#values[c] as Float64Array)[i] = values[COLUMNS[c] as Column]
    this.#head = (i + 1) % this.#capacity
    this.#size = Math.min(this.#size + 1, this.#capacity)
  }

  reset(): void {
    this.#size = 0
  }

  /**
   * Statistics of `column` over the window ending at `now`: distribution of its values in `out`; returns the sum of
   * the values and the number of samples in the window (with or without a value), and the window span (ms).
   */
  compute(column: Column, now: number, out: Distribution): { sum: number; samples: number; spanMs: number } {
    const col = this.#values[COLUMNS.indexOf(column)] as Float64Array
    let k = 0
    let sum = 0
    let samples = 0
    let first = now
    for (let j = 0; j < this.#size; j++) {
      const i = (this.#head - 1 - j + this.#capacity) % this.#capacity
      const t = this.#now[i] as number
      if (now - t > this.#windowMs) break
      samples++
      first = t
      const v = col[i] as number
      if (Number.isNaN(v)) continue
      this.#scratch[k++] = v
      sum += v
    }
    summarizeInto(this.#scratch, k, out)
    return { sum, samples, spanMs: now - first }
  }
}
