/**
 * Which faces a sticker applies to (`faces`, spec §5.4) and which asset each face shows (`{ pick }`), pure and
 * allocation-free.
 */

/** `faces` of an anchored layer: `"all"`, `"first"`, `"largest"`, or a maximum count. */
export type FacesSelector = 'all' | 'first' | 'largest' | number

/** Number of instances a layer needs for `faces`, with `maxFaces` faces at most. */
export function instanceCount(faces: FacesSelector, maxFaces: number): number {
  if (faces === 'all') return maxFaces
  if (faces === 'first' || faces === 'largest') return 1
  return Math.max(1, Math.min(maxFaces, Math.trunc(faces)))
}

/** Sort key of an id: the oldest face (smallest id) first, slots without an id (0) last. */
const rank = (id: number) => (id > 0 ? id : Number.MAX_SAFE_INTEGER)

/**
 * Writes into `out` the face slots (indices in the `FaceFrame`) the layer applies to, and returns how many:
 *
 * - `"all"`: every tracked face, in slot order;
 * - `"first"`: the face that has been visible the longest (smallest stable id);
 * - `"largest"`: the face with the largest apparent size (`sizes[slot]`);
 * - `n`: the `n` faces visible the longest, oldest first.
 *
 * `ids[slot]` is the stable id of each slot (spec §5.4), `count` the number of tracked faces. At most `out.length`
 * slots are written.
 */
export function selectFaces(
  faces: FacesSelector,
  count: number,
  ids: ArrayLike<number>,
  sizes: ArrayLike<number>,
  out: Int32Array,
): number {
  const room = out.length
  if (count <= 0 || room === 0) return 0
  if (faces === 'all') {
    const n = Math.min(count, room)
    for (let i = 0; i < n; i++) out[i] = i
    return n
  }
  if (faces === 'largest') {
    let best = 0
    for (let i = 1; i < count; i++) if ((sizes[i] ?? 0) > (sizes[best] ?? 0)) best = i
    out[0] = best
    return 1
  }
  const n = Math.min(count, room, faces === 'first' ? 1 : Math.max(1, Math.trunc(faces)))
  // Partial selection sort by id: n is at most 16.
  for (let k = 0; k < n; k++) {
    let best = -1
    for (let i = 0; i < count; i++) {
      let taken = false
      for (let j = 0; j < k; j++) if (out[j] === i) taken = true
      if (taken) continue
      if (best < 0 || rank(ids[i] ?? 0) < rank(ids[best] ?? 0)) best = i
    }
    out[k] = best
  }
  return n
}

/** `by` of a `{ pick }` source: stable per face, or drawn at random on each activation. */
export type PickMode = 'face' | 'random'

/**
 * Index of the asset a face shows among `count` picks. `"face"`: from the face's stable id, so it stays the same
 * while the face is visible and successive faces get successive assets (deterministic with a file source);
 * id 0 (no face, `anchor: "screen"`) takes the first one. `"random"`: `draw` (drawn once per activation, in [0, 1)).
 */
export function pickIndex(by: PickMode, faceId: number, count: number, draw: number): number {
  if (count <= 1) return 0
  if (by === 'random') return Math.min(count - 1, Math.max(0, Math.floor(draw * count)))
  return faceId > 0 ? (faceId - 1) % count : 0
}
