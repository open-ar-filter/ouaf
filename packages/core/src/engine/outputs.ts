/**
 * What the host gets back from the engine (#33): a photo (`snapshot`), a video (`record`) and a live `MediaStream`
 * (`outputStream`) of the composited image, as the user sees it (mirroring included, spec §5.1), minus the overlay
 * layers marked `excludeFromCapture` (spec §6.2).
 *
 * The compositor draws every frame into the engine's canvas in two steps: everything but the excluded overlays, then
 * the excluded overlays on top. While an output is in use, `Outputs.capture` is called between the two steps and
 * copies the canvas into a capture surface, a 2D `OffscreenCanvas` of the render size: photos and exports are encoded
 * from it. Streams and recordings need `captureStream`, which only a `<canvas>` has: while one is open, the surface
 * is copied on into such a canvas, never shown. Without any output in use, nothing is copied.
 *
 * Why not draw the WebGL canvas into the `<canvas>` directly: Firefox (159, Linux, with a GPU) swaps red and blue when
 * a WebGL canvas is drawn into a 2D `<canvas>`, not into an `OffscreenCanvas` (#137).
 *
 * Nothing leaves the device: the host decides what to do with the blobs and streams (docs/privacy.md).
 */
import { EncodedRecording } from './encoded-recording.ts'
import { OuafError, disposedError } from './errors.ts'

/** `engine.snapshot()`. */
export interface SnapshotOptions {
  /**
   * Image type, e.g. `image/png` (default), `image/jpeg`, `image/webp`. A browser that cannot encode the type gives a
   * PNG (`Blob.type` tells).
   */
  type?: string
  /** Quality from 0 to 1, for lossy types (`image/jpeg`, `image/webp`). Default: the browser's. */
  quality?: number
}

/** `engine.outputStream()`. */
export interface OutputStreamOptions {
  /**
   * Maximum frame rate of the stream. Default: none, a frame for every rendered frame (the engine renders once per
   * source frame).
   */
  frameRate?: number
}

/** `engine.record()`. */
export interface RecordOptions {
  /**
   * Container and codecs, e.g. `video/webm;codecs=vp9`; it must be supported (`MediaRecorder.isTypeSupported`). Given,
   * the recording uses `MediaRecorder`. Default: an MP4 encoded with WebCodecs (H.264, else VP9) where the browser has
   * it and no `audio` is given, else the first `MediaRecorder` type of `RECORDING_TYPES` (H.264 MP4 first, then WebM).
   */
  mimeType?: string
  /** Target video bitrate (bits per second). Default: the browser's. */
  videoBitsPerSecond?: number
  /** Target audio bitrate (bits per second), when `audio` is given. Default: the browser's. */
  audioBitsPerSecond?: number
  /**
   * Audio to record with the video, e.g. the microphone track the host opened. The engine never opens the
   * microphone itself, and it does not stop these tracks: they stay the host's.
   */
  audio?: MediaStream | readonly MediaStreamTrack[]
  /** Maximum frame rate of the recorded video. Default: every rendered frame. */
  frameRate?: number
}

/** A recording in progress (`engine.record()`). */
export interface Recording {
  /**
   * Container and codecs recorded: `video/mp4; codecs="…"` with WebCodecs (`video/mp4` until the encoder is ready,
   * from the first frame), else the `MediaRecorder`'s.
   */
  readonly mimeType: string
  readonly state: 'recording' | 'paused' | 'inactive'
  pause(): void
  resume(): void
  /** Stops the recording; resolves with the video. Calling it again returns the same promise. */
  stop(): Promise<Blob>
  /**
   * Resolves with the video once the recording has ended: `stop()`, the engine disposed, or the recorder failed
   * (with what was recorded until then; rejects only when nothing could be recorded).
   */
  readonly done: Promise<Blob>
}

/**
 * Recording types tried in order when `RecordOptions.mimeType` is not set, `[video only, with audio]`. H.264 in MP4
 * comes first: it plays everywhere (iOS included, and the apps videos are shared to) and is hardware-encoded on most
 * devices. Browsers without an H.264 encoder for `MediaRecorder` (Firefox, Chromium without proprietary codecs) get
 * WebM with VP9, else VP8. The bare types last let the browser pick (Safari before WebM support records MP4).
 */
