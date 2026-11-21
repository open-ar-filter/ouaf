/**
 * Stable face ids (spec §5.4): frame-to-frame matching of the tracked faces, with a grace delay.
 *
 * Each face of a result is matched to a **track** by the distance between its bounding-box centre and the track's
 * predicted centre (constant velocity), in face sizes, plus a size-change term; the assignment is optimal
 * (Hungarian method) and gated, so faces that cross keep their ids even when the tracker swaps their order.
 * A track that is not matched survives `graceMs` (about 500 ms, for occlusions, e.g. while the faces overlap),
 * moving on its predicted path; after that it ends, and a face seen again later gets a **new** id: the matching
 * uses positions only, never appearance (no face recognition).
 *
 * Allocation-free after construction.
 */
import { LANDMARKS_STRIDE, type FaceFrame } from '../face.ts'

export interface FaceIdentityOptions {
  /** Faces per result (the `FaceFrame` capacity). */
  maxFaces: number
  /** How long a face that is no longer tracked keeps its id (ms). Default 500. */
  graceMs?: number
  /** Largest matching cost, in face sizes, for a face to continue a track. Default 1. */
  gate?: number
  /** Tracks kept at once, alive or in their grace delay. Default `2 × maxFaces`. */
  capacity?: number
}

/** Mesh landmarks used for the bounding box (the irises are inside it). */
const MESH_LANDMARKS = 468
const BIG = 1e9

export class FaceIdentityTracker {
  readonly maxFaces: number
  readonly capacity: number
  readonly graceMs: number
  readonly gate: number

  /** Id of the face in each slot of the last result (`ids[i]` for `i < count`); ids start at 1 and never repeat. */
  readonly ids: Int32Array
  /** Track index (0 ≤ track < capacity) of the face in each slot of the last result. */
  readonly tracks: Int32Array
  /** Bounding-box size of the face in each slot of the last result (max of width and height, pixels). */
  readonly sizes: Float64Array
  /** Faces in the last result. */
  count = 0
  /** Ids that started with the last update (`faceEnter`). */
  readonly entered: Int32Array
  enteredCount = 0
  /** Ids that ended with the last update, after their grace delay (`faceLeave`). */
  readonly left: Int32Array
  leftCount = 0

  // Track pool.
  readonly #trackId: Int32Array // 0 = free
  readonly #cx: Float64Array
  readonly #cy: Float64Array
  readonly #vx: Float64Array
  readonly #vy: Float64Array
  readonly #size: Float64Array
  readonly #seen: Float64Array // time last matched (s)
  readonly #hits: Int32Array
  // Detections of the current result.
  readonly #dx: Float64Array
  readonly #dy: Float64Array
  readonly #ds: Float64Array
  readonly #detTrack: Int32Array
  // Assignment scratch.
  readonly #rowTrack: Int32Array
  readonly #cost: Float64Array
  readonly #u: Float64Array
  readonly #v: Float64Array
  readonly #minv: Float64Array
  readonly #p: Int32Array
  readonly #way: Int32Array
  readonly #used: Uint8Array
  readonly #dim: number
  #nextId = 1
  #time = Number.NaN

  constructor(options: FaceIdentityOptions) {
    const { maxFaces } = options
    if (!Number.isInteger(maxFaces) || maxFaces < 1) throw new RangeError(`maxFaces must be a positive integer, got ${maxFaces}`)
    this.maxFaces = maxFaces
    this.capacity = Math.max(maxFaces, options.capacity ?? 2 * maxFaces)
    this.graceMs = options.graceMs ?? 500
    this.gate = options.gate ?? 1
    const K = this.capacity
    this.ids = new Int32Array(maxFaces)
    this.tracks = new Int32Array(maxFaces)
    this.sizes = new Float64Array(maxFaces)
    this.entered = new Int32Array(K + maxFaces)
    this.left = new Int32Array(K + maxFaces)
    this.#trackId = new Int32Array(K)
    this.#cx = new Float64Array(K)
    this.#cy = new Float64Array(K)
    this.#vx = new Float64Array(K)
    this.#vy = new Float64Array(K)
    this.#size = new Float64Array(K)
    this.#seen = new Float64Array(K)
    this.#hits = new Int32Array(K)
    this.#dx = new Float64Array(maxFaces)
    this.#dy = new Float64Array(maxFaces)
    this.#ds = new Float64Array(maxFaces)
    this.#detTrack = new Int32Array(maxFaces)
    this.#rowTrack = new Int32Array(K)
    const dim = K + maxFaces
    this.#dim = dim
    this.#cost = new Float64Array((dim + 1) * (dim + 1))
    this.#u = new Float64Array(dim + 1)
    this.#v = new Float64Array(dim + 1)
    this.#minv = new Float64Array(dim + 1)
    this.#p = new Int32Array(dim + 1)
    this.#way = new Int32Array(dim + 1)
    this.#used = new Uint8Array(dim + 1)
  }

