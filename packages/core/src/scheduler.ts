/** A new video frame, as seen by the processing callback. */
export interface VideoFrameInfo {
  /** Time at which the frame is processed (`performance.now()` clock, ms). */
  now: number
  /** Media time of the frame (s). For a file source this is the position in the file. */
  mediaTime: number
  /** Frame size in pixels. */
  width: number
  height: number
  /**
   * When the camera captured the frame (`performance.now()` clock, ms), from the `requestVideoFrameCallback`
   * metadata when the browser provides it (local cameras in Chromium); `undefined` otherwise.
   */
  captureTime?: number | undefined
  /**
   * Frames the browser has presented for composition since the video started (`requestVideoFrameCallback`
   * metadata); a jump of more than 1 between two callbacks means camera frames went by without a callback (the main
   * thread was busy). `undefined` in `animation-frame` mode.
   */
  presentedFrames?: number | undefined
}

export type FrameCallback = (frame: VideoFrameInfo) => void

export type SchedulerMode = 'video-frame' | 'animation-frame'

export interface FrameSchedulerOptions {
  /**
   * `'auto'` (default) uses `requestVideoFrameCallback` when the browser has it, `requestAnimationFrame` otherwise.
   */
  mode?: SchedulerMode | 'auto'
  /** Called when the callback throws; scheduling continues. Default: `console.error`. */
  onError?: (err: unknown) => void
}

/** Minimum `readyState` for a frame to be available (`HAVE_CURRENT_DATA`). */
const HAVE_CURRENT_DATA = 2

export function hasVideoFrameCallback(video: HTMLVideoElement): boolean {
  return typeof video.requestVideoFrameCallback === 'function'
}

/**
 * Calls `callback` once per **new** video frame, and never for a frame that was already processed.
 *
 * - `video-frame` mode relies on `requestVideoFrameCallback`, which fires exactly when the browser presents a new
 *   frame: a 30 fps camera on a 120 Hz screen triggers 30 calls per second, not 120.
 * - `animation-frame` mode (browsers without `requestVideoFrameCallback`) polls every display frame and skips the
 *   frame when the video's `currentTime` has not moved.
 *
 * Frames that arrive while the callback is still running are dropped by the browser, not queued.
 */
export class FrameScheduler {
  readonly video: HTMLVideoElement
  readonly mode: SchedulerMode
  #callback: FrameCallback | undefined
  #onError: (err: unknown) => void
  #handle: number | undefined
  #running = false
  #lastMediaTime = -1

  constructor(video: HTMLVideoElement, callback: FrameCallback, options: FrameSchedulerOptions = {}) {
    this.video = video
    this.#callback = callback
    this.#onError = options.onError ?? ((err) => console.error('[ouaf] frame callback failed:', err))
    const mode = options.mode ?? 'auto'
    if (mode === 'video-frame' && !hasVideoFrameCallback(video)) {
      throw new Error('requestVideoFrameCallback is not supported by this browser.')
    }
    this.mode = mode === 'auto' ? (hasVideoFrameCallback(video) ? 'video-frame' : 'animation-frame') : mode
  }

  get running(): boolean {
    return this.#running
  }

  /** Starts (or resumes) scheduling. No-op when already running. */
  start(): void {
    if (this.#running) return
    if (!this.#callback) throw new Error('The frame scheduler has been disposed.')
    this.#running = true
    this.#request()
  }

  /** Stops scheduling; `start()` resumes it. No frame is processed after `stop()` returns. */
  stop(): void {
    if (!this.#running) return
    this.#running = false
    if (this.#handle !== undefined) {
      if (this.mode === 'video-frame') this.video.cancelVideoFrameCallback(this.#handle)
      else cancelAnimationFrame(this.#handle)
      this.#handle = undefined
    }
  }

  /** Stops scheduling and releases the callback. Idempotent; the scheduler cannot be restarted. */
  dispose(): void {
    this.stop()
    this.#callback = undefined
  }

  #request(): void {
    this.#handle =
      this.mode === 'video-frame'
        ? this.video.requestVideoFrameCallback(this.#onVideoFrame)
        : requestAnimationFrame(this.#onAnimationFrame)
  }

  #onVideoFrame = (now: number, meta: VideoFrameCallbackMetadata): void => {
    this.#handle = undefined
    if (!this.#running) return
    this.#emit({ now, mediaTime: meta.mediaTime, width: meta.width, height: meta.height, captureTime: meta.captureTime, presentedFrames: meta.presentedFrames })
  }

  #onAnimationFrame = (now: number): void => {
    this.#handle = undefined
    if (!this.#running) return
    const v = this.video
    if (v.readyState >= HAVE_CURRENT_DATA && v.currentTime !== this.#lastMediaTime) {
      this.#emit({ now, mediaTime: v.currentTime, width: v.videoWidth, height: v.videoHeight })
    } else {
      this.#request()
    }
  }

  #emit(frame: VideoFrameInfo): void {
    this.#lastMediaTime = frame.mediaTime
    try {
      this.#callback?.(frame)
    } catch (err) {
      this.#onError(err)
    }
    // The callback may have stopped (or stopped and restarted) the scheduler.
    if (this.#running && this.#handle === undefined) this.#request()
  }
}
