/** Version of the `@ouaf/core` package. */
export const VERSION = '0.1.0'

export * from './camera.ts'
export * from './video-source.ts'
export * from './scheduler.ts'
export * from './face.ts'
export * from './anchors.ts'
export * from './stats.ts'
export { createFaceTracker, type FaceTrackerOptions } from './face-tracker.ts'
export * from './viewport.ts'
export * from './renderer.ts'
export * from './perf-stats.ts'
export * from './perf-session.ts'
export * from './device-info.ts'

// The engine validates every manifest before loading it; expose the same validator to hosts.
export { validateManifest, formatIssues, type Issue } from '@ouaf/spec'
