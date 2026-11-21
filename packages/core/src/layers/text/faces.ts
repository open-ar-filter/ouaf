/**
 * The `faces` selector of anchored layers (spec §5.4, §6.2): which tracked face slots get an instance this frame.
 * Allocation-free: candidates and results live in arrays sized for `maxFaces`.
 */

export type FacesSelector = 'all' | 'first' | 'largest' | number

/**
 * Writes into `out` the selected slots among `count` slots (those with `ok[i]` set: anchor available), returns how
 * many. `all`: every slot, in slot order; `first`: the face seen first (smallest stable id); a number `n`: the `n`
 * faces seen first, oldest first; `largest`: the face with the greatest `size` (its apparent size on screen).
 */
export function selectFaces(
  selector: FacesSelector,
  count: number,
  ok: ArrayLike<number>,
  ids: (slot: number) => number,
  size: ArrayLike<number>,
  out: Int32Array,
): number {
  let n = 0
  if (selector === 'all') {
    for (let i = 0; i < count && n < out.length; i++) if (ok[i]) out[n++] = i
    return n
  }
  if (selector === 'largest') {
    let best = -1
    for (let i = 0; i < count; i++) if (ok[i] && (best < 0 || size[i]! > size[best]!)) best = i
    if (best >= 0) out[n++] = best
    return n
  }
  const max = Math.min(selector === 'first' ? 1 : selector, out.length)
  // Selection by increasing id (a few faces at most).
  let last = 0
  while (n < max) {
    let pick = -1
    let pickId = 0
    for (let i = 0; i < count; i++) {
      if (!ok[i]) continue
      // A slot without an id yet (0) sorts after every identified face, in slot order.
      const id = ids(i) || 2 ** 31 + i
      if (id > last && (pick < 0 || id < pickId)) {
        pick = i
        pickId = id
      }
    }
    if (pick < 0) break
    out[n++] = pick
    last = pickId
  }
  return n
}
