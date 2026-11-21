import type { DeviceInfo } from './device-info.ts'
import type { Delegate } from './face.ts'
import { createDistribution, percentileOfSorted, summarizeInto } from './perf-stats.ts'
import type { FrameSample, FrameSampleSink, PipelineInfo } from './stats.ts'

// ---------------------------------------------------------------------------------------------------------------
// Export format (see docs/perf/session-format.md)
// ---------------------------------------------------------------------------------------------------------------

export const PERF_SESSION_FORMAT = 'ouaf-perf-session'
/** Bumped on any breaking change of `PerfSession`; readers must check it. */
export const PERF_SESSION_VERSION = 1

/**
 * A recorded performance session, as exported to JSON. Times are in milliseconds relative to the start of the
 * recording (`performance.now()` clock) unless stated otherwise. Statistics that cannot be computed (no data)
 * are `null`.
 */
export interface PerfSession {
  format: typeof PERF_SESSION_FORMAT
  version: typeof PERF_SESSION_VERSION
  /** Wall-clock start of the recording (ISO 8601, UTC). */
  startedAt: string
  /** Length of the recording (ms), including hidden periods. */
  durationMs: number
  stopReason: SessionStopReason | null
  /** Free-form description of the producer (app name, versions, scheduler mode…). */
  app: Record<string, string | number | boolean>
  /** Pipeline at the start of the recording; later changes are `pipeline` events. */
  pipeline: SessionPipelineInfo | null
  device: DeviceInfo | null
  summary: SessionSummary
  /** Length of each entry of `intervals` (ms). */
  intervalMs: number
  /** Statistics per consecutive interval (per minute by default), to see thermal throttling over time. */
  intervals: SessionInterval[]
  events: SessionEvent[]
  /**
   * Names of the extra sample columns (`SessionRecorderOptions.columns`), in order; absent when there are none.
   * Each one is a column of `samples` and has statistics in `summary.columns` and in each interval.
   */
  columns?: string[]
  samples: SessionSamples
}

/** Why the recording ended: `manual` stop, duration limit reached, or sample buffers `full`. */
export type SessionStopReason = 'manual' | 'duration' | 'full'

/** `PipelineInfo` with `delegate: null` when unknown (JSON has no `undefined`). */
export interface SessionPipelineInfo extends Omit<PipelineInfo, 'delegate'> {
  delegate: Delegate | null
}

export interface SessionDistribution {
  mean: number | null
  p50: number | null
  p95: number | null
  p99: number | null
  max: number | null
}

export interface SessionStats {
  samples: number
  /**
   * Frames per second, from the frame times (`1000 / mean frame time`): periods without frames caused by a
   * hidden page or a pipeline change are not counted.
   */
  fps: number | null
  /** Time between consecutive samples, excluding the gaps described above. */
  frameMs: SessionDistribution
  trackingMs: SessionDistribution
  renderMs: SessionDistribution
  /** Mean number of detected faces. */
  faces: number | null
  /** Statistics of each extra column over its values (samples without a value are skipped); only with columns. */
  columns?: Record<string, SessionColumnStats>
}

/** Statistics of an extra sample column. */
export interface SessionColumnStats extends SessionDistribution {
  /** Samples that have a value. */
  count: number
  /** Sum of the values (e.g. the number of dropped frames for a 0/1 column). */
  sum: number
}

export interface SessionSummary extends SessionStats {
  /** Total time the page was hidden during the recording (ms). */
  hiddenMs: number
  /** Events not kept because the event log was full. */
  droppedEvents: number
}

export interface SessionInterval extends SessionStats {
  /** Start of the interval, relative to the start of the recording (ms). */
  startMs: number
  /** Length of the interval (the last one may be shorter). */
  durationMs: number
}

/**
 * Column-oriented raw samples, one entry per processed frame, in recording order. Extra columns
 * (`PerfSession.columns`) hold `null` for samples without a value.
 */
