import {
  FaceLandmarker,
  FilesetResolver,
  ImageSegmenter,
  MPMask,
  type ImageSegmenterResult,
} from '@mediapipe/tasks-vision'
import type { Delegate } from '@ouaf/core'
import type { Probe } from './probe.ts'

/** Self-hosted assets (vite.config.ts), relative to the spike page in `spikes/`. */
const WASM_URL = '../mediapipe/wasm'
const SEGMENTER_URL = '../models/selfie_segmenter.tflite'
const FACE_URL = '../models/face_landmarker.task'

export type { ImageSegmenter, ImageSegmenterResult, MPMask }

async function fetchModel(url: string): Promise<Uint8Array> {
  const href = new URL(url, document.baseURI).href
  const res = await fetch(href)
  if (!res.ok || res.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`Could not download ${href} (HTTP ${res.status}) — run \`npm run fetch-models\``)
  }
  return new Uint8Array(await res.arrayBuffer())
}

let fileset: ReturnType<typeof FilesetResolver.forVisionTasks> | undefined
function getFileset() {
  return (fileset ??= FilesetResolver.forVisionTasks(new URL(WASM_URL, document.baseURI).href))
}

/**
 * MediaPipe resizes the canvas it was given to every input frame (`GraphRunner.setAutoResizeCanvas`, on by
 * default). On a canvas shared with the renderer this would change the drawing buffer behind three's back (and
 * clear it). The switch is not exposed by the tasks API: it lives on the task's graph runner, a minified private
 * field, found here by duck typing. Returns whether it was found (pinned `@mediapipe/tasks-vision` 1.2.3).
 */
export function disableAutoResizeCanvas(task: object): boolean {
  for (const value of Object.values(task)) {
    if (value && typeof value === 'object' && typeof (value as { setAutoResizeCanvas?: unknown }).setAutoResizeCanvas === 'function') {
      ;(value as { setAutoResizeCanvas(on: boolean): void }).setAutoResizeCanvas(false)
      return true
    }
  }
  return false
}

export interface SegmenterOptions {
  /**
   * Canvas whose WebGL2 context MediaPipe uses. When it already has one (three's), MediaPipe's `getContext`
   * returns that same context: one shared context. Default: MediaPipe creates its own (an `OffscreenCanvas`).
   */
  canvas?: HTMLCanvasElement | OffscreenCanvas
  delegate: Delegate
  probe: Probe
}

export interface Segmenter {
  readonly task: ImageSegmenter
  readonly delegate: Delegate
  /** Whether `disableAutoResizeCanvas` applied (only attempted with a caller-provided canvas). */
  readonly autoResizeDisabled: boolean
  /**
   * Runs the selfie segmenter on a video frame; `onMasks` receives the person confidence mask, valid only during
   * the callback (MediaPipe recycles it afterwards; no copy is made). Timestamps are made strictly increasing.
   */
  segment(video: HTMLVideoElement, timestampMs: number, onMask: (mask: MPMask) => void): void
  close(): void
}

/** Creates the selfie segmenter (VIDEO mode, one confidence mask: the person). */
export async function createSegmenter(options: SegmenterOptions): Promise<Segmenter> {
  const [files, model] = await Promise.all([getFileset(), fetchModel(SEGMENTER_URL)])
  options.probe.watchMasks(MPMask)
  const task = await ImageSegmenter.createFromOptions(files, {
    baseOptions: { modelAssetBuffer: model, delegate: options.delegate },
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
    ...(options.canvas ? { canvas: options.canvas } : {}),
  })
  const autoResizeDisabled = options.canvas ? disableAutoResizeCanvas(task) : false
  let last = -Infinity
  return {
    task,
    delegate: options.delegate,
    autoResizeDisabled,
    segment(video, timestampMs, onMask) {
      const ts = timestampMs > last ? timestampMs : last + 1
      last = ts
      // Callback form: the masks are handed over without the copy (`clone`) the returning form makes.
      task.segmentForVideo(video, ts, (result: ImageSegmenterResult) => {
        // selfie_segmenter has one output: the person confidence (0 = background, 1 = person).
        const mask = result.confidenceMasks?.[0]
        if (mask) onMask(mask)
      })
    },
    close() {
      task.close()
    },
  }
}

export interface FaceTask {
  readonly autoResizeDisabled: boolean
  /** Runs face tracking on the frame; returns the number of faces. */
  detect(video: HTMLVideoElement, timestampMs: number): number
  close(): void
}

/**
 * Bonus (#7): a FaceLandmarker (GPU delegate) on its own context, or on the shared canvas. Created directly with
 * MediaPipe here rather than through `@ouaf/core`, whose public API has no canvas option.
 */
export async function createFaceTask(canvas: HTMLCanvasElement | undefined): Promise<FaceTask> {
  const [files, model] = await Promise.all([getFileset(), fetchModel(FACE_URL)])
  const task = await FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetBuffer: model, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    ...(canvas ? { canvas } : {}),
  })
  const autoResizeDisabled = canvas ? disableAutoResizeCanvas(task) : false
  let last = -Infinity
  return {
    autoResizeDisabled,
    detect(video, timestampMs) {
      const ts = timestampMs > last ? timestampMs : last + 1
      last = ts
      return task.detectForVideo(video, ts).faceLandmarks.length
    },
    close() {
      task.close()
    },
  }
}
