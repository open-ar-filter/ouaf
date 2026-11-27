/**
 * A fake WebCodecs `VideoEncoder` and `VideoFrame` for the unit tests of the encoder and the recordings (#137).
 */
import type { FrameEncoderEnv } from '../src/engine/frame-encoder.ts'

export const AVCC = Uint8Array.of(1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0, 0)

export interface Queued {
  timestamp: number
  keyFrame: boolean
}

/** A fake encoder: frames wait in the queue until `drain` or `flush` outputs them. */
/**
 * `auto`: each frame comes out right after `encode` (a fast encoder). `broken`: codecs said supported that fail on
 * the first frame. `encoders` and `frames` leave out the trial encoders and frames of `create`.
 */
export function fakeEnv(supported: (codec: string) => boolean = () => true, auto = false, broken: (codec: string) => boolean = () => false) {
  const trials: string[] = []
  const encoders: FakeEncoder[] = []
  const frames: FakeFrame[] = []
  class FakeFrame {
    closed = false
    readonly init: VideoFrameInit & { timestamp: number }
    constructor(image: unknown, init: VideoFrameInit & { timestamp: number }) {
      this.init = init
      if (!(image instanceof Uint8Array)) frames.push(this)
    }
    close() {
      this.closed = true
    }
  }
  class FakeEncoder extends EventTarget {
    static async isConfigSupported(config: VideoEncoderConfig) {
      return { supported: supported(config.codec), config }
    }
    state: CodecState = 'unconfigured'
    config: VideoEncoderConfig | undefined
    queue: Queued[] = []
    /** Every frame encoded, in order. */
    log: Queued[] = []
    described = false
    readonly init: VideoEncoderInit
    constructor(init: VideoEncoderInit) {
      super()
      this.init = init
      encoders.push(this)
    }
    get encodeQueueSize() {
      return this.queue.length
    }
    configure(config: VideoEncoderConfig) {
      this.config = config
      this.state = 'configured'
    }
    encode(frame: FakeFrame, options: VideoEncoderEncodeOptions) {
      if (frame.closed) throw new Error('closed frame')
      if (!frames.includes(frame)) {
        // The trial frame of `create`: this encoder is a trial one.
        encoders.splice(encoders.indexOf(this), 1)
        trials.push(this.config!.codec)
      }
      if (broken(this.config!.codec)) {
        queueMicrotask(() => this.init.error(new DOMException('The given encoding is not supported.', 'NotSupportedError')))
        return
      }
      const q = { timestamp: frame.init.timestamp, keyFrame: options.keyFrame ?? false }
      this.queue.push(q)
      this.log.push(q)
      if (auto) queueMicrotask(() => this.drain())
    }
    drain(n = 1) {
      for (let i = 0; i < n && this.queue.length > 0; i++) {
        const q = this.queue.shift()!
        const data = Uint8Array.of(q.keyFrame ? 1 : 0, q.timestamp & 0xff)
        const chunk = { timestamp: q.timestamp, type: q.keyFrame ? 'key' : 'delta', byteLength: data.byteLength, copyTo: (dest: Uint8Array) => dest.set(data) }
        const metadata = this.described ? {} : { decoderConfig: { codec: this.config!.codec, description: AVCC.buffer.slice(0) } }
        this.described = true
        this.init.output(chunk as unknown as EncodedVideoChunk, metadata as EncodedVideoChunkMetadata)
        this.dispatchEvent(new Event('dequeue'))
      }
    }
    async flush() {
      this.drain(Infinity)
    }
    close() {
      this.state = 'closed'
    }
  }
  const env: FrameEncoderEnv = { VideoEncoder: FakeEncoder as unknown as typeof VideoEncoder, VideoFrame: FakeFrame as unknown as typeof VideoFrame }
  return { env, encoders, frames, trials }
}

export const canvas = (width: number, height: number) => ({ width, height }) as unknown as HTMLCanvasElement
