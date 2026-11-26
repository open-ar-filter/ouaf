/**
 * Adaptive rendering resolution (#34, spec §16.5): lowers the engine's internal resolution when it cannot render every
 * frame of a live video source, and raises it again once it can. Pure logic, driven by the engine once per rendered
 * frame with the source's frame counter; the engine applies the scale (`Compositor.setRenderScale`).
 *
 * The measure is the share of the source's frames that were **not** rendered: `requestVideoFrameCallback` reports,
 * with each frame, how many frames the browser presented since the video started (`presentedFrames`); a jump of more
 * than one means frames went by while the engine was still busy with an earlier one, whatever held it up (the main
 * thread, or the GPU: WebGL calls wait once its queue is full). The GPU time is not measured directly (no portable
 * timer query), so the governor learns by trying:
 *
 * - **Drop**: missed share above `dropAbove` (10 %) for `dropAfterMs` (2 s) → the next lower level of `levels`.
 * - **Judge**: the first `judgeMs` (2 s) after a drop's settle time. A drop that brought the missed share neither
 *   below `dropAbove` nor down by `minGain` (5 points) did not help. Frames are rendered at whole periods of the
 *   source (a 50 ms frame and a 36 ms one both take two 33 ms periods), so one level may show no gain where the next
 *   would: the next one is tried, up to `trialLevels` (2) below where the trial started. When none of them helped,
 *   the pixels were not the bottleneck (a busy main thread, a slow tracker on it): the trial is undone, and none is
 *   started for `blockMs` (30 s, doubling on each useless trial up to `maxBlockMs`).
 * - **Restore**: missed share at most `restoreBelow` (2 %) for `restoreAfterMs` (5 s) → the next higher level. A drop
 *   within `probationMs` (10 s) of a restore doubles the next restore delay (up to `maxRestoreMs`): a device that keeps
 *   up only at the lower level settles there instead of switching back and forth.
 * - After each change, nothing is measured for `settleMs` (1 s): resizing the render targets takes a frame or two.
 * - A pause between frames longer than `pauseMs` (a background tab, a stalled source) restarts the measure.
 *
 * Without `presentedFrames` (browsers without `requestVideoFrameCallback`, canvas sources) nothing is measured and the
 * resolution stays as it is.
 */

export interface ResolutionTuning {
  /** Scales of the internal resolution, from full (1) down, relative to the host's own resolution. */
  levels: readonly number[]
  /** Length of a measure window (ms). */
  windowMs: number
  /** After each change, frames are not counted for this long (ms). */
  settleMs: number
  /** A missed share above this... */
  dropAbove: number
  /** ...for this long (ms) drops a level. */
  dropAfterMs: number
  /** After a drop, the missed share is judged over this long (ms) once settled. */
  judgeMs: number
  /** A drop that lowered the missed share by less than this, and not below `dropAbove`, did not help... */
  minGain: number
  /** ...then the next level is tried, up to this many levels below where the trial started, before it is undone. */
  trialLevels: number
  /** After an undone drop, none is tried for this long (ms), doubled on each one... */
  blockMs: number
  /** ...up to this (ms). */
  maxBlockMs: number
  /** A missed share at most this... */
  restoreBelow: number
  /** ...for this long (ms) restores a level, doubled when dropped again within `probationMs` of a restore... */
  restoreAfterMs: number
  /** ...up to this (ms). */
  maxRestoreMs: number
  probationMs: number
  /** A gap between two frames longer than this (ms) restarts the measure. */
  pauseMs: number
}

export const DEFAULT_RESOLUTION_TUNING: Readonly<ResolutionTuning> = {
  levels: [1, 0.85, 0.7, 0.6, 0.5],
  windowMs: 1000,
  settleMs: 1000,
  dropAbove: 0.1,
  dropAfterMs: 2000,
  judgeMs: 2000,
  minGain: 0.05,
  trialLevels: 2,
  blockMs: 30_000,
  maxBlockMs: 600_000,
  restoreBelow: 0.02,
  restoreAfterMs: 5000,
  maxRestoreMs: 120_000,
  probationMs: 10_000,
  pauseMs: 1500,
}

/** A level change: `undo` when a drop that did not help is taken back. */
export interface ResolutionChange {
  readonly kind: 'drop' | 'restore' | 'undo'
  readonly scale: number
}

/** A drop being judged. */
interface Judging {
  /** Missed share of the window that started the trial, and the level before it. */
  before: number
  from: number
  /** Frames rendered and presented since it settled. */
  rendered: number
  presented: number
  /** End of the judgement (ms). */
  until: number
}

export class ResolutionGovernor {
  readonly tuning: Readonly<ResolutionTuning>
  #level = 0
  #lastNow = Number.NaN
  #lastPresented = Number.NaN
  /** Frames are not counted before this time (settle after a change, restart). */
  #settledAt = Number.NaN
  #windowStart = Number.NaN
  #windowRendered = 0
  #windowPresented = 0
  /** Missed share of the last complete window (NaN: none yet). */
  #missed = Number.NaN
  #overSince = Number.NaN
  #underSince = Number.NaN
  /** A drop being judged. */
  #judging: Judging | undefined
  #blockedUntil = -Infinity
  #blockBackoff = 1
  #restoreBackoff = 1
  #restoredAt = -Infinity

