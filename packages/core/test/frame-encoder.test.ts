/**
 * Frame-exact encoder of `engine.export()` (#137) on a fake WebCodecs `VideoEncoder`: codec choice and fallback,
 * even sizes, keyframe interval, media-time timestamps, waiting on a full queue, the MP4 it writes (read back with
 * the demuxer) and its errors. The real encoders are exercised by e2e/export.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import { checkEncodingOptions, FrameEncoder, mp4MimeType, videoCodecCandidates, type FrameEncoderEnv } from '../src/engine/frame-encoder.ts'
import { OuafError } from '../src/engine/errors.ts'
import { demuxMp4 } from '../src/mp4.ts'

const AVCC = Uint8Array.of(1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0, 0)

interface Queued {
  timestamp: number
  keyFrame: boolean
}

/** A fake encoder: frames wait in the queue until `drain` or `flush` outputs them. */
/**
 * `auto`: each frame comes out right after `encode` (a fast encoder). `broken`: codecs said supported that fail on
 * the first frame. `encoders` and `frames` leave out the trial encoders and frames of `create`.
 */
function fakeEnv(supported: (codec: string) => boolean = () => true, auto = false, broken: (codec: string) => boolean = () => false) {
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

const canvas = (width: number, height: number) => ({ width, height }) as unknown as HTMLCanvasElement

describe('videoCodecCandidates', () => {
  it('asks for the H.264 and VP9 levels the size needs', () => {
    expect(videoCodecCandidates(640, 360)).toEqual(['avc1.64001e', 'avc1.4d001e', 'avc1.42e01e', 'vp09.00.31.08'])
    expect(videoCodecCandidates(1280, 720)[0]).toBe('avc1.64001f')
    expect(videoCodecCandidates(1280, 1024)[0]).toBe('avc1.640020')
    expect(videoCodecCandidates(1920, 1080)).toEqual(['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'vp09.00.41.08'])
    expect(videoCodecCandidates(2560, 1440)[0]).toBe('avc1.640032')
    expect(videoCodecCandidates(3840, 2160)).toEqual(['avc1.640033', 'avc1.4d0033', 'avc1.42e033', 'vp09.00.51.08'])
    expect(videoCodecCandidates(7680, 4320)).toEqual(['avc1.640034', 'avc1.4d0034', 'avc1.42e034', 'vp09.00.61.08'])
    expect(mp4MimeType('avc1.640028')).toBe('video/mp4; codecs="avc1.640028"')
  })
})

describe('FrameEncoder', () => {
  it('configures the first supported codec at an even size, with a default bitrate', async () => {
    const { env, encoders } = fakeEnv((c) => c.startsWith('avc1.4d'))
    const encoder = await FrameEncoder.create(641, 361, 30, {}, env)
    expect([encoder.codec, encoder.width, encoder.height]).toEqual(['avc1.4d001e', 640, 360])
    const config = encoders[0]!.config!
    expect(config).toMatchObject({ codec: 'avc1.4d001e', width: 640, height: 360, framerate: 30, avc: { format: 'avc' } })
    expect(config.bitrate).toBe(Math.round(640 * 360 * 30 * 0.15))
  })

  it('falls back to VP9, and takes the codec and bitrate given', async () => {
    const vp9 = await FrameEncoder.create(320, 240, 25, {}, fakeEnv((c) => c.startsWith('vp09')).env)
    expect(vp9.codec).toBe('vp09.00.31.08')
    const { env, encoders } = fakeEnv()
    await FrameEncoder.create(320, 240, Number.NaN, { codec: 'vp09.00.10.08', videoBitsPerSecond: 1e6 }, env)
    expect(encoders[0]!.config).toMatchObject({ codec: 'vp09.00.10.08', bitrate: 1e6, framerate: 30 })
    expect(encoders[0]!.config!.avc).toBeUndefined()
  })

  it('tries each codec on one frame: a codec said supported that fails is skipped', async () => {
    const { env, encoders, trials } = fakeEnv(undefined, false, (c) => c.startsWith('avc1'))
    const encoder = await FrameEncoder.create(640, 360, 30, {}, env)
    expect(encoder.codec).toBe('vp09.00.31.08')
    expect(trials).toEqual(['avc1.64001e', 'avc1.4d001e', 'avc1.42e01e', 'vp09.00.31.08'])
    expect(encoders).toHaveLength(1)
    await expect(FrameEncoder.create(640, 360, 30, {}, fakeEnv(undefined, false, () => true).env)).rejects.toThrow(/cannot encode H.264 or VP9/)
    // An encoder that throws while configured counts as failing.
    const throwing = fakeEnv()
    const proto = (throwing.env.VideoEncoder as unknown as { prototype: { configure: unknown } }).prototype
    proto.configure = () => {
      throw new Error('configure failed')
    }
    await expect(FrameEncoder.create(64, 48, 30, {}, throwing.env)).rejects.toThrow(/cannot encode/)
  })

  it('reports what it cannot encode', async () => {
    const unsupported = (p: Promise<unknown>) => expect(p).rejects.toSatisfy((e) => e instanceof OuafError && e.code === 'unsupported')
    await unsupported(FrameEncoder.create(64, 48, 30, {}, { VideoEncoder: undefined }))
    await unsupported(FrameEncoder.create(64, 48, 30, {}, fakeEnv(() => false).env))
    await expect(FrameEncoder.create(64, 48, 30, { codec: 'avc1.640028' }, fakeEnv(() => false).env)).rejects.toThrow(/"avc1.640028"/)
    await expect(FrameEncoder.create(64, 48, 30, { codec: 'av01.0.04M.08' }, fakeEnv().env)).rejects.toThrow(/only H.264/)
    await expect(FrameEncoder.create(1, 48, 30, {}, fakeEnv().env)).rejects.toThrow(/1×48/)
    const throwing = fakeEnv().env
    ;(throwing.VideoEncoder as unknown as { isConfigSupported: unknown }).isConfigSupported = () => Promise.reject(new Error('no'))
    await unsupported(FrameEncoder.create(64, 48, 30, {}, throwing))
    await expect(FrameEncoder.create(64, 48, 30, { videoBitsPerSecond: 0 }, fakeEnv().env)).rejects.toThrow(RangeError)
  })

  it('encodes each frame at its media time, with a keyframe every interval, into an MP4', async () => {
    const { env, encoders, frames } = fakeEnv(undefined, true)
    const encoder = await FrameEncoder.create(64, 48, 30, { keyFrameInterval: 1 }, env)
    for (let i = 0; i < 75; i++) await encoder.encode(canvas(64, 48), i / 30)
    expect(frames.every((f) => f.closed)).toBe(true)
    expect(frames[1]!.init).toEqual({ timestamp: 33333 })
    const fake = encoders[0]!
    const keys = fake.log.flatMap((q, i) => (q.keyFrame ? [i] : []))
    expect(keys).toEqual([0, 30, 60])
    const blob = await encoder.finish(2.5)
    expect(fake.state).toBe('closed')
    expect(encoder.frameCount).toBe(75)
    const track = demuxMp4(new Uint8Array(await blob.arrayBuffer()))
    expect(track.codec).toBe('avc1.640028') // read from the avcC record the fake gives
    expect([...track.description!]).toEqual([...AVCC])
    expect(track.samples).toHaveLength(75)
    expect(track.samples.filter((s) => s.sync)).toHaveLength(3)
    expect(track.duration).toBeCloseTo(2.5, 4)
  })

  it('crops a frame larger than the encoded size, and starts a new run with a keyframe', async () => {
    const { env, encoders, frames } = fakeEnv()
    const encoder = await FrameEncoder.create(65, 49, 30, {}, env)
    await encoder.encode(canvas(65, 49), 0)
    await encoder.encode({ displayWidth: 64, displayHeight: 48 } as unknown as VideoFrame, 0.5)
    await encoder.encode(canvas(65, 49), 0.1)
    expect(frames[0]!.init.visibleRect).toEqual({ x: 0, y: 0, width: 64, height: 48 })
    expect(frames[1]!.init.visibleRect).toBeUndefined()
    expect(encoders[0]!.log.map((q) => q.keyFrame)).toEqual([true, false, true])
  })

  it('waits while the encoder queue is full', async () => {
    const { env, encoders } = fakeEnv()
    const encoder = await FrameEncoder.create(64, 48, 30, {}, env)
    for (let i = 0; i < 4; i++) await encoder.encode(canvas(64, 48), i / 30)
    let settled = false
    const fifth = encoder.encode(canvas(64, 48), 4 / 30).then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 30))
    expect(settled).toBe(false)
    encoders[0]!.drain()
    await fifth
    expect(settled).toBe(true)
    expect(encoder.frameCount).toBe(1)
  })

  it('rejects after an encoder error, and when no frame came out', async () => {
    const failing = fakeEnv()
    const encoder = await FrameEncoder.create(64, 48, 30, {}, failing.env)
    failing.encoders[0]!.init.error(new DOMException('GPU gone', 'EncodingError'))
    await expect(encoder.encode(canvas(64, 48), 0)).rejects.toThrow(/GPU gone/)
    await expect(encoder.finish()).rejects.toThrow(/GPU gone/)

    const empty = fakeEnv()
    const none = await FrameEncoder.create(64, 48, 30, {}, empty.env)
    await expect(none.finish()).rejects.toThrow(/no frame/)
    await expect(none.encode(canvas(64, 48), 0)).rejects.toThrow(/closed/)
    none.close()

    const flushFails = fakeEnv()
    const f = await FrameEncoder.create(64, 48, 30, {}, flushFails.env)
    flushFails.encoders[0]!.flush = () => Promise.reject(new Error('flush failed'))
    await f.encode(canvas(64, 48), 0)
    await expect(f.finish()).rejects.toThrow(/flush failed/)
  })

  it('reports a chunk the MP4 cannot take', async () => {
    const { env, encoders } = fakeEnv()
    const encoder = await FrameEncoder.create(64, 48, 30, {}, env)
    await encoder.encode(canvas(64, 48), 0)
    encoders[0]!.queue[0]!.keyFrame = false // the first frame out is not a keyframe
    encoders[0]!.drain()
    await expect(encoder.finish()).rejects.toThrow(/keyframe/)
  })

  it('checks the options', () => {
    expect(() => checkEncodingOptions({ videoBitsPerSecond: -1 })).toThrow(RangeError)
    expect(() => checkEncodingOptions({ videoBitsPerSecond: Infinity })).toThrow(RangeError)
    expect(() => checkEncodingOptions({ keyFrameInterval: 0 })).toThrow(RangeError)
    expect(() => checkEncodingOptions({ videoBitsPerSecond: 1e6, keyFrameInterval: 0.5 })).not.toThrow()
  })
})
