/**
 * Reference mapping of the v1 face anchors to MediaPipe FaceLandmarker landmarks (spec §5.3 and Appendix D).
 * "Left" / "right" are the person's sides. When several landmarks are listed, the anchor origin is their mean.
 * Indices are provisional until checked visually with the debug overlay.
 */
import { LANDMARKS_STRIDE, type FaceFrame } from './face.ts'

/** Face anchors defined by landmarks. `head` is derived from the transformation matrix instead (Appendix D). */
export const LANDMARK_ANCHORS = {
  forehead: [10],
  eyes: [168],
  leftEye: [263, 362],
  rightEye: [33, 133],
  noseBridge: [6],
  noseTip: [1],
  mouth: [13, 14],
  upperLip: [0],
  lowerLip: [17],
  chin: [152],
  leftCheek: [280],
  rightCheek: [50],
  leftTemple: [356],
  rightTemple: [127],
} as const satisfies Record<string, readonly number[]>

export type LandmarkAnchor = keyof typeof LANDMARK_ANCHORS

export type AnchorFollow = 'rigid' | 'expression'

/** What `follow: "auto"` resolves to for each face anchor (spec §5.3). */
export const ANCHOR_DEFAULT_FOLLOW: Readonly<Record<LandmarkAnchor | 'head', AnchorFollow>> = {
  head: 'rigid',
  forehead: 'rigid',
  eyes: 'rigid',
  leftEye: 'rigid',
  rightEye: 'rigid',
  noseBridge: 'rigid',
  noseTip: 'rigid',
  mouth: 'expression',
  upperLip: 'expression',
  lowerLip: 'expression',
  chin: 'expression',
  leftCheek: 'rigid',
  rightCheek: 'rigid',
  leftTemple: 'rigid',
  rightTemple: 'rigid',
}

export const LANDMARK_ANCHOR_NAMES = Object.keys(LANDMARK_ANCHORS) as readonly LandmarkAnchor[]

export interface Point3 {
  x: number
  y: number
  z: number
}

/**
 * Live position of an anchor for face `face` of `faces`, from the current landmarks (the `expression` behaviour),
 * in the landmarks' space: normalized image coordinates, not mirrored. Writes into `out` (no allocation).
 */
export function liveAnchorPosition(faces: Readonly<FaceFrame>, face: number, anchor: LandmarkAnchor, out: Point3): Point3 {
  const indices: readonly number[] = LANDMARK_ANCHORS[anchor]
  const base = face * LANDMARKS_STRIDE
  let x = 0
  let y = 0
  let z = 0
  for (let i = 0; i < indices.length; i++) {
    const o = base + indices[i]! * 3
    x += faces.landmarks[o]!
    y += faces.landmarks[o + 1]!
    z += faces.landmarks[o + 2]!
  }
  out.x = x / indices.length
  out.y = y / indices.length
  out.z = z / indices.length
  return out
}
