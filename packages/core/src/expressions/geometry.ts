/**
 * Expression signals from the landmark geometry (spec §13, §16.2): what the expression detectors read while the
 * device governor has dropped blendshapes, on the same 0–1 scale as the blendshape scores so that the event
 * thresholds keep their meaning.
 *
 * Each signal is a ratio of 3D landmark distances (scale-free: the face's size on screen does not matter), mapped
 * linearly between a "0" and a "1" value and clamped. The mappings were fitted on the test clips against
 * MediaPipe's blendshape scores of the same frames (`GEOMETRY_CALIBRATION`, fixtures and figures in
 * `test/geometry-signals.test.ts`); the head pose comes from the transformation matrix, as with blendshapes.
 *
 * Landmark indices are those of MediaPipe's face mesh; "left" / "right" are the person's sides (spec §5.1).
 */
import { LANDMARKS_STRIDE, type FaceFrame } from '../face.ts'
import { SIGNAL, SIGNALS_STRIDE, writeHeadPose, type ExpressionSignalSource } from './signals.ts'

/** Landmarks the geometric source reads (for fixtures and tests). */
export const GEOMETRY_LANDMARKS = {
  /** Person's left eye: outer and inner corners, then five upper / lower lid pairs across the eye. */
  leftEye: { outer: 263, inner: 362, upper: [386, 385, 387, 384, 388], lower: [374, 380, 373, 381, 390] },
  /** Person's right eye. */
  rightEye: { outer: 33, inner: 133, upper: [159, 158, 160, 157, 161], lower: [145, 153, 144, 154, 163] },
  /** Inner lips (upper, lower) and mouth corners (person's right, left). */
  lips: { upper: 13, lower: 14, right: 61, left: 291 },
  /** Face "up" axis: from below the nose to between the eyes (rigid points). */
  up: { from: 2, to: 168 },
  /** Inner ends of the eyebrows (person's right, left). */
  brows: { right: 107, left: 336 },
} as const

/** Every landmark index above, sorted (fixtures store only these). */
export const GEOMETRY_LANDMARK_INDICES: readonly number[] = [
  ...new Set(Object.values(GEOMETRY_LANDMARKS).flatMap((group) => Object.values(group).flatMap((v: number | readonly number[]) => (typeof v === 'number' ? [v] : v)))),
].sort((a, b) => a - b)

/**
 * Measure → signal mappings: the measure value that maps to 0 and the one that maps to 1 (linear in between,
 * clamped). Measures (`GeometryMeasures`), all divided by a rigid length so they do not depend on the face's size:
 *
 * - `eyeClosed`: eyelid opening (mean of five lid distances) / eye width. Open ≈ 0.25–0.35, closed ≈ 0.
 * - `jawOpen`: inner lip gap / distance between the outer eye corners.
 * - `smile`: height of the mouth corners above the inner lip centre, along the face's up axis / outer eye corners.
 * - `browRaise`: height of the inner eyebrow ends above the inner eye corners, up axis / outer eye corners.
 * - `pucker`: mouth width (corner to corner) / outer eye corners; narrower is more puckered.
 *
 * Calibration (#90): face 0 of the test clips `pesquet-talk`, `pesquet-walk`, `pesquet-turn` and
 * `two-faces-stacked` with |yaw| < 35° (≈ 180 frames), least mean absolute error against the blendshape score. The
 * clips cover blinks, smiles and speech; they do not reach the default thresholds of `mouthOpen` (jawOpen ≤ 0.3 on
 * those frames), `eyebrowRaise` (browInnerUp ≤ 0.3) or `kiss` (mouthPucker ≤ 0.8, rarely): those mappings
 * extrapolate from small values, with the "1" end set from typical face proportions (a full eyebrow raise lifts the
 * brows by ≈ 15 % of the eye distance, a pucker narrows the mouth to ≈ 40 %), and are to be checked on real faces
 * (spec Appendix C).
 */
export const GEOMETRY_CALIBRATION = {
  eyeClosed: { zero: 0.3, one: 0 },
  jawOpen: { zero: 0.04, one: 0.95 },
  smile: { zero: 0.012, one: 0.08 },
  browRaise: { zero: 0.265, one: 0.45 },
  pucker: { zero: 0.5, one: 0.38 },
} as const