export interface SessionSamples {
  [column: string]: (number | null)[]
  /** `FrameSample.now` relative to the start of the recording (ms, 0.01 ms precision). */
  t: number[]
  /** `FrameSample.mediaTime` (s, 0.00001 s precision). */
  mediaTime: number[]
  /** ms, 0.01 ms precision. */
  trackingMs: number[]
  renderMs: number[]
  faces: number[]
}

/** Notable things that happened during the recording; `t` is relative to the start (ms). */
export type SessionEvent =
  | { t: number; type: 'visibility'; state: 'visible' | 'hidden' }
  | { t: number; type: 'pipeline'; pipeline: SessionPipelineInfo }
  | { t: number; type: 'full' }
  | { t: number; type: 'wakeLock'; state: 'acquired' | 'released' | 'unsupported' | 'error'; message?: string }
  | { t: number; type: 'battery'; level?: number; charging?: boolean }
  /** Compute Pressure API (`PressureObserver`) state change, e.g. `{ source: 'cpu', state: 'serious' }`. */
  | { t: number; type: 'pressure'; source: string; state: string }
  | { t: number; type: 'note'; message: string }

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** An event as passed to `SessionRecorder.event` (the recorder stamps `t`). */
export type SessionEventInput = DistributiveOmit<SessionEvent, 't'>

// ---------------------------------------------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------------------------------------------

const BUILTIN_COLUMNS: readonly string[] = ['t', 'mediaTime', 'trackingMs', 'renderMs', 'faces']

/** 10 minutes at 120 fps, 20 minutes at 60 fps (≈ 1.8 MB of buffers). */
export const DEFAULT_SESSION_CAPACITY = 72_000
const DEFAULT_MAX_EVENTS = 10_000

export interface SessionRecorderOptions {
  /** Maximum number of samples; the recording stops by itself when it is reached. Default: 72 000. */
  capacity?: number
  /** Maximum number of events kept; later ones are counted in `droppedEvents`. Default: 10 000. */
  maxEvents?: number
  /** Length of the per-interval statistics (ms). Default: 60 000 (per minute). */
  intervalMs?: number
  /**
   * Extra numeric sample columns, recorded from `FrameSample.extra` (e.g. `['inferenceMs', 'latencyMs']`).
   * Names must be unique identifiers and differ from the built-in columns. Default: none.
   */
  columns?: readonly string[]
  /** Monotonic clock, same as `FrameSample.now`. Default: `performance.now()`. */
  clock?: () => number
  /** Wall clock (ms since the epoch). Default: `Date.now()`. */
  wallClock?: () => number
}

export interface SessionStartOptions {
  /** Stops the recording automatically after this long (ms). */
  maxDurationMs?: number
}

export type SessionRecorderState = 'idle' | 'recording' | 'stopped'

/**
 * Records every frame sample of a session into preallocated column buffers, plus notable events, and exports the
 * result as a `PerfSession`.
 *
 * `record` is allocation-free and ignores samples unless a recording is in progress. When the buffers are full
 * the recording stops by itself (`stopReason: 'full'`, plus a `full` event); the data recorded so far is kept.
 */
export class SessionRecorder implements FrameSampleSink {
  readonly capacity: number
  readonly maxEvents: number
  readonly intervalMs: number
  /** Extra sample columns, in order. */
  readonly columns: readonly string[]
  readonly #clock: () => number
  readonly #wallClock: () => number
  readonly #t: Float64Array
  readonly #mediaTime: Float64Array
  readonly #trackingMs: Float32Array
  readonly #renderMs: Float32Array
  readonly #faces: Uint8Array
  /** One buffer per extra column; NaN = no value. */
  readonly #extra: Float32Array[]
  #count = 0
  #state: SessionRecorderState = 'idle'
  #stopReason: SessionStopReason | null = null
  #startNow = 0
  #startWall = 0
  #stopNow = 0
  #maxDurationMs = Infinity
  #events: SessionEvent[] = []
  #droppedEvents = 0
  #info: SessionPipelineInfo | null = null
  #startInfo: SessionPipelineInfo | null = null

