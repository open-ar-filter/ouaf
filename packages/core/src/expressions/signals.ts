/**
 * Expression signals: the per-face values the expression event detectors (spec §13) read, independent of where they
 * come from. With blendshapes they are read from MediaPipe's scores (`blendshapeSignals`); when the device governor
 * drops blendshapes (§16.2), a geometric source derived from the landmarks writes the same signals on the same 0–1
 * scale (#90), so the event thresholds keep their meaning.
 *
 * Layout: `SIGNALS_STRIDE` floats per face, face `i` at offset `i * SIGNALS_STRIDE`, indexed by `SIGNAL`. A `NaN`
 * signal means "no data this frame": the detectors keep their state for that value.
 */
import { BLENDSHAPES_STRIDE, MATRIX_STRIDE, blendshapeIndex, type FaceFrame } from '../face.ts'

/** Index of each signal in a face's slice. "Left" / "right" are the person's sides (spec §5.1). */
export const SIGNAL = {
  /** 0 = left eye open, 1 = closed (`eyeBlinkLeft`). */
  eyeClosedLeft: 0,
  /** 0 = right eye open, 1 = closed (`eyeBlinkRight`). */
  eyeClosedRight: 1,
  /** 0 = mouth closed, 1 = wide open (`jawOpen`). */
  jawOpen: 2,
  /** 0 = neutral, 1 = full smile (mean of `mouthSmileLeft` and `mouthSmileRight`). */
  smile: 3,
  /** 0 = neutral, 1 = eyebrows fully raised (`browInnerUp`). */
  browRaise: 4,
  /** 0 = neutral, 1 = lips fully puckered (`mouthPucker`). */
  pucker: 5,
  /** Head pitch in radians, positive when the face turns up (towards image -y). Not a 0–1 value. */
  pitch: 6,
  /** Head yaw in radians, positive when the face turns towards image +x (not mirrored). Not a 0–1 value. */
  yaw: 7,
} as const

export type SignalName = keyof typeof SIGNAL

/** Number of 0–1 expression signals (they come first in a face's slice, before the pose). */
export const EXPRESSION_SIGNAL_COUNT = 6
/** Floats per face in a signals array. */
export const SIGNALS_STRIDE = 8

/**
 * Writes the signals of face `face` of `faces` into `out` at `offset` (`SIGNALS_STRIDE` floats). Must not allocate.
 * Implementations: `blendshapeSignals`; the landmark-geometry source (#90).
 */
export type ExpressionSignalSource = (faces: Readonly<FaceFrame>, face: number, out: Float32Array, offset: number) => void

const EYE_BLINK_LEFT = blendshapeIndex('eyeBlinkLeft')
const EYE_BLINK_RIGHT = blendshapeIndex('eyeBlinkRight')
const JAW_OPEN = blendshapeIndex('jawOpen')
const SMILE_LEFT = blendshapeIndex('mouthSmileLeft')
const SMILE_RIGHT = blendshapeIndex('mouthSmileRight')
const BROW_INNER_UP = blendshapeIndex('browInnerUp')
const MOUTH_PUCKER = blendshapeIndex('mouthPucker')

/**
 * Signals from MediaPipe's blendshapes (spec Appendix B) and the head pose from the transformation matrix.
 * MediaPipe's `…Left` blendshapes are the person's left side, like the anchors (checked on the test clips: the
 * `eyeBlinkLeft` score follows the opening of the eye at landmarks 263/362).
 */
export const blendshapeSignals: ExpressionSignalSource = (faces, face, out, offset) => {
  const b = faces.blendshapes
  const o = face * BLENDSHAPES_STRIDE
  out[offset + SIGNAL.eyeClosedLeft] = b[o + EYE_BLINK_LEFT]!
  out[offset + SIGNAL.eyeClosedRight] = b[o + EYE_BLINK_RIGHT]!
  out[offset + SIGNAL.jawOpen] = b[o + JAW_OPEN]!
  out[offset + SIGNAL.smile] = (b[o + SMILE_LEFT]! + b[o + SMILE_RIGHT]!) / 2
  out[offset + SIGNAL.browRaise] = b[o + BROW_INNER_UP]!
  out[offset + SIGNAL.pucker] = b[o + MOUTH_PUCKER]!
  writeHeadPose(faces, face, out, offset)
}

/**
 * Writes the head pitch and yaw (radians) of face `face` at `offset + SIGNAL.pitch` / `SIGNAL.yaw`, from the facial
 * transformation matrix: the canonical face's +z axis (out of the face) expressed in camera space. Shared by every
 * signal source, since the pose is never dropped (§16.2).
 */
export function writeHeadPose(faces: Readonly<FaceFrame>, face: number, out: Float32Array, offset: number): void {
  const m = faces.matrices
  const o = face * MATRIX_STRIDE
  // Third column of the column-major matrix; it carries the scale, if any, hence the normalisation.
  const fx = m[o + 8]!
  const fy = m[o + 9]!
  const fz = m[o + 10]!
  const n = Math.sqrt(fx * fx + fy * fy + fz * fz) // not Math.hypot: it allocates
  if (n === 0) {
    out[offset + SIGNAL.pitch] = NaN
    out[offset + SIGNAL.yaw] = NaN
    return
  }
  out[offset + SIGNAL.pitch] = Math.asin(Math.max(-1, Math.min(1, fy / n)))
  out[offset + SIGNAL.yaw] = Math.atan2(fx, fz)
}

/**
 * Writes the signals of the first `faces.count` faces into `out` (`SIGNALS_STRIDE` floats per face) with `source`.
 * `out` must hold at least `faces.count * SIGNALS_STRIDE` floats (`createSignals(maxFaces)`).
 */
export function readExpressionSignals(faces: Readonly<FaceFrame>, out: Float32Array, source: ExpressionSignalSource = blendshapeSignals): void {
  for (let i = 0; i < faces.count; i++) source(faces, i, out, i * SIGNALS_STRIDE)
}

/** Signals array for `maxFaces` faces. */
export function createSignals(maxFaces: number): Float32Array {
  return new Float32Array(maxFaces * SIGNALS_STRIDE)
}
