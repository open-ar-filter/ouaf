/**
 * When the LiteRT.js pipeline runs its face detector (#165, multi-face). Pure logic, no model: unit-tested on its own.
 */

/**
 * While some faces are tracked but fewer than `maxFaces`, the detector runs at most this often (ms): a slot that stays
 * empty, the usual case with `maxFaces` above the faces in view, would otherwise add the detector's cost to every
 * result (≈ 25–45 ms on the Redmi Note 11S). A face that comes into view is found within this delay.
 */
export const DETECT_INTERVAL_MS = 500

/** Quick retries of the detector after a detection the landmark model did not confirm. */
export const DETECTOR_RETRIES = 3

/**
 * On every frame while no face is tracked; while some are tracked but fewer than wanted, at most every `intervalMs`.
 * Except right after a detection whose face the landmark model did not confirm (a ROI a little off on its first frame,
 * as for the second face of `two-faces-stacked`: presence 0.07, then 1.00 on the next frame's detection): the detector
 * runs again on the next frames, `DETECTOR_RETRIES` times at most in a row, so that a face in view is not missed for
 * `intervalMs` while a persistent false detection does not cost every frame.
 */
export class DetectorSchedule {
  readonly intervalMs: number
  #last = Number.NEGATIVE_INFINITY
  #retry = false
  #retries = 0

  constructor(intervalMs = DETECT_INTERVAL_MS) {
    this.intervalMs = intervalMs
  }

  /** The detector should run on this frame: `tracked` faces of `wanted`, at `now` (ms). */
  due(tracked: number, wanted: number, now: number): boolean {
    if (tracked >= wanted) return false
    return tracked === 0 || this.#retry || now - this.#last >= this.intervalMs
  }

  /** The detector ran at `now`. */
  ran(now: number): void {
    this.#last = now
    // A run on schedule starts a new series of retries.
    if (!this.#retry) this.#retries = 0
    this.#retry = false
  }

  /** A face the detector found was not confirmed by the landmark model: retry on the next frame, if retries are left. */
  unconfirmed(): void {
    if (this.#retry || this.#retries >= DETECTOR_RETRIES) return
    this.#retry = true
    this.#retries++
  }

  reset(): void {
    this.#last = Number.NEGATIVE_INFINITY
    this.#retry = false
    this.#retries = 0
  }
}
