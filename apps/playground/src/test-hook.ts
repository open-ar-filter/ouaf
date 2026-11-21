import { liveAnchorPosition, type FaceFrame, type LandmarkAnchor } from '@ouaf/core'

/**
 * Hooks for the browser tests (`?test`): counts what the pipeline produced and exposes it on `window.ouafTest`.
 * Not loaded otherwise.
 */
export interface OuafTestHook {
  /** Frames processed since the source started. */
  frames: number
  /** `faceCounts[n]` = number of frames with `n` faces. */
  faceCounts: number[]
  /** Frames with at least one face whose anchors are in anatomical order (see `anchorsInOrder`). */
  orderedFrames: number
  /** Live anchors of face 0 on the last frame with a face (normalized image coordinates, not mirrored). */
  lastAnchors: Partial<Record<LandmarkAnchor, { x: number; y: number }>> | null
  /** Error shown by the playground, if any. */
  error: string | null
  delegate: string | null
  /** 16×16 luminance (0–255) of the last rendered canvas, row-major, for mirroring checks. */
  thumbnail: number[]
  /** True once a non-looping source has played to its end. */
  readonly ended: boolean
  /** Pauses the video at `time` (s) and resolves once that frame has been processed and rendered. */
  seek(time: number): Promise<void>
  /**
   * Deterministic run (spec §12.5): resets the counters, then seeks through the whole file every `step` seconds,
   * processing each frame whatever the machine speed. Resolves when the end is reached.
   */
  runStepwise(step: number): Promise<void>
}

declare global {
  interface Window {
    ouafTest?: OuafTestHook
  }
}

const THUMB = 16
const p = { x: 0, y: 0, z: 0 }
const CHECKED: LandmarkAnchor[] = ['forehead', 'eyes', 'noseTip', 'mouth', 'chin', 'leftEye', 'rightEye']

/**
 * Forehead above the eyes, above the nose tip, above the mouth, above the chin, and the person's left eye on the
 * image's right (the image is not mirrored), for face `face`.
 */
export function anchorsInOrder(faces: Readonly<FaceFrame>, face: number): boolean {
  const y = (a: LandmarkAnchor) => liveAnchorPosition(faces, face, a, p).y
  const x = (a: LandmarkAnchor) => liveAnchorPosition(faces, face, a, p).x
  return y('forehead') < y('eyes') && y('eyes') < y('noseTip') && y('noseTip') < y('mouth') && y('mouth') < y('chin') && x('leftEye') > x('rightEye')
}

export function createTestHook(video: HTMLVideoElement): { afterFrame(faces: FaceFrame, mediaTime: number, canvas: HTMLCanvasElement | undefined): void; hook: OuafTestHook } {
  const thumbCanvas = document.createElement('canvas')
  thumbCanvas.width = thumbCanvas.height = THUMB
  const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true })
  let waiting: { time: number; resolve: () => void } | undefined

  const hook: OuafTestHook = {
    frames: 0,
    faceCounts: [],
    orderedFrames: 0,
    lastAnchors: null,
    error: null,
    delegate: null,
    thumbnail: [],
    get ended() {
      return video.ended
    },
    seek(time) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = undefined
          reject(new Error(`No frame processed after seeking to ${time}s`))
        }, 15_000)
        waiting = { time, resolve: () => (clearTimeout(timer), resolve()) }
        video.pause()
        video.currentTime = time
      })
    },
    async runStepwise(step) {
      video.pause()
      hook.frames = 0
      hook.faceCounts = []
      hook.orderedFrames = 0
      hook.lastAnchors = null
      // Stay a little before the end: seeking to `duration` may not present a new frame.
      for (let t = 0; t < video.duration - 0.05; t += step) await hook.seek(Math.round(t * 1000) / 1000)
    },
  }
  window.ouafTest = hook

  return {
    hook,
    afterFrame(faces, mediaTime, canvas) {
      hook.frames++
      hook.faceCounts[faces.count] = (hook.faceCounts[faces.count] ?? 0) + 1
      if (faces.count > 0) {
        if (anchorsInOrder(faces, 0)) hook.orderedFrames++
        const anchors: NonNullable<OuafTestHook['lastAnchors']> = {}
        for (const a of CHECKED) {
          liveAnchorPosition(faces, 0, a, p)
          anchors[a] = { x: p.x, y: p.y }
        }
        hook.lastAnchors = anchors
      }
      // The WebGL drawing buffer is still valid right after rendering, in the same task.
      if (canvas && thumbCtx) {
        thumbCtx.drawImage(canvas, 0, 0, THUMB, THUMB)
        const data = thumbCtx.getImageData(0, 0, THUMB, THUMB).data
        const luma: number[] = []
        for (let i = 0; i < data.length; i += 4) luma.push(Math.round(0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!))
        hook.thumbnail = luma
      }
      // Frames already in flight when seek() was called are ignored: wait for the requested one.
      // (`video.seeking` may still be true when the sought frame is presented.)
      if (waiting && Math.abs(mediaTime - waiting.time) < 0.05) {
        const { resolve } = waiting
        waiting = undefined
        resolve()
      }
    },
  }
}
