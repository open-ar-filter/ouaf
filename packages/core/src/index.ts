/** Version of the `@ouaf/core` package. */
export const VERSION = '0.1.0'

export * from './camera.ts'
export * from './video-source.ts'
export * from './offline-video.ts'
export { demuxMp4, Mp4Error, type Mp4Sample, type Mp4VideoTrack } from './mp4.ts'
export { isFrameImage, type FrameImage } from './frame-image.ts'
export { SeededRandom, deriveSeed } from './random.ts'
export * from './scheduler.ts'
export * from './face.ts'
export * from './anchors.ts'
export * from './stats.ts'
export { createFaceTracker, type FaceTrackerOptions, type WasmLoader } from './face-tracker.ts'
export * from './face-frame-buffer.ts'
export { createLiteRtFaceTracker, LiteRtFrameTracker, type FrameTransfer, type LiteRtTrackerOptions } from './litert/tracker.ts'
export * from './viewport.ts'
export * from './renderer.ts'
export * from './perf-stats.ts'
export * from './perf-session.ts'
export * from './device-info.ts'

// The engine validates every manifest before loading it; expose the same validator to hosts.
export { validateManifest, formatIssues, type Issue } from '@ouaf/spec'

// Engine (#11, #12, #17)
export * from './engine/index.ts'
export * from './params/index.ts'
export * from './bindings/index.ts'
export * from './anchoring/index.ts'
export * from './expressions/index.ts'

// Layer types (#19–#25), each a built-in plugin
export * from './layers/color/index.ts'
export * from './layers/shader/index.ts'
export * from './layers/sticker/index.ts'
export * from './layers/model/index.ts'