export const RECORDING_TYPES: ReadonlyArray<readonly [video: string, withAudio: string]> = [
  ['video/mp4;codecs=avc1', 'video/mp4;codecs=avc1,mp4a.40.2'],
  ['video/webm;codecs=vp9', 'video/webm;codecs=vp9,opus'],
  ['video/webm;codecs=vp8', 'video/webm;codecs=vp8,opus'],
  ['video/mp4', 'video/mp4'],
  ['video/webm', 'video/webm'],
]

/** The first of `RECORDING_TYPES` that `isTypeSupported` accepts; `undefined` lets the recorder choose. */
export function pickRecordingType(isTypeSupported: (type: string) => boolean, withAudio: boolean): string | undefined {
  for (const [video, audio] of RECORDING_TYPES) {
    const type = withAudio ? audio : video
    if (isTypeSupported(type)) return type
  }
  return undefined
}

/** What the capture surface is: the canvas photos are encoded from and streams read. */
export type CaptureCanvas = HTMLCanvasElement | OffscreenCanvas

/** Browser services of the outputs, replaced in tests. */
export interface OutputsEnv {
  /** Creates the capture surface (default: an `OffscreenCanvas`, else a detached `<canvas>`). */
  createSurface(): CaptureCanvas
  /**
   * Creates the canvas that streams and recordings read (default: a detached `<canvas>`; an `OffscreenCanvas` in a
   * worker, which has no `captureStream`).
   */
  createCanvas(): CaptureCanvas
  /** Default: the global `MediaRecorder`, when there is one. */
  MediaRecorder: typeof MediaRecorder | undefined
  /** WebCodecs, for recordings without audio (default: the globals, when there are). */
  VideoEncoder: typeof VideoEncoder | undefined
  VideoFrame: typeof VideoFrame | undefined
  /** Clock of the WebCodecs recordings, in ms (default: `performance.now`). */
  now(): number
}

function defaultEnv(): OutputsEnv {
  return {
    createSurface: () => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas')),
    createCanvas: () => (typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1)),
    MediaRecorder: typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined,
    VideoEncoder: typeof VideoEncoder !== 'undefined' ? VideoEncoder : undefined,
    VideoFrame: typeof VideoFrame !== 'undefined' ? VideoFrame : undefined,
    now: () => performance.now(),
  }
}

interface PendingSnapshot {
  type: string
  quality: number | undefined
  resolve(blob: Blob): void
  reject(error: unknown): void
}

interface ActiveRecording {
  /** Stops the recording (its `done` resolves with what was recorded). */
  finish(): void
  /** A WebCodecs recording: gets the capture surface after each frame. `MediaRecorder` ones read the stream canvas. */
  frame?(surface: CaptureCanvas): void
}

export class Outputs {
  #env: OutputsEnv
  #context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | undefined
  /** The canvas streams and recordings read, a copy of the surface. */
  #streamContext: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | undefined
  #snapshots: PendingSnapshot[] = []
  /** Streams given to the host, until all their video tracks have ended (`track.stop()`). */
  #streams: MediaStream[] = []
  #recordings = new Set<ActiveRecording>()
  /** `MediaRecorder` recordings: they read the stream canvas. */
  #mediaRecordings = 0
  /** Exports in progress (`hold`): they read the capture surface after each frame. */
  #holds = 0
  #disposed = false

  constructor(env: Partial<OutputsEnv> = {}) {
    this.#env = { ...defaultEnv(), ...env }
  }

