/**
 * Which asset each face shows (`{ pick }`, spec §10.1), pure and allocation-free. Face selection (`faces`) is in
 * `../faces.ts`.
 */

/** `by` of a `{ pick }` source: from the face's stable id, or drawn at random for each face. */
export type PickMode = 'face' | 'random'

/**
 * Index of the asset a face shows among `count` picks (spec §10.1). `"face"`: `(id − 1) mod count` from the face's
 * stable id, so successive faces get successive assets (deterministic with a file source); id 0 (no face,
 * `anchor: "screen"`) takes the first one. `"random"`: from `draw`, in [0, 1), drawn when the face gets its id.
 * Either way the caller keeps the index while the face keeps its id.
 */
export function pickIndex(by: PickMode, faceId: number, count: number, draw: number): number {
  if (count <= 1) return 0
  if (by === 'random') return Math.min(count - 1, Math.max(0, Math.floor(draw * count)))
  return faceId > 0 ? (faceId - 1) % count : 0
}
