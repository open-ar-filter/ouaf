/**
 * Frame-exact video encoding (#137): each frame the engine renders goes through a WebCodecs `VideoEncoder` with its
 * media time as timestamp, then into an MP4 (`mp4-writer.ts`). Unlike `MediaRecorder`, nothing depends on the wall
 * clock: an offline clip rendered faster or slower than real time gives the same file, one frame per source frame.
 *
 * H.264 first (plays everywhere, hardware-encoded on most devices), else VP9 in MP4; each codec is tried on one frame
 * before it is chosen. `encode` waits while the encoder has frames queued, so the engine renders no faster than the
 * device can encode, and no frame is dropped.
 */
import { Mp4Writer } from '../mp4-writer.ts'
import { OuafError } from './errors.ts'

/** Encoding options of `engine.export()`. */
export interface VideoEncodingOptions {
  /**
   * WebCodecs codec string, `avc1.*` (H.264) or `vp09.*` (VP9); it must be supported (`VideoEncoder.isConfigSupported`).
   * Default: the first supported of `videoCodecCandidates` (H.264 High, Main, Baseline, then VP9).
   */
  codec?: string
  /** Target video bitrate (bits per second). Default: about 0.15 bit per pixel and frame (4 Mbit/s for 720p30). */
  videoBitsPerSecond?: number
  /** Seconds between keyframes (where a player can seek to without decoding from the start). Default: 2. */
  keyFrameInterval?: number
}

/** Browser services of the encoder, replaced in tests. */
export interface FrameEncoderEnv {
  VideoEncoder: typeof VideoEncoder | undefined
  VideoFrame: typeof VideoFrame | undefined
}

function defaultEnv(): FrameEncoderEnv {
  return {
    VideoEncoder: typeof VideoEncoder !== 'undefined' ? VideoEncoder : undefined,
    VideoFrame: typeof VideoFrame !== 'undefined' ? VideoFrame : undefined,
  }
}

/** Frames queued in the encoder before `encode` waits. */
const MAX_QUEUE = 4
const DEFAULT_KEY_FRAME_INTERVAL = 2
const BITS_PER_PIXEL = 0.15

/**
 * Codec strings tried in order for a `width` × `height` video: H.264 High, Main and Constrained Baseline at the
 * level the size needs (3.0 to 5.2, at 30 fps), then VP9 profile 0 (8 bits) at its level for the size.
 */
export function videoCodecCandidates(width: number, height: number): string[] {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16)
  const avcLevels: Array<[number, string]> = [[1620, '1e'], [3600, '1f'], [5120, '20'], [8192, '28'], [22080, '32'], [36864, '33']]
  const avc = avcLevels.find(([max]) => macroblocks <= max)?.[1] ?? '34'
  const pixels = width * height
  const vp9Levels: Array<[number, string]> = [[983040, '31'], [2228224, '41'], [8912896, '51']]
  const vp9 = vp9Levels.find(([max]) => pixels <= max)?.[1] ?? '61'
  return [`avc1.6400${avc}`, `avc1.4d00${avc}`, `avc1.42e0${avc}`, `vp09.00.${vp9}.08`]
}

/** `video/mp4; codecs="…"` of an MP4 holding `codec`. */
export function mp4MimeType(codec: string): string {
  return `video/mp4; codecs="${codec}"`
}

export class FrameEncoder {
  /** Codec string of the encoder configuration. */
  readonly codec: string
  /** Size of the encoded frames: the frames' size rounded down to even numbers (4:2:0 chroma). */
  readonly width: number
  readonly height: number
  readonly #env: FrameEncoderEnv
  readonly #encoder: VideoEncoder
  readonly #keyInterval: number
  #writer: Mp4Writer | undefined
  #error: Error | undefined
  #lastKey = Number.NEGATIVE_INFINITY
  #lastTime = Number.NEGATIVE_INFINITY
  #closed = false