  /**
   * True while an output needs the frames: a pending snapshot, an open stream, a recording. Checked by the compositor
   * once per frame; drops the streams whose tracks the host has stopped.
   */
  get active(): boolean {
    if (this.#snapshots.length > 0 || this.#recordings.size > 0 || this.#holds > 0) return true
    const streams = this.#streams
    for (let i = streams.length - 1; i >= 0; i--) if (ended(streams[i]!)) streams.splice(i, 1)
    return streams.length > 0
  }

  /**
   * Copies the frame drawn so far (`source`: the engine's canvas, before the excluded overlays) into the capture
   * surface, then encodes the pending snapshots from it. Called by the compositor in the task that rendered the
   * frame, so the WebGL drawing buffer is still readable.
   */
  capture(source: CanvasImageSource, width: number, height: number): void {
    if (this.#disposed || width <= 0 || height <= 0) return
    const ctx = this.#surface()
    const canvas = ctx.canvas
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    ctx.drawImage(source, 0, 0, width, height)
    if (this.#streams.length > 0 || this.#mediaRecordings > 0) {
      const stream = this.#streamSurface()
      if (stream.canvas.width !== width || stream.canvas.height !== height) {
        stream.canvas.width = width
        stream.canvas.height = height
      }
      stream.drawImage(canvas, 0, 0)
    }
    for (const r of this.#recordings) r.frame?.(canvas)
    const snapshots = this.#snapshots
    if (snapshots.length === 0) return
    this.#snapshots = []
    for (const s of snapshots) encode(canvas, s.type, s.quality).then(s.resolve, s.reject)
  }

  /**
   * Keeps the capture surface up to date on every frame until `release` (an export, #137): the surface holds the last
   * frame rendered, as captured (excluded overlays left out), at the render size.
   */
  hold(): { readonly canvas: CaptureCanvas; release(): void } {
    this.#assertAlive()
    const canvas = this.#surface().canvas
    this.#holds++
    let held = true
    return {
      canvas,
      release: () => {
        if (!held) return
        held = false
        this.#holds--
      },
    }
  }

  /** Resolves with the next rendered frame, encoded as an image. */
  snapshot(options: SnapshotOptions = {}): Promise<Blob> {
    this.#assertAlive()
    const type = options.type ?? 'image/png'
    const quality = options.quality
    if (quality !== undefined && !(quality >= 0 && quality <= 1)) throw new RangeError(`quality must be from 0 to 1, got ${quality}`)
    return new Promise((resolve, reject) => this.#snapshots.push({ type, quality, resolve, reject }))
  }

  /** A new `MediaStream` of the output, with one video track. Stop its track when done (`track.stop()`). */
  outputStream(options: OutputStreamOptions = {}): MediaStream {
    this.#assertAlive()
    const stream = this.#captureStream(options.frameRate)
    this.#streams.push(stream)
    return stream
  }

  /**
   * Starts recording the output, in real time: WebCodecs into an MP4 when the browser has it, no `audio` and no
   * `mimeType` are given (falling back to `MediaRecorder` when no codec can encode the size), else `MediaRecorder`.
   */
  record(options: RecordOptions = {}): Recording {
    this.#assertAlive()
    const audio = options.audio === undefined ? [] : 'getAudioTracks' in options.audio ? options.audio.getAudioTracks() : options.audio.filter((t) => t.kind === 'audio')
    const env = this.#env
    if (audio.length > 0 || options.mimeType !== undefined || !env.VideoEncoder || !env.VideoFrame) return this.#mediaRecord(options, audio)
    const { frameRate, videoBitsPerSecond } = options
    if (frameRate !== undefined && !(frameRate > 0)) throw new RangeError(`frameRate must be positive, got ${frameRate}`)
    if (videoBitsPerSecond !== undefined && !(videoBitsPerSecond > 0 && Number.isFinite(videoBitsPerSecond))) throw new RangeError(`videoBitsPerSecond must be a positive number, got ${videoBitsPerSecond}`)
    const active: ActiveRecording = { finish: () => void recording.stop().catch(() => {}), frame: (surface) => recording.frame(surface) }
    const recording: EncodedRecording = new EncodedRecording(
      { ...(frameRate !== undefined ? { frameRate } : {}), ...(videoBitsPerSecond !== undefined ? { videoBitsPerSecond } : {}) },
      { VideoEncoder: env.VideoEncoder, VideoFrame: env.VideoFrame, now: env.now, createCanvas: env.createSurface },
      () => this.#mediaRecord(options, []),
      () => this.#recordings.delete(active),
    )
    this.#recordings.add(active)
    return recording
  }

  #mediaRecord(options: RecordOptions, audio: readonly MediaStreamTrack[]): Recording {
    const Recorder = this.#env.MediaRecorder
    if (!Recorder) throw new OuafError('unsupported', 'Recording needs MediaRecorder, which this browser does not provide.')
    let mimeType = options.mimeType
    if (mimeType !== undefined && !Recorder.isTypeSupported(mimeType)) throw new OuafError('unsupported', `This browser cannot record "${mimeType}".`)
    mimeType ??= pickRecordingType((t) => Recorder.isTypeSupported(t), audio.length > 0)

    const video = this.#captureStream(options.frameRate)
    const track = video.getVideoTracks()[0]!
    const init: MediaRecorderOptions = {}
    if (mimeType !== undefined) init.mimeType = mimeType
    if (options.videoBitsPerSecond !== undefined) init.videoBitsPerSecond = options.videoBitsPerSecond
    if (options.audioBitsPerSecond !== undefined) init.audioBitsPerSecond = options.audioBitsPerSecond
    let recorder: MediaRecorder
    try {
      recorder = new Recorder(new MediaStream([track, ...audio]), init)
    } catch (error) {
      track.stop()
      throw new OuafError('unsupported', `Could not start recording: ${String(error)}`, { cause: error })
    }

    const chunks: Blob[] = []
    let failure: unknown
    let settle!: { resolve(blob: Blob): void; reject(error: unknown): void }
    const done = new Promise<Blob>((resolve, reject) => (settle = { resolve, reject }))
    const active: ActiveRecording = {
      finish: () => {
        if (recorder.state !== 'inactive') recorder.stop() // `stop` fires `dataavailable` (the last chunk), then `stop`
      },
    }
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    })
    recorder.addEventListener('error', (e) => {
      failure = (e as Event & { error?: unknown }).error ?? new Error('MediaRecorder error')
    })
    recorder.addEventListener('stop', () => {
      if (this.#recordings.delete(active)) this.#mediaRecordings--
      track.stop()
      if (chunks.length === 0 && failure !== undefined) settle.reject(failure)
      else settle.resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || chunks[0]?.type || '' }))
    })
    // Chunks every second: a recorder that fails midway still gives what it recorded until then.
    recorder.start(1000)
    this.#recordings.add(active)
    this.#mediaRecordings++