  /** Id of track `track`, or 0 if that track is free. */
  trackId(track: number): number {
    return this.#trackId[track] ?? 0
  }

  /** Ends every track (their ids go to `left`) and forgets the clock. */
  reset(): void {
    this.enteredCount = 0
    this.leftCount = 0
    for (let k = 0; k < this.capacity; k++) if (this.#trackId[k] !== 0) this.#end(k)
    this.count = 0
    this.#time = Number.NaN
  }

  /**
   * Matches the faces of a new result, taken at `time` (s, e.g. the media time of the analysed frame), to the
   * tracks. Fills `ids`, `tracks`, `sizes`, `count`, `entered` and `left`. A time earlier than the previous one
   * (a video that loops or seeks back) ends every track first.
   */
  update(faces: Readonly<FaceFrame>, time: number): void {
    this.enteredCount = 0
    this.leftCount = 0
    if (time < this.#time) for (let k = 0; k < this.capacity; k++) if (this.#trackId[k] !== 0) this.#end(k)
    this.#time = time
    const K = this.capacity
    const grace = this.graceMs / 1000

    // Tracks whose grace delay is over end now.
    for (let k = 0; k < K; k++) if (this.#trackId[k] !== 0 && time - this.#seen[k]! > grace) this.#end(k)

    // Detections: bounding box of the mesh, in pixels (normalized units when the frame size is unknown).
    const m = Math.min(faces.count, this.maxFaces)
    const w = faces.width > 0 ? faces.width : 1
    const h = faces.height > 0 ? faces.height : 1
    const L = faces.landmarks
    for (let j = 0; j < m; j++) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      const base = j * LANDMARKS_STRIDE
      for (let i = 0; i < MESH_LANDMARKS; i++) {
        const x = L[base + i * 3]!
        const y = L[base + i * 3 + 1]!
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      this.#dx[j] = ((minX + maxX) / 2) * w
      this.#dy[j] = ((minY + maxY) / 2) * h
      this.#ds[j] = Math.max((maxX - minX) * w, (maxY - minY) * h, 1e-6)
      this.#detTrack[j] = -1
    }

    // Live tracks → rows of the assignment.
    let n = 0
    for (let k = 0; k < K; k++) if (this.#trackId[k] !== 0) this.#rowTrack[n++] = k
    if (n > 0 && m > 0) this.#assign(n, m, time)

    // Unmatched detections start new tracks; a full pool drops the track unseen for the longest time.
    for (let j = 0; j < m; j++) {
      if (this.#detTrack[j] !== -1) continue
      let k = this.#trackId.indexOf(0)
      if (k < 0) {
        let oldest = Infinity
        for (let t = 0; t < K; t++) {
          if (this.#seen[t]! < time && this.#seen[t]! < oldest) {
            oldest = this.#seen[t]!
            k = t
          }
        }
        this.#end(k)
      }
      const id = this.#nextId++
      this.#trackId[k] = id
      this.#cx[k] = this.#dx[j]!
      this.#cy[k] = this.#dy[j]!
      this.#vx[k] = 0
      this.#vy[k] = 0
      this.#size[k] = this.#ds[j]!
      this.#seen[k] = time
      this.#hits[k] = 1
      this.#detTrack[j] = k
      this.entered[this.enteredCount++] = id
    }

    for (let j = 0; j < m; j++) {
      const k = this.#detTrack[j]!
      this.tracks[j] = k
      this.ids[j] = this.#trackId[k]!
      this.sizes[j] = this.#ds[j]!
    }
    this.count = m
  }

  #end(k: number): void {
    this.left[this.leftCount++] = this.#trackId[k]!
    this.#trackId[k] = 0
  }

  /** Optimal gated assignment of `n` live tracks to `m` detections; updates the matched tracks. */
  #assign(n: number, m: number, time: number): void {
    const gate = this.gate
    const grace = this.graceMs / 1000
    const N = n + m // square problem: rows = tracks + "new face" dummies, columns = detections + "lost" dummies
    const W = this.#dim + 1
    const a = this.#cost
    for (let r = 0; r < n; r++) {
      const k = this.#rowTrack[r]!
      const dt = Math.min(time - this.#seen[k]!, grace)
      const px = this.#cx[k]! + this.#vx[k]! * dt
      const py = this.#cy[k]! + this.#vy[k]! * dt
      const ts = this.#size[k]!
      // Staleness: a track that was seen in the previous result wins ties against one that has been hidden for a
      // while, e.g. when two faces cross and the hidden one is predicted right behind the visible one.
      const stale = (0.5 * dt) / grace
      for (let j = 0; j < m; j++) {
        const ds = this.#ds[j]!
        const ex = this.#dx[j]! - px
        const ey = this.#dy[j]! - py
        const dist = Math.sqrt(ex * ex + ey * ey) / Math.max(ts, ds)
        const c = dist + Math.abs(Math.log(ds / ts)) + stale
        a[(r + 1) * W + j + 1] = c < gate ? c : BIG
      }
      for (let j = m; j < N; j++) a[(r + 1) * W + j + 1] = j - m === r ? gate : BIG
    }
    for (let r = n; r < N; r++) {
      for (let j = 0; j < m; j++) a[(r + 1) * W + j + 1] = r - n === j ? gate : BIG
      for (let j = m; j < N; j++) a[(r + 1) * W + j + 1] = 0
    }
    hungarian(N, a, W, this.#u, this.#v, this.#minv, this.#p, this.#way, this.#used)

    const p = this.#p
    for (let j = 1; j <= m; j++) {
      const r = p[j]! - 1
      if (r >= n || a[(r + 1) * W + j]! >= BIG) continue
      const k = this.#rowTrack[r]!
      const d = j - 1
      const dt = time - this.#seen[k]!
      if (dt > 0) {
        const vx = (this.#dx[d]! - this.#cx[k]!) / dt
        const vy = (this.#dy[d]! - this.#cy[k]!) / dt
        const first = this.#hits[k] === 1
        this.#vx[k] = first ? vx : 0.5 * this.#vx[k]! + 0.5 * vx
        this.#vy[k] = first ? vy : 0.5 * this.#vy[k]! + 0.5 * vy
      }
      this.#cx[k] = this.#dx[d]!
      this.#cy[k] = this.#dy[d]!
      this.#size[k] = this.#ds[d]!
      this.#seen[k] = time
      this.#hits[k] = this.#hits[k]! + 1
      this.#detTrack[d] = k
    }
  }
}

/**
 * Hungarian method (Kuhn–Munkres, O(N³) with potentials) on the square N×N cost matrix stored 1-based in `a`
 * (row stride `W`). On return, `p[j]` is the row assigned to column `j` (1-based).
 */
function hungarian(
  N: number,
  a: Float64Array,
  W: number,
  u: Float64Array,
  v: Float64Array,
  minv: Float64Array,
  p: Int32Array,
  way: Int32Array,
  used: Uint8Array,
): void {
  u.fill(0, 0, N + 1)
  v.fill(0, 0, N + 1)
  p.fill(0, 0, N + 1)
  way.fill(0, 0, N + 1)
  for (let i = 1; i <= N; i++) {
    p[0] = i
    let j0 = 0
    minv.fill(Infinity, 0, N + 1)
    used.fill(0, 0, N + 1)
    do {
      used[j0] = 1
      const i0 = p[j0]!
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= N; j++) {
        if (used[j]) continue
        const cur = a[i0 * W + j]! - u[i0]! - v[j]!
        if (cur < minv[j]!) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j]! < delta) {
          delta = minv[j]!
          j1 = j
        }
      }
      for (let j = 0; j <= N; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta
          v[j] = v[j]! - delta
        } else minv[j] = minv[j]! - delta
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]!
      p[j0] = p[j1]!
      j0 = j1
    } while (j0 !== 0)
  }
}
