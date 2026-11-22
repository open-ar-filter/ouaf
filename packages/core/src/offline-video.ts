/**
 * Offline video source (#32): an MP4 / MOV file decoded with WebCodecs, frame by frame. Unlike `VideoFileSource`
 * (a playing `<video>`, a live source), the engine renders **every** frame at its exact timestamp, waiting for
 * tracking before each one, so a run is deterministic (spec §12.1, §12.5) and may go faster or slower than real time.
 *
 * ```ts
 * const clip = await OfflineVideoSource.open('/clips/talk.mp4', { rate: Infinity }) // as fast as possible
 * engine.on('sourceEnd', () => console.log('done'))
 * await engine.setSource(clip)
 * ```
 *
 * The whole file is read into memory (fine for clips of a few minutes; streaming is not implemented).
 */
import { demuxMp4, Mp4Error, type Mp4VideoTrack } from './mp4.ts'
import { VideoFileError } from './video-source.ts'

export interface OfflineVideoOptions {
  /**
   * Speed relative to real time: 1 (default) paces the frames at their own timestamps, 2 twice as fast, `Infinity`
   * as fast as the device can track and render them. No frame is ever dropped: a slow device runs slower instead.
   */
  rate?: number
  /** Start again from the first frame after the last one. Default: false (the engine emits `sourceEnd`). */
  loop?: boolean
  /** Mirror the image. Default: false (a file is shown as recorded). */
  mirror?: boolean
  /** `fetch` used for a URL. Default: the global `fetch`. */
  fetch?: typeof fetch
}

/** A decoded frame, owned by the reader until `close`. */
export interface OfflineFrame {
  /** The frame as displayed: a `VideoFrame`, or a canvas when the track is rotated. */
  readonly image: VideoFrame | OffscreenCanvas
  /** Presentation time in seconds (the position in the file). */
  readonly time: number
  /** Index of the frame in presentation order. */
  readonly index: number
  close(): void
}

/** Decoded frames kept ahead of the reader. Decoders have a small pool of output frames: do not hold many. */
const MAX_AHEAD = 4

export class OfflineVideoSource {
  /** URL or name of the file, for messages. */
  readonly label: string
  /** WebCodecs codec string. */
  readonly codec: string
  /** Clockwise rotation applied to the decoded frames (from the track matrix). */
  readonly rotation: 0 | 90 | 180 | 270
  /** Duration in seconds. */
  readonly duration: number
  /** Number of frames shown (frames before the start of the edit list are decoded but not shown). */
  readonly frameCount: number
  readonly mirrored: boolean
  loop: boolean
  #rate = 1
  #track: Mp4VideoTrack
  #data: Uint8Array
  #config: VideoDecoderConfig
  #decoder: VideoDecoder | undefined
  /** Next sample to decode (decoding order), and frames decoded ahead, in presentation order. */
  #next = 0
  #ahead: VideoFrame[] = []
  #flush: Promise<void> | undefined
  #flushed = false
  #error: Error | undefined
  #wake: (() => void) | undefined
  /** Exact presentation time (s) by WebCodecs timestamp (µs), and the index of each time. */
  #times = new Map<number, number>()
  #indices = new Map<number, number>()
  #rotated: OffscreenCanvas | undefined
  /** Incremented by `restart`: a `read` waiting across a restart returns `null` (its reader was stopped). */
  #epoch = 0
  #disposed = false

  private constructor(label: string, data: Uint8Array, track: Mp4VideoTrack, config: VideoDecoderConfig, options: OfflineVideoOptions) {
    this.label = label
    this.#data = data
    this.#track = track
    this.#config = config
    this.codec = track.codec
    this.rotation = track.rotation
    this.duration = track.duration
    this.mirrored = options.mirror ?? false
    this.loop = options.loop ?? false
    this.rate = options.rate ?? 1
    const shown = track.samples.map((s) => s.time).filter((t) => t >= -1e-6).sort((a, b) => a - b)
    this.frameCount = shown.length
    shown.forEach((t, i) => {
      this.#times.set(toMicros(t), t)
      this.#indices.set(toMicros(t), i)
    })
  }