/** The raw measures behind `geometrySignals`, before mapping (see `GEOMETRY_CALIBRATION`). */
export interface GeometryMeasures {
  /** Eyelid opening / eye width, person's left and right eye (`eyeClosed`). */
  eyeLeft: number
  eyeRight: number
  /** Inner lip gap / outer eye corners (`jawOpen`). */
  lipGap: number
  /** Mouth corners above the inner lip centre / outer eye corners (`smile`). */
  cornerRise: number
  /** Inner eyebrow ends above the inner eye corners / outer eye corners (`browRaise`). */
  browRise: number
  /** Mouth width / outer eye corners (`pucker`). */
  mouthWidth: number
}

const LE = GEOMETRY_LANDMARKS.leftEye
const RE = GEOMETRY_LANDMARKS.rightEye
const LIPS = GEOMETRY_LANDMARKS.lips
const UP = GEOMETRY_LANDMARKS.up
const BROWS = GEOMETRY_LANDMARKS.brows
const C = GEOMETRY_CALIBRATION

/**
 * Per-call state, kept in typed arrays (module scratch) rather than passed as arguments or return values, so that no
 * double is boxed (see the note in `detector.ts`): the frame's landmarks, base offset and pixel scales, the face's up
 * axis and the last helper result.
 */
let L: Float32Array = new Float32Array(0)
const s = new Float64Array(8)
/** Integer state: the base offset of the face in `L`. */
const base = new Int32Array(1)
const SX = 1
const SY = 2
const UX = 3
const UY = 4
const UZ = 5
const R = 6
const ACC = 7

/** The raw measures of the last face (`GeometryMeasures` order), and their calibration (zero, one pairs). */
const measures = new Float64Array(6)
const M_EYE_LEFT = 0
const M_EYE_RIGHT = 1
const M_LIP_GAP = 2
const M_CORNER_RISE = 3
const M_BROW_RISE = 4
const M_MOUTH_WIDTH = 5
// prettier-ignore
const CAL = new Float64Array([
  C.eyeClosed.zero, C.eyeClosed.one,
  C.eyeClosed.zero, C.eyeClosed.one,
  C.jawOpen.zero, C.jawOpen.one,
  C.smile.zero, C.smile.one,
  C.browRaise.zero, C.browRaise.one,
  C.pucker.zero, C.pucker.one,
])
/** Signal written from each measure. */
const SIGNAL_OF = new Int32Array([SIGNAL.eyeClosedLeft, SIGNAL.eyeClosedRight, SIGNAL.jawOpen, SIGNAL.smile, SIGNAL.browRaise, SIGNAL.pucker])

