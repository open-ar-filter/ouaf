/**
 * Pairs of faces (spec §12.4, §13): `frame.pairs` and the `pairContact` / `pairSeparate` events.
 *
 * - `PairGeometry` measures, once per displayed frame, every pair of tracked faces **on screen** (units of screen
 *   height, so x and y have the same scale): the distance between the head centres and the gap between the face
 *   outlines, both in **face units**, the mean of the two faces' unit on screen (the distance between the eye centres,
 *   spec §5.1, at the depth of the head). The outline is the face oval of the landmarks (`FACE_OVAL`); the head centre
 *   and the face unit come from the `head` anchor frame, so a turned head keeps its unit. The gap is 0 when the
 *   outlines touch or overlap.
 * - `PairContacts` (one per filter: thresholds are the manifest's) turns the gaps into contact states with the same
 *   hysteresis as the expression events: contact when the gap is at most the `pairContact` threshold (0 by default:
 *   the outlines touch) for `minDurationMs`, released when it exceeds the threshold plus `PAIR_HYSTERESIS` for the
 *   `pairSeparate` `minDurationMs`. A pair is identified by the stable ids of its faces (spec §5.4). A pair missing
 *   from a frame (a face not tracked for a moment) keeps its state for the grace delay of the face ids; after that the
 *   face has left, and a contact ends with `pairSeparate`.
 *
 * Nothing is allocated per frame: every buffer is sized for `maxFaces`.
 */
import type { Matrix4 } from 'three'
import { FACE_OVAL } from '../anchoring/face-mesh.ts'
import type { AnchorProvider } from '../engine/anchor-provider.ts'
import { LANDMARKS_STRIDE, type FaceFrame } from '../face.ts'
import type { VideoToClip } from '../viewport.ts'
import type { EventTuning } from './detector.ts'

/** Release margin of a contact (face units): it ends when the gap exceeds the threshold by this much. */
export const PAIR_HYSTERESIS = 0.1
/** Default `minDurationMs` of `pairContact` (implementation choice, spec Appendix C): the first frame in contact. */
export const DEFAULT_PAIR_CONTACT_MS = 0
/** Default `minDurationMs` of `pairSeparate`: a short tracking jitter apart does not end a contact. */
export const DEFAULT_PAIR_SEPARATE_MS = 100
/** How long (ms) a pair missing from the frames keeps its state: the grace delay of the face ids (spec §5.4). */
export const DEFAULT_PAIR_GRACE_MS = 500
/**
 * Gaps (face units) beyond this are not measured exactly: the gap between the bounding boxes, a lower bound, is
 * reported instead. Above any threshold (at most 1) plus the hysteresis.
 */
export const PAIR_GAP_LIMIT = 1.5

const OVAL = FACE_OVAL.length

/** The pairs of tracked faces of the displayed frame, measured on screen. */
export class PairGeometry {
  readonly maxFaces: number
  /** Faces with a usable geometry this frame. */
  count = 0
  /** Pairs this frame: `count * (count - 1) / 2`, face `a` before face `b` in frame order. */
  pairCount = 0
  /** Per face (compact): slot in the frame, stable id. */
  readonly slot: Int32Array
  readonly id: Float64Array
  /** Per pair: faces (compact indices), distance between the head centres and gap between the outlines (face units). */
  readonly a: Int32Array
  readonly b: Int32Array
  readonly distance: Float64Array
  readonly gap: Float64Array
  // Per face (compact): outline points (x, y), bounding box (minX, minY, maxX, maxY), head centre (x, y), face unit.
  readonly #outline: Float64Array
  readonly #box: Float64Array
  readonly #centre: Float64Array
  readonly #unit: Float64Array

  constructor(maxFaces: number) {
    if (!Number.isInteger(maxFaces) || maxFaces < 1) throw new RangeError(`maxFaces must be a positive integer, got ${maxFaces}`)
    this.maxFaces = maxFaces
    const pairs = (maxFaces * (maxFaces - 1)) / 2
    this.slot = new Int32Array(maxFaces)
    this.id = new Float64Array(maxFaces)
    this.a = new Int32Array(pairs)
    this.b = new Int32Array(pairs)
    this.distance = new Float64Array(pairs)
    this.gap = new Float64Array(pairs)
    this.#outline = new Float64Array(maxFaces * OVAL * 2)
    this.#box = new Float64Array(maxFaces * 4)
    this.#centre = new Float64Array(maxFaces * 2)
    this.#unit = new Float64Array(maxFaces)
  }

