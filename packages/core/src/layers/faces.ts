/**
 * The `faces` selector of anchored layers (spec §5.4): which tracked face slots a layer applies to this frame. Shared
 * by the text, sticker, model and warp layers. Pure and allocation-free: callers pass arrays sized for `maxFaces`.
 */

/** `faces` of an anchored layer: `"all"`, `"first"`, `"largest"`, or a maximum count. */
export type FacesSelector = 'all' | 'first' | 'largest' | number

/** Reads the `faces` property of a validated layer declaration (default `"all"`). */
export function parseFacesSelector(value: unknown): FacesSelector {
  if (value === 'first' || value === 'largest') return value
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value
  return 'all'
}

/** Number of instances a layer needs for `faces`, with `maxFaces` faces at most. */
export function instanceCount(faces: FacesSelector, maxFaces: number): number {
  if (faces === 'all') return maxFaces
  if (faces === 'first' || faces === 'largest') return 1
  return Math.max(1, Math.min(maxFaces, Math.trunc(faces)))
}

/** Sort key of a slot for `first` / n: its stable id, slots without an id yet (0) after every identified face. */
const rank = (ids: ArrayLike<number>, slot: number) => {
  const id = ids[slot] ?? 0
  return id > 0 ? id : Number.MAX_SAFE_INTEGER
}

/**
 * Writes into `out` the face slots (indices in the `FaceFrame`) the layer applies to, and returns how many. Slots
 * `0 … count − 1` are candidates, those with `ok[slot]` unset (anchor not available) excepted when `ok` is given.
 *
 * - `"all"`: every candidate, in slot order;
 * - `"first"`: the face that has been visible the longest (smallest stable id), so it does not jump to a newcomer;
 * - `"largest"`: the face with the largest apparent size (`sizes[slot]`), the lowest slot on a tie;
 * - `n`: the `n` faces visible the longest, oldest first.
 *
 * `ids[slot]` is the stable face id (spec §5.4); a slot without an id yet (0) sorts after the identified faces, in
 * slot order. At most `out.length` slots are written.
 */
export function selectFaces(
  faces: FacesSelector,
  count: number,
  ids: ArrayLike<number>,
  sizes: ArrayLike<number>,
  out: Int32Array,
  ok?: ArrayLike<number>,
): number {
  const room = out.length
  if (count <= 0 || room === 0) return 0
  let n = 0
  if (faces === 'all') {
    for (let i = 0; i < count && n < room; i++) if (!ok || ok[i]) out[n++] = i
    return n
  }
  if (faces === 'largest') {
    let best = -1
    for (let i = 0; i < count; i++) {
      if (ok && !ok[i]) continue
      if (best < 0 || (sizes[i] ?? 0) > (sizes[best] ?? 0)) best = i
    }
    if (best < 0) return 0
    out[0] = best
    return 1
  }
  const max = Math.min(room, faces === 'first' ? 1 : Math.max(1, Math.trunc(faces)))
  // Partial selection sort by (rank, slot): a few faces at most. `last*` is the previous pick, so each pass takes
  // the smallest key above it.
  let lastRank = 0
  let lastSlot = -1
  while (n < max) {
    let best = -1
    let bestRank = 0
    for (let i = 0; i < count; i++) {
      if (ok && !ok[i]) continue
      const r = rank(ids, i)
      if (r < lastRank || (r === lastRank && i <= lastSlot)) continue
      if (best < 0 || r < bestRank) {
        best = i
        bestRank = r
      }
    }
    if (best < 0) break
    out[n++] = best
    lastRank = bestRank
    lastSlot = best
  }
  return n
}
