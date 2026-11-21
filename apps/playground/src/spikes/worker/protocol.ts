/**
 * Messages between the page and the tracking worker (#6 spike).
 *
 * Results travel in transferable `ArrayBuffer`s laid out by `faceFrameView` (@ouaf/core): the page owns a small
 * pool (two buffers: one in flight, one spare), sends a free buffer along with every frame, and the worker sends it
 * back filled. No result buffer is allocated per frame (only the message objects and the views over a received
 * buffer are); the page copies the results into the frame it renders and puts the buffer back in the pool.
 */
import type { Delegate } from '@ouaf/core'

/** Producer slots of the `FaceFrameView` header (`FACE_FRAME_USER_SLOTS` = 4 slots, from index 4). */
export const HEADER_FRAME_ID = 4
/** Time spent in `FaceTracker.detect` in the worker (ms, worker clock). */
export const HEADER_INFERENCE_MS = 5
/** Time between the frame message reaching the worker and the result being posted (ms, worker clock). */
export const HEADER_WORKER_MS = 6
/** 1 when `detect` threw for this frame (the result is empty), 0 otherwise. */
export const HEADER_ERROR = 7

export interface InitMessage {
  type: 'init'
  maxFaces: number
  delegate: Delegate
  /** Absolute URLs (relative ones would resolve against the worker script, not the page). */
  wasmBaseUrl: string
  modelUrl: string
}

export interface FrameMessage {
  type: 'frame'
  /** Transferred; the worker closes it. */
  frame: VideoFrame | ImageBitmap
  /** Free result buffer (transferred), sent back in the `result` message. */
  buffer: ArrayBuffer
  id: number
  /** MediaPipe timestamp (the page's scheduler `now`, strictly increasing). */
  timestampMs: number
  mediaTime: number
}

export type ToWorker = InitMessage | FrameMessage

export type FromWorker =
  | { type: 'ready'; delegate: Delegate; warnings: string[] }
  | { type: 'error'; message: string; fatal: boolean }
  /** `buffer` holds the results of frame `HEADER_FRAME_ID`. */
  | { type: 'result'; buffer: ArrayBuffer }
  /** MediaPipe's usage-metrics request from the worker, and what happened to it (see docs/privacy.md). */
  | { type: 'telemetry'; outcome: 'blocked' | 'sent' | 'failed'; detail: string }