  /**
   * Measures the faces of the displayed frame. `anchors` gives their `head` frames in the camera space that
   * `projection` maps to clip space; `videoToClip` maps their landmarks to the same clip space; `aspect` is the
   * displayed width / height. `matrix` is scratch space.
   */
  update(faces: Readonly<FaceFrame>, anchors: AnchorProvider, projection: Matrix4, videoToClip: Readonly<VideoToClip>, aspect: number, matrix: Matrix4): void {
    this.count = 0
    this.pairCount = 0
    const p = projection.elements
    const m = matrix.elements
    const sx = aspect / 2
    const n = Math.min(faces.count, this.maxFaces)
    for (let slot = 0; slot < n; slot++) {
      const id = anchors.id(slot)
      if (id <= 0 || !anchors.face(slot, 'head', 'rigid', matrix)) continue
      // Head centre, projected (camera space → clip), then to screen heights.
      const x = m[12]!
      const y = m[13]!
      const z = m[14]!
      const w = p[3]! * x + p[7]! * y + p[11]! * z + p[15]!
      if (!(w > 0) || !(z < 0)) continue
      const k = this.count
      const c = 2 * k
      this.#centre[c] = (((p[0]! * x + p[4]! * y + p[8]! * z + p[12]!) / w) * sx)
      this.#centre[c + 1] = ((p[1]! * x + p[5]! * y + p[9]! * z + p[13]!) / w) / 2
      // The face unit at the depth of the head: the length of the frame's x axis (cm), projected.
      const unitCm = Math.sqrt(m[0]! * m[0]! + m[1]! * m[1]! + m[2]! * m[2]!)
      this.#unit[k] = (unitCm * p[5]!) / -z / 2
      if (!(this.#unit[k]! > 0)) continue
      // Outline: the face oval of the landmarks, in screen heights.
      const lm = faces.landmarks
      const o = slot * LANDMARKS_STRIDE
      const out = k * OVAL * 2
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let i = 0; i < OVAL; i++) {
        const l = o + FACE_OVAL[i]! * 3
        const px = (videoToClip.ax * lm[l]! + videoToClip.bx) * sx
        const py = (videoToClip.ay * lm[l + 1]! + videoToClip.by) / 2
        this.#outline[out + 2 * i] = px
        this.#outline[out + 2 * i + 1] = py
        if (px < minX) minX = px
        if (px > maxX) maxX = px
        if (py < minY) minY = py
        if (py > maxY) maxY = py
      }
      if (!(maxX >= minX && maxY >= minY)) continue // NaN landmarks
      const b = 4 * k
      this.#box[b] = minX
      this.#box[b + 1] = minY
      this.#box[b + 2] = maxX
      this.#box[b + 3] = maxY
      this.slot[k] = slot
      this.id[k] = id
      this.count++
    }
    for (let i = 0; i < this.count; i++) {
      for (let j = i + 1; j < this.count; j++) {
        const q = this.pairCount++
        const unit = (this.#unit[i]! + this.#unit[j]!) / 2
        this.a[q] = i
        this.b[q] = j
        const dx = this.#centre[2 * i]! - this.#centre[2 * j]!
        const dy = this.#centre[2 * i + 1]! - this.#centre[2 * j + 1]!
        this.distance[q] = Math.sqrt(dx * dx + dy * dy) / unit
        SCRATCH[2] = PAIR_GAP_LIMIT * unit
        this.#gap(q, i, j)
        this.gap[q] = this.gap[q]! / unit
      }
    }
  }

  /**
   * Writes into `gap[q]` the gap between the outlines of faces `i` and `j` (screen heights): 0 when they touch or
   * overlap; beyond `SCRATCH[2]`, the gap between their bounding boxes, a lower bound.
   */
  #gap(q: number, i: number, j: number): void {
    const box = this.#box
    const bi = 4 * i
    const bj = 4 * j
    const dx = Math.max(0, box[bj]! - box[bi + 2]!, box[bi]! - box[bj + 2]!)
    const dy = Math.max(0, box[bj + 1]! - box[bi + 3]!, box[bi + 1]! - box[bj + 3]!)
    const boxGap = Math.sqrt(dx * dx + dy * dy)
    if (boxGap > SCRATCH[2]!) {
      this.gap[q] = boxGap
      return
    }
    const pts = this.#outline
    const oi = i * OVAL * 2
    const oj = j * OVAL * 2
    // Overlap: the outlines cross, or one is inside the other.
    if (boxGap === 0) {
      for (let e = 0; e < OVAL; e++) {
        const a0 = oi + 2 * e
        const a1 = oi + 2 * ((e + 1) % OVAL)
        for (let f = 0; f < OVAL; f++) {
          if (segmentsCross(pts, a0, a1, oj + 2 * f, oj + 2 * ((f + 1) % OVAL))) {
            this.gap[q] = 0
            return
          }
        }
      }
      if (inside(pts, oi, oj) || inside(pts, oj, oi)) {
        this.gap[q] = 0
        return
      }
    }
    // The nearest vertex of either outline to an edge of the other.
    const d = SCRATCH
    d[1] = Infinity
    for (let v = 0; v < OVAL; v++) {
      for (let e = 0; e < OVAL; e++) {
        segmentDistance2(pts, oi + 2 * v, oj + 2 * e, oj + 2 * ((e + 1) % OVAL))
        if (d[0]! < d[1]!) d[1] = d[0]!
        segmentDistance2(pts, oj + 2 * v, oi + 2 * e, oi + 2 * ((e + 1) % OVAL))
        if (d[0]! < d[1]!) d[1] = d[0]!
      }
    }
    this.gap[q] = Math.sqrt(d[1]!)
  }
}

// The helpers below take offsets into the points array (integers) and write numbers into `SCRATCH` rather than take
// or return them: V8 boxes a double passed to or returned from a call it does not inline, which would allocate
// thousands of times per pair and frame.

/** `[0]`: result of `segmentDistance2`; `[1]`: running minimum of `PairGeometry#gap`; `[2]`: its limit. */
const SCRATCH = new Float64Array(3)

/** Writes into `SCRATCH[0]` the squared distance from point `p` to the segment (`s`, `t`) of `pts`. */
function segmentDistance2(pts: Float64Array, p: number, s: number, t: number): void {
  const ax = pts[s]!
  const ay = pts[s + 1]!
  const ex = pts[t]! - ax
  const ey = pts[t + 1]! - ay
  const px = pts[p]! - ax
  const py = pts[p + 1]! - ay
  const len = ex * ex + ey * ey
  let u = len > 0 ? (px * ex + py * ey) / len : 0
  u = u < 0 ? 0 : u > 1 ? 1 : u
  const rx = px - u * ex
  const ry = py - u * ey
  SCRATCH[0] = rx * rx + ry * ry
}

/** The segments (`a0`, `a1`) and (`b0`, `b1`) of `pts` intersect, touching included. */
function segmentsCross(pts: Float64Array, a0: number, a1: number, b0: number, b1: number): boolean {
  const bx = pts[b1]! - pts[b0]!
  const by = pts[b1 + 1]! - pts[b0 + 1]!
  const ax = pts[a1]! - pts[a0]!
  const ay = pts[a1 + 1]! - pts[a0 + 1]!
  // Side of each end against the other segment (cross products).
  const d1 = bx * (pts[a0 + 1]! - pts[b0 + 1]!) - by * (pts[a0]! - pts[b0]!)
  const d2 = bx * (pts[a1 + 1]! - pts[b0 + 1]!) - by * (pts[a1]! - pts[b0]!)
  const d3 = ax * (pts[b0 + 1]! - pts[a0 + 1]!) - ay * (pts[b0]! - pts[a0]!)
  const d4 = ax * (pts[b1 + 1]! - pts[a0 + 1]!) - ay * (pts[b1]! - pts[a0]!)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  // Collinear or touching at an end: touching counts as contact.
  return (d1 === 0 && within(pts, b0, b1, a0)) || (d2 === 0 && within(pts, b0, b1, a1)) || (d3 === 0 && within(pts, a0, a1, b0)) || (d4 === 0 && within(pts, a0, a1, b1))
}

/** Point `p` of `pts` is in the bounding box of the segment (`s`, `t`). */
function within(pts: Float64Array, s: number, t: number, p: number): boolean {
  return Math.min(pts[s]!, pts[t]!) <= pts[p]! && pts[p]! <= Math.max(pts[s]!, pts[t]!) && Math.min(pts[s + 1]!, pts[t + 1]!) <= pts[p + 1]! && pts[p + 1]! <= Math.max(pts[s + 1]!, pts[t + 1]!)
}

/** Point `p` of `pts` is inside the outline at offset `o` (even-odd rule). */
function inside(pts: Float64Array, o: number, p: number): boolean {
  const x = pts[p]!
  const y = pts[p + 1]!
  let result = false
  for (let e = 0, prev = OVAL - 1; e < OVAL; prev = e++) {
    const xi = pts[o + 2 * e]!
    const yi = pts[o + 2 * e + 1]!
    const xj = pts[o + 2 * prev]!
    const yj = pts[o + 2 * prev + 1]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) result = !result
  }
  return result
}

