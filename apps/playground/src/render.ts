import { Renderer, type CameraSource, type FaceFrame, type FitMode } from '@ouaf/core'
import { createSyntheticFace } from './debug-face.ts'

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
 * Creates the WebGL2 renderer for a camera (video background + landmark debug layer), or `undefined` when
 * WebGL2 is unavailable (the raw video is shown instead).
 *
 * URL parameters, for testing:
 * - `fit=contain` — letterbox instead of the default `cover` crop;
 * - `res=WIDTHxHEIGHT` — fixed internal resolution (e.g. `res=720x1280`), otherwise it follows the video;
 * - `scale=0.5` — internal resolution relative to the video, when `res` is not set;
 * - `debug-face` — draw a synthetic face while no face is tracked (see `debug-face.ts`).
 */
export function createRenderer(camera: CameraSource, options: { maxFaces: number }): PlaygroundRenderer | undefined {
  const params = new URLSearchParams(location.search)
  const fit: FitMode = params.get('fit') === 'contain' ? 'contain' : 'cover'
  const res = /^(\d+)x(\d+)$/.exec(params.get('res') ?? '')
  const scale = Number(params.get('scale')) || 1
  const synthetic = params.has('debug-face') ? createSyntheticFace() : undefined

  let renderer: Renderer
  try {
    renderer = new Renderer({
      video: camera.video,
      mirrored: camera.mirrored,
      maxFaces: options.maxFaces,
      fit,
      scale,
      ...(res ? { width: Number(res[1]), height: Number(res[2]) } : {}),
      debugLandmarks: true,
    })
  } catch (err) {
    console.error('[playground] WebGL2 renderer unavailable, showing the raw video:', err)
    return undefined
  }

  return {
    element: renderer.canvas,
    get width() {
      return renderer.width
    },
    get height() {
      return renderer.height
    },
    render(faces) {
      renderer.render(synthetic && faces.count === 0 ? synthetic : faces)
    },
    dispose() {
      renderer.dispose()
      renderer.canvas.remove()
    },
  }
}
