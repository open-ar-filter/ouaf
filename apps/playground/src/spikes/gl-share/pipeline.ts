import type { Delegate } from '@ouaf/core'

/** `?path=` variants of the spike page. */
export type MaskPath = 'shared' | 'cpu' | 'webgpu'
/** `?reset=`: when three's GL state cache is reset around MediaPipe on the shared context. */
export type ResetMode = 'both' | 'after' | 'none'
/** `?copy=` (webgpu path): how the WebGL mask reaches the WebGPU device. */
export type CopyMode = 'canvas' | 'readback'
/** `?effect=`: what is done to the background behind the person. */
export type Effect = 'blur' | 'tint'
/** `?view=`: composite, or the mask alone (alignment check by eye). */
export type View = 'composite' | 'mask'

export interface SpikeOptions {
  path: MaskPath
  delegate: Delegate
  reset: ResetMode
  copy: CopyMode
  effect: Effect
  view: View
  /** `?face=`: also run a FaceLandmarker, on its own context or on the shared canvas (bonus). */
  face: 'off' | 'own' | 'shared'
  /** `?gpu=low-power|high-performance`: WebGPU adapter power preference (dual-GPU machines). Default: browser's. */
  powerPreference: GPUPowerPreference | undefined
  /** `?flip=0|1`: forces the vertical orientation of the GPU mask instead of the built-in one. */
  maskFlipY: boolean | undefined
}

/** Per-frame timings filled in by a pipeline (ms; `NaN` when a step does not exist on that path). */
export interface FrameTimings {
  trackingMs: number
  faces: number
  segmentationMs: number
  transferMs: number
  uploadMs: number
  renderMs: number
}

export function resetTimings(t: FrameTimings): void {
  t.trackingMs = NaN
  t.faces = 0
  t.segmentationMs = NaN
  t.transferMs = NaN
  t.uploadMs = NaN
  t.renderMs = NaN
}

/** One variant: segmentation → mask transfer → three render, for one camera frame. */
export interface MaskPipeline {
  /** Canvas to display. */
  readonly canvas: HTMLCanvasElement
  readonly renderWidth: number
  readonly renderHeight: number
  /** Mask size of the last frame (0 until the first mask). */
  readonly maskWidth: number
  readonly maskHeight: number
  /** Variant details for the export's `app` and the page. */
  details(): Record<string, string | number | boolean>
  /** Processes one camera frame and fills `out`. */
  frame(video: HTMLVideoElement, timestampMs: number, out: FrameTimings): void
  /**
   * Alignment / orientation check, run on the next frame: compares the mask as the renderer sees it on the GPU
   * with MediaPipe's own CPU copy (`getAsFloat32Array`, top row first). Performs readbacks: one-off, never per frame.
   */
  check(): Promise<string>
  dispose(): void
}

/**
 * Compares a GPU mask read back row by row (`rows(y)` returns row `y` as stored in the texture, `y = 0` first)
 * with MediaPipe's CPU mask (`ref`, row 0 = top of the image). Returns which storage order matches.
 */
export function compareOrientation(
  width: number,
  height: number,
  ref: Float32Array,
  gpuAt: (x: number, y: number) => number,
): { direct: number; flipped: number; orientation: 'top-first' | 'bottom-first' | 'unclear' } {
  let direct = 0
  let flipped = 0
  let n = 0
  // Sub-sampled: a few thousand points are enough to tell the orientation and the error.
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 4096)))
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const g = gpuAt(x, y)
      direct += Math.abs(g - (ref[y * width + x] ?? 0))
      flipped += Math.abs(g - (ref[(height - 1 - y) * width + x] ?? 0))
      n++
    }
  }
  direct /= n
  flipped /= n
  const orientation = direct < 0.02 && direct < flipped ? 'top-first' : flipped < 0.02 && flipped < direct ? 'bottom-first' : 'unclear'
  return { direct, flipped, orientation }
}

/** Mean of a mask, to tell an empty (no person) mask from a mismatch in the check report. */
export function meanOf(a: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] as number
  return a.length ? s / a.length : 0
}
