/**
 * One Euro filter (Casiez, Roussel, Vogel, CHI 2012) over a bank of channels sharing one clock: an adaptive
 * low-pass whose cutoff rises with the speed, so the signal is steady at rest and lags little when it moves.
 * Handles a variable time step (tracking results arrive irregularly). Allocation-free after construction.
 */

export interface OneEuroParams {
  /** Cutoff at rest (Hz): lower = steadier, more lag on slow motion. */
  minCutoff: number
  /** Speed coefficient: how fast the cutoff rises with the (scaled) speed. */
  beta: number
  /** Cutoff of the speed estimate (Hz). */
  dCutoff: number
}

// The smoothing factor of a cutoff, α = r / (r + 1) with r = 2π · cutoff · dt, is written out where it is used
// rather than returned by a helper: V8 boxes a fractional number returned from a call it does not inline, and
// `filter` computes one per channel (thousands per tracking result).

export class OneEuroBank {
  readonly size: number
  params: OneEuroParams
  /** Filtered values. */
  readonly value: Float64Array
  /** Filtered speed of each channel (units per second), used for prediction. */
  readonly speed: Float64Array
  /** Last raw sample of each channel (the speed is measured on the raw signal, as MediaPipe does). */
  readonly #raw: Float64Array
  /** Time of the last sample (s); `NaN` until the first one. */
  time = Number.NaN

  constructor(size: number, params: OneEuroParams) {
    this.size = size
    this.params = { ...params }
    this.value = new Float64Array(size)
    this.speed = new Float64Array(size)
    this.#raw = new Float64Array(size)
  }

  get initialized(): boolean {
    return !Number.isNaN(this.time)
  }

  /** Forgets the state: the next sample is taken as is. */
  reset(): void {
    this.time = Number.NaN
    this.speed.fill(0)
  }

  /**
   * Filters `size` values read from `src` at `srcOffset`, taken at time `time` (s), and writes the filtered values
   * to `dst` at `dstOffset` (`dst` may be `src`). The speed that drives the cutoff of channel `i` is multiplied by
   * `speedScale[i % speedScale.length]` (e.g. 1 / face size, so that `beta` does not depend on the units).
   * A sample that is not newer than the previous one leaves the state unchanged and outputs the previous values.
   */
  filter(
    src: ArrayLike<number>,
    srcOffset: number,
    dst: Float32Array | Float64Array,
    dstOffset: number,
    time: number,
    speedScale: ArrayLike<number>,
  ): void {
    const n = this.size
    const x = this.value
    const dx = this.speed
    const raw = this.#raw
    if (!this.initialized) {
      for (let i = 0; i < n; i++) x[i] = raw[i] = src[srcOffset + i]!
      dx.fill(0)
      this.time = time
    } else {
      const dt = time - this.time
      if (dt > 0) {
        const { minCutoff, beta, dCutoff } = this.params
        const rd = 2 * Math.PI * dCutoff * dt
        const ad = rd / (rd + 1)
        const scales = speedScale.length
        for (let i = 0; i < n; i++) {
          const v = src[srcOffset + i]!
          const d = dx[i]! + ad * ((v - raw[i]!) / dt - dx[i]!)
          dx[i] = d
          raw[i] = v
          const cutoff = minCutoff + beta * Math.abs(d * speedScale[i % scales]!)
          const r = 2 * Math.PI * cutoff * dt
          x[i] = x[i]! + (r / (r + 1)) * (v - x[i]!)
        }
        this.time = time
      }
    }
    for (let i = 0; i < n; i++) dst[dstOffset + i] = x[i]!
  }

  /** Writes the filtered values extrapolated by `horizon` seconds along their filtered speed. */
  predict(horizon: number, dst: Float32Array | Float64Array, dstOffset: number): void {
    const x = this.value
    const dx = this.speed
    for (let i = 0; i < this.size; i++) dst[dstOffset + i] = x[i]! + dx[i]! * horizon
  }
}