/** One pair event. Instances are reused: copy what you keep. */
export interface PairEvent {
  name: 'pairContact' | 'pairSeparate'
  /** Stable ids of the two faces, in frame order (`pairSeparate` of a face that left: the order of the contact). */
  a: number
  b: number
}

/** Hysteresis states. */
const IDLE = 0
const PENDING_ON = 1
const ACTIVE = 2
const PENDING_OFF = 3

/** Contact states of the pairs of faces, and their events, for one filter's tuning. */
export class PairContacts {
  /** Contact of each pair of the last `update` (indexed like the geometry's pairs). */
  readonly contact: Uint8Array
  readonly #on = new Float64Array(4) // threshold, release level, min durations on and off (ms)
  // Per tracked pair (unordered ids), up to `capacity`.
  readonly #idA: Float64Array
  readonly #idB: Float64Array
  readonly #state: Uint8Array
  readonly #since: Float64Array
  readonly #seen: Uint8Array
  /** Time the pair was last in a frame (ms). */
  readonly #lastSeen: Float64Array
  readonly #graceMs: number
  #count = 0
  #lastT = -Infinity
  readonly #out: { count: number; items: PairEvent[] }

  /** `graceMs`: how long a pair missing from the frames keeps its state (the face ids' grace delay). */
  constructor(maxFaces: number, events?: EventTuning, graceMs = DEFAULT_PAIR_GRACE_MS) {
    // The pairs of a frame, and those of the faces in their grace delay (up to twice as many faces, as face identity).
    const capacity = Math.max(1, maxFaces * (2 * maxFaces - 1))
    this.#graceMs = graceMs
    this.contact = new Uint8Array(Math.max(1, (maxFaces * (maxFaces - 1)) / 2))
    this.#idA = new Float64Array(capacity)
    this.#idB = new Float64Array(capacity)
    this.#state = new Uint8Array(capacity)
    this.#since = new Float64Array(capacity)
    this.#seen = new Uint8Array(capacity)
    this.#lastSeen = new Float64Array(capacity)
    // At most one event per pair and frame, plus the ends of the pairs whose face left.
    const items: PairEvent[] = []
    for (let i = 0; i < 2 * capacity; i++) items.push({ name: 'pairContact', a: 0, b: 0 })
    this.#out = { count: 0, items }
    this.configure(events)
  }

