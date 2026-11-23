/**
 * Device governor (spec §16): keeps the tracking rate above the floor by dropping optional capabilities, in a fixed
 * order, and hides the face filters when even that is not enough. Pure logic, driven by the engine with the measured
 * tracking rate; the engine applies the decisions (tracker configuration, suspended filters, `performance` events).
 *
 * Timeline (`DEFAULT_GOVERNOR_TUNING`):
 * - After each change (start, drop, restore, hide, show) the rate window restarts and nothing is judged for
 *   `settleMs` (1 s), so that every decision is made on the rate of the current configuration.
 * - **Drop**: a settled rate below `dropBelowHz` (13 Hz) drops the next optional capability the stack can do without
 *   (blendshapes, then extra faces, then analysis resolution): one per `settleMs` (1 s) while the rate stays low.
 * - **Hide** (spec §16.3): once the rate has stayed below the 12 Hz floor for 3 s and nothing is left to drop.
 * - **Show**: once the rate predicted with the filters shown is above 14 Hz for `showAfterMs`. Hiding them frees the
 *   main thread, so the rate while hidden is not that rate: the prediction is the rate measured just before hiding,
 *   scaled by how much faster tracking got after the first `hiddenBaselineMs` (6 s) hidden. Without such a gain, only
 *   the slow probes (below) show them again. The delays double each time the filters are hidden again soon after
 *   being shown.
 * - **Restore**: the last capability dropped comes back first, once the rate predicted with it (what dropping it
 *   gained, as a share of the pipeline time per result, added back to the current period) stays above
 *   `restoreAboveHz` (17 Hz) for `restoreAfterMs` (5 s); the delay doubles for a capability dropped
 *   again soon after its restore. A capability that becomes required (`requires.blendshapes` added) or no longer
 *   applies is restored at once.
 * - **Probe**: when the rate itself is high enough but the prediction says no, the show or restore is tried after
 *   `probeAfterMs` (30 s, doubling on each failure up to 10 min): a gain measured while the load was changing cannot
 *   block it for good.
 */

/** Optional capabilities (spec §16.2), in drop order. */
export const CAPABILITIES = ['blendshapes', 'extraFaces', 'resolution'] as const
export type Capability = (typeof CAPABILITIES)[number]

export type PerformanceState = 'ok' | 'degraded' | 'unsupported'

/** Floor of the tracking rate (spec §16.1). */
export const TRACKING_FLOOR_HZ = 12
/** Rate above which hidden filters are shown again (spec §16.3). */
export const TRACKING_RESUME_HZ = 14
/** Time below the floor before the filters are hidden (spec §16.3). */
export const FLOOR_DELAY_MS = 3000

export interface GovernorTuning {
  floorHz: number
  resumeHz: number
  floorDelayMs: number
  /** Time after a change before the rate is judged (the rate window restarts at each change). */
  settleMs: number
  /** A settled rate below this drops the next optional capability. */
  dropBelowHz: number
  /** A dropped capability is restored when the rate predicted with it stays above this... */
  restoreAboveHz: number
  /** ...for this long (ms), doubled each time it had to be dropped again soon after a restore. */
  restoreAfterMs: number
  /** Hidden filters are shown again after the rate stays above `resumeHz` this long, doubled on each quick re-hide. */
  showAfterMs: number
  /** After hiding, what hiding gained is measured this long (ms) before a show can be predicted. */
  hiddenBaselineMs: number
  /**
   * When the measured rate is high enough but the prediction (from a gain measured once) says no, the show or restore
   * is tried anyway after this long (ms; doubled like the other delays): a gain measured while the load changed
   * would otherwise block it for good.
   */
  probeAfterMs: number
  /** Longest probe delay (ms). */
  maxProbeMs: number
  /** A drop (or hide) within this delay after a restore (or show) doubles the next delay. */
  probationMs: number
  /** Longest restore / show delay (ms). */
  maxDelayMs: number
}

export const DEFAULT_GOVERNOR_TUNING: Readonly<GovernorTuning> = {
  floorHz: TRACKING_FLOOR_HZ,
  resumeHz: TRACKING_RESUME_HZ,
  floorDelayMs: FLOOR_DELAY_MS,
  settleMs: 1000,
  dropBelowHz: 13,
  restoreAboveHz: 17,
  restoreAfterMs: 5000,
  showAfterMs: 1000,
  hiddenBaselineMs: 6000,
  probeAfterMs: 30_000,
  maxProbeMs: 600_000,
  probationMs: 10_000,
  maxDelayMs: 120_000,
}

