/**
 * Shared, allocation-free structure for face tracking results.
 *
 * A tracker writes into a `FaceFrame` preallocated for `maxFaces`; the renderer, the perf tools and (later) the
 * anchors read from it. Nothing is allocated per frame: arrays are sized once and `count` says how many faces
 * are valid this frame. Face `i` occupies a fixed slice of each array (see the `*_STRIDE` constants).
 */

/** Landmarks per face (MediaPipe FaceLandmarker with irises). */
export const LANDMARK_COUNT = 478

/** Blendshape categories in MediaPipe output order; index 0 is `_neutral` (not exposed to filters). */
export const BLENDSHAPE_NAMES = [
  '_neutral',
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeLookDownLeft',
  'eyeLookDownRight',
  'eyeLookInLeft',
  'eyeLookInRight',
  'eyeLookOutLeft',
  'eyeLookOutRight',
  'eyeLookUpLeft',
  'eyeLookUpRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'eyeWideLeft',
  'eyeWideRight',
  'jawForward',
  'jawLeft',
  'jawOpen',
  'jawRight',
  'mouthClose',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthFunnel',
  'mouthLeft',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthPucker',
  'mouthRight',
  'mouthRollLower',
  'mouthRollUpper',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'noseSneerLeft',
  'noseSneerRight',
] as const

export type BlendshapeName = (typeof BLENDSHAPE_NAMES)[number]

export const BLENDSHAPE_COUNT = BLENDSHAPE_NAMES.length

/** Floats per face in `FaceFrame.landmarks`: x, y, z for each landmark. */
export const LANDMARKS_STRIDE = LANDMARK_COUNT * 3
/** Floats per face in `FaceFrame.blendshapes`. */
export const BLENDSHAPES_STRIDE = BLENDSHAPE_COUNT
/** Floats per face in `FaceFrame.matrices`: one 4×4 column-major matrix. */
export const MATRIX_STRIDE = 16

export interface FaceFrame {
  /** Capacity: number of faces the arrays are sized for. */
  readonly maxFaces: number
  /** Faces detected in this frame (0 ≤ count ≤ maxFaces). Only the first `count` slices are valid. */
  count: number
  /** Media time of the video frame the results belong to (s). */
  mediaTime: number
  /** Size of the analysed video frame in pixels (to convert normalized coordinates). */
  width: number
  height: number
  /**
   * Landmarks, `LANDMARKS_STRIDE` floats per face, as returned by MediaPipe: x and y normalized to [0, 1] in
   * **image space, not mirrored** (x right, y down, origin top-left of the video frame); z is relative depth in
   * roughly the same scale as x (smaller = closer to the camera). Mirroring is applied by the renderer.
   */
  readonly landmarks: Float32Array
  /** Blendshape scores in [0, 1], `BLENDSHAPES_STRIDE` floats per face, indexed like `BLENDSHAPE_NAMES`. */
  readonly blendshapes: Float32Array
  /**
   * Facial transformation matrix (MediaPipe canonical face → camera space, centimetres), `MATRIX_STRIDE` floats
   * per face, column-major. Not mirrored.
   */
  readonly matrices: Float32Array
}

export function createFaceFrame(maxFaces: number): FaceFrame {
  if (!Number.isInteger(maxFaces) || maxFaces < 1) throw new RangeError(`maxFaces must be a positive integer, got ${maxFaces}`)
  return {
    maxFaces,
    count: 0,
    mediaTime: 0,
    width: 0,
    height: 0,
    landmarks: new Float32Array(maxFaces * LANDMARKS_STRIDE),
    blendshapes: new Float32Array(maxFaces * BLENDSHAPES_STRIDE),
    matrices: new Float32Array(maxFaces * MATRIX_STRIDE),
  }
}

/** Index of a blendshape in a face's slice. */
export function blendshapeIndex(name: BlendshapeName): number {
  return BLENDSHAPE_NAMES.indexOf(name)
}

/**
 * Frames a tracker accepts: the camera `<video>` (main thread), a frame captured from it and sent elsewhere, e.g.
 * to a worker (`VideoFrame`, `ImageBitmap`), or an image the host gives the engine directly (canvas, `<img>`, #32).
 */
export type TrackerInput = HTMLVideoElement | VideoFrame | ImageBitmap | HTMLCanvasElement | OffscreenCanvas | HTMLImageElement

/** Inference backend actually in use. */
export type Delegate = 'GPU' | 'CPU'

/**
 * Face tracker contract. `detect` is synchronous (MediaPipe VIDEO mode) and writes into `out` without allocating.
 * Implementations: `@ouaf/core` MediaPipe tracker (#3); test doubles.
 */
export interface FaceTracker {
  /** Backend in use after initialisation (GPU, or CPU after an automatic fallback). */
  readonly delegate: Delegate
  readonly maxFaces: number
  /**
   * Runs tracking on the video's current frame (or on a captured frame). `timestampMs` must increase strictly
   * between calls (use the scheduler's `now`). Writes `count`, `mediaTime`, `width`, `height` and the face slices
   * of `out`. A captured frame is not closed: the caller owns it.
   */
  detect(source: TrackerInput, timestampMs: number, mediaTime: number, out: FaceFrame): void
  /**
   * Tracks a still image (MediaPipe IMAGE mode: every call detects from scratch, no state is carried over from the
   * previous frame). Writes `out` like `detect`. A later `detect` switches back to video mode first, which
   * `setRunningMode('VIDEO')` does ahead of time.
   */
  detectImage(source: TrackerInput, mediaTime: number, out: FaceFrame): Promise<void>
  /** Current running mode: `VIDEO` (`detect`) or `IMAGE` (`detectImage`). */
  readonly runningMode: RunningMode
  /** Switches the running mode; `detect` requires `VIDEO`. Resolves once the landmarker is reconfigured. */
  setRunningMode(mode: RunningMode): Promise<void>
  /**
   * Forgets the temporal state (the face regions carried from frame to frame in VIDEO mode), so that the next frame
   * is tracked as if it were the first: each run of a file source then gives the same result (spec §12.5).
   */
  resetState(): Promise<void>
  dispose(): void
}

export type RunningMode = 'VIDEO' | 'IMAGE'
