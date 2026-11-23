/**
 * Messages between the LiteRT.js face tracker (`tracker.ts`, page side) and its worker (`face.worker.ts`).
 *
 * The page transfers each frame (`VideoFrame`, or `ImageBitmap` where `VideoFrame` is missing) with a result buffer
 * from a small pool; the worker closes the frame and sends the buffer back filled (`RESULT_FLOATS`: landmarks, then
 * blendshapes). One frame in flight at a time (docs/decisions/tracking-worker.md).
 */
import { BLENDSHAPE_COUNT, LANDMARK_COUNT } from '../face.ts'
import type { Crop, StageTimings } from './pipeline.ts'

/** Floats of a result buffer: 478 × xyz landmarks (normalized, as in `FaceFrame`), then 52 blendshape scores. */
export const RESULT_FLOATS = LANDMARK_COUNT * 3 + BLENDSHAPE_COUNT

export interface InitMessage {
  type: 'init'
  /** Absolute URL: `litert/wasm/` and `models/` resolve against it. */
  assetsBaseUrl: string
  crop: Crop
}

export interface FrameMessage {
  type: 'frame'
  id: number
  /** Transferred; the worker closes it. */
  frame: VideoFrame | ImageBitmap
  width: number
  height: number
  /** Run the blendshapes model. */
  blendshapes: boolean
  /** Forget the tracked face first (still image, new run of a file source). */
  reset: boolean
  /** Free result buffer (`RESULT_FLOATS` floats, transferred), sent back in the `result` message. */
  buffer: ArrayBuffer
}

export type ToWorker = InitMessage | FrameMessage

export interface ReadyMessage {
  type: 'ready'
  /** Crops actually used (after fallbacks). */
  crop: Crop
  /** Fallbacks taken in the worker. */
  warnings: string[]
}

export interface ResultMessage {
  type: 'result'
  id: number
  buffer: ArrayBuffer
  found: boolean
  hasBlendshapes: boolean
  timings: StageTimings
  /** Warnings raised during this run (crop fallback after a context loss). */
  warnings: string[]
  /** The run failed: `found` is false. */
  error?: string
}

export type FromWorker = ReadyMessage | ResultMessage | { type: 'error'; message: string }
