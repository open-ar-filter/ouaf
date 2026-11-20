import type { FrameSample, FrameSampleSink } from './stats.ts'

/** Summary of a set of values. Every field is `NaN` when the set is empty. */
export interface Distribution {
  mean: number
  /** Median. */
  p50: number
  p95: number
  max: number
}

export function createDistribution(): Distribution {
  return { mean: NaN, p50: NaN, p95: NaN, max: NaN }
}

/**
 * Percentile `p` (0–1) of the first `n` values of an ascending-sorted array, with linear interpolation between
 * the closest ranks (the usual "type 7" definition, as in NumPy and spreadsheets). `NaN` when `n` is 0.
 */
export function percentileOfSorted(sorted: ArrayLike<number>, n: number, p: number): number {
  if (n <= 0) return NaN
  const pos = (n - 1) * Math.min(1, Math.max(0, p))
  const lo = Math.floor(pos)
  const a = sorted[lo] as number
  const frac = pos - lo
  return frac === 0 ? a : a + ((sorted[lo + 1] as number) - a) * frac
}

/**
 * Sorts the first `n` values of `scratch` in place and writes their summary into `out`. The values must not be
 * `NaN`. Allocates only the `subarray` view.
 */
export function summarizeInto(scratch: Float64Array, n: number, out: Distribution): Distribution {
  if (n <= 0) {
    out.mean = out.p50 = out.p95 = out.max = NaN
    return out
  }
  const values = scratch.subarray(0, n).sort()
  let sum = 0
  for (let i = 0; i < n; i++) sum += values[i] as number
  out.mean = sum / n
  out.p50 = percentileOfSorted(values, n, 0.5)
  out.p95 = percentileOfSorted(values, n, 0.95)
  out.max = values[n - 1] as number
  return out
}

/** Statistics over the recent window, as computed by `RollingStats.compute`. */
export interface RollingSnapshot {
  /** Samples inside the window. */
  samples: number
  /** Frames per second over the window (from the frame times); `NaN` without at least two consecutive samples. */
  fps: number
  /** Time between consecutive frames (ms). */
  readonly frameMs: Distribution
  readonly trackingMs: Distribution
  readonly renderMs: Distribution
  /** Mean number of detected faces. */
  faces: number
}

export function createRollingSnapshot(): RollingSnapshot {
  return {
    samples: 0,
    fps: NaN,
    frameMs: createDistribution(),
    trackingMs: createDistribution(),
    renderMs: createDistribution(),
    faces: NaN,
  }
}

export interface RollingStatsOptions {
  /** Length of the window (ms). Default: 2000. */
  windowMs?: number
  /**
   * Maximum number of samples kept. Default: 256 (2 s at 128 fps). When the frame rate is higher than
   * `capacity / windowMs`, the window is shortened to the last `capacity` samples.
   */
  capacity?: number
}

/**
 * Rolling statistics over the last `windowMs` of frame samples, for the live overlay.
 *
 * `record` is allocation-free (it writes into preallocated ring buffers); `compute` sorts a preallocated scratch
 * array and is meant to be called a few times per second, not per frame.
 */
export class RollingStats implements FrameSampleSink {
  readonly windowMs: number
  readonly capacity: number
  readonly #now: Float64Array
  readonly #frameMs: Float64Array
  readonly #trackingMs: Float64Array
  readonly #renderMs: Float64Array
  readonly #faces: Float64Array
  readonly #scratch: Float64Array
  /** Index of the next write. */
  #head = 0
  #size = 0
  /** `now` of the previous sample, `NaN` after a gap (the next frame time is unknown). */
  #prevNow = NaN

  constructor(options: RollingStatsOptions = {}) {
    const windowMs = options.windowMs ?? 2000
    const capacity = options.capacity ?? 256
    if (!(windowMs > 0)) throw new RangeError(`windowMs must be positive, got ${windowMs}`)
    if (!Number.isInteger(capacity) || capacity < 2) throw new RangeError(`capacity must be an integer ≥ 2, got ${capacity}`)
    this.windowMs = windowMs
    this.capacity = capacity
    this.#now = new Float64Array(capacity)
    this.#frameMs = new Float64Array(capacity)
    this.#trackingMs = new Float64Array(capacity)
    this.#renderMs = new Float64Array(capacity)
    this.#faces = new Float64Array(capacity)
    this.#scratch = new Float64Array(capacity)
  }

  /** Samples currently held (inside the window or not). */
  get size(): number {
    return this.#size
  }

  record(sample: Readonly<FrameSample>): void {
    const i = this.#head
    this.#now[i] = sample.now
    this.#frameMs[i] = sample.now - this.#prevNow
    this.#trackingMs[i] = sample.trackingMs
    this.#renderMs[i] = sample.renderMs
    this.#faces[i] = sample.faces
    this.#prevNow = sample.now
    this.#head = (i + 1) % this.capacity
    if (this.#size < this.capacity) this.#size++
  }

  /**
   * Declares a discontinuity (page hidden, camera restarted): the time until the next sample is not counted as a
   * frame time. The samples already recorded are kept.
   */
  markGap(): void {
    this.#prevNow = NaN
  }

  /** Forgets every sample. */
  reset(): void {
    this.#head = 0
    this.#size = 0
    this.#prevNow = NaN
  }

  /**
   * Computes the statistics of the samples whose `now` is within `windowMs` of `refNow` (default: the newest
   * sample) and writes them into `out`. Passing the current time makes the window empty once frames stop.
   */
  compute(out: RollingSnapshot = createRollingSnapshot(), refNow?: number): RollingSnapshot {
    const cap = this.capacity
    const newest = (this.#head - 1 + cap) % cap
    const ref = refNow ?? this.#now[newest] ?? 0
    const from = ref - this.windowMs
    // Collect the in-window indices, newest first, by walking back from the head.
    let n = 0
    while (n < this.#size) {
      const i = (newest - n + cap) % cap
      if ((this.#now[i] as number) < from) break
      n++
    }
    out.samples = n

    const s = this.#scratch
    // Frame times: skip the unknown ones (first sample, first sample after a gap).
    let m = 0
    let sum = 0
    for (let k = 0; k < n; k++) {
      const v = this.#frameMs[(newest - k + cap) % cap] as number
      if (Number.isNaN(v)) continue
      s[m++] = v
      sum += v
    }
    out.fps = m > 0 && sum > 0 ? (m * 1000) / sum : NaN
    summarizeInto(s, m, out.frameMs)

    for (let k = 0; k < n; k++) s[k] = this.#trackingMs[(newest - k + cap) % cap] as number
    summarizeInto(s, n, out.trackingMs)
    for (let k = 0; k < n; k++) s[k] = this.#renderMs[(newest - k + cap) % cap] as number
    summarizeInto(s, n, out.renderMs)

    let faces = 0
    for (let k = 0; k < n; k++) faces += this.#faces[(newest - k + cap) % cap] as number
    out.faces = n > 0 ? faces / n : NaN
    return out
  }
}