/** Largest delay multiplier (the delays themselves are capped by `maxDelayMs` and `maxProbeMs`). */
const MAX_BACKOFF = 1024

/** What the caller measured besides the tracking rate (`DeviceGovernor.update`). */
export interface GovernorMeasures {
  /**
   * Mean time from a frame's submission to its result over the same period (ms): what a capability costs even when
   * the camera's frame rate caps the tracking rate.
   */
  pipelineMs?: number
  /** Faces in the latest result: recorded with each drop and hide (`referenceFaces`). */
  faces?: number
  /**
   * Rate (Hz) and pipeline time (ms) of the results with at least `referenceFaces` faces, for showing and restoring:
   * a tracker is much faster without a face to analyse (MediaPipe then runs only its detector), and that is no
   * recovery. NaN: no such result in the window (no decision then). Default: `rateHz` and `pipelineMs`.
   */
  recoveryHz?: number
  recoveryPipelineMs?: number
}

export type GovernorChange =
  | { readonly kind: 'drop' | 'restore'; readonly capability: Capability }
  | { readonly kind: 'hide' | 'show' }

interface CapabilityState {
  /** Rate and pipeline time (ms per result) measured just before it was dropped. */
  rateBefore: number
  pipelineBefore: number
  /**
   * What dropping it gained, as a ratio of times (≤ 1): pipeline time once dropped / before (or tracking periods,
   * without pipeline times). Relative, so that it still holds when the device gets faster or slower. NaN until
   * measured, on the first settled rate after the drop.
   */
  ratio: number
  /** `ratio` compares pipeline times (else tracking periods). */
  ofPipeline: boolean
  /** Restore delay multiplier (backoff). */
  backoff: number
  /** When it was last restored (-Infinity: never). */
  restoredAt: number
  /** Since when the predicted rate with it has stayed above `restoreAboveHz` (NaN: not now). */
  goodSince: number
  /** Faces tracked when it was dropped. */
  facesAtDrop: number
}

export class DeviceGovernor {
  readonly tuning: Readonly<GovernorTuning>
  #dropped: Capability[] = []
  #hidden = false
  #changedAt = Number.NaN
  /** The first settled evaluation since the last change has not happened yet (the gain of the last change is measured on it). */
  #fresh = false
  #belowSince = Number.NaN
  #aboveSince = Number.NaN
  #showBackoff = 1
  #shownAt = -Infinity
  /** Rate just before the filters were hidden (shown), when they were hidden, and the rate and pipeline time measured
   * once hidden (`hiddenBaselineMs`): what hiding them gained, which a later rate must beat to predict a show. */
  #rateBeforeHide = Number.NaN
  #hiddenAt = Number.NaN
  #hiddenRate = 0
  #hiddenPipeline = Number.NaN
  /** Faces tracked when the filters were hidden. */
  #facesAtHide = 0
  #caps: Record<Capability, CapabilityState>

