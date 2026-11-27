/**
 * `engine.record()` on WebCodecs (#137): each frame captured goes through a `FrameEncoder`, timed by the clock (a
 * recording is real time), into an MP4 that has its duration and index from the start: it plays and seeks at once,
 * unlike the WebM of Chrome's `MediaRecorder`. Video only; `Outputs.record` keeps `MediaRecorder` for audio, an
 * explicit `mimeType`, browsers without WebCodecs, and falls back to it when no codec can encode the size.
 *
 * Live: a frame is dropped when the encoder has a few queued (a slow device records fewer frames, at their real
 * times); frames closer than `1 / frameRate` to the previous one are skipped.
 */
import type { CaptureCanvas, Recording } from './outputs.ts'
import { OuafError } from './errors.ts'
import { FrameEncoder, mp4MimeType, type FrameEncoderEnv, type VideoEncodingOptions } from './frame-encoder.ts'

export interface EncodedRecordingOptions extends VideoEncodingOptions {
  /** Maximum frame rate. Default: every frame captured. */
  frameRate?: number
}

export interface EncodedRecordingEnv extends Partial<FrameEncoderEnv> {
  /** Clock in ms (default `performance.now`). */
  now?: () => number
  /** A 2D canvas to scale frames into when the capture size changes during the recording; none: frames are cropped. */
  createCanvas?: () => CaptureCanvas
}

export class EncodedRecording implements Recording {
  readonly done: Promise<Blob>
  readonly #options: EncodedRecordingOptions
  readonly #env: EncodedRecordingEnv
  readonly #now: () => number
  readonly #fallback: () => Recording
  readonly #ended: () => void
  #settle!: { resolve(blob: Blob): void; reject(error: unknown): void }
  #state: 'recording' | 'paused' | 'inactive' = 'recording'
  #encoder: FrameEncoder | undefined
  #starting: Promise<void> | undefined
  /** The `MediaRecorder` recording used when no encoder could start. */
  #media: Recording | undefined
  /** Clock time (ms) of the first frame, and the time spent paused since. */
  #t0 = Number.NaN
  #paused = 0
  #pauseStart = 0
  #last = Number.NEGATIVE_INFINITY
  #scale: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | undefined
  #stopping: Promise<Blob> | undefined

  /**
   * `fallback` starts a `MediaRecorder` recording (it may throw); `ended` is called when the recording stops taking
   * frames (it may be called twice).
   */
  constructor(options: EncodedRecordingOptions, env: EncodedRecordingEnv, fallback: () => Recording, ended: () => void) {
    this.#options = options
    this.#env = env
    this.#now = env.now ?? (() => performance.now())
    this.#fallback = fallback
    this.#ended = ended
    this.done = new Promise<Blob>((resolve, reject) => (this.#settle = { resolve, reject }))
    // A host that awaits `stop()` only must not get an unhandled rejection from `done` as well.
    this.done.catch(() => {})
  }

  get mimeType(): string {
    if (this.#media) return this.#media.mimeType
    return this.#encoder ? mp4MimeType(this.#encoder.codec) : 'video/mp4'
  }

  get state(): 'recording' | 'paused' | 'inactive' {
    return this.#media?.state ?? this.#state
  }

  /** The capture surface after a frame was drawn into it. */
  frame(surface: CaptureCanvas): void {
    if (this.#state !== 'recording' || this.#media) return
    const encoder = this.#encoder
    if (!encoder) {
      // Sized from the first frame captured; frames until the encoder is ready are not recorded.
      this.#starting ??= this.#start(surface.width, surface.height)
      return
    }
    const now = this.#now()
    if (Number.isNaN(this.#t0)) this.#t0 = now
    const time = (now - this.#t0 - this.#paused) / 1000
    const rate = this.#options.frameRate
    if (rate !== undefined && time - this.#last < 1 / rate - 0.002) return
    if (encoder.tryEncode(this.#fit(surface, encoder), time)) this.#last = time
    else if (encoder.failed) void this.stop()
  }

  pause(): void {
    if (this.#media) return this.#media.pause()
    if (this.#state !== 'recording') return
    this.#state = 'paused'
    this.#pauseStart = this.#now()
  }

  resume(): void {
    if (this.#media) return this.#media.resume()
    if (this.#state !== 'paused') return
    this.#state = 'recording'
    if (!Number.isNaN(this.#t0)) this.#paused += this.#now() - this.#pauseStart
  }

  stop(): Promise<Blob> {
    if (this.#stopping) return this.#stopping
    if (this.#media) return (this.#stopping = this.#media.stop())
    this.#state = 'inactive'
    this.#ended()
    this.#stopping = this.#finish()
    this.#stopping.then(this.#settle.resolve, this.#settle.reject)
    return this.#stopping
  }

  async #finish(): Promise<Blob> {
    await this.#starting
    if (this.#media) return this.#media.stop()
    const encoder = this.#encoder
    if (!encoder) throw new OuafError('unsupported', 'Nothing was recorded: the recording stopped before its first frame.')
    try {
      return await encoder.finish()
    } catch (error) {
      // An encoder that failed midway: what it gave until then.
      const blob = encoder.partial()
      if (blob) return blob
      throw error
    }
  }

  async #start(width: number, height: number): Promise<void> {
    const { frameRate, codec, videoBitsPerSecond, keyFrameInterval } = this.#options
    const options: VideoEncodingOptions = {}
    if (codec !== undefined) options.codec = codec
    if (videoBitsPerSecond !== undefined) options.videoBitsPerSecond = videoBitsPerSecond
    if (keyFrameInterval !== undefined) options.keyFrameInterval = keyFrameInterval
    let encoder: FrameEncoder
    try {
      encoder = await FrameEncoder.create(width, height, frameRate ?? 30, options, this.#env)
    } catch (error) {
      if (this.#state === 'inactive') return
      // No codec for this size: `MediaRecorder`, from here on.
      try {
        const media = this.#fallback()
        this.#media = media
        this.#ended() // the `MediaRecorder` recording takes its frames itself
        if (this.#state === 'paused') media.pause()
        media.done.then(this.#settle.resolve, this.#settle.reject)
      } catch {
        this.#state = 'inactive'
        this.#ended()
        this.#settle.reject(error)
      }
      return
    }
    if (this.#state === 'inactive') return encoder.close()
    this.#encoder = encoder
  }

  /** The surface, or a copy scaled to the encoded size when the capture size changed since the recording started. */
  #fit(surface: CaptureCanvas, encoder: FrameEncoder): CaptureCanvas {
    const { width, height } = encoder
    if ((surface.width & ~1) === width && (surface.height & ~1) === height) return surface
    const create = this.#env.createCanvas
    if (!create) return surface
    const ctx = (this.#scale ??= create().getContext('2d', { alpha: false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D)
    if (ctx.canvas.width !== width || ctx.canvas.height !== height) {
      ctx.canvas.width = width
      ctx.canvas.height = height
    }
    ctx.drawImage(surface, 0, 0, width, height)
    return ctx.canvas
  }
}
