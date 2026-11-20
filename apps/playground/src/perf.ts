import type { FrameSampleSink, PipelineInfo } from '@ouaf/core'

export interface PlaygroundPerf extends FrameSampleSink {
  /** Element holding the overlay (fps, timings, recorder controls). */
  readonly element: HTMLElement
  setInfo(info: PipelineInfo): void
  dispose(): void
}

/**
 * Creates the performance overlay and recorder, or `undefined` while it is not wired in.
 * Owned by issue #5 (performance overlay and sustained recording).
 */
export function createPerf(): PlaygroundPerf | undefined {
  return undefined
}
