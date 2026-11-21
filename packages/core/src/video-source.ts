/**
 * Anything that plays frames into a `<video>` element the engine can schedule, track and render: a live camera
 * (`CameraSource`) or a video file (`VideoFileSource`).
 */
export interface VideoSource {
  readonly video: HTMLVideoElement
  /** True when the image must be displayed and captured mirrored (front camera). */
  readonly mirrored: boolean
  /** Current frame size in pixels. */
  readonly width: number
  readonly height: number
  readonly disposed: boolean
  /** Stops the source and releases its resources. Idempotent. */
  dispose(): void
}

export interface VideoFileOptions {
  /** Loop the video. Default: true. */
  loop?: boolean
  /** Mirror the image. Default: false (a file is shown as recorded). */
  mirror?: boolean
  /** Playback rate. Default: 1. */
  playbackRate?: number
  /** Start time in seconds. Default: 0. */
  startTime?: number
  /** Video element to play into. Default: a new, detached element. */
  video?: HTMLVideoElement
}

/** Error raised when a video file cannot be loaded or played. */
export class VideoFileError extends Error {
  override readonly name = 'VideoFileError'
  readonly url: string

  constructor(url: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.url = url
  }
}

const MEDIA_ERRORS: Record<number, string> = {
  1: 'loading was aborted',
  2: 'a network error occurred',
  3: 'the video could not be decoded',
  4: 'the format is not supported or the file was not found',
}

/**
 * A video file played into a `<video>` element, muted and inline, usable wherever a camera is (tests, demos,
 * device measurements on a fixed input). With a file source `FrameInfo.mediaTime` is the position in the file
 * (spec §12.5).
 */
export class VideoFileSource implements VideoSource {
  readonly video: HTMLVideoElement
  readonly url: string
  readonly mirrored: boolean
  #disposed = false

  private constructor(video: HTMLVideoElement, url: string, mirrored: boolean) {
    this.video = video
    this.url = url
    this.mirrored = mirrored
  }

  /** Loads `url` and starts playing it. Rejects with a `VideoFileError`. */
  static async open(url: string, options: VideoFileOptions = {}): Promise<VideoFileSource> {
    const video = options.video ?? document.createElement('video')
    video.playsInline = true
    video.muted = true
    video.autoplay = true
    video.setAttribute('playsinline', '')
    video.loop = options.loop ?? true
    video.playbackRate = options.playbackRate ?? 1
    video.srcObject = null
    video.src = url

    try {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          video.removeEventListener('loadeddata', onLoaded)
          video.removeEventListener('error', onError)
        }
        const onLoaded = () => (done(), resolve())
        const onError = () => {
          done()
          const code = video.error?.code ?? 0
          reject(new VideoFileError(url, `Cannot load ${url}: ${MEDIA_ERRORS[code] ?? 'unknown error'}.`))
        }
        video.addEventListener('loadeddata', onLoaded)
        video.addEventListener('error', onError)
        video.load()
      })
      if (options.startTime) video.currentTime = options.startTime
      await video.play()
    } catch (err) {
      video.removeAttribute('src')
      video.load()
      if (err instanceof VideoFileError) throw err
      throw new VideoFileError(url, `Cannot play ${url}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }
    return new VideoFileSource(video, url, options.mirror ?? false)
  }

  get width(): number {
    return this.video.videoWidth
  }

  get height(): number {
    return this.video.videoHeight
  }

  get disposed(): boolean {
    return this.#disposed
  }

  /** Stops playback and unloads the file. Idempotent. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
  }
}
