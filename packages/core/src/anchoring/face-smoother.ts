/**
 * Landmark smoothing and prediction, per face identity.
 *
 * Tracking results arrive irregularly and late (≈ 15–18 Hz on phones, 100–140 ms old when the frame is drawn,
 * docs/decisions/tracking-worker.md), while rendering runs at the display rate. Two steps:
 *
 * 1. `update`, once per tracking result: a One Euro filter per landmark coordinate (variable time step, state kept
 *    per **track**, so it follows the face when the tracker reorders its slots and restarts when the id changes),
 *    then the head pose is fitted to the smoothed landmarks (`estimateFacePose`), so the pose, the rigid anchors and
 *    the expression anchors are all smoothed consistently, whatever the tracker.
 * 2. `predict`, once per rendered frame: the smoothed landmarks are extrapolated along their filtered speed to the
 *    time of the displayed frame (capped by `maxPredictionMs`), and the pose is fitted again, which hides most of
 *    the result age on motion without delaying the image.
 *
 * Allocation-free after construction.
 */
import { BLENDSHAPES_STRIDE, LANDMARKS_STRIDE, type FaceFrame } from '../face.ts'
import type { FaceIdentityTracker } from './face-identity.ts'
import { estimateFacePose } from './face-pose.ts'
import { OneEuroBank, type OneEuroParams } from './one-euro.ts'

export interface FaceSmootherOptions {
  /**
   * One Euro parameters of the landmark coordinates; the speed is measured in face sizes per second (bounding box
   * of the mesh). Default `DEFAULT_LANDMARK_SMOOTHING`.
   */
  landmarks?: Partial<OneEuroParams>
  /** Longest extrapolation of `predict` (ms); 0 disables prediction. Default 100. */
  maxPredictionMs?: number
}

/**
 * Starting point, to be tuned on devices: MediaPipe's face landmark smoothing (`minCutoff` 0.05 Hz, `dCutoff` 1 Hz)
 * with a lower `beta` (20 instead of 80): at 15 Hz the jitter alone raised MediaPipe's cutoff to several hertz,
 * while 20 still opens the filter to ≈ 20 Hz at one face size per second.
 */
export const DEFAULT_LANDMARK_SMOOTHING: Readonly<OneEuroParams> = { minCutoff: 0.05, beta: 20, dCutoff: 1 }

export class FaceSmoother {
  readonly identity: FaceIdentityTracker
  maxPredictionMs: number
  readonly #banks: OneEuroBank[]
  readonly #bankId: Int32Array
  readonly #slotTrack: Int32Array
  readonly #scale = new Float64Array(3)
  #count = 0

  /** `identity` must be updated with each result before `update` is called with it. */
  constructor(identity: FaceIdentityTracker, options: FaceSmootherOptions = {}) {
    this.identity = identity
    this.maxPredictionMs = options.maxPredictionMs ?? 100
    const params = { ...DEFAULT_LANDMARK_SMOOTHING, ...options.landmarks }
    this.#banks = Array.from({ length: identity.capacity }, () => new OneEuroBank(LANDMARKS_STRIDE, params))
    this.#bankId = new Int32Array(identity.capacity)
    this.#slotTrack = new Int32Array(identity.maxFaces)
  }

  /** One Euro parameters of the landmarks (shared by every face; changes apply from the next result). */
  setLandmarkParams(params: Partial<OneEuroParams>): void {
    for (const bank of this.#banks) bank.params = { ...bank.params, ...params }
  }

  /**
   * Smooths a tracking result taken at `time` (s, same clock as `identity.update`) into `out` (`out` may be
   * `input`): landmarks filtered, blendshapes copied, matrices fitted to the smoothed landmarks. The slots of
   * `out` are those of `input`; their ids are `identity.ids`.
   */
  update(input: Readonly<FaceFrame>, time: number, out: FaceFrame): void {
    const id = this.identity
    const count = Math.min(id.count, input.count, out.maxFaces)
    copyHeader(input, out, count)
    const w = input.width > 0 ? input.width : 1
    const h = input.height > 0 ? input.height : 1
    const scale = this.#scale
    for (let j = 0; j < count; j++) {
      const k = id.tracks[j]!
      const bank = this.#banks[k]!
      if (this.#bankId[k] !== id.ids[j]) {
        bank.reset()
        this.#bankId[k] = id.ids[j]!
      }
      const size = id.sizes[j]!
      scale[0] = w / size
      scale[1] = h / size
      scale[2] = w / size
      bank.filter(input.landmarks, j * LANDMARKS_STRIDE, out.landmarks, j * LANDMARKS_STRIDE, time, scale)
      copyBlendshapes(input, out, j)
      estimateFacePose(out, j, out.matrices)
      this.#slotTrack[j] = k
    }
    this.#count = count
  }

  /**
   * Writes into `out` the last smoothed result (`smoothed`, the `out` of the last `update`) extrapolated to `time`
   * (s, e.g. the media time of the frame being drawn). Without prediction, or for a time not after the result,
   * this is a copy of the smoothed result.
   */
  predict(smoothed: Readonly<FaceFrame>, time: number, out: FaceFrame): void {
    const count = Math.min(this.#count, smoothed.count, out.maxFaces)
    copyHeader(smoothed, out, count)
    const max = this.maxPredictionMs / 1000
    for (let j = 0; j < count; j++) {
      const bank = this.#banks[this.#slotTrack[j]!]!
      const horizon = Math.min(Math.max(time - bank.time, 0), max)
      // `bank.predict(horizon, …)` written out: V8 boxes (allocates) a fractional argument of a call it does not inline.
      const x = bank.value
      const dx = bank.speed
      const dst = out.landmarks
      const o = j * LANDMARKS_STRIDE
      for (let i = 0; i < bank.size; i++) dst[o + i] = x[i]! + dx[i]! * horizon
      if (out !== smoothed) copyBlendshapes(smoothed, out, j)
      estimateFacePose(out, j, out.matrices)
    }
  }
}

function copyHeader(src: Readonly<FaceFrame>, dst: FaceFrame, count: number): void {
  dst.count = count
  dst.mediaTime = src.mediaTime
  dst.width = src.width
  dst.height = src.height
}

function copyBlendshapes(src: Readonly<FaceFrame>, dst: FaceFrame, face: number): void {
  if (src === dst) return
  const o = face * BLENDSHAPES_STRIDE
  for (let i = 0; i < BLENDSHAPES_STRIDE; i++) dst.blendshapes[o + i] = src.blendshapes[o + i]!
}
