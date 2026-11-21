/**
 * Anchor frames for layers (spec §5), in the objects camera space (`ObjectsView.camera`): +x right, +y up, looking
 * down -z, centimetres. A matrix maps the anchor frame (1 unit = the distance between the eye centres, spec §5.1) to
 * that space, as displayed: with a mirrored source the poses are mirrored (M' = S·M·S, S = diag(-1, 1, 1)), so
 * geometry and text are never mirrored themselves.
 *
 * The math is `computeAnchorMatrix` (#13): rigid anchors from the canonical face and the head pose, expression
 * anchors from the live landmarks. The engine gives it the smoothed and predicted faces of the displayed frame.
 */
import { Matrix4, type PerspectiveCamera } from 'three'
import { CANONICAL_ANCHOR_ORIGINS, CANONICAL_EYE_DISTANCE, computeAnchorMatrix, type FaceAnchor } from '../anchoring/anchor-matrix.ts'
import { FACE_CAMERA_FOV_Y_DEG } from '../anchoring/face-pose.ts'
import type { AnchorFollow } from '../anchors.ts'
import type { FaceFrame } from '../face.ts'

/** The face unit in cm: the distance between the eye centres of the canonical face (spec §5.1). */
export const FACE_UNIT_CM = CANONICAL_EYE_DISTANCE
/** Vertical field of view of the face camera over the analysed frame (degrees, MediaPipe's convention). */
export const TRACKER_FOV_Y = FACE_CAMERA_FOV_Y_DEG
/** Depth of the plane on which `anchor: "screen"` layers are placed, in cm (in front of any face). */
export const SCREEN_PLANE_DEPTH_CM = 10

export interface AnchorProvider {
  /**
   * Writes into `out` the matrix of `anchor` for face slot `face` (0 ≤ face < faces.count). `follow` resolves `auto`
   * to the anchor's default (spec §5.3). Returns false (and leaves `out` unchanged) when the face is not tracked, its
   * pose is not usable, or the anchor is unknown to the provider.
   */
  face(face: number, anchor: string, follow: AnchorFollow | 'auto', out: Matrix4): boolean
  /** Writes the screen frame (spec §5.2) into `out`: origin at the centre, +y up, 1 unit = screen height. */
  screen(out: Matrix4): void
  /**
   * Stable id of the face in slot `face` (spec §5.4: kept while visible, with a grace delay; a new id when the person
   * comes back), 0 when the slot is empty. Ids start at 1 and are never reused.
   */
  id(face: number): number
}

export class FaceAnchors implements AnchorProvider {
  #faces: Readonly<FaceFrame>
  #ids: ArrayLike<number> = new Int32Array(0)
  #camera: PerspectiveCamera
  #mirrored = false
  #m = new Float32Array(16)

  constructor(faces: Readonly<FaceFrame>, camera: PerspectiveCamera) {
    this.#faces = faces
    this.#camera = camera
  }

  /** Called by the engine before layers update: the faces of the displayed frame and their stable ids. */
  setFrame(faces: Readonly<FaceFrame>, ids: ArrayLike<number>, mirrored: boolean): void {
    this.#faces = faces
    this.#ids = ids
    this.#mirrored = mirrored
  }

  face(face: number, anchor: string, follow: AnchorFollow | 'auto', out: Matrix4): boolean {
    if (!Object.hasOwn(CANONICAL_ANCHOR_ORIGINS, anchor)) return false
    if (!computeAnchorMatrix(this.#faces, face, anchor as FaceAnchor, follow, this.#mirrored, this.#m)) return false
    out.fromArray(this.#m)
    return true
  }

  screen(out: Matrix4): void {
    // Visible height at depth d through the projection (cover crop included): 2·d / P[1][1].
    const p11 = this.#camera.projectionMatrix.elements[5]!
    const h = (2 * SCREEN_PLANE_DEPTH_CM) / p11
    out.makeScale(h, h, h)
    out.elements[14] = -SCREEN_PLANE_DEPTH_CM
  }

  id(face: number): number {
    return face >= 0 && face < this.#faces.count ? (this.#ids[face] ?? 0) : 0
  }
}