  constructor(tuning: Partial<ResolutionTuning> = {}) {
    const t = { ...DEFAULT_RESOLUTION_TUNING, ...tuning }
    const levels = t.levels
    if (levels.length === 0 || levels[0] !== 1 || levels.some((s, i) => !(s > 0) || (i > 0 && !(s < levels[i - 1]!)))) {
      throw new RangeError(`levels must start at 1 and decrease, got [${levels.join(', ')}]`)
    }
    this.tuning = t
  }

  /** Current scale of the internal resolution (1: full). */
  get scale(): number {
    return this.tuning.levels[this.#level]!
  }

  /** Share of the source's frames not rendered over the last window (0 to 1; NaN before the first). */
  get missed(): number {
    return this.#missed
  }

  /**
   * One rendered frame at `now` (ms), with the source's count of presented frames (`undefined` when the browser does
   * not report it). Returns the change to apply, if any.
   */
  frame(now: number, presentedFrames: number | undefined): ResolutionChange | undefined {
    if (presentedFrames === undefined || !Number.isFinite(presentedFrames)) return undefined
    const lastNow = this.#lastNow
    const lastPresented = this.#lastPresented
    this.#lastNow = now
    this.#lastPresented = presentedFrames
    const t = this.tuning
    // First frame, a pause, or a counter that went back (a new video): the measure restarts from this frame.
    if (Number.isNaN(lastNow) || now - lastNow > t.pauseMs || !(presentedFrames > lastPresented)) {
      this.#restart(Number.isNaN(this.#settledAt) || now > this.#settledAt ? now : this.#settledAt)
      return undefined
    }
    if (now < this.#settledAt) return undefined
    const presented = presentedFrames - lastPresented
    if (Number.isNaN(this.#windowStart)) this.#windowStart = now
    this.#windowRendered++
    this.#windowPresented += presented
    const judging = this.#judging
    if (judging) {
      judging.rendered++
      judging.presented += presented
      if (now >= judging.until) return this.#judge(now, judging)
    }
    if (now - this.#windowStart < t.windowMs) return undefined
    const missed = missedShare(this.#windowRendered, this.#windowPresented)
    this.#missed = missed
    this.#windowStart = now
    this.#windowRendered = 0
    this.#windowPresented = 0
    if (judging) return undefined

    if (missed > t.dropAbove) {
      this.#underSince = Number.NaN
      if (Number.isNaN(this.#overSince)) this.#overSince = now - t.windowMs
      if (now - this.#overSince >= t.dropAfterMs && now >= this.#blockedUntil && this.#level < t.levels.length - 1) return this.#drop(now, missed, this.#level)
    } else {
      this.#overSince = Number.NaN
      if (missed <= t.restoreBelow) {
        if (Number.isNaN(this.#underSince)) this.#underSince = now - t.windowMs
        const delay = Math.min(t.restoreAfterMs * this.#restoreBackoff, t.maxRestoreMs)
        if (this.#level > 0 && now - this.#underSince >= delay) return this.#change(now, 'restore', this.#level - 1)
      } else this.#underSince = Number.NaN
    }
    return undefined
  }

  /** Frames stop counting until the next one (the engine is not drawing filters, or must not change size now). */
  pause(): void {
    this.#lastNow = Number.NaN
    this.#judging = undefined
  }

  /** Back to the full resolution, every delay forgotten (a new source). */
  reset(): void {
    this.#level = 0
    this.#lastNow = Number.NaN
    this.#lastPresented = Number.NaN
    this.#settledAt = Number.NaN
    this.#missed = Number.NaN
    this.#judging = undefined
    this.#blockedUntil = -Infinity
    this.#blockBackoff = 1
    this.#restoreBackoff = 1
    this.#restoredAt = -Infinity
    this.#restart(Number.NaN)
  }

  #drop(now: number, before: number, from: number): ResolutionChange {
    const t = this.tuning
    if (from === this.#level && now - this.#restoredAt < t.probationMs) this.#restoreBackoff = Math.min(this.#restoreBackoff * 2, 1024)
    const change = this.#change(now, 'drop', this.#level + 1)
    this.#judging = { before, from, rendered: 0, presented: 0, until: now + t.settleMs + t.judgeMs }
    return change
  }

  #judge(now: number, judging: Judging): ResolutionChange | undefined {
    const t = this.tuning
    this.#judging = undefined
    const missed = missedShare(judging.rendered, judging.presented)
    this.#missed = missed
    if (missed <= t.dropAbove || judging.before - missed >= t.minGain) {
      // It helped: keep it, and judge the next windows as usual.
      this.#blockBackoff = 1
      this.#restart(now)
      return undefined
    }
    if (this.#level - judging.from < t.trialLevels && this.#level < t.levels.length - 1) return this.#drop(now, judging.before, judging.from)
    this.#blockedUntil = now + Math.min(t.blockMs * this.#blockBackoff, t.maxBlockMs)
    this.#blockBackoff = Math.min(this.#blockBackoff * 2, 1024)
    return this.#change(now, 'undo', judging.from)
  }

  #change(now: number, kind: ResolutionChange['kind'], level: number): ResolutionChange {
    this.#level = level
    if (kind === 'restore') this.#restoredAt = now
    this.#restart(now + this.tuning.settleMs)
    return { kind, scale: this.scale }
  }

  /** The windows restart: frames count again from `from` (ms). */
  #restart(from: number): void {
    this.#settledAt = from
    this.#windowStart = Number.NaN
    this.#windowRendered = 0
    this.#windowPresented = 0
    this.#overSince = Number.NaN
    this.#underSince = Number.NaN
  }
}

function missedShare(rendered: number, presented: number): number {
  return presented > 0 ? Math.max(0, 1 - rendered / presented) : 0
}
