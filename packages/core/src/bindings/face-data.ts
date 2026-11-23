/**
 * Built-in v1 data paths of bindings (spec §8), read from the allocation-free `FaceFrame`.
 *
 * Nothing is computed ahead of time: each reader derives its value from the current `FaceFrame` when a binding
 * evaluates it, without allocating. Values that cannot be derived (no face at that index, blendshapes dropped,
 * degenerate pose matrix) read as missing (`NaN`), so the binding takes its `default`.
 */
import { liveAnchorPosition, type Point3 } from '../anchors.ts'
import { BLENDSHAPE_NAMES, BLENDSHAPES_STRIDE, MATRIX_STRIDE, type FaceFrame } from '../face.ts'
import type { VideoToClip } from '../viewport.ts'
import type { BindingDataSource, DataReader, NumberArray } from './types.ts'

const RAD_TO_DEG = 180 / Math.PI

/** Offsets of the angles written by `computeHeadPose`. */
export const POSE_YAW = 0
export const POSE_PITCH = 1
export const POSE_ROLL = 2

/**
 * Head pose of face `face`, from its facial transformation matrix, in degrees: writes yaw, pitch and roll into
 * `out[offset + POSE_YAW | POSE_PITCH | POSE_ROLL]` (no allocation; a typed array rather than an object so that no
 * number is boxed).
 *
 * Angles are right-handed rotations about the axes of the face frame as seen on screen (spec §5.1: +x right, +y up,
 * +z towards the camera), applied as R = Ry(yaw) · Rx(pitch) · Rz(roll):
 * - `yaw` > 0: the face turns towards the right of the screen;
 * - `pitch` > 0: the face tilts down (chin towards the chest);
 * - `roll` > 0: the head tilts counter-clockwise on screen (top of the head towards the left of the screen).
 *
 * The matrix is unmirrored camera space; with `mirrored` (front camera shown as a mirror), yaw and roll change sign
 * so the angles match what is displayed. A uniform scale in the matrix is ignored. A degenerate matrix gives `NaN`.
 */
export function computeHeadPose(
  faces: Readonly<FaceFrame>,
  face: number,
  mirrored: boolean,
  out: NumberArray,
  offset = 0,
): void {
  const m = faces.matrices
  const o = face * MATRIX_STRIDE
  // Column-major: element (row r, column c) is m[o + 4c + r]. With R = Ry·Rx·Rz:
  // R02 = sin(yaw)·cos(pitch), R22 = cos(yaw)·cos(pitch), R12 = -sin(pitch), R10 = cos(pitch)·sin(roll),
  // R11 = cos(pitch)·cos(roll).
  const r02 = m[o + 8]!
  const r12 = m[o + 9]!
  const r22 = m[o + 10]!
  const r10 = m[o + 1]!
  const r11 = m[o + 5]!
  const scale = Math.sqrt(r02 * r02 + r12 * r12 + r22 * r22)
  const sign = mirrored ? -1 : 1
  if (!(scale > 0)) {
    out[offset + POSE_YAW] = out[offset + POSE_PITCH] = out[offset + POSE_ROLL] = NaN
    return
  }
  out[offset + POSE_YAW] = sign * Math.atan2(r02, r22) * RAD_TO_DEG
  out[offset + POSE_PITCH] = Math.asin(Math.max(-1, Math.min(1, -r12 / scale))) * RAD_TO_DEG
  out[offset + POSE_ROLL] = sign * Math.atan2(r10, r11) * RAD_TO_DEG
}

/**
 * `BindingDataSource` for the v1 data paths: `time`, `faces.count`, `face.index`, `face.size`, `face.pose.yaw`,
 * `face.pose.pitch`, `face.pose.roll` and `face.blendshapes.<name>` (spec §8, appendix B).
 *
 * The engine updates the public fields once per frame (no allocation): `faces` (it may point to another
 * `FaceFrame` each frame, e.g. a view on a buffer received from a worker), `time`, `blendshapes`, and when the
 * view changes `mirrored` and `videoToClip`. Plugin data paths come from other sources (`BindingDataSource`).
 */
