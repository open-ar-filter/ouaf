/**
 * The faces the LiteRT.js pipeline tracks (#165, multi-face): one slot per face, each with the ROI tracked from its
 * previous landmarks (MediaPipe's policy, `face_landmarker_graph`): the detector only looks for the faces that are
 * missing, and a detection that covers a tracked face is not a new face. A slot keeps its face from result to result,
 * so faces do not swap when they cross; a face lost frees its slot. Pure logic, no model: unit-tested on its own.
 */
import type { Roi } from './geometry.ts'

export interface FaceSlot {
  readonly index: number
  /** The ROI to crop on the next frame (from this face's last landmarks or its detection); undefined: free. */
  roi: Roi | undefined
  /** The ROI before `roi` (consecutive results only): extrapolation of the async readback. */
  before: Roi | undefined
  /** Face presence of the last result (0–1). */
  presence: number
}

/** Overlap of two ROIs, as axis-aligned squares (intersection over union, 0–1). */
export function roiOverlap(a: Roi, b: Roi): number {
  const ha = a.size / 2
  const hb = b.size / 2
  const w = Math.min(a.cx + ha, b.cx + hb) - Math.max(a.cx - ha, b.cx - hb)
  const h = Math.min(a.cy + ha, b.cy + hb) - Math.max(a.cy - ha, b.cy - hb)
  if (w <= 0 || h <= 0) return 0
  const inter = w * h
  return inter / (a.size * a.size + b.size * b.size - inter)
}

/** A detection whose ROI overlaps a tracked face's by more than this is that face. */
export const DETECTION_OVERLAP = 0.3
/** Two tracked ROIs that overlap by more than this follow the same face: one of them is freed. */
export const DUPLICATE_OVERLAP = 0.5

export class FaceSlots {
  readonly slots: FaceSlot[]

  constructor(capacity: number) {
    this.slots = Array.from({ length: capacity }, (_, index) => ({ index, roi: undefined, before: undefined, presence: 0 }))
  }

  /** The tracked slots, in slot order. */
  get active(): FaceSlot[] {
    return this.slots.filter((s) => s.roi !== undefined)
  }

  get count(): number {
    let n = 0
    for (const s of this.slots) if (s.roi) n++
    return n
  }

  /**
   * Keeps the first `limit` tracked faces (in slot order), frees the others (extra faces dropped, spec §16.2).
   * Returns the slots freed.
   */
  limit(limit: number): FaceSlot[] {
    const freed: FaceSlot[] = []
    let kept = 0
    for (const s of this.slots) {
      if (!s.roi) continue
      if (kept < limit) kept++
      else {
        this.free(s)
        freed.push(s)
      }
    }
    return freed
  }

  /**
   * Places new detections (best first) into free slots, up to `limit` tracked faces; a detection that overlaps a
   * tracked face (or one placed before it) is that face, not a new one. Returns the slots filled.
   */
  addDetections(rois: readonly Roi[], limit: number): FaceSlot[] {
    const added: FaceSlot[] = []
    let count = this.count
    for (const roi of rois) {
      if (count >= limit) break
      if (this.slots.some((s) => s.roi && roiOverlap(s.roi, roi) > DETECTION_OVERLAP)) continue
      const slot = this.slots.find((s) => !s.roi)
      if (!slot) break
      slot.roi = roi
      slot.before = undefined
      slot.presence = 0
      added.push(slot)
      count++
    }
    return added
  }

  /** The result of `slot`: its face found (`roi` from its landmarks, for the next frame) or lost (`undefined`). */
  track(slot: FaceSlot, roi: Roi | undefined, presence: number, consecutive = true): void {
    if (!roi) return this.free(slot)
    slot.before = consecutive ? slot.roi : undefined
    slot.roi = roi
    slot.presence = presence
  }

  /**
   * Two slots on the same face (their ROIs converged, e.g. a detection of a face already tracked under another
   * angle): frees the one with the lower presence, the higher slot on a tie. Returns the slots freed.
   */
  dedup(): FaceSlot[] {
    const freed: FaceSlot[] = []
    const active = this.active
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i]!
        const b = active[j]!
        if (!a.roi || !b.roi || roiOverlap(a.roi, b.roi) <= DUPLICATE_OVERLAP) continue
        const loser = b.presence > a.presence ? a : b
        this.free(loser)
        freed.push(loser)
      }
    }
    return freed
  }

  /** The ROI to crop on a frame one result later than `slot.roi` (async readback): extrapolated from the last two. */
  predict(slot: FaceSlot): Roi | undefined {
    const a = slot.roi
    const b = slot.before
    if (!a || !b) return a
    return { cx: 2 * a.cx - b.cx, cy: 2 * a.cy - b.cy, size: a.size, rotation: a.rotation }
  }

  free(slot: FaceSlot): void {
    slot.roi = slot.before = undefined
    slot.presence = 0
  }

  reset(): void {
    for (const s of this.slots) this.free(s)
  }
}

/** Quick retries of the detector after a detection the landmark model did not confirm. */
export const DETECTOR_RETRIES = 3

/**
 * When the detector runs: on every frame while no face is tracked; while some are tracked but fewer than wanted, at
 * most every `intervalMs` (a slot that stays empty, the usual case with `maxFaces` > the faces in view, would
 * otherwise add the detector's cost to every result: ≈ 25–45 ms on the Redmi Note 11S). Except right after a
 * detection whose face the landmark model did not confirm (a ROI a little off on the first frame, as on
 * `two-faces-stacked`): the detector runs again on the next frames, `DETECTOR_RETRIES` times at most in a row, so
 * that a face in view is not missed for `intervalMs` while a persistent false detection does not cost every frame.
 */
export class DetectorSchedule {
  readonly intervalMs: number
  #last = Number.NEGATIVE_INFINITY
  #retry = false
  #retries = 0

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs
  }

  due(tracked: number, wanted: number, now: number): boolean {
    if (tracked >= wanted) return false
    return tracked === 0 || this.#retry || now - this.#last >= this.intervalMs
  }

  /** The detector ran; `unconfirmed`: some of the faces it found were not confirmed by the landmark model. */
  ran(now: number, unconfirmed = false): void {
    this.#last = now
    this.#retry = unconfirmed && this.#retries < DETECTOR_RETRIES
    this.#retries = this.#retry ? this.#retries + 1 : 0
  }

  reset(): void {
    this.#last = Number.NEGATIVE_INFINITY
    this.#retry = false
    this.#retries = 0
  }
}
