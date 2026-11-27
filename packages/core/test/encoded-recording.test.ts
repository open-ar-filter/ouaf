/**
 * `engine.record()` on WebCodecs (#137) with a fake encoder and clock: frames at their clock times, `frameRate`,
 * pauses left out of the timeline, frames dropped by a full encoder, the size fixed at the first frame, the fallback to
 * `MediaRecorder`, and what `done` gives when the encoder fails or nothing was recorded.
 */
import { describe, expect, it, vi } from 'vitest'
import { EncodedRecording, type EncodedRecordingEnv } from '../src/engine/encoded-recording.ts'
import type { Recording } from '../src/engine/outputs.ts'
import { demuxMp4 } from '../src/mp4.ts'
import { canvas, fakeEnv } from './fake-webcodecs.ts'

/** Lets the encoder start (codec check, trial frame). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup(env: Partial<EncodedRecordingEnv> = {}, options: { frameRate?: number } = {}, fallback: () => Recording = () => {
  throw new Error('no MediaRecorder')
}) {
  const fake = fakeEnv(undefined, true)
  let clock = 1000
  const ended = vi.fn()
  const recording = new EncodedRecording(options, { ...fake.env, now: () => clock, ...env }, fallback, ended)
  return {
    recording,
    fake,
    ended,
    /** Captures a frame `ms` after the previous one. */
    frame: (ms = 1000 / 30, surface = canvas(64, 48)) => {
      clock += ms
      recording.frame(surface)
    },
    advance: (ms: number) => (clock += ms),
  }
}

async function times(blob: Blob): Promise<number[]> {
  return demuxMp4(new Uint8Array(await blob.arrayBuffer())).samples.map((s) => Math.round(s.time * 1000))
}