  /** Applies the manifest's `events` tuning. */
  configure(events?: EventTuning): void {
    const t = events?.pairContact?.threshold
    const threshold = typeof t === 'number' && t >= 0 && t <= 1 ? t : 0
    const minOn = events?.pairContact?.minDurationMs
    const minOff = events?.pairSeparate?.minDurationMs
    this.#on[0] = threshold
    this.#on[1] = threshold + PAIR_HYSTERESIS
    this.#on[2] = typeof minOn === 'number' && minOn >= 0 ? minOn : DEFAULT_PAIR_CONTACT_MS
    this.#on[3] = typeof minOff === 'number' && minOff >= 0 ? minOff : DEFAULT_PAIR_SEPARATE_MS
  }

  /** Forgets every pair without events (a new source, a new run). */
  reset(): void {
    this.#count = 0
    this.#lastT = -Infinity
    this.#out.count = 0
  }

  /**
   * Steps every pair of `geometry` at media time `timeMs`; returns the events, in a buffer reused by the next call.
   * Time going backwards (seek, loop) forgets the contacts without events.
   */
  update(timeMs: number, geometry: Readonly<PairGeometry>): { readonly count: number; readonly items: readonly PairEvent[] } {
    const out = this.#out
    out.count = 0
    if (timeMs < this.#lastT) this.#count = 0
    this.#lastT = timeMs
    this.#seen.fill(0, 0, this.#count)
    const on = this.#on[0]!
    const off = this.#on[1]!
    const minOn = this.#on[2]!
    const minOff = this.#on[3]!
    for (let q = 0; q < geometry.pairCount; q++) {
      const a = geometry.id[geometry.a[q]!]!
      const b = geometry.id[geometry.b[q]!]!
      const k = this.#find(a, b)
      if (k < 0) {
        this.contact[q] = 0
        continue
      }
      this.#seen[k] = 1
      this.#lastSeen[k] = timeMs
      const gap = geometry.gap[q]!
      const state = this.#state
      const since = this.#since
      switch (state[k]) {
        case IDLE:
          if (gap <= on) {
            state[k] = PENDING_ON
            since[k] = timeMs
          }
          break
        case PENDING_ON:
          if (gap > off) state[k] = IDLE
          break
        case ACTIVE:
          if (gap > off) {
            state[k] = PENDING_OFF
            since[k] = timeMs
          }
          break
        default: // PENDING_OFF
          if (gap <= on) state[k] = ACTIVE
      }
      if (state[k] === PENDING_ON && timeMs - since[k]! >= minOn) {
        state[k] = ACTIVE
        this.#emit('pairContact', a, b)
      } else if (state[k] === PENDING_OFF && timeMs - since[k]! >= minOff) {
        state[k] = IDLE
        this.#emit('pairSeparate', a, b)
      }
      this.contact[q] = state[k] === ACTIVE || state[k] === PENDING_OFF ? 1 : 0
    }
    // Pairs missing for longer than the grace delay: a face left, and a contact ends.
    for (let k = this.#count - 1; k >= 0; k--) {
      if (this.#seen[k] || timeMs - this.#lastSeen[k]! <= this.#graceMs) continue
      if (this.#state[k] === ACTIVE || this.#state[k] === PENDING_OFF) this.#emit('pairSeparate', this.#idA[k]!, this.#idB[k]!)
      this.#remove(k)
    }
    return out
  }

  /** Index of the pair of ids `a`, `b` (either order), created if new; -1 when full. */
  #find(a: number, b: number): number {
    for (let k = 0; k < this.#count; k++) {
      if ((this.#idA[k] === a && this.#idB[k] === b) || (this.#idA[k] === b && this.#idB[k] === a)) return k
    }
    const k = this.#count
    if (k >= this.#state.length) return -1
    this.#count++
    this.#idA[k] = a
    this.#idB[k] = b
    this.#state[k] = IDLE
    this.#seen[k] = 0
    this.#lastSeen[k] = this.#lastT
    return k
  }

  #remove(k: number): void {
    const last = --this.#count
    if (k === last) return
    this.#idA[k] = this.#idA[last]!
    this.#idB[k] = this.#idB[last]!
    this.#state[k] = this.#state[last]!
    this.#since[k] = this.#since[last]!
    this.#seen[k] = this.#seen[last]!
    this.#lastSeen[k] = this.#lastSeen[last]!
  }

  #emit(name: PairEvent['name'], a: number, b: number): void {
    const out = this.#out
    const e = out.items[out.count]
    if (!e) return
    e.name = name
    e.a = a
    e.b = b
    out.count++
  }
}