  constructor(tuning: Partial<GovernorTuning> = {}) {
    this.tuning = { ...DEFAULT_GOVERNOR_TUNING, ...tuning }
    this.#caps = Object.fromEntries(
      CAPABILITIES.map((c) => [c, { rateBefore: NaN, pipelineBefore: NaN, ratio: NaN, ofPipeline: false, backoff: 1, restoredAt: -Infinity, goodSince: NaN, facesAtDrop: 0 }]),
    ) as Record<Capability, CapabilityState>
  }

  /** Capabilities dropped, in drop order. */
  get dropped(): readonly Capability[] {
    return this.#dropped
  }

  isDropped(capability: Capability): boolean {
    return this.#dropped.includes(capability)
  }

  /** The face filters are hidden (spec §16.3). */
  get hidden(): boolean {
    return this.#hidden
  }

  get state(): PerformanceState {
    return this.#hidden ? 'unsupported' : this.#dropped.length > 0 ? 'degraded' : 'ok'
  }

  /** Restarts the measure without changing anything (the rate window restarts too): e.g. after a pause of frames. */
  restart(now: number): void {
    this.#changed(now)
  }

  /** Back to everything on and shown, and forgets what was learnt (new source). */
  reset(now: number): void {
    this.#dropped = []
    this.#hidden = false
    this.#showBackoff = 1
    this.#shownAt = -Infinity
    this.#rateBeforeHide = Number.NaN
    this.#hiddenAt = Number.NaN
    this.#facesAtHide = 0
    for (const c of CAPABILITIES) Object.assign(this.#caps[c], { rateBefore: NaN, pipelineBefore: NaN, ratio: NaN, ofPipeline: false, backoff: 1, restoredAt: -Infinity, goodSince: NaN, facesAtDrop: 0 })
    this.#changed(now)
  }

  /**
   * Faces the latest drop or hide was decided with: the rate that counts for showing and restoring is the one of the
   * results with at least that many faces (`GovernorMeasures.recoveryHz`). 0 when nothing is dropped or hidden.
   */
  get referenceFaces(): number {
    if (this.#hidden) return this.#facesAtHide
    const last = this.#dropped.at(-1)
    return last ? this.#caps[last].facesAtDrop : 0
  }

  /**
   * One evaluation, with the tracking rate measured since the last change (`rateHz`, all results) and the
   * capabilities the stack may lose now (`droppable`: used by a filter and not required); `measures` adds what the
   * caller knows (see `GovernorMeasures`). Returns the change to apply, if any; the caller restarts the rate window
   * after a change. At most one change per call.
   */
  update(now: number, rateHz: number, droppable: ReadonlySet<Capability>, measures: GovernorMeasures = {}): GovernorChange | undefined {
    const t = this.tuning
    const pipelineMs = measures.pipelineMs ?? Number.NaN
    const faces = measures.faces ?? Number.POSITIVE_INFINITY
    // Showing and restoring judge the results with the faces of the decision; dropping and hiding, every result.
    const recoveryHz = measures.recoveryHz ?? rateHz
    const recoveryPipelineMs = measures.recoveryPipelineMs ?? pipelineMs
    if (Number.isNaN(this.#changedAt)) this.#changed(now)
    // A dropped capability that may not be dropped any more comes back at once.
    for (const c of this.#dropped) if (!droppable.has(c)) return this.#restore(now, c, false)
    if (now - this.#changedAt < t.settleMs) return undefined

    if (this.#fresh) {
      this.#fresh = false
      const last = this.#dropped.at(-1)
      const cap = last && this.#caps[last]
      if (!this.#hidden && cap && Number.isNaN(cap.ratio)) {
        cap.ofPipeline = recoveryPipelineMs > 0 && cap.pipelineBefore > 0
        if (cap.ofPipeline) cap.ratio = Math.min(1, recoveryPipelineMs / cap.pipelineBefore)
        else if (recoveryHz > 0 && cap.rateBefore > 0) cap.ratio = Math.min(1, cap.rateBefore / recoveryHz)
      }
    }

    // Floor timer: the rate measured since the last change covers that whole period.
    if (rateHz < t.floorHz) {
      if (Number.isNaN(this.#belowSince)) this.#belowSince = this.#changedAt
    } else this.#belowSince = Number.NaN

    if (this.#hidden) {
      // No result with the faces of the hide in the window (none in view): nothing to judge; the timers keep running.
      if (Number.isNaN(recoveryHz)) return undefined
      // Hiding the filters frees the main thread (rendering, scripts): the rate measured while hidden says nothing
      // about the rate once shown. First learn what hiding gained (the hidden rate and pipeline time over
      // `hiddenBaselineMs`); then the rate predicted with the filters shown is the rate before hiding, scaled by how
      // much faster tracking got since (rate or pipeline time). Otherwise only slow probes try again.
      if (now - this.#hiddenAt < t.hiddenBaselineMs || this.#hiddenRate === 0) {
        this.#hiddenRate = Math.max(this.#hiddenRate, recoveryHz)
        if (recoveryPipelineMs > 0) this.#hiddenPipeline = recoveryPipelineMs
      }
      const learnt = now - this.#hiddenAt >= t.hiddenBaselineMs && this.#hiddenRate > 0
      const gain = learnt
        ? Math.max(recoveryHz / this.#hiddenRate, this.#hiddenPipeline > 0 && recoveryPipelineMs > 0 ? this.#hiddenPipeline / recoveryPipelineMs : 0)
        : 0
      const shown = this.#rateBeforeHide * gain
      const wait =
        shown > t.resumeHz
          ? Math.min(t.maxDelayMs, t.showAfterMs * this.#showBackoff)
          : recoveryHz > t.resumeHz
            ? Math.min(t.maxProbeMs, t.probeAfterMs * this.#showBackoff)
            : Number.NaN
      if (!Number.isNaN(wait)) {
        if (Number.isNaN(this.#aboveSince)) this.#aboveSince = now
        if (now - this.#aboveSince >= wait) {
          this.#hidden = false
          this.#shownAt = now
          this.#changed(now)
          return { kind: 'show' }
        }
      } else this.#aboveSince = Number.NaN
      return undefined
    }
    // Shown for long enough: quick re-hides are forgiven.
    if (now - this.#shownAt > 3 * t.probationMs) this.#showBackoff = 1

    if (rateHz < t.dropBelowHz) {
      for (const c of CAPABILITIES) this.#caps[c].goodSince = Number.NaN
      const next = CAPABILITIES.find((c) => droppable.has(c) && !this.#dropped.includes(c))
      if (next) {
        const cap = this.#caps[next]
        if (now - cap.restoredAt < t.probationMs) cap.backoff = Math.min(cap.backoff * 2, MAX_BACKOFF)
        cap.rateBefore = rateHz
        cap.pipelineBefore = pipelineMs
        cap.facesAtDrop = Math.min(faces, 1e6)
        cap.ratio = Number.NaN
        this.#dropped.push(next)
        this.#changed(now)
        return { kind: 'drop', capability: next }
      }
      if (!Number.isNaN(this.#belowSince) && now - this.#belowSince >= t.floorDelayMs) {
        if (now - this.#shownAt < t.probationMs) this.#showBackoff = Math.min(this.#showBackoff * 2, MAX_BACKOFF)
        this.#hidden = true
        this.#rateBeforeHide = rateHz
        this.#hiddenAt = now
        this.#hiddenRate = 0
        this.#hiddenPipeline = Number.NaN
        this.#facesAtHide = Math.min(faces, 1e6)
        this.#changed(now)
        return { kind: 'hide' }
      }
      return undefined
    }

    const last = this.#dropped.at(-1)
    if (!last) return undefined
    const cap = this.#caps[last]
    // No result with the faces of the drop in the window: nothing to judge; the timers keep running.
    if (Number.isNaN(recoveryHz)) return undefined
    // Restoring it adds its share back to what was measured (the pipeline time, else the tracking period), on top of
    // the current period: rate 30 Hz capped by the camera, pipeline 8 ms, ratio 0.6 → 1000 / (33 + 5.3) = 26 Hz.
    const period = 1000 / recoveryHz
    const ratio = Number.isNaN(cap.ratio) || !(cap.ratio > 0) ? 1 : cap.ratio
    const basis = cap.ofPipeline && recoveryPipelineMs > 0 ? recoveryPipelineMs : period
    const predicted = recoveryHz > 0 ? 1000 / (period + basis * (1 / ratio - 1)) : 0
    const wait =
      predicted >= t.restoreAboveHz
        ? Math.min(t.maxDelayMs, t.restoreAfterMs * cap.backoff)
        : recoveryHz >= t.restoreAboveHz
          ? Math.min(t.maxProbeMs, t.probeAfterMs * cap.backoff)
          : Number.NaN
    if (Number.isNaN(wait)) {
      cap.goodSince = Number.NaN
      return undefined
    }
    if (Number.isNaN(cap.goodSince)) cap.goodSince = now
    if (now - cap.goodSince < wait) return undefined
    return this.#restore(now, last, true)
  }

  #restore(now: number, capability: Capability, earned: boolean): GovernorChange {
    const cap = this.#caps[capability]
    this.#dropped.splice(this.#dropped.indexOf(capability), 1)
    cap.goodSince = Number.NaN
    // A forced restore (now required) says nothing about whether the device can afford it.
    if (earned) cap.restoredAt = now
    this.#changed(now)
    return { kind: 'restore', capability }
  }

  #changed(now: number): void {
    this.#changedAt = now
    this.#fresh = true
    this.#aboveSince = Number.NaN
  }
}