  /**
   * Loads and demuxes `input` (URL, `Blob`/`File` or the file's bytes) and checks that this browser can decode it.
   * Rejects with a `VideoFileError` (not an MP4 / MOV, unsupported codec, no WebCodecs).
   */
  static async open(input: string | URL | Blob | ArrayBuffer | Uint8Array, options: OfflineVideoOptions = {}): Promise<OfflineVideoSource> {
    const label = typeof input === 'string' ? input : input instanceof URL ? input.href : typeof Blob !== 'undefined' && input instanceof Blob ? ((input as File).name ?? 'blob') : 'buffer'
    if (typeof VideoDecoder === 'undefined') throw new VideoFileError(label, 'This browser cannot decode video offline (no WebCodecs VideoDecoder).')
    let data: Uint8Array
    try {
      data = await readBytes(input, options.fetch ?? ((i, init) => fetch(i, init)))
    } catch (cause) {
      if (cause instanceof VideoFileError) throw cause
      throw new VideoFileError(label, `Cannot load ${label}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    }
    let track: Mp4VideoTrack
    try {
      track = demuxMp4(data)
    } catch (cause) {
      throw new VideoFileError(label, `Cannot read ${label}: ${cause instanceof Mp4Error ? cause.message : String(cause)}`, { cause })
    }
    if (track.samples.length === 0) throw new VideoFileError(label, `${label} has no video frame.`)
    const config: VideoDecoderConfig = {
      codec: track.codec,
      codedWidth: track.codedWidth,
      codedHeight: track.codedHeight,
      ...(track.description ? { description: track.description } : {}),
    }
    const support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }))
    if (!support.supported) throw new VideoFileError(label, `This browser cannot decode the video codec of ${label} (${track.codec}).`)
    return new OfflineVideoSource(label, data, track, config, options)
  }

  /** Width and height of the frames as displayed (rotation applied). */
  get width(): number {
    return this.rotation % 180 === 0 ? this.#track.codedWidth : this.#track.codedHeight
  }

  get height(): number {
    return this.rotation % 180 === 0 ? this.#track.codedHeight : this.#track.codedWidth
  }

  /** Speed relative to real time (`Infinity`: as fast as possible). Can be changed while the video runs. */
  get rate(): number {
    return this.#rate
  }

  set rate(value: number) {
    if (!(value > 0)) throw new RangeError(`rate must be positive (Infinity: as fast as possible), got ${value}`)
    this.#rate = value
  }

  get disposed(): boolean {
    return this.#disposed
  }

  /**
   * The next frame in presentation order, or `null` after the last one. Used by the engine, which closes each frame
   * once rendered; a host may also read frames itself (e.g. to `pushFrame` them) when the source is not set on an
   * engine. Rejects with a `VideoFileError` when decoding fails.
   */
  async read(): Promise<OfflineFrame | null> {
    const epoch = this.#epoch
    for (;;) {
      if (this.#disposed || epoch !== this.#epoch) return null
      if (this.#error) throw this.#error
      const decoder = this.#decoder ?? this.#start()
      const frame = this.#ahead.shift()
      if (frame) {
        this.#feed(decoder)
        return this.#output(frame)
      }
      this.#feed(decoder)
      if (this.#flushed) return null
      await new Promise<void>((resolve) => (this.#wake = resolve))
    }
  }

  /** Goes back to the first frame: the next `read` returns it (a `read` still waiting returns `null`). */
  restart(): void {
    this.#epoch++
    this.#stop()
  }

  /** Stops decoding and frees the decoder and the file. Idempotent. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#stop()
    this.#data = new Uint8Array(0)
  }

  #start(): VideoDecoder {
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (this.#decoder !== decoder) return frame.close()
        // Frames before the edit list start are decoded (they may be references) but not shown.
        if (!this.#times.has(frame.timestamp)) frame.close()
        else this.#ahead.push(frame)
        this.#notify()
      },
      error: (error) => {
        if (this.#decoder !== decoder) return
        this.#error = new VideoFileError(this.label, `Cannot decode ${this.label}: ${error.message}`, { cause: error })
        this.#notify()
      },
    })
    decoder.configure(this.#config)
    decoder.addEventListener('dequeue', () => {
      if (this.#decoder === decoder) this.#notify()
    })
    this.#decoder = decoder
    this.#next = 0
    this.#flushed = false
    this.#flush = undefined
    return decoder
  }

  #stop(): void {
    const decoder = this.#decoder
    this.#decoder = undefined
    for (const f of this.#ahead) f.close()
    this.#ahead.length = 0
    this.#flush = undefined
    this.#flushed = false
    this.#error = undefined
    if (decoder && decoder.state !== 'closed') decoder.close()
    this.#notify()
  }

  /** Keeps a few chunks queued and a few frames ahead; flushes after the last chunk. */
  #feed(decoder: VideoDecoder): void {
    const samples = this.#track.samples
    while (this.#next < samples.length && decoder.decodeQueueSize < 2 && this.#ahead.length + decoder.decodeQueueSize < MAX_AHEAD) {
      const s = samples[this.#next++]!
      decoder.decode(new EncodedVideoChunk({ type: s.sync ? 'key' : 'delta', timestamp: toMicros(s.time), duration: toMicros(s.duration), data: this.#data.subarray(s.offset, s.offset + s.size) }))
    }
    if (this.#next >= samples.length && !this.#flush) {
      this.#flush = decoder.flush().then(
        () => {
          if (this.#decoder !== decoder) return
          this.#flushed = true
          this.#notify()
        },
        () => {}, // closed or reset: a restart or dispose
      )
    }
  }

  #notify(): void {
    const wake = this.#wake
    this.#wake = undefined
    wake?.()
  }

  #output(frame: VideoFrame): OfflineFrame {
    const time = this.#times.get(frame.timestamp)!
    const index = this.#indices.get(frame.timestamp)!
    if (this.rotation === 0) return { image: frame, time, index, close: () => frame.close() }
    // Rotate into a canvas (WebCodecs frames are decoded as coded; the track matrix only applies at display).
    const canvas = (this.#rotated ??= new OffscreenCanvas(this.width, this.height))
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.translate(this.width / 2, this.height / 2)
    ctx.rotate((this.rotation * Math.PI) / 180)
    ctx.drawImage(frame, -frame.displayWidth / 2, -frame.displayHeight / 2)
    frame.close()
    return { image: canvas, time, index, close: () => {} }
  }
}

function toMicros(seconds: number): number {
  return Math.round(seconds * 1e6)
}

async function readBytes(input: string | URL | Blob | ArrayBuffer | Uint8Array, fetchImpl: typeof fetch): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (typeof Blob !== 'undefined' && input instanceof Blob) return new Uint8Array(await input.arrayBuffer())
  const url = new URL(String(input), globalThis.location?.href).href
  const res = await fetchImpl(url)
  if (!res.ok) throw new VideoFileError(url, `Cannot load ${url}: HTTP ${res.status}.`)
  if (res.headers.get('content-type')?.includes('text/html')) throw new VideoFileError(url, `Cannot load ${url}: the server returned an HTML page (missing file?).`)
  return new Uint8Array(await res.arrayBuffer())
}
