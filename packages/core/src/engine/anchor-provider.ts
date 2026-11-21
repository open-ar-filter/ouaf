/**
 * Anchor frames for layers (spec §5), in the objects camera space (`ObjectsView.camera`): +x right, +y up, looking
 * down -z, centimetres. A matrix maps the anchor frame (1 unit = distance between the eye centres, spec §5.1) to that
 * space, as displayed: with a mirrored source the poses are mirrored (M' = S·M·S, S = diag(-1, 1, 1)), so geometry
 * and text are never mirrored themselves.
 *
 * PROVISIONAL implementation: issue #13 (anchors, smoothing, face identity) replaces `ProvisionalAnchors` with the
 * real anchor math (rigid anchors from the canonical face, smoothing, pose from landmarks). Layers only depend on the
 * `AnchorProvider` interface.
 */
import { Matrix4, Vector3, type PerspectiveCamera } from 'three'
import { LANDMARKS_STRIDE, MATRIX_STRIDE, type FaceFrame } from '../face.ts'
import { LANDMARK_ANCHORS, type AnchorFollow, type LandmarkAnchor } from '../anchors.ts'

/** Average distance between the eye centres of an adult, in cm: the face unit (spec §5.1). */
export const FACE_UNIT_CM = 6.3
/** Vertical field of view of MediaPipe's face geometry camera, over the analysed frame (degrees). */
export const TRACKER_FOV_Y = 63
/** Depth of the plane on which `anchor: "screen"` layers are placed, in cm (in front of any face). */
export const SCREEN_PLANE_DEPTH_CM = 10

export interface AnchorProvider {
  /**
   * Writes into `out` the matrix of `anchor` for face slot `face` (0 ≤ face < faces.count). `follow` resolves `auto`
   * to the anchor's default (spec §5.3). Returns false (and leaves `out` unchanged) when the face is not tracked or
   * the anchor is unknown to the provider.
   */
  face(face: number, anchor: string, follow: AnchorFollow | 'auto', out: Matrix4): boolean
  /** Writes the screen frame (spec §5.2) into `out`: origin at the centre, +y up, 1 unit = screen height. */
  screen(out: Matrix4): void
  /** Apparent size of a face: eye distance / frame height (`face.size` data path), 0 when not tracked. */
  size(face: number): number
}

/** Landmark-based anchors, using the tracker's pose matrix when it has one (MediaPipe tasks-vision). */
export class ProvisionalAnchors implements AnchorProvider {
  #faces: FaceFrame
  #camera: PerspectiveCamera
  #mirrored = false
  #pose = new Matrix4()
  #mirror = new Matrix4().makeScale(-1, 1, 1)
  #tmp = new Matrix4()
  #unit = new Vector3(FACE_UNIT_CM, FACE_UNIT_CM, FACE_UNIT_CM)
  #p = { x: 0, y: 0, z: 0 }
  #q = { x: 0, y: 0, z: 0 }

  constructor(faces: FaceFrame, camera: PerspectiveCamera) {
    this.#faces = faces
    this.#camera = camera
  }

  /** Called by the engine before layers update. */
  setFrame(faces: FaceFrame, mirrored: boolean): void {
    this.#faces = faces
    this.#mirrored = mirrored
  }

  face(face: number, anchor: string, _follow: AnchorFollow | 'auto', out: Matrix4): boolean {
    const faces = this.#faces
    if (face < 0 || face >= faces.count) return false
    if (!this.#headPose(face, this.#pose)) return false
    if (anchor !== 'head') {
      if (!(anchor in LANDMARK_ANCHORS)) return false
      // Provisional (#13): rigid and expression anchors both take the live landmark position, at the head's depth;
      // `follow` is accepted but not honoured yet.
      const depth = -this.#pose.elements[14]!
      this.#landmarkAt(face, anchor as LandmarkAnchor, depth, this.#p)
      this.#pose.elements[12] = this.#p.x
      this.#pose.elements[13] = this.#p.y
      this.#pose.elements[14] = this.#p.z
    }
    if (this.#mirrored) out.multiplyMatrices(this.#mirror, this.#tmp.multiplyMatrices(this.#pose, this.#mirror))
    else out.copy(this.#pose)
    return true
  }

  screen(out: Matrix4): void {
    // Visible height at depth d through the projection (cover crop included): 2·d / P[1][1].
    const p11 = this.#camera.projectionMatrix.elements[5]!
    const h = (2 * SCREEN_PLANE_DEPTH_CM) / p11
    out.makeScale(h, h, h)
    out.elements[14] = -SCREEN_PLANE_DEPTH_CM
  }

  size(face: number): number {
    const faces = this.#faces
    if (face < 0 || face >= faces.count) return 0
    this.#landmarkAt(face, 'leftEye', 1, this.#p)
    this.#landmarkAt(face, 'rightEye', 1, this.#q)
    // In normalized frame units: the distance at depth 1 over the visible height at depth 1.
    const dx = this.#p.x - this.#q.x
    const dy = this.#p.y - this.#q.y
    return Math.hypot(dx, dy) / (2 * Math.tan((TRACKER_FOV_Y * Math.PI) / 360))
  }

  /** Head pose with the face unit as scale; from the tracker's matrix, else from the eyes (roll only). */
  #headPose(face: number, out: Matrix4): boolean {
    const faces = this.#faces
    const m = faces.matrices
    const base = face * MATRIX_STRIDE
    const hasMatrix = m[base + 14] !== 0 // identity (translation z = 0) means "no pose from the tracker"
    if (hasMatrix) {
      out.fromArray(m, base)
      out.scale(this.#unit)
      return true
    }
    // Landmarks only: depth from the apparent eye distance, roll from the eye line.
    this.#landmarkAt(face, 'leftEye', 1, this.#p)
    this.#landmarkAt(face, 'rightEye', 1, this.#q)
    const dx = this.#p.x - this.#q.x
    const dy = this.#p.y - this.#q.y
    const eye = Math.hypot(dx, dy)
    if (!(eye > 0)) return false
    const depth = FACE_UNIT_CM / eye
    const roll = Math.atan2(dy, dx)
    out.makeRotationZ(roll)
    out.scale(this.#unit)
    out.elements[12] = ((this.#p.x + this.#q.x) / 2) * depth
    out.elements[13] = ((this.#p.y + this.#q.y) / 2) * depth
    out.elements[14] = -depth
    return true
  }

  /** Landmark anchor position unprojected at `depth` (cm, positive) in camera space. */
  #landmarkAt(face: number, anchor: LandmarkAnchor, depth: number, out: { x: number; y: number; z: number }): void {
    const L = this.#faces.landmarks
    const indices: readonly number[] = LANDMARK_ANCHORS[anchor]
    const base = face * LANDMARKS_STRIDE
    let u = 0
    let v = 0
    for (let i = 0; i < indices.length; i++) {
      const o = base + indices[i]! * 3
      u += L[o]!
      v += L[o + 1]!
    }
    u /= indices.length
    v /= indices.length
    const tanY = Math.tan((TRACKER_FOV_Y * Math.PI) / 360)
    const aspect = this.#faces.height > 0 ? this.#faces.width / this.#faces.height : 1
    out.x = (2 * u - 1) * tanY * aspect * depth
    out.y = (1 - 2 * v) * tanY * depth
    out.z = -depth
  }
}
