/**
 * Raster resolution of a `text` layer (#147, spec §6.3): the font size in pixels of its texture follows the text's
 * size on screen, so that a large `size` (or a face close to the camera) stays as sharp as a small one, without
 * redrawing the texture every frame while a face moves.
 *
 * - The resolution goes by levels of √2 (32, 45, 64, 90, 128… 512 px per em): small changes of the apparent size do
 *   not redraw.
 * - It is the level at or above the size on screen. It goes up when the text is drawn more than `OVERSAMPLE` times
 *   larger than its raster, down when the raster is two levels (2×) larger than needed; only once the new level has
 *   been wanted for `HOLD` seconds of frame time (the first choice is immediate). A time earlier than the previous
 *   one (a new run of a file source) starts over, so a run gives the same images every time (spec §12.5).
 * - `scale` (an animation, spec §6.2) only counts once it has stayed within 2 % for `SETTLE` seconds: a "pop" does
 *   not redraw, a lasting larger `scale` redraws once.
 */

/** Smallest and largest raster font size, in pixels per em. */
export const MIN_PX = 32
export const MAX_PX = 512
/** How much larger than its raster the text may be drawn before the resolution goes up. */
export const OVERSAMPLE = 1.25
/** Seconds a new level must be wanted before the texture is redrawn at it. */
export const HOLD = 0.25
/** Seconds `scale` must stay put before it counts. */
export const SETTLE = 0.3
const SCALE_TOLERANCE = 0.02

/** The level (√2 steps from `MIN_PX`, at most `MAX_PX`) at or above `px`. */
export function pxLevel(px: number): number {
  if (!(px > MIN_PX)) return MIN_PX
  const k = Math.ceil(2 * Math.log2(px / MIN_PX) - 1e-9)
  return Math.min(MAX_PX, Math.round(MIN_PX * 2 ** (k / 2)))
}

/** The resolution of one texture, with hysteresis. */
export class Resolution {
  /** Current pixels per em; `undefined` before the first choice. */
  px: number | undefined
  #side = 0
  #since = 0
  #last = Number.NEGATIVE_INFINITY

  /**
   * The resolution for text drawn at `need` screen pixels per em at frame `time` (s). Changes `px` only as described
   * above; `need` ≤ 0 (nothing drawn) keeps it.
   */
  update(need: number, time: number): number | undefined {
    if (time < this.#last) this.px = undefined
    this.#last = time
    if (!(need > 0)) return this.px
    const target = pxLevel(need)
    const px = this.px
    if (px === undefined) {
      this.px = target
      this.#side = 0
      return target
    }
    // Out of the band on one side since `#since` (a face coming closer keeps wanting more, whatever the level).
    const side = pxLevel(need / OVERSAMPLE) > px ? 1 : target * 2 <= px ? -1 : 0
    if (side !== this.#side) {
      this.#side = side
      this.#since = time
    }
    if (side !== 0 && time - this.#since >= HOLD - 1e-9) {
      this.px = target
      this.#side = 0
    }
    return this.px
  }
}

/** The settled value of an animated `scale`. */
export class SettledScale {
  value = 1
  #last = Number.NaN
  #since = 0
  #time = Number.NEGATIVE_INFINITY

  /** Feeds the current scale at frame `time` (s); returns the settled one. */
  update(scale: number, time: number): number {
    if (time < this.#time) this.#last = Number.NaN
    this.#time = time
    if (Number.isNaN(this.#last)) {
      this.value = this.#last = scale
      this.#since = time
      return scale
    }
    if (Math.abs(scale - this.#last) > SCALE_TOLERANCE * this.#last) {
      this.#last = scale
      this.#since = time
    }
    if (time - this.#since >= SETTLE - 1e-9) this.value = this.#last
    return this.value
  }
}
