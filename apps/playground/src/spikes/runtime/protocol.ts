/**
 * Messages between the #83 runtime page and its LiteRT.js worker (`litert.worker.ts`, `mode=worker`).
 *
 * As in the #6 spike: the page transfers each frame (`VideoFrame`, or `ImageBitmap` with `transfer=bitmap`) with a
 * result buffer from a small pool; the worker closes the frame and sends the buffer back filled (landmarks then
 * blendshapes, `RESULT_FLOATS` floats). One frame in flight at a time.
 */
import type { LiteRtOptions, StageTimings } from './litert-pipeline.ts'
import type { Roi } from './geometry.ts'

/** Floats of a result buffer: 478 × xyz landmarks, then 52 blendshape scores. */
export const RESULT_FLOATS = 478 * 3 + 52

export interface InitMessage {
  type: 'init'
  options: LiteRtOptions
}

export interface FrameMessage {
  type: 'frame'
  id: number
  /** Transferred; the worker closes it. */
  frame: VideoFrame | ImageBitmap
  width: number
  height: number
  /** Free result buffer (`RESULT_FLOATS` floats, transferred), sent back in the `result` message. */
  buffer: ArrayBuffer
}

export type ToWorker = InitMessage | FrameMessage | { type: 'reset' }

export interface ReadyMessage {
  type: 'ready'
  /** The pipeline actually created (after fallbacks). */
  description: string
  options: LiteRtOptions
  /** `crossOriginIsolated` inside the worker: wasm threads need it there too. */
  crossOriginIsolated: boolean
  /** Fallbacks taken in the worker (threads without isolation, no WebGL2 on OffscreenCanvas…). */
  warnings: string[]
}

export interface ResultMessage {
  type: 'result'
  id: number
  buffer: ArrayBuffer
  found: boolean
  presence: number
  roi: Roi | undefined
  timings: StageTimings
  /** Frame message received → result posted (ms, worker clock). */
  workerMs: number
  /** Pthreads the wasm runtime started so far (XNNPACK's thread pool), counted by the worker's `Worker` shim. */
  pthreads: number
}

export type FromWorker = ReadyMessage | ResultMessage | { type: 'error'; message: string; fatal: boolean }