export class FaceBindingData implements BindingDataSource {
  /** Tracking results the bindings read this frame. */
  faces: Readonly<FaceFrame>
  /** Media time of the frame being rendered, in seconds (`time`). */
  time = 0
  /**
   * Whether blendshapes are available. `false` while the engine has dropped them (spec §16.2): every
   * `face.blendshapes.<name>` binding then takes its `default`.
   */
  blendshapes = true
  /** The view is mirrored (front camera): `face.pose.yaw` and `face.pose.roll` are given as seen on screen. */
  mirrored = false
  /**
   * Video → clip mapping of the displayed view (`computeVideoToClip`), so `face.size` is relative to the height of
   * the screen rather than of the analysed frame. Without it, the frame is assumed to span the screen height.
   */
  videoToClip: Readonly<VideoToClip> | undefined = undefined

  readonly #headPose = new Float64Array(3)
  readonly #left: Point3 = { x: 0, y: 0, z: 0 }
  readonly #right: Point3 = { x: 0, y: 0, z: 0 }

  constructor(faces: Readonly<FaceFrame>) {
    this.faces = faces
  }

  /** Whether face slot `face` holds a tracked face this frame. */
  hasFace(face: number): boolean {
    return face >= 0 && face < this.faces.count
  }

  resolve(path: string): DataReader | undefined {
    switch (path) {
      case 'time':
        return { type: 'number', perFace: false, read: (_face, out, i) => { out[i] = this.time } }
      case 'faces.count':
        return { type: 'number', perFace: false, read: (_face, out, i) => { out[i] = this.faces.count } }
      case 'face.index':
        return { type: 'number', perFace: true, read: (face, out, i) => { out[i] = this.hasFace(face) ? face : NaN } }
      case 'face.size':
        return { type: 'number', perFace: true, read: (face, out, i) => this.#size(face, out, i) }
      case 'face.pose.yaw':
        return { type: 'number', perFace: true, read: (face, out, i) => this.#pose(face, POSE_YAW, out, i) }
      case 'face.pose.pitch':
        return { type: 'number', perFace: true, read: (face, out, i) => this.#pose(face, POSE_PITCH, out, i) }
      case 'face.pose.roll':
        return { type: 'number', perFace: true, read: (face, out, i) => this.#pose(face, POSE_ROLL, out, i) }
    }
    const prefix = 'face.blendshapes.'
    if (path.startsWith(prefix)) {
      const index = (BLENDSHAPE_NAMES as readonly string[]).indexOf(path.slice(prefix.length))
      // Index 0 is `_neutral`, which is not exposed to filters (appendix B).
      if (index > 0) return { type: 'number', perFace: true, read: (face, out, i) => this.#blendshape(face, index, out, i) }
    }
    return undefined
  }

  // The readers write their result instead of returning it: see `DataReader`.

  /** Apparent face size: distance between the eye centers divided by the screen height. */
  #size(face: number, out: Float64Array, i: number): void {
    const f = this.faces
    if (!this.hasFace(face) || !(f.height > 0)) {
      out[i] = NaN
      return
    }
    const l = liveAnchorPosition(f, face, 'leftEye', this.#left)
    const r = liveAnchorPosition(f, face, 'rightEye', this.#right)
    const dx = (l.x - r.x) * f.width
    const dy = (l.y - r.y) * f.height
    // The screen shows 1 / sy of the frame height (sy: half-height of the video quad in clip units).
    const sy = this.videoToClip ? Math.abs(this.videoToClip.ay) / 2 : 1
    out[i] = (Math.sqrt(dx * dx + dy * dy) * sy) / f.height
  }

  #pose(face: number, angle: number, out: Float64Array, i: number): void {
    if (!this.hasFace(face)) {
      out[i] = NaN
      return
    }
    computeHeadPose(this.faces, face, this.mirrored, this.#headPose)
    out[i] = this.#headPose[angle]!
  }

  #blendshape(face: number, index: number, out: Float64Array, i: number): void {
    // Two stores, not `… ? score : NaN`: V8 boxes a fractional number merged with the global `NaN` (#159).
    if (this.blendshapes && this.hasFace(face)) out[i] = this.faces.blendshapes[face * BLENDSHAPES_STRIDE + index]!
    else out[i] = NaN
  }
}