  constructor(options: SessionRecorderOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_SESSION_CAPACITY
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`capacity must be a positive integer, got ${capacity}`)
    const intervalMs = options.intervalMs ?? 60_000
    if (!(intervalMs > 0)) throw new RangeError(`intervalMs must be positive, got ${intervalMs}`)
    this.capacity = capacity
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
    this.intervalMs = intervalMs
    this.#clock = options.clock ?? (() => performance.now())
    this.#wallClock = options.wallClock ?? (() => Date.now())
    this.#t = new Float64Array(capacity)
    this.#mediaTime = new Float64Array(capacity)
    this.#trackingMs = new Float32Array(capacity)
    this.#renderMs = new Float32Array(capacity)
    this.#faces = new Uint8Array(capacity)
    const columns = options.columns ?? []
    for (const name of columns) {
      if (!/^[A-Za-z_]\w*$/.test(name) || BUILTIN_COLUMNS.includes(name)) throw new RangeError(`Invalid extra column name: ${name}`)
    }
    if (new Set(columns).size !== columns.length) throw new RangeError('Extra column names must be unique')
    this.columns = [...columns]
    this.#extra = columns.map(() => new Float32Array(capacity))
  }

  get state(): SessionRecorderState {
    return this.#state
  }

  get recording(): boolean {
    return this.#state === 'recording'
  }

  get stopReason(): SessionStopReason | null {
    return this.#stopReason
  }

  /** Samples recorded in the current (or last) session. */
  get count(): number {
    return this.#count
  }

  get full(): boolean {
    return this.#count >= this.capacity
  }

  /** Duration limit of the current session (ms), `Infinity` when none. */
  get maxDurationMs(): number {
    return this.#maxDurationMs
  }

  /** Time since the start of the recording (ms); frozen once stopped, 0 when idle. */
  get elapsedMs(): number {
    if (this.#state === 'idle') return 0
    const end = this.#state === 'recording' ? this.#clock() : this.#stopNow
    return Math.min(end - this.#startNow, this.#maxDurationMs)
  }

  /** Sets the current pipeline description; logged as a `pipeline` event when it changes during a recording. */
  setInfo(info: Readonly<PipelineInfo>): void {
    const copy: SessionPipelineInfo = { ...info, delegate: info.delegate ?? null }
    const changed = this.#info === null || JSON.stringify(this.#info) !== JSON.stringify(copy)
    this.#info = copy
    if (this.#state !== 'recording') return
    if (this.#startInfo === null) this.#startInfo = copy
    else if (changed) this.event({ type: 'pipeline', pipeline: copy })
  }

  /** Starts a new recording, discarding the previous one. */
  start(options: SessionStartOptions = {}): void {
    const max = options.maxDurationMs ?? Infinity
    if (!(max > 0)) throw new RangeError(`maxDurationMs must be positive, got ${max}`)
    this.#count = 0
    this.#events = []
    this.#droppedEvents = 0
    this.#stopReason = null
    this.#maxDurationMs = max
    this.#startNow = this.#clock()
    this.#startWall = this.#wallClock()
    this.#startInfo = this.#info
    this.#state = 'recording'
  }

  /** Stops the recording (no-op when not recording). */
  stop(reason: SessionStopReason = 'manual'): void {
    if (this.#state !== 'recording') return
    this.#stopNow = Math.min(this.#clock(), this.#startNow + this.#maxDurationMs)
    this.#stopReason = reason
    this.#state = 'stopped'
  }

  /**
   * Stops the recording once its duration limit has elapsed. Call it periodically (e.g. from the overlay
   * refresh): samples also enforce the limit, but they stop arriving when the camera stops.
   */
  update(): SessionRecorderState {
    if (this.#state === 'recording' && this.#clock() - this.#startNow >= this.#maxDurationMs) this.stop('duration')
    return this.#state
  }

  record(sample: Readonly<FrameSample>): void {
    if (this.#state !== 'recording') return
    const t = sample.now - this.#startNow
    if (t >= this.#maxDurationMs) {
      this.stop('duration')
      return
    }
    const i = this.#count
    if (i >= this.capacity) {
      this.event({ type: 'full' })
      this.stop('full')
      return
    }
    this.#t[i] = t
    this.#mediaTime[i] = sample.mediaTime
    this.#trackingMs[i] = sample.trackingMs
    this.#renderMs[i] = sample.renderMs
    this.#faces[i] = sample.faces
    const extra = sample.extra
    for (let c = 0; c < this.#extra.length; c++) {
      const v = extra?.[this.columns[c] as string]
      ;(this.#extra[c] as Float32Array)[i] = typeof v === 'number' && Number.isFinite(v) ? v : NaN
    }
    this.#count = i + 1
  }

  /** Logs an event at the current time (ignored unless recording). */
  event(e: SessionEventInput): void {
    if (this.#state !== 'recording') return
    if (this.#events.length >= this.maxEvents) {
      this.#droppedEvents++
      return
    }
    this.#events.push({ t: round(this.#clock() - this.#startNow, 100), ...e } as SessionEvent)
  }

  /** Builds the export document of the current (or last) recording. Works while recording, too. */
  export(context: { device?: DeviceInfo | null; app?: Record<string, string | number | boolean> } = {}): PerfSession {
    const n = this.#count
    const durationMs = this.elapsedMs
    const t = this.#t
    const events = this.#events.slice()

    // Frame times: undefined for the first sample and when a visibility or pipeline change happened since the
    // previous sample (the camera was paused or restarted, the delta is not a frame time).
    const frameMs = new Float64Array(n).fill(NaN)
    const breaks = events.filter((e) => e.type === 'visibility' || e.type === 'pipeline').map((e) => e.t)
    let b = 0
    for (let i = 1; i < n; i++) {
      const prev = t[i - 1] as number
      const cur = t[i] as number
      // An event logged at the same time as a sample happened after it: gap when prev ≤ break < cur.
      while (b < breaks.length && (breaks[b] as number) < prev) b++
      const gap = b < breaks.length && (breaks[b] as number) < cur
      if (!gap) frameMs[i] = cur - prev
    }

    const scratch = new Float64Array(n)
    const statsOf = (from: number, to: number): SessionStats => {
      let m = 0
      let sum = 0
      for (let i = from; i < to; i++) {
        const v = frameMs[i] as number
        if (!Number.isNaN(v)) {
          scratch[m++] = v
          sum += v
        }
      }
      const fps = m > 0 && sum > 0 ? (m * 1000) / sum : NaN
      const frame = distribution(scratch, m)
      for (let i = from; i < to; i++) scratch[i - from] = this.#trackingMs[i] as number
      const tracking = distribution(scratch, to - from)
      for (let i = from; i < to; i++) scratch[i - from] = this.#renderMs[i] as number
      const render = distribution(scratch, to - from)
      let faces = 0
      for (let i = from; i < to; i++) faces += this.#faces[i] as number
      const stats: SessionStats = {
        samples: to - from,
        fps: nullable(fps, 100),
        frameMs: frame,
        trackingMs: tracking,
        renderMs: render,
        faces: nullable(to > from ? faces / (to - from) : NaN, 1000),
      }
      if (this.columns.length > 0) {
        stats.columns = {}
        for (let c = 0; c < this.columns.length; c++) {
          const col = this.#extra[c] as Float32Array
          let k = 0
          let total = 0
          for (let i = from; i < to; i++) {
            const v = col[i] as number
            if (Number.isNaN(v)) continue
            scratch[k++] = v
            total += v
          }
          stats.columns[this.columns[c] as string] = { count: k, sum: round(total, 1000), ...distribution(scratch, k) }
        }
      }
      return stats
    }

    const intervals: SessionInterval[] = []
    let from = 0
    for (let start = 0; start < durationMs; start += this.intervalMs) {
      const end = start + this.intervalMs
      let to = from
      while (to < n && (t[to] as number) < end) to++
      intervals.push({ startMs: start, durationMs: round(Math.min(this.intervalMs, durationMs - start), 100), ...statsOf(from, to) })
      from = to
    }

    const samples: SessionSamples = { t: [], mediaTime: [], trackingMs: [], renderMs: [], faces: [] }
    for (let i = 0; i < n; i++) {
      samples.t.push(round(t[i] as number, 100))
      samples.mediaTime.push(round(this.#mediaTime[i] as number, 100_000))
      samples.trackingMs.push(round(this.#trackingMs[i] as number, 100))
      samples.renderMs.push(round(this.#renderMs[i] as number, 100))
      samples.faces.push(this.#faces[i] as number)
    }
    for (let c = 0; c < this.columns.length; c++) {
      const col = this.#extra[c] as Float32Array
      const values: (number | null)[] = []
      for (let i = 0; i < n; i++) values.push(nullable(col[i] as number, 100))
      samples[this.columns[c] as string] = values
    }

    return {
      format: PERF_SESSION_FORMAT,
      version: PERF_SESSION_VERSION,
      startedAt: new Date(this.#state === 'idle' ? this.#wallClock() : this.#startWall).toISOString(),
      durationMs: round(durationMs, 100),
      stopReason: this.#stopReason,
      app: context.app ?? {},
      pipeline: this.#startInfo,
      device: context.device ?? null,
      summary: {
        ...statsOf(0, n),
        hiddenMs: round(hiddenTime(events, durationMs), 100),
        droppedEvents: this.#droppedEvents,
      },
      intervalMs: this.intervalMs,
      intervals,
      events,
      ...(this.columns.length > 0 ? { columns: [...this.columns] } : {}),
      samples,
    }
  }
}

function round(v: number, scale: number): number {
  return Math.round(v * scale) / scale
}

function nullable(v: number, scale: number): number | null {
  return Number.isFinite(v) ? round(v, scale) : null
}

const tmp = createDistribution()

function distribution(scratch: Float64Array, n: number): SessionDistribution {
  summarizeInto(scratch, n, tmp)
  return {
    mean: nullable(tmp.mean, 1000),
    p50: nullable(tmp.p50, 1000),
    p95: nullable(tmp.p95, 1000),
    // summarizeInto sorted scratch[0..n) in place.
    p99: nullable(percentileOfSorted(scratch, n, 0.99), 1000),
    max: nullable(tmp.max, 1000),
  }
}

/** Total time between `hidden` and the next `visible` event (or the end of the recording). */
function hiddenTime(events: readonly SessionEvent[], durationMs: number): number {
  let total = 0
  let hiddenSince: number | undefined
  for (const e of events) {
    if (e.type !== 'visibility') continue
    if (e.state === 'hidden') hiddenSince ??= e.t
    else if (hiddenSince !== undefined) {
      total += e.t - hiddenSince
      hiddenSince = undefined
    }
  }
  if (hiddenSince !== undefined) total += Math.max(0, durationMs - hiddenSince)
  return total
}

/**
 * Serializes a session compactly but readably: one top-level field per line, one event or interval per line and
 * one sample column per line.
 */
export function stringifySession(doc: PerfSession): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(doc)) {
    let text: string
    if (key === 'samples') {
      const cols = Object.entries(value as SessionSamples).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      text = `{\n${cols.join(',\n')}\n  }`
    } else if (Array.isArray(value)) {
      text = value.length === 0 ? '[]' : `[\n${value.map((v) => `    ${JSON.stringify(v)}`).join(',\n')}\n  ]`
    } else {
      text = JSON.stringify(value, null, 2).replaceAll('\n', '\n  ')
    }
    lines.push(`  ${JSON.stringify(key)}: ${text}`)
  }
  return `{\n${lines.join(',\n')}\n}\n`
}
