/**
 * MP4 muxer of the frame-exact export (#137), read back with the demuxer of the offline source: codec strings and
 * configuration, frame times and durations, keyframes, reordered frames, fast start (`moov` before `mdat`) and the
 * errors on what it cannot write.
 */
import { describe, expect, it } from 'vitest'
import { demuxMp4 } from '../src/mp4.ts'
import { Mp4Writer } from '../src/mp4-writer.ts'

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
})
