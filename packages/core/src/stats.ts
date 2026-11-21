import type { Delegate } from './face.ts'

/**
 * Per-frame timing sample, filled in by the pipeline (scheduler → tracking → render) and consumed by the
 * performance overlay and recorder (#5). The pipeline reuses one object: consumers must copy what they keep.
 */
export interface FrameSample {
  /** Time the frame was processed (`performance.now()` clock, ms), from the scheduler. */
  now: number
  /** Media time of the frame (s). */
  mediaTime: number
  /** Time spent in `FaceTracker.detect` (ms). */
  trackingMs: number
  /** Time spent rendering the frame (ms). */
  renderMs: number
  /** Faces detected in the frame. */
  faces: number
  /**
   * Values of the recorder's extra columns (`SessionRecorderOptions.extraColumns`), in the same order; `NaN`
   * when a value does not apply to this frame. Optional: pipelines without extra columns leave it undefined.
   */
  extra?: ArrayLike<number>
}

export function createFrameSample(): FrameSample {
  return { now: 0, mediaTime: 0, trackingMs: 0, renderMs: 0, faces: 0 }
}

/** Slow-changing context reported alongside the samples. */
export interface PipelineInfo {
  delegate: Delegate | undefined
  /** Camera resolution and requested frame rate. */
  videoWidth: number
  videoHeight: number
  /** Internal render resolution. */
  renderWidth: number
  renderHeight: number
  maxFaces: number
}

/** Anything that consumes frame samples (overlay, recorder). */
export interface FrameSampleSink {
  record(sample: Readonly<FrameSample>): void
}
