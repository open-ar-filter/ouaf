/**
 * What `ouaf preview` (Node) and its page (the headless browser, `page.ts`) exchange: one job per reference input,
 * one result back. Plain JSON data only (it goes through Playwright's `page.evaluate`).
 */

/** The frames a job renders: frames of a clip, or a still image repeated. */
export type PreviewFrames =
  /** Every frame of the clip from `from` to `time` (media time, s), in order; the last one is the screenshot. */
  | { kind: 'video'; url: string; from: number; time: number }
  /** The image given `frames` times, 1/30 s apart (tracking and smoothing settle); the last one is the screenshot. */
  | { kind: 'image'; url: string; frames: number }

/**
 * Expression signals whose peak a result reports, and the events they drive (spec §13): the blendshape, or the mean
 * or minimum of two, that the engine compares with the event's threshold.
 */
export const SIGNAL_OF_EVENT = {
  blink: 'eyeBlink',
  mouthOpen: 'jawOpen',
  smile: 'mouthSmile',
  eyebrowRaise: 'browInnerUp',
  kiss: 'mouthPucker',
} as const

export type PreviewSignal = (typeof SIGNAL_OF_EVENT)[keyof typeof SIGNAL_OF_EVENT]

/** An event delivered to a filter of the stack (`handle.on('expression')`). */
export interface PreviewEvent {
  /** Id of the filter. */
  filter: string
  /** `faceEnter`, `mouthOpen`, `wink`… */
  name: string
  /** Media time of the frame it fired on (s). */
  time: number
  /** Stable id of the face (spec §5.4). */
  face: number
  /** `wink` only. */
  side?: 'left' | 'right'
}

/** The highest value of a signal over the frames rendered, on any face. */
export interface PreviewPeak {
  peak: number
  /** Media time of the frame (s). */
  time: number
}

export interface PreviewJob {
  /** URLs of the packages (`.ouaf`) on the preview origin, bottom of the stack first. */
  filters: string[]
  /** Parameter values of each filter (`--param`), as the host gives them at load: index of `filters`. */
  params?: Array<Record<string, unknown>>
  frames: PreviewFrames
  maxFaces: number
  /** Seed of random choices (spec §12.5); the engine's fixed file-source seed when undefined. */
  seed?: number
  /** The screenshot is scaled down (never up) so that its longer side is at most this many pixels. */
  maxSize?: number
}

/** Distribution of a per-frame measure (ms). */
export interface PreviewTiming {
  mean: number
  p50: number
  p95: number
  max: number
}

export interface PreviewPageResult {
  /** The screenshot, PNG, base64. */
  png: string
  width: number
  height: number
  /** SHA-256 (hex) of the screenshot's RGBA pixels: equal hashes, identical images. */
  pixelsSha256: string
  /** Share of the pixels that differ clearly (more than 24/255 on a channel) from the same frame without filter. */
  changed: number
  /** Faces tracked on the screenshot: those its face layers are drawn for (`engine.faceCount`). */
  faces: number
  /** Frames rendered (pushed to the engine), the settling frames included. */
  framesRendered: number
  /** Media time of the screenshot frame (s). */
  time: number
  /** Ids of the filters as loaded, bottom first. */
  filters: string[]
  /** Events delivered to the filters, in order (pair events not included). */
  events: PreviewEvent[]
  /**
   * Peak of each signal of `SIGNAL_OF_EVENT` over the frames rendered, from the blendshapes of the tracking results;
   * empty when no face was tracked. `eyeBlink` is the less closed eye (both close for a blink); the engine may
   * also derive it from the eyelids, so a blink can fire slightly below it.
   */
  signals: Partial<Record<PreviewSignal, PreviewPeak>>
  /** Engine warnings (`engine.on('warning')`, the filters' load warnings) and errors (`engine.on('error')`). */
  warnings: string[]
  errors: string[]
  perf: {
    /** Time to load the filters (`addFilter`, assets included), ms. */
    loadMs: number
    /** Wall time of the first frame, ms: it includes starting the tracker (loading the model, warm-up). */
    firstFrameMs: number
    /** Wall time of each later frame: tracking (the frame waits for its own result), update and render, ms. */
    frameMs: PreviewTiming
    /** The engine's own time per frame (params, layer updates, render submission) from its last `stats` event. */
    engineFrameMs: number | null
    /**
     * Tracker backend (`MediaPipe GPU, main thread`…), from the engine's last `stats` event; `null` (as
     * `engineFrameMs`) when the run was shorter than the 1 s period of that event.
     */
    tracker: string | null
    /** Internal render size (px). */
    renderWidth: number
    renderHeight: number
    /** `WEBGL_debug_renderer_info` of the page's WebGL2 context: SwiftShader or the GPU used. */
    renderer: string | null
  }
}

/** A filter could not be loaded or a frame failed: reported, exit code 1. */
export interface PreviewPageFailure {
  error: string
  warnings: string[]
  errors: string[]
}

export type PreviewPageOutcome = ({ ok: true } & PreviewPageResult) | ({ ok: false } & PreviewPageFailure)

declare global {
  interface Window {
    /** Set by `page.ts` once loaded. */
    ouafPreview?: { render(job: PreviewJob): Promise<PreviewPageOutcome> }
  }
}