describe('EncodedRecording', () => {
  it('records each frame at its clock time into an MP4, sized from the first frame', async () => {
    const { recording, frame, ended, fake } = setup()
    expect([recording.mimeType, recording.state]).toEqual(['video/mp4', 'recording'])
    frame(0) // starts the encoder: not recorded
    await settle()
    expect(recording.mimeType).toBe('video/mp4; codecs="avc1.64001e"')
    expect(fake.encoders[0]!.config).toMatchObject({ width: 64, height: 48, framerate: 30 })
    for (let i = 0; i < 5; i++) frame(i === 0 ? 0 : 40)
    await settle()
    const blob = await recording.stop()
    expect(recording.stop()).toBe(recording.stop())
    expect(await recording.done).toBe(blob)
    expect(recording.state).toBe('inactive')
    expect(ended).toHaveBeenCalled()
    expect(await times(blob)).toEqual([0, 40, 80, 120, 160])
    recording.frame(canvas(64, 48)) // after stop: ignored
  })

  it('leaves pauses out of the timeline and skips frames above frameRate', async () => {
    const { recording, frame, advance } = setup({}, { frameRate: 10 })
    frame(0)
    await settle()
    frame(0) // t = 0
    frame(50) // 50 ms: under 100 ms, skipped
    frame(60) // t = 110
    recording.pause()
    expect(recording.state).toBe('paused')
    frame(100) // paused: not recorded
    advance(5000)
    recording.resume()
    recording.resume() // not paused: nothing
    frame(100) // t = 110 + 100 (the pause and the frames in it do not count)
    await settle()
    expect(await times(await recording.stop())).toEqual([0, 110, 210])
  })

  it('drops frames while the encoder is behind', async () => {
    const fake = fakeEnv() // frames wait in the queue
    let clock = 0
    const recording = new EncodedRecording({}, { ...fake.env, now: () => (clock += 10) }, () => {
      throw new Error('unused')
    }, () => {})
    recording.frame(canvas(64, 48))
    await settle()
    for (let i = 0; i < 8; i++) recording.frame(canvas(64, 48))
    expect(fake.encoders[0]!.queue).toHaveLength(5)
    const blob = await recording.stop()
    expect((await times(blob)).length).toBe(5)
  })

  it('scales frames into the encoded size when the capture size changes', async () => {
    const drawn: unknown[][] = []
    const scaler = { width: 0, height: 0, getContext: () => ({ canvas: scaler, drawImage: (...args: unknown[]) => drawn.push(args) }) }
    const { recording, frame, fake } = setup({ createCanvas: () => scaler as unknown as OffscreenCanvas })
    frame(0, canvas(65, 49))
    await settle()
    frame(0, canvas(65, 49)) // odd: cropped by the encoder, not scaled
    const bigger = canvas(130, 98)
    frame(40, bigger)
    expect(drawn).toEqual([[bigger, 0, 0, 64, 48]])
    expect([scaler.width, scaler.height]).toEqual([64, 48])
    expect(fake.frames.at(-1)!.init.visibleRect).toBeUndefined()
    // Without a canvas to scale into, the frame is cropped.
    const crop = setup({ createCanvas: undefined })
    crop.frame(0)
    await settle()
    crop.frame(0, canvas(130, 98))
    expect(crop.fake.frames.at(-1)!.init.visibleRect).toEqual({ x: 0, y: 0, width: 64, height: 48 })
    await recording.stop()
    await crop.recording.stop()
  })

  it('falls back to MediaRecorder when no codec can encode the size', async () => {
    const media = { mimeType: 'video/webm;codecs=vp8', state: 'recording' as const, pause: vi.fn(), resume: vi.fn(), stop: vi.fn(() => Promise.resolve(new Blob(['webm']))), done: Promise.resolve(new Blob(['webm'])) }
    const ended = vi.fn()
    const recording = new EncodedRecording({}, { ...fakeEnv(() => false).env }, () => media, ended)
    recording.pause()
    recording.frame(canvas(64, 48)) // paused: does not start the encoder
    recording.resume()
    recording.frame(canvas(64, 48))
    await settle()
    expect(ended).toHaveBeenCalledOnce()
    expect([recording.mimeType, recording.state]).toEqual(['video/webm;codecs=vp8', 'recording'])
    recording.pause()
    recording.resume()
    recording.frame(canvas(64, 48))
    expect([media.pause.mock.calls.length, media.resume.mock.calls.length]).toEqual([1, 1])
    expect(await (await recording.done).text()).toBe('webm')
    expect(await (await recording.stop()).text()).toBe('webm')
    expect(media.stop).toHaveBeenCalledOnce()
  })

  it('a fallback started while paused is paused; none starts once stopped', async () => {
    const media = { mimeType: 'video/webm', state: 'paused' as const, pause: vi.fn(), resume: vi.fn(), stop: vi.fn(() => Promise.resolve(new Blob(['m']))), done: new Promise<Blob>(() => {}) }
    const recording = new EncodedRecording({}, { ...fakeEnv(() => false).env }, () => media, () => {})
    recording.frame(canvas(64, 48))
    recording.pause()
    await settle()
    expect(media.pause).toHaveBeenCalledOnce()
    expect(await (await recording.stop()).text()).toBe('m')
    // Stopped while the encoder was starting: nothing recorded, no fallback started.
    const fallback = vi.fn(() => media)
    const fresh = new EncodedRecording({}, { ...fakeEnv(() => false).env }, fallback, () => {})
    fresh.frame(canvas(64, 48))
    await expect(fresh.stop()).rejects.toThrow(/before its first frame/)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('rejects when nothing could be recorded', async () => {
    const before = setup()
    await expect(before.recording.stop()).rejects.toThrow(/before its first frame/)
    await expect(before.recording.done).rejects.toThrow(/before its first frame/)

    const noCodec = new EncodedRecording({}, { ...fakeEnv(() => false).env }, () => {
      throw new Error('no MediaRecorder')
    }, () => {})
    noCodec.frame(canvas(64, 48))
    await expect(noCodec.done).rejects.toThrow(/cannot encode/)
    expect(noCodec.state).toBe('inactive')

    // Stopped while the encoder starts: it is closed when ready.
    const early = setup()
    early.frame(0)
    const stopped = early.recording.stop()
    await expect(stopped).rejects.toThrow(/before its first frame/)
    expect(early.fake.encoders[0]!.state).toBe('closed')
    const late = new EncodedRecording({}, { ...fakeEnv(() => false).env }, () => {
      throw new Error('unused')
    }, () => {})
    late.frame(canvas(64, 48))
    await expect(late.stop()).rejects.toThrow(/before its first frame/)
  })

  it('stops itself when the encoder fails, with what it recorded', async () => {
    const { recording, frame, fake } = setup()
    frame(0)
    await settle()
    frame(0)
    frame(40)
    await settle() // two frames out
    fake.encoders[0]!.init.error(new DOMException('GPU gone', 'EncodingError'))
    frame(40)
    expect(recording.state).toBe('inactive')
    expect(await times(await recording.done)).toEqual([0, 40])

    const empty = setup()
    empty.frame(0)
    await settle()
    empty.fake.encoders[0]!.init.error(new DOMException('GPU gone', 'EncodingError'))
    empty.frame(0)
    await expect(empty.recording.done).rejects.toThrow(/GPU gone/)
  })
})
