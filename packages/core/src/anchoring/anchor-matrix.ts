/**
 * Face anchor frames (spec §5.1, §5.3, Appendix D) as 4×4 matrices from the anchor frame to camera space
 * (`face-pose.ts`): 1 unit = the distance between the eye centres of the canonical model, axes as seen on screen.
 */
import {
  ANCHOR_DEFAULT_FOLLOW,
  LANDMARK_ANCHORS,
  liveAnchorPosition,
  type AnchorFollow,
  type LandmarkAnchor,
  type Point3,
} from '../anchors.ts'
import { MATRIX_STRIDE, type FaceFrame } from '../face.ts'
import { CANONICAL_FACE } from './canonical-face.ts'
import { videoToCameraInPlace } from './face-pose.ts'

/** Every v1 face anchor (`screen` is not a face anchor). */
export type FaceAnchor = LandmarkAnchor | 'head'

const meanCanonical = (indices: readonly number[]): [number, number, number] => {
  const p: [number, number, number] = [0, 0, 0]
  for (const i of indices) {
    const c = CANONICAL_FACE[i]!
    p[0] += c[0] / indices.length
    p[1] += c[1] / indices.length
    p[2] += c[2] / indices.length
  }
  return p
}

const LEFT_EYE = meanCanonical(LANDMARK_ANCHORS.leftEye)
const RIGHT_EYE = meanCanonical(LANDMARK_ANCHORS.rightEye)

/** The face unit on the canonical model (cm): distance between the two eye centres (≈ 6.30 cm). */
export const CANONICAL_EYE_DISTANCE = Math.hypot(
  LEFT_EYE[0] - RIGHT_EYE[0],
  LEFT_EYE[1] - RIGHT_EYE[1],
  LEFT_EYE[2] - RIGHT_EYE[2],
)

/** How far behind the `eyes` point the `head` origin is, in face units (Appendix D, provisional). */
export const HEAD_ORIGIN_DEPTH = 1.5

/** Canonical origin (cm) of each face anchor: mean of its landmarks on the canonical model; `head` per Appendix D. */
export const CANONICAL_ANCHOR_ORIGINS: Readonly<Record<FaceAnchor, readonly [number, number, number]>> = (() => {
  const origins = {} as Record<FaceAnchor, readonly [number, number, number]>
  for (const name of Object.keys(LANDMARK_ANCHORS) as LandmarkAnchor[]) origins[name] = meanCanonical(LANDMARK_ANCHORS[name])
  const eyes = origins.eyes
  origins.head = [eyes[0], eyes[1], eyes[2] - HEAD_ORIGIN_DEPTH * CANONICAL_EYE_DISTANCE]
  return origins
})()

const live: Point3 = { x: 0, y: 0, z: 0 }

/**
 * Writes into `out` (16 floats, column-major) the matrix from the anchor frame of `anchor` on face `face` to camera
 * space, and returns true. Columns 0–2 are the frame's x, y, z axes scaled by the face unit (cm), column 3 its
 * origin (cm). The orientation is always the head's; the origin follows `follow` (`auto` resolves per §5.3):
 * - `rigid`: the anchor's point on the canonical model, transformed by the head pose (`faces.matrices`);
 * - `expression`: the live landmarks (`faces.landmarks`), on their camera ray at the depth of the rigid origin.
 *   `head` has no landmarks and is always rigid.
 *
 * Unmirrored, the frame's +x points towards the person's left, which is the image right. For a mirrored
 * display, pass `mirrored` (or apply `mirrorMatrix` to the result): the matrix is conjugated by S = diag(-1, 1, 1),
 * so content keeps its handedness (text is not mirrored) and +x points to the screen right.
 *
 * Returns false (and writes an identity matrix) when the face has no valid pose: no face in that slot, or a
 * degenerate matrix (e.g. the identity a tracker writes when it has none, see `estimateFacePose`).
 * Allocation-free.
 */
export function computeAnchorMatrix(
  faces: Readonly<FaceFrame>,
  face: number,
  anchor: FaceAnchor,
  follow: AnchorFollow | 'auto',
  mirrored: boolean,
  out: Float32Array,
): boolean {
  const M = faces.matrices
  const b = face * MATRIX_STRIDE
  const tz = M[b + 14]!
  // Not Math.hypot: it allocates its arguments in V8.
  const scale = Math.sqrt(M[b]! * M[b]! + M[b + 1]! * M[b + 1]! + M[b + 2]! * M[b + 2]!)
  if (face < 0 || face >= faces.count || !(tz < 0) || !(scale > 1e-6) || !Number.isFinite(scale + tz)) {
    for (let i = 0; i < 16; i++) out[i] = i % 5 === 0 ? 1 : 0
    return false
  }
  // Axes: the pose's rotation columns × face unit (the pose's scale is part of the columns already).
  const k = CANONICAL_EYE_DISTANCE
  for (let c = 0; c < 3; c++) {
    out[c * 4] = M[b + c * 4]! * k
    out[c * 4 + 1] = M[b + c * 4 + 1]! * k
    out[c * 4 + 2] = M[b + c * 4 + 2]! * k
    out[c * 4 + 3] = 0
  }
  // Rigid origin: M · canonical point.
  const p = CANONICAL_ANCHOR_ORIGINS[anchor]
  let ox = M[b]! * p[0] + M[b + 4]! * p[1] + M[b + 8]! * p[2] + M[b + 12]!
  let oy = M[b + 1]! * p[0] + M[b + 5]! * p[1] + M[b + 9]! * p[2] + M[b + 13]!
  const oz = M[b + 2]! * p[0] + M[b + 6]! * p[1] + M[b + 10]! * p[2] + tz
  const mode = follow === 'auto' ? ANCHOR_DEFAULT_FOLLOW[anchor] : follow
  if (mode === 'expression' && anchor !== 'head' && oz < 0) {
    liveAnchorPosition(faces, face, anchor, live)
    live.z = oz
    videoToCameraInPlace(faces, live)
    ox = live.x
    oy = live.y
  }
  out[12] = ox
  out[13] = oy
  out[14] = oz
  out[15] = 1
  if (mirrored) mirrorMatrix(out, out)
  return true
}

/**
 * Conjugates a column-major 4×4 matrix by S = diag(-1, 1, 1, 1): `out = S · m · S` (`out` may be `m`). Applied to
 * an anchor matrix, this gives the anchor frame of the mirrored display; applying it twice is the identity.
 */
export function mirrorMatrix(m: ArrayLike<number>, out: Float32Array): Float32Array {
  for (let i = 0; i < 16; i++) {
    const row = i & 3
    const col = i >> 2
    // Element (row, col) is multiplied by s[row]·s[col]: negated when exactly one of them is the x index.
    out[i] = (row === 0) !== (col === 0) ? -m[i]! : m[i]!
  }
  return out
}
