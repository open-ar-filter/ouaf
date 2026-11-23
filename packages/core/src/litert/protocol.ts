/**
 * Messages between the LiteRT.js face tracker (`tracker.ts`, page side) and its worker (`face.worker.ts`).
 *
 * The page transfers each frame (`VideoFrame`, or `ImageBitmap` where `VideoFrame` is missing) with a result buffer
 * from a small pool; the worker closes the frame and sends the buffer back filled (`RESULT_FLOATS` per face: landmarks, then
 * blendshapes). A frame that comes while the worker runs waits for the run to end; a newer one replaces it (its
 * buffer comes back with `dropped`).
 */
import { BLENDSHAPE_COUNT, LANDMARK_COUNT } from '../face.ts'
import type { Crop, Readback, StageTimings } from './pipeline.ts'

/**
 * Floats per face of a result buffer: 478 × xyz landmarks (normalized, as in `FaceFrame`), then 52 blendshape scores;
 * a buffer holds `maxFaces` of them.
 */
export const RESULT_FLOATS = LANDMARK_COUNT * 3 + BLENDSHAPE_COUNT

export interface InitMessage {
  type: 'init'
  /** Absolute URL: `litert/wasm/` and `models/` resolve against it. */
  assetsBaseUrl: string
  crop: Crop
  readback: Readback
  /** Faces tracked at most: the result buffers hold that many. */
  maxFaces: number
}

export interface FrameMessage {
  type: 'frame'
  id: number
  /** Transferred; the worker closes it. Absent: the newest frame of the camera stream (`StreamMessage`). */
  frame?: VideoFrame | ImageBitmap
  width: number
  height: number
  /** Run the blendshapes model. */
  blendshapes: boolean
  /** Faces to track now (≤ the init's `maxFaces`; fewer while the governor has dropped the extra faces). */
  maxFaces: number
  /** Forget the tracked face first (still image, new run of a file source). */
  reset: boolean
  /** The result must be this frame's (file source): no async readback for it. */
  exact?: boolean
  /** Free result buffer (`RESULT_FLOATS` floats, transferred), sent back in the `result` message. */
  buffer: ArrayBuffer
  /** When it was posted: `performance.timeOrigin + performance.now()` of the page (ms). */
  sentAt: number
}

/**
 * The camera's frames, read in the worker straight from the track: the `readable` of a `MediaStreamTrackProcessor`
 * created on the page, transferred. Replaces the previous stream.
 */
export interface StreamMessage {
  type: 'stream'
  readable: ReadableStream<VideoFrame>
}

export type ToWorker = InitMessage | FrameMessage | StreamMessage

export interface ReadyMessage {
  type: 'ready'
  /** Crops and readback actually used (after fallbacks). */
  crop: Crop
  readback: Readback
  /** Fallbacks taken in the worker. */
  warnings: string[]
}

export interface ResultMessage {
  type: 'result'
  id: number
  /** The frame the result describes: `id`, or an earlier frame with the async readback. */
  frame: number
  buffer: ArrayBuffer
  /** Faces found, in slot order: face `i` at `i × RESULT_FLOATS` in the buffer. */
  count: number
  hasBlendshapes: boolean
  timings: StageTimings
  /** Warnings raised during this run (crop fallback after a context loss). */
  warnings: string[]
  /**
   * When the worker received the frame, started its run and posted this result: `performance.timeOrigin +
   * performance.now()` (ms).
   */
  receivedAt: number
  startedAt: number
  postedAt: number
  /** The worker had no frame for this long before the run (ms): it was waiting for the page. */
  idleMs: number
  /** The frame did not run: a newer one came while the worker was busy. */
  dropped?: boolean
  /**
   * The camera stream's frames are not the video element's (rotated or another size: the stream is closed); the page
   * captures frames from the element again.
   */
  streamUnusable?: string
  /** The run failed: `count` is 0. */
  error?: string
}

export type FromWorker = ReadyMessage | ResultMessage | { type: 'error'; message: string }
