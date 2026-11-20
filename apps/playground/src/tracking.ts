import type { FaceTracker } from '@ouaf/core'

/**
 * Creates the face tracker used by the playground, or `undefined` while tracking is not wired in.
 * Owned by issue #3 (MediaPipe FaceLandmarker).
 */
export async function createTracker(_options: { maxFaces: number }): Promise<FaceTracker | undefined> {
  return undefined
}
