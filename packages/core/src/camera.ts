import type { VideoSource } from './video-source.ts'

export type FacingMode = 'user' | 'environment'

export interface CameraOptions {
  /** Which camera to open. Default: `'user'` (front camera). Ignored when `deviceId` is set. */
  facingMode?: FacingMode
  /** Specific device (from `enumerateDevices()`); takes precedence over `facingMode`. */
  deviceId?: string
  /** Ideal capture width in pixels. Default: 1280. */
  width?: number
  /** Ideal capture height in pixels. Default: 720. */
  height?: number
  /** Ideal frame rate. Default: 30. */
  frameRate?: number
  /**
   * Mirror the image. Default: `'auto'` — mirrored for front cameras and for cameras that do not report their
   * facing mode (desktop webcams), not mirrored for rear cameras.
   */
  mirror?: boolean | 'auto'
  /** Video element to render the stream into. Default: a new, detached element. */
  video?: HTMLVideoElement
}

export type CameraErrorCode =
  | 'not-supported' // no getUserMedia in this browser
  | 'insecure-context' // page not served over HTTPS / localhost
  | 'permission-denied' // the user or a permissions policy refused access
  | 'not-found' // no camera matches the request
  | 'in-use' // the camera exists but cannot be read (used by another app, hardware error)
  | 'overconstrained' // no camera satisfies the required constraints
  | 'aborted' // the request was interrupted
  | 'unknown'

/** Error raised when the camera cannot be opened. `code` is stable and can be used to pick a message. */
export class CameraError extends Error {
  override readonly name = 'CameraError'
  readonly code: CameraErrorCode

  constructor(code: CameraErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}

const DOM_ERRORS: Record<string, [CameraErrorCode, string]> = {
  NotAllowedError: ['permission-denied', 'Camera access was denied.'],
  PermissionDeniedError: ['permission-denied', 'Camera access was denied.'],
  SecurityError: ['permission-denied', 'Camera access is blocked by the page security settings.'],
  NotFoundError: ['not-found', 'No camera was found.'],
  DevicesNotFoundError: ['not-found', 'No camera was found.'],
  NotReadableError: ['in-use', 'The camera could not be started; it may be in use by another application.'],
  TrackStartError: ['in-use', 'The camera could not be started; it may be in use by another application.'],
  OverconstrainedError: ['overconstrained', 'No camera satisfies the requested constraints.'],
  ConstraintNotSatisfiedError: ['overconstrained', 'No camera satisfies the requested constraints.'],
  AbortError: ['aborted', 'Opening the camera was interrupted.'],
}

/** Converts any error thrown while opening the camera into a `CameraError`. */
export function toCameraError(err: unknown): CameraError {
  if (err instanceof CameraError) return err
  const name = err instanceof Error || (typeof err === 'object' && err !== null && 'name' in err) ? String((err as { name: unknown }).name) : ''
  const known = DOM_ERRORS[name]
  if (known) return new CameraError(known[0], known[1], { cause: err })
  const detail = err instanceof Error ? err.message : String(err)
  return new CameraError('unknown', `The camera could not be opened: ${detail}`, { cause: err })
}

/** Builds the `getUserMedia` video constraints. Constraints are `ideal` so any camera still opens. */
export function videoConstraints(options: CameraOptions = {}): MediaTrackConstraints {
  const c: MediaTrackConstraints = {
    width: { ideal: options.width ?? 1280 },
    height: { ideal: options.height ?? 720 },
    frameRate: { ideal: options.frameRate ?? 30 },
  }
  if (options.deviceId) c.deviceId = { exact: options.deviceId }
  else c.facingMode = { ideal: options.facingMode ?? 'user' }
  return c
}

/**
 * Whether the image must be mirrored. The reported facing mode wins over the requested one; a camera that reports
 * nothing (most desktop webcams) faces the user.
 */
export function resolveMirror(mirror: CameraOptions['mirror'], reported: string | undefined): boolean {
  if (typeof mirror === 'boolean') return mirror
  return reported !== 'environment'
}

/** A live camera stream played into a `<video>` element, ready to be scheduled and rendered. */
export class CameraSource implements VideoSource {
  readonly video: HTMLVideoElement
  readonly stream: MediaStream
  /** True when the engine must display and capture the image mirrored (front camera). */
  readonly mirrored: boolean
  /** Facing mode reported by the camera, when it reports one. */
  readonly facingMode: FacingMode | undefined
  #disposed = false

  private constructor(video: HTMLVideoElement, stream: MediaStream, mirrored: boolean, facingMode: FacingMode | undefined) {
    this.video = video
    this.stream = stream
    this.mirrored = mirrored
    this.facingMode = facingMode
  }

  /**
   * Opens a camera and starts playing it. Must be called from a secure context; on iOS, call it from a user
   * gesture the first time. Rejects with a `CameraError`.
   */
  static async open(options: CameraOptions = {}): Promise<CameraSource> {
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      throw new CameraError('insecure-context', 'The camera is only available on pages served over HTTPS (or localhost).')
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('not-supported', 'This browser does not support camera access (getUserMedia).')
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(options), audio: false })
    } catch (err) {
      throw toCameraError(err)
    }

    const video = options.video ?? document.createElement('video')
    // iOS Safari: without `playsinline` the video goes fullscreen; without `muted` autoplay is refused.
    video.playsInline = true
    video.muted = true
    video.autoplay = true
    video.setAttribute('playsinline', '')
    video.srcObject = stream

    try {
      await video.play()
    } catch (err) {
      for (const track of stream.getTracks()) track.stop()
      video.srcObject = null
      throw toCameraError(err)
    }

    const settings = stream.getVideoTracks()[0]?.getSettings() ?? {}
    const reported = settings.facingMode === 'user' || settings.facingMode === 'environment' ? settings.facingMode : undefined
    return new CameraSource(video, stream, resolveMirror(options.mirror, reported), reported)
  }

  /** Current frame size (changes when a phone rotates). */
  get width(): number {
    return this.video.videoWidth
  }

  get height(): number {
    return this.video.videoHeight
  }

  get disposed(): boolean {
    return this.#disposed
  }

  /**
   * Releases the camera (its indicator light turns off) and detaches the stream from the video element.
   * Idempotent. A disposed source cannot be restarted: open a new one.
   */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const track of this.stream.getTracks()) track.stop()
    this.video.pause()
    this.video.srcObject = null
  }
}
