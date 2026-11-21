/**
 * The `faces` selector of a layer (spec §5.4): which tracked face slots it applies to this frame.
 */

export type FacesSelector = 'all' | 'first' | 'largest' | number

/** Reads the `faces` property of a validated layer declaration (default `all`). */
export function parseFacesSelector(value: unknown): FacesSelector {
  if (value === 'first' || value === 'largest') return value
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value
  return 'all'
}

/**
 * Writes into `out` the face slots selected among the `count` tracked ones and returns how many there are, without
 * allocating. `ids[slot]` is the stable face id (spec §5.4, 0 for an empty slot), read for `first` and n;
 * `sizes[slot]` the face's size on screen, read for `largest`.
 *
 * - `all`: every tracked face, in slot order.
 * - `first`: the face tracked for the longest time (smallest id), so it does not jump to a newcomer.
 * - `largest`: the face that looks the largest on screen (the closest one).
 * - n: up to n faces, the longest tracked first.
 */
export function selectFaces(
  selector: FacesSelector,
  count: number,
  ids: ArrayLike<number>,
  sizes: ArrayLike<number>,
  out: Int32Array,
): number {
  const n = Math.min(count, out.length)
  if (selector === 'all') {
    for (let i = 0; i < n; i++) out[i] = i
    return n
  }
  if (selector === 'largest') {
    let best = -1
    let bestSize = 0
    for (let i = 0; i < n; i++) {
      const s = sizes[i]!
      if (s > bestSize) {
        best = i
        bestSize = s
      }
    }
    if (best < 0) return 0
    out[0] = best
    return 1
  }
  // `first` / n: the `limit` smallest ids, by selection (n ≤ 16).
  const limit = Math.min(selector === 'first' ? 1 : selector, n)
  let selected = 0
  let floor = 0
  while (selected < limit) {
    let best = -1
    let bestId = Infinity
    for (let i = 0; i < n; i++) {
      const v = ids[i]!
      if (v > floor && v < bestId) {
        best = i
        bestId = v
      }
    }
    if (best < 0) break
    out[selected++] = best
    floor = bestId
  }
  return selected
}