    return {
      get mimeType() {
        return recorder.mimeType || mimeType || ''
      },
      get state() {
        return recorder.state
      },
      pause: () => {
        if (recorder.state === 'recording') recorder.pause()
      },
      resume: () => {
        if (recorder.state === 'paused') recorder.resume()
      },
      stop: () => {
        active.finish()
        return done
      },
      done,
    }
  }

  /**
   * Ends every output: pending snapshots reject (`disposed`), recordings stop (their `done` resolves with what was
   * recorded), the tracks of the streams given to the host end. Idempotent.
   */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    const error = disposedError('The engine')
    for (const s of this.#snapshots) s.reject(error)
    this.#snapshots = []
    for (const r of this.#recordings) r.finish()
    for (const stream of this.#streams) for (const t of stream.getVideoTracks()) t.stop()
    this.#streams = []
  }

  #captureStream(frameRate: number | undefined): MediaStream {
    if (frameRate !== undefined && !(frameRate > 0)) throw new RangeError(`frameRate must be positive, got ${frameRate}`)
    const canvas = this.#streamSurface().canvas
    if (!('captureStream' in canvas)) throw new OuafError('unsupported', 'Streams and recordings need HTMLCanvasElement.captureStream (not available in a worker).')
    return frameRate === undefined ? canvas.captureStream() : canvas.captureStream(frameRate)
  }

  #surface(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
    return (this.#context ??= context2d(this.#env.createSurface()))
  }

  #streamSurface(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
    return (this.#streamContext ??= context2d(this.#env.createCanvas()))
  }

  #assertAlive(): void {
    if (this.#disposed) throw disposedError('The engine')
  }
}

function context2d(canvas: CaptureCanvas): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  // Opaque, like the engine's canvas: no alpha to encode or premultiply.
  const ctx = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) throw new OuafError('unsupported', 'Could not create the 2D canvas of the outputs.')
  return ctx
}

function ended(stream: MediaStream): boolean {
  const tracks = stream.getVideoTracks()
  for (let i = 0; i < tracks.length; i++) if (tracks[i]!.readyState !== 'ended') return false
  return true
}

/** Encodes the canvas as it is now (`toBlob` copies the bitmap synchronously, then encodes in the background). */
function encode(canvas: CaptureCanvas, type: string, quality: number | undefined): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob(quality === undefined ? { type } : { type, quality })
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new OuafError('unsupported', `Could not encode the snapshot as "${type}".`))), type, quality)
  })
}