/** Distance between landmarks `a` and `b` (pixels, isotropic) into `s[R]`. */
function dist(a: number, b: number): void {
  const o = base[0]!
  const dx = (L[o + a * 3]! - L[o + b * 3]!) * s[SX]!
  const dy = (L[o + a * 3 + 1]! - L[o + b * 3 + 1]!) * s[SY]!
  const dz = (L[o + a * 3 + 2]! - L[o + b * 3 + 2]!) * s[SX]!
  s[R] = Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/** Height of the midpoint of (a, b) above the midpoint of (c, d) along the face's up axis, into `s[R]`. */
function rise(a: number, b: number, c: number, d: number): void {
  const o = base[0]!
  const dx = ((L[o + a * 3]! + L[o + b * 3]! - L[o + c * 3]! - L[o + d * 3]!) / 2) * s[SX]!
  const dy = ((L[o + a * 3 + 1]! + L[o + b * 3 + 1]! - L[o + c * 3 + 1]! - L[o + d * 3 + 1]!) / 2) * s[SY]!
  const dz = ((L[o + a * 3 + 2]! + L[o + b * 3 + 2]! - L[o + c * 3 + 2]! - L[o + d * 3 + 2]!) / 2) * s[SX]!
  s[R] = dx * s[UX]! + dy * s[UY]! + dz * s[UZ]!
}

/** Eyelid opening / eye width into `measures[slot]`. */
function eyeOpening(eye: typeof LE | typeof RE, slot: number): void {
  // The sum stays in the scratch array (see above).
  s[ACC] = 0
  for (let i = 0; i < eye.upper.length; i++) {
    dist(eye.upper[i]!, eye.lower[i]!)
    s[ACC] += s[R]!
  }
  dist(eye.outer, eye.inner)
  // A zero-width eye (degenerate face, caught by `measure`) gives NaN or Infinity: clamped like any value.
  measures[slot] = s[ACC]! / (eye.upper.length * s[R]!)
}

/** Computes `measures` for face `face`; false for a degenerate face (all points at one place). */
function measure(faces: Readonly<FaceFrame>, face: number): boolean {
  L = faces.landmarks
  base[0] = face * LANDMARKS_STRIDE
  s[SX] = faces.width > 0 ? faces.width : 1
  s[SY] = faces.height > 0 ? faces.height : 1
  // Up axis (y down in the image, so "up" points towards -y on an upright face).
  const o = base[0]!
  const ux = (L[o + UP.to * 3]! - L[o + UP.from * 3]!) * s[SX]!
  const uy = (L[o + UP.to * 3 + 1]! - L[o + UP.from * 3 + 1]!) * s[SY]!
  const uz = (L[o + UP.to * 3 + 2]! - L[o + UP.from * 3 + 2]!) * s[SX]!
  const un = Math.sqrt(ux * ux + uy * uy + uz * uz)
  dist(LE.outer, RE.outer)
  const scale = s[R]!
  if (!(un > 0) || !(scale > 0)) return false
  s[UX] = ux / un
  s[UY] = uy / un
  s[UZ] = uz / un
  eyeOpening(LE, M_EYE_LEFT)
  eyeOpening(RE, M_EYE_RIGHT)
  dist(LIPS.upper, LIPS.lower)
  measures[M_LIP_GAP] = s[R]! / scale
  rise(LIPS.right, LIPS.left, LIPS.upper, LIPS.lower)
  measures[M_CORNER_RISE] = s[R]! / scale
  rise(BROWS.right, BROWS.left, RE.inner, LE.inner)
  measures[M_BROW_RISE] = s[R]! / scale
  dist(LIPS.right, LIPS.left)
  measures[M_MOUTH_WIDTH] = s[R]! / scale
  return true
}

/**
 * Signals from the landmark geometry, the head pose from the transformation matrix. Allocation-free. Writes NaN
 * ("no data": the detectors keep their state) for a degenerate face.
 */
export const geometrySignals: ExpressionSignalSource = (faces, face, out, offset) => {
  // No conditional expression mixes a double with a constant here: V8 boxes the double of such a phi.
  if (measure(faces, face)) {
    for (let k = 0; k < SIGNAL_OF.length; k++) {
      const zero = CAL[2 * k]!
      out[offset + SIGNAL_OF[k]!] = Math.min(1, Math.max(0, (measures[k]! - zero) / (CAL[2 * k + 1]! - zero)))
    }
  } else {
    for (let k = 0; k < SIGNAL_OF.length; k++) out[offset + SIGNAL_OF[k]!] = NaN
  }
  writeHeadPose(faces, face, out, offset)
}

/** The raw measures of face `face` (calibration tools; allocates its result). NaN for a degenerate face. */
export function geometryMeasures(faces: Readonly<FaceFrame>, face: number): GeometryMeasures {
  const ok = measure(faces, face)
  const m = (slot: number) => (ok ? measures[slot]! : NaN)
  return {
    eyeLeft: m(M_EYE_LEFT),
    eyeRight: m(M_EYE_RIGHT),
    lipGap: m(M_LIP_GAP),
    cornerRise: m(M_CORNER_RISE),
    browRise: m(M_BROW_RISE),
    mouthWidth: m(M_MOUTH_WIDTH),
  }
}

/**
 * Eyes closed, relative to each person's open eyes (#90): the eyelid opening varies a lot between people, head poses
 * (looking down lowers the lids) and expressions (a smile narrows the eyes), while a blink is a fast drop from
 * whatever the opening was. Each eye keeps an open-eye baseline per face: it follows the opening up quickly
 * (`riseTauMs`) and down slowly (`fallTauMs`), a slow running upper envelope, restarted when the face is new or was
 * not seen for `resetGapMs`. The closure `1 − opening / baseline` is mapped linearly from `zero` to `one`, less
 * `smile` × the smile signal (a smile narrows the eyes without closing them).
 */
export const EYE_BASELINE = { riseTauMs: 300, fallTauMs: 15000, resetGapMs: 1000, zero: 0.2, one: 0.7, smile: 0.2 } as const

/** Per-face state: face id, open-eye baselines (left, right), time of the last update (ms). */
const EYE_STATE = 4

/**
 * Stateful geometric source (what the engine uses): `geometrySignals`, with the eyes judged against each face's
 * adaptive open-eye baseline (`EYE_BASELINE`). Call `begin` with the face ids of the frame (slot → stable id) and its
 * time before reading the signals with `source`. Allocation-free.
 */
export class GeometrySignals {
  readonly maxFaces: number
  readonly #state: Float64Array
  /** Time of the frame being read (ms). */
  readonly #time = new Float64Array(1)
  #ids: ArrayLike<number> = []

  constructor(maxFaces: number) {
    this.maxFaces = maxFaces
    this.#state = new Float64Array(maxFaces * EYE_STATE).fill(Number.NaN)
  }

  /** The frame about to be read: `ids[slot]` is the stable id of the face in `slot`, `timeMs` its time. */
  begin(ids: ArrayLike<number>, timeMs: number): void {
    this.#ids = ids
    this.#time[0] = timeMs
  }

  /** Forgets every baseline (new source). */
  reset(): void {
    this.#state.fill(Number.NaN)
  }

  readonly source: ExpressionSignalSource = (faces, face, out, offset) => {
    geometrySignals(faces, face, out, offset)
    if (face >= this.maxFaces || Number.isNaN(out[offset + SIGNAL.jawOpen]!)) return
    const st = this.#state
    const o = face * EYE_STATE
    const id = this.#ids[face] ?? -1
    const t = this.#time[0]!
    const dt = t - st[o + 3]!
    // A new face, or one not seen for a while: start from its current opening.
    if (st[o] !== id || !(dt >= 0 && dt <= EYE_BASELINE.resetGapMs)) {
      st[o] = id
      st[o + 1] = measures[M_EYE_LEFT]!
      st[o + 2] = measures[M_EYE_RIGHT]!
    } else {
      const rise = 1 - Math.exp(-dt / EYE_BASELINE.riseTauMs)
      const fall = 1 - Math.exp(-dt / EYE_BASELINE.fallTauMs)
      for (let e = 0; e < 2; e++) {
        const m = measures[M_EYE_LEFT + e]!
        const b = st[o + 1 + e]!
        if (m > b) st[o + 1 + e] = b + (m - b) * rise
        else if (m < b) st[o + 1 + e] = b + (m - b) * fall
        else if (Number.isNaN(b)) st[o + 1 + e] = m
      }
    }
    st[o + 3] = t
    const smile = out[offset + SIGNAL.smile]! * EYE_BASELINE.smile
    const span = EYE_BASELINE.one - EYE_BASELINE.zero
    out[offset + SIGNAL.eyeClosedLeft] = Math.min(1, Math.max(0, (1 - measures[M_EYE_LEFT]! / st[o + 1]! - EYE_BASELINE.zero) / span - smile))
    out[offset + SIGNAL.eyeClosedRight] = Math.min(1, Math.max(0, (1 - measures[M_EYE_RIGHT]! / st[o + 2]! - EYE_BASELINE.zero) / span - smile))
  }
}

/**
 * Eyes for the blink and wink events while blendshapes are available (#90): per eye, the larger of the blendshape
 * score and the geometric closure (`GeometrySignals`), written into `signals` for the first `count` faces; `geometry`
 * holds the geometric signals of the same faces (same layout). MediaPipe's `eyeBlink` peaks at 0.5–0.6 on a full blink
 * for some people, and a blink sampled at 10–15 Hz is often caught half-closed: on the test clips this catches more
 * blendshape blinks at 15 and 10 Hz with no extra event. Only the event signals change: bindings and scripts keep the
 * raw blendshapes. Allocation-free.
 */
export function maxEyeSignals(count: number, geometry: Float32Array, signals: Float32Array): void {
  for (let i = 0; i < count; i++) {
    const o = i * SIGNALS_STRIDE
    for (let k = SIGNAL.eyeClosedLeft; k <= SIGNAL.eyeClosedRight; k++) {
      const g = geometry[o + k]!
      if (g > signals[o + k]!) signals[o + k] = g
    }
  }
}
