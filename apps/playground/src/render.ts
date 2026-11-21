import { Renderer, type FaceFrame, type FitMode, type VideoSource } from '@ouaf/core'
import { createAnchorsOverlay } from './anchors-overlay.ts'
import { createSyntheticFace } from './debug-face.ts'

export interface PlaygroundRenderer {
  /** Element to show instead of the raw `<video>`. */
  readonly element: HTMLElement
  /** The WebGL canvas (for test snapshots). */
  readonly canvas: HTMLCanvasElement
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
 * - `debug-face` — draw a synthetic face while no face is tracked (see `debug-face.ts`);
 * - `anchors=0` — hide the labelled anchors overlay (#10), shown by default.
 */
export function createRenderer(camera: VideoSource, options: { maxFaces: number }): PlaygroundRenderer | undefined {
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

  const anchors = params.get('anchors') === '0' ? undefined : createAnchorsOverlay()
  const element = document.createElement('div')
  element.className = 'view'
  element.append(renderer.canvas)
  if (anchors) element.append(anchors.element)

  return {
    element,
    canvas: renderer.canvas,
    get width() {
      return renderer.width
    },
    get height() {
      return renderer.height
    },
    render(faces) {
      const shown = synthetic && faces.count === 0 ? synthetic : faces
      renderer.render(shown)
      anchors?.draw(shown, renderer)
    },
    dispose() {
      renderer.dispose()
      anchors?.dispose()
      element.remove()
    },
  }
}
