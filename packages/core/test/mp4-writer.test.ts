/**
 * MP4 muxer of the frame-exact export (#137), read back with the demuxer of the offline source: codec strings and
 * configuration, frame times and durations, keyframes, reordered frames, fast start (`moov` before `mdat`), an audio
 * track copied next to the frames (interleaved, cut at the end of the video) and the errors on what it cannot write.
 */
import { describe, expect, it } from 'vitest'
import { demuxMp4, demuxMp4Audio } from '../src/mp4.ts'
import { Mp4Writer, type Mp4WriterAudio } from '../src/mp4-writer.ts'

const AVCC = Uint8Array.of(1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0, 0)
const frame = (i: number, size = 10 + i) => new Uint8Array(size).fill(i & 0xff)

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

/** Top-level boxes of a file: [type, size]. */
function topBoxes(data: Uint8Array): Array<[string, number]> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const out: Array<[string, number]> = []
  for (let p = 0; p + 8 <= data.byteLength; ) {
    let size = view.getUint32(p)
    const type = String.fromCharCode(...data.subarray(p + 4, p + 8))
    if (size === 1) size = view.getUint32(p + 8) * 2 ** 32 + view.getUint32(p + 12)
    out.push([type, size])
    p += size
  }
  return out
}

describe('Mp4Writer', () => {
  it('writes an H.264 track the demuxer reads back frame for frame', async () => {
    const writer = new Mp4Writer({ codec: 'avc1.640028', width: 640, height: 360, description: AVCC })
    for (let i = 0; i < 90; i++) writer.add(frame(i), i / 30, i % 30 === 0)
    expect(writer.frameCount).toBe(90)
    const blob = writer.finish(3)
    expect(blob.type).toBe('video/mp4')
    const data = await bytesOf(blob)
    expect(topBoxes(data).map(([t]) => t)).toEqual(['ftyp', 'moov', 'mdat'])

    const track = demuxMp4(data)
    expect(track.codec).toBe('avc1.640028')
    expect([...track.description!]).toEqual([...AVCC])
    expect([track.codedWidth, track.codedHeight, track.rotation]).toEqual([640, 360, 0])
    expect(track.duration).toBeCloseTo(3, 6)
    expect(track.samples).toHaveLength(90)
    track.samples.forEach((s, i) => {
      expect(s.time).toBeCloseTo(i / 30, 6)
      expect(s.duration).toBeCloseTo(1 / 30, 6)
      expect(s.sync).toBe(i % 30 === 0)
      expect([...data.subarray(s.offset, s.offset + s.size)]).toEqual([...frame(i)])
    })
  })

  it('writes VP9 with its vpcC box', async () => {
    const writer = new Mp4Writer({ codec: 'vp09.00.31.08', width: 320, height: 240 })
    writer.add(frame(0), 0, true)
    writer.add(frame(1), 0.04, false)
    const track = demuxMp4(await bytesOf(writer.finish()))
    expect(track.codec).toBe('vp09.00.31.08')
    expect(track.description).toBeUndefined()
    expect(track.samples.map((s) => s.time)).toEqual([0, 0.04])
    // Without `end`, the last frame lasts as long as the one before.
    expect(track.duration).toBeCloseTo(0.08, 6)
  })

  it('starts at 0 and keeps variable frame intervals', async () => {
    const writer = new Mp4Writer({ codec: 'avc1.42001f', width: 64, height: 48, description: AVCC })
    const times = [10, 10.1, 10.15, 10.4]
    times.forEach((t, i) => writer.add(frame(i), t, i === 0))
    const track = demuxMp4(await bytesOf(writer.finish(10.5)))
    expect(track.samples.map((s) => s.time)).toEqual(times.map((t) => expect.closeTo(t - 10, 4)))
    expect(track.samples.map((s) => s.duration)).toEqual([0.1, 0.05, 0.25, 0.1].map((d) => expect.closeTo(d, 4)))
    expect(track.duration).toBeCloseTo(0.5, 4)
  })

  it('gives reordered frames (B-frames) composition offsets', async () => {
    const writer = new Mp4Writer({ codec: 'avc1.640028', width: 64, height: 48, description: AVCC })
    // Decoding order I0 P3 B1 B2.
    ;[0, 3, 1, 2].forEach((k, i) => writer.add(frame(k), k / 30, i === 0))
    const track = demuxMp4(await bytesOf(writer.finish(4 / 30)))
    expect(track.samples.map((s) => Math.round(s.time * 30))).toEqual([0, 3, 1, 2])
    expect(track.samples.map((s) => s.size)).toEqual([10, 13, 11, 12])
    expect(track.duration).toBeCloseTo(4 / 30, 6)
  })

  it('writes a single frame of the default length, and ignores an end before the last frame', async () => {
    const one = new Mp4Writer({ codec: 'avc1.640028', width: 64, height: 48, description: AVCC })
    one.add(frame(0), 0, true)
    expect(demuxMp4(await bytesOf(one.finish())).duration).toBeCloseTo(1 / 30, 6)
    const two = new Mp4Writer({ codec: 'avc1.640028', width: 64, height: 48, description: AVCC })
    two.add(frame(0), 0, true)
    two.add(frame(1), 0.5, false)
    expect(demuxMp4(await bytesOf(two.finish(0.2))).duration).toBeCloseTo(1, 6)
  })

  it('rejects what it cannot write', () => {
    expect(() => new Mp4Writer({ codec: 'avc1.640028', width: 0, height: 48, description: AVCC })).toThrow(RangeError)
    expect(() => new Mp4Writer({ codec: 'avc1.640028', width: 70000, height: 48, description: AVCC })).toThrow(RangeError)
    expect(() => new Mp4Writer({ codec: 'avc1.640028', width: 64, height: 48 })).toThrow(/avcC/)
    expect(() => new Mp4Writer({ codec: 'vp09.bad', width: 64, height: 48 })).toThrow(/VP9/)
    expect(() => new Mp4Writer({ codec: 'av01.0.04M.08', width: 64, height: 48 })).toThrow(/Unsupported codec/)
    const writer = new Mp4Writer({ codec: 'avc1.640028', width: 64, height: 48, description: AVCC })
    expect(() => writer.finish()).toThrow(/No frame/)
    expect(() => writer.add(frame(0), 0, false)).toThrow(/keyframe/)
    expect(() => writer.add(frame(0), Number.NaN, true)).toThrow(/finite/)
  })

  describe('audio', () => {
    /** An AAC-like sample entry (version 0 `mp4a` with an `esds` box), as the demuxer rewrites it. */
    const ENTRY = Uint8Array.of(
      0, 0, 0, 56, 0x6d, 0x70, 0x34, 0x61, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 16, 0, 0, 0, 0, 0xbb, 0x80, 0, 0,
      0, 0, 0, 20, 0x65, 0x73, 0x64, 0x73, 0, 0, 0, 0, 3, 6, 0, 1, 0, 4, 1, 0x40,
    )
    const sample = (i: number) => new Uint8Array(4 + (i % 3)).fill(0x80 | (i & 0x7f))
    /** `count` samples of 1024 ticks at 48 kHz, the first at `start` s. */
    const audio = (count: number, start: number): Mp4WriterAudio => ({
      sampleEntry: ENTRY,
      timescale: 48000,
      samples: Array.from({ length: count }, (_, i) => ({ data: sample(i), time: start + (i * 1024) / 48000, duration: 1024 / 48000 })),
    })
    const video = (frames: number, first = 0) => {
      const writer = new Mp4Writer({ codec: 'avc1.640028', width: 64, height: 48, description: AVCC })
      for (let i = 0; i < frames; i++) writer.add(frame(i), first + i / 30, i % 30 === 0)
      return writer
    }

    it('copies the samples as given, interleaved with the frames, the encoder delay kept before 0', async () => {
      // 1 s of video; audio from −1024 ticks (AAC priming) to past the end: samples starting after 1 s are left out.
      const data = await bytesOf(video(30).finish(1, audio(50, -1024 / 48000)))
      expect(topBoxes(data).map(([t]) => t)).toEqual(['ftyp', 'moov', 'mdat'])
      const track = demuxMp4Audio(data)!
      expect([...track.sampleEntry]).toEqual([...ENTRY])
      expect([track.format, track.channels, track.sampleRate, track.timescale]).toEqual(['mp4a', 2, 48000, 48000])
      const kept = Math.ceil((1 + 1024 / 48000) / (1024 / 48000)) // samples starting before 1 s
      expect(track.samples).toHaveLength(kept)
      track.samples.forEach((s, i) => {
        expect(s.time * 48000, `sample ${i}`).toBeCloseTo(i * 1024 - 1024, 6)
        expect([...data.subarray(s.offset, s.offset + s.size)]).toEqual([...sample(i)])
      })
      // Every sample sits in the file before the first frame shown after it.
      const frames = demuxMp4(data).samples
      expect(frames).toHaveLength(30)
      for (const s of track.samples) {
        const next = frames.find((f) => f.time > s.time + 1e-9)
        if (next) expect(s.offset).toBeLessThan(next.offset)
      }
      expect(track.samples.at(-1)!.offset).toBeGreaterThan(frames[0]!.offset)
    })

    it('starts late audio with an empty edit, on the timeline of the first frame', async () => {
      const track = demuxMp4Audio(await bytesOf(video(30, 10).finish(11, audio(10, 10.5))))!
      expect(track.samples[0]!.time).toBeCloseTo(0.5, 3)
      expect(track.samples).toHaveLength(10)
      expect(demuxMp4(await bytesOf(video(30, 10).finish(11, audio(10, 10.5)))).duration).toBeCloseTo(1, 6)
    })

    it('keeps gaps between samples, and writes no audio track when no sample starts before the end', async () => {
      const gapped = audio(3, 0)
      const samples = [gapped.samples[0]!, gapped.samples[1]!, { ...gapped.samples[2]!, time: 0.5 }]
      const track = demuxMp4Audio(await bytesOf(video(30).finish(1, { ...gapped, samples })))!
      expect(track.samples.map((s) => s.time)).toEqual([0, 1024 / 48000, 0.5].map((t) => expect.closeTo(t, 6)))
      expect(demuxMp4Audio(await bytesOf(video(30).finish(1, audio(4, 2))))).toBeUndefined()
      expect(demuxMp4Audio(await bytesOf(video(30).finish(1, { ...gapped, samples: [] })))).toBeUndefined()
    })

    it('rejects an invalid timescale, entry or time', () => {
      expect(() => video(2).finish(undefined, { ...audio(2, 0), timescale: 0 })).toThrow(/timescale/)
      expect(() => video(2).finish(undefined, { ...audio(2, 0), timescale: 44100.5 })).toThrow(/timescale/)
      expect(() => video(2).finish(undefined, { ...audio(2, 0), sampleEntry: new Uint8Array(4) })).toThrow(/not a box/)
      const bad = audio(2, 0)
      expect(() => video(2).finish(undefined, { ...bad, samples: [{ ...bad.samples[0]!, time: Number.NEGATIVE_INFINITY }] })).toThrow(/finite/)
    })
  })
})