  private constructor(env: FrameEncoderEnv, config: VideoEncoderConfig, keyInterval: number) {
    this.#env = env
    this.codec = config.codec
    this.width = config.width
    this.height = config.height
    this.#keyInterval = keyInterval
    this.#encoder = new env.VideoEncoder!({
      output: (chunk, metadata) => this.#output(chunk, metadata),
      error: (error) => {
        this.#error ??= new OuafError('unsupported', `The video encoder failed: ${error.message}`, { cause: error })
      },
    })
    this.#encoder.configure(config)
  }

  /**
   * An encoder for frames of `width` × `height` (rounded down to even sizes) at about `frameRate` frames per second.
   * Rejects with `OuafError('unsupported')` without WebCodecs or when no codec can encode that size; `RangeError` on
   * an invalid option.
   */
  static async create(width: number, height: number, frameRate: number, options: VideoEncodingOptions = {}, env: Partial<FrameEncoderEnv> = {}): Promise<FrameEncoder> {
    checkEncodingOptions(options)
    const full = { ...defaultEnv(), ...env }
    const Encoder = full.VideoEncoder
    if (!Encoder || !full.VideoFrame) throw new OuafError('unsupported', 'Exporting a video needs WebCodecs (VideoEncoder), which this browser does not provide.')
    const w = width & ~1
    const h = height & ~1
    if (w < 2 || h < 2) throw new OuafError('unsupported', `Cannot encode frames of ${width}×${height}.`)
    const fps = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 30
    const bitrate = options.videoBitsPerSecond ?? Math.round(w * h * fps * BITS_PER_PIXEL)
    const codecs = options.codec !== undefined ? [options.codec] : videoCodecCandidates(w, h)
    for (const codec of codecs) {
      if (!/^(avc1|vp09)\./.test(codec)) throw new OuafError('unsupported', `Cannot export "${codec}": only H.264 (avc1.*) and VP9 (vp09.*) go into the MP4.`)
      const config: VideoEncoderConfig = { codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality' }
      if (codec.startsWith('avc1')) config.avc = { format: 'avc' } // `avcC` description, length-prefixed frames
      const support = await Encoder.isConfigSupported(config).catch(() => ({ supported: false }))
      if (support.supported && (await encodes(full, config))) return new FrameEncoder(full, config, options.keyFrameInterval ?? DEFAULT_KEY_FRAME_INTERVAL)
    }
    const what = options.codec !== undefined ? `"${options.codec}"` : 'H.264 or VP9'
    throw new OuafError('unsupported', `This browser cannot encode ${what} video of ${w}×${h}.`)
  }

  /** Frames encoded into the file so far. */
  get frameCount(): number {
    return this.#writer?.frameCount ?? 0
  }

  /**
   * Encodes `image` as the frame shown at `time` (s), then waits while the encoder has more than a few frames queued.
   * The image is read at once: it may change as soon as this returns (before the promise settles). Rejects with
   * `OuafError('unsupported')` when the encoder failed.
   */
  async encode(image: CanvasImageSource | OffscreenCanvas | VideoFrame, time: number): Promise<void> {
    this.#check()
    const encoder = this.#encoder
    const timestamp = Math.round(time * 1e6)
    const init: VideoFrameInit = { timestamp }
    const iw = 'displayWidth' in image ? image.displayWidth : (image as { width: number }).width
    const ih = 'displayHeight' in image ? image.displayHeight : (image as { height: number }).height
    // An odd size: the encoded frame leaves out the last column or row.
    if (iw !== this.width || ih !== this.height) init.visibleRect = { x: 0, y: 0, width: Math.min(iw, this.width), height: Math.min(ih, this.height) }
    const frame = new this.#env.VideoFrame!(image as CanvasImageSource, init)
    // A keyframe every interval, and where the time goes back (a new run of the source).
    const keyFrame = time - this.#lastKey >= this.#keyInterval || time < this.#lastTime
    if (keyFrame) this.#lastKey = time
    this.#lastTime = time
    try {
      encoder.encode(frame, { keyFrame })
    } finally {
      frame.close()
    }
    while (encoder.encodeQueueSize > MAX_QUEUE && !this.#error) {
      await new Promise<void>((resolve) => {
        encoder.addEventListener('dequeue', () => resolve(), { once: true })
        // Browsers without the `dequeue` event: check again shortly.
        setTimeout(resolve, 10)
      })
    }
    this.#check()
  }

  /**
   * Encodes the frames still queued and returns the MP4. `end` (s) is when the last frame stops showing (the source's
   * duration); default: one frame interval after it. The encoder is closed afterwards.
   */
  async finish(end?: number): Promise<Blob> {
    this.#check()
    try {
      await this.#encoder.flush()
    } catch (cause) {
      this.#error ??= new OuafError('unsupported', `The video encoder failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    }
    this.#check()
    const writer = this.#writer
    this.close()
    if (!writer) throw new OuafError('unsupported', 'The video encoder gave no frame.')
    return writer.finish(end)
  }

  /** Stops encoding and frees the encoder. Idempotent. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#encoder.state !== 'closed') this.#encoder.close()
  }

  #output(chunk: EncodedVideoChunk, metadata: EncodedVideoChunkMetadata | undefined): void {
    if (this.#closed || this.#error) return
    try {
      if (!this.#writer) {
        const config = metadata?.decoderConfig
        const description = config?.description
        const bytes = description === undefined ? undefined : ArrayBuffer.isView(description) ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice() : new Uint8Array(description).slice()
        this.#writer = new Mp4Writer({ codec: config?.codec ?? this.codec, width: this.width, height: this.height, description: bytes })
      }
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      this.#writer.add(data, chunk.timestamp / 1e6, chunk.type === 'key')
    } catch (cause) {
      this.#error = new OuafError('unsupported', `Cannot write the encoded video: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    }
  }

  #check(): void {
    if (this.#error) throw this.#error
    if (this.#closed) throw new OuafError('unsupported', 'The video encoder is closed.')
  }
}

/**
 * Whether an encoder with `config` really gives a frame: one black frame of the size, encoded and flushed. Some
 * browsers say yes to `isConfigSupported` and then fail on the first frame (Firefox 159 on Linux without an H.264
 * encoder: "The given encoding is not supported"), so the answer alone cannot pick the codec.
 */
async function encodes(env: FrameEncoderEnv, config: VideoEncoderConfig): Promise<boolean> {
  let chunks = 0
  let failed = false
  let encoder: VideoEncoder | undefined
  try {
    encoder = new env.VideoEncoder!({ output: () => chunks++, error: () => (failed = true) })
    encoder.configure(config)
    const { width, height } = config
    const data = new Uint8Array(width * height * 4)
    for (let i = 3; i < data.length; i += 4) data[i] = 255
    const frame = new env.VideoFrame!(data, { format: 'RGBA', codedWidth: width, codedHeight: height, timestamp: 0 })
    try {
      encoder.encode(frame, { keyFrame: true })
    } finally {
      frame.close()
    }
    await encoder.flush()
  } catch {
    failed = true
  } finally {
    if (encoder && encoder.state !== 'closed') encoder.close()
  }
  return !failed && chunks > 0
}

/** Throws `RangeError` on an invalid option (`engine.export` checks them before it starts). */
export function checkEncodingOptions(options: VideoEncodingOptions): void {
  const { videoBitsPerSecond: bitrate, keyFrameInterval: interval } = options
  if (bitrate !== undefined && !(bitrate > 0 && Number.isFinite(bitrate))) throw new RangeError(`videoBitsPerSecond must be a positive number, got ${bitrate}`)
  if (interval !== undefined && !(interval > 0)) throw new RangeError(`keyFrameInterval must be positive (seconds), got ${interval}`)
}
