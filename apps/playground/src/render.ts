import type { CameraSource, FaceFrame } from '@ouaf/core'

export interface PlaygroundRenderer {
  /** Element to show instead of the raw `<video>`. */
  readonly element: HTMLElement
  /** Internal render resolution. */
  readonly width: number
  readonly height: number
  /** Draws the current video frame and the debug overlay for `faces`. */
  render(faces: FaceFrame): void
  dispose(): void
}

/**
 * Creates the renderer for a camera, or `undefined` while rendering is not wired in (the raw video is shown).
 * Owned by issue #4 (three.js WebGL2 renderer).
 */
export function createRenderer(_camera: CameraSource): PlaygroundRenderer | undefined {
  return undefined
}
