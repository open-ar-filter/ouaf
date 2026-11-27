/**
 * MP4 demuxer (#32) on synthetic files: codec strings of each supported codec, composition offsets, keyframes, edit
 * lists, rotation, 64-bit boxes and offsets, the audio track and its sample description rewritten for another MP4,
 * and the explicit errors on what it cannot read. Real clips and forged
 * table counts are tested in sources.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { demuxMp4, demuxMp4Audio, Mp4Error } from '../src/mp4.ts'

const enc = new TextEncoder()

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) (out.set(p, o), (o += p.length))
  return out
}

/** A box: 32-bit size, fourcc, payload. */
const box = (type: string, ...payload: Uint8Array[]) => {
  const body = concat(...payload)
  const out = concat(new Uint8Array(4), enc.encode(type), body)
  new DataView(out.buffer).setUint32(0, out.length)
  return out
}
/** Big-endian 32-bit words. */
function u32(...words: number[]): Uint8Array {
  const out = new Uint8Array(words.length * 4)
  words.forEach((w, i) => new DataView(out.buffer).setUint32(i * 4, w >>> 0))
  return out
}
const bytes = (...b: number[]) => Uint8Array.from(b)

/** VisualSampleEntry of `type` (78 bytes of fields, width and height at 24 and 26), then its configuration boxes. */
const sampleEntry = (type: string, width: number, height: number, ...config: Uint8Array[]) =>
  box(type, new Uint8Array(24), u32((width << 16) | height), new Uint8Array(50), ...config)
const avc1 = () => sampleEntry('avc1', 64, 48, box('avcC', bytes(1, 0x64, 0x00, 0x28, 0xff)))

/** tkhd version 0 with a rotation matrix [a b 0; c d 0; 0 0 1]. */
const tkhd = (a: number, b: number, c: number, d: number, version = 0) => {
  const fields = version === 1 ? new Uint8Array(52) : new Uint8Array(40)
  fields[0] = version
  return box('tkhd', fields, u32(a * 0x10000, b * 0x10000, 0, c * 0x10000, d * 0x10000, 0, 0, 0, 0x40000000), u32(0, 0))
}

interface Options {
  frames?: number
  entry?: Uint8Array
  stsd?: Uint8Array
  /** Replaces the default boxes of stbl (by type); `null` leaves one out. */
  stbl?: Record<string, Uint8Array | null>
  more?: Uint8Array[]
  mdhd?: Uint8Array | null
  tkhd?: Uint8Array
  edts?: Uint8Array
  mvhd?: Uint8Array | null
  handler?: string
  /** Boxes before the video track in moov. */
  before?: Uint8Array[]
}

/** One video track of `frames` 10-byte samples in one chunk, at 30 fps; the chunk offset points into mdat. */
function mp4(o: Options = {}): Uint8Array {
  const frames = o.frames ?? 3
  const build = (chunkOffset: number) => {
    const tables: Record<string, Uint8Array | null> = {
      stsd: o.stsd ?? box('stsd', u32(0, 1), o.entry ?? avc1()),
      stts: box('stts', u32(0, 1, frames, 1)),
      stsc: box('stsc', u32(0, 1, 1, frames, 1)),
      stsz: box('stsz', u32(0, 10, frames)),
      stco: box('stco', u32(0, 1, chunkOffset)),
      ...o.stbl,
    }
    const stbl = box('stbl', ...Object.values(tables).filter((b): b is Uint8Array => b !== null), ...(o.more ?? []))
    const hdlr = box('hdlr', u32(0, 0), enc.encode(o.handler ?? 'vide'), new Uint8Array(13))
    const mdhd = o.mdhd === undefined ? box('mdhd', u32(0, 0, 0, 30, frames, 0)) : o.mdhd
    const mdia = box('mdia', ...(mdhd ? [mdhd] : []), hdlr, box('minf', stbl))
    const trak = box('trak', o.tkhd ?? tkhd(1, 0, 0, 1), ...(o.edts ? [o.edts] : []), mdia)
    const mvhd = o.mvhd === undefined ? box('mvhd', u32(0, 0, 0, 1000, 0), new Uint8Array(80)) : o.mvhd
    return box('moov', ...(mvhd ? [mvhd] : []), ...(o.before ?? []), trak)
  }
  const moovLength = build(0).length
  const ftyp = box('ftyp', enc.encode('isom'), u32(0x200), enc.encode('isomavc1'))
  return concat(ftyp, build(ftyp.length + moovLength + 8), box('mdat', new Uint8Array(frames * 10)))
}

const times = (data: Uint8Array) => demuxMp4(data).samples.map((s) => Math.round(s.time * 30))

describe('codecs', () => {
  it('H.264: profile, constraints and level in hex; avcC is the description', () => {
    const track = demuxMp4(mp4())
    expect(track.codec).toBe('avc1.640028')
    expect([...track.description!]).toEqual([1, 0x64, 0x00, 0x28, 0xff])
    expect([track.codedWidth, track.codedHeight]).toEqual([64, 48])
    const avc3 = demuxMp4(mp4({ entry: sampleEntry('avc3', 64, 48, box('avcC', bytes(1, 0x42, 0xc0, 0x1e))) }))
    expect(avc3.codec).toBe('avc3.42c01e')
  })

  it('H.265: profile space, tier, reversed compatibility flags, level, constraint bytes without trailing zeros', () => {
    // Main profile (1), main tier, compatibility flags 0x60000000 (profiles 1 and 2), level 93 (3.1), constraint 0x90.
    const hvcC = (byte1: number, constraints: number[]) => box('hvcC', bytes(1, byte1, 0x60, 0, 0, 0, ...constraints, 93, 0xf0, 0))
    expect(demuxMp4(mp4({ entry: sampleEntry('hvc1', 64, 48, hvcC(0x01, [0x90, 0, 0, 0, 0, 0])) })).codec).toBe('hvc1.1.6.L93.90')
    // Profile space B (2), high tier, profile 2, two constraint bytes.
    expect(demuxMp4(mp4({ entry: sampleEntry('hev1', 64, 48, hvcC(0x80 | 0x20 | 0x02, [0xb0, 0x01, 0, 0, 0, 0])) })).codec)
      .toBe('hev1.B2.6.H93.b0.1')
    expect(demuxMp4(mp4({ entry: sampleEntry('hvc1', 64, 48, hvcC(0x01, [0, 0, 0, 0, 0, 0])) })).codec).toBe('hvc1.1.6.L93')
  })

  it('VP9: profile, level and bit depth from vpcC, no description', () => {
    const track = demuxMp4(mp4({ entry: sampleEntry('vp09', 64, 48, box('vpcC', u32(0x01000000), bytes(0, 31, 0x80, 0))) }))
    expect(track.codec).toBe('vp09.00.31.08')
    expect(track.description).toBeUndefined()
  })

  it('AV1: profile, level, tier and bit depth from av1C', () => {
    const av1C = (byte1: number, byte2: number) => sampleEntry('av01', 64, 48, box('av1C', bytes(0x81, byte1, byte2, 0)))
    expect(demuxMp4(mp4({ entry: av1C(0x08, 0x00) })).codec).toBe('av01.0.08M.08')
    expect(demuxMp4(mp4({ entry: av1C(0x20 | 0x0d, 0x80 | 0x40) })).codec).toBe('av01.1.13H.10')
    expect(demuxMp4(mp4({ entry: av1C(0x40 | 0x10, 0x20) })).codec).toBe('av01.2.16M.12')
    expect(demuxMp4(mp4({ entry: av1C(0, 0) })).description?.[0]).toBe(0x81)
  })

  it('refuses encrypted tracks, other codecs and a missing configuration box', () => {
    expect(() => demuxMp4(mp4({ entry: sampleEntry('encv', 64, 48) }))).toThrow('Encrypted video tracks are not supported.')
    expect(() => demuxMp4(mp4({ entry: sampleEntry('mp4v', 64, 48) }))).toThrow(
      'Unsupported video codec "mp4v" (supported: H.264, H.265, VP9, AV1).',
    )
    expect(() => demuxMp4(mp4({ entry: sampleEntry('avc1', 64, 48) }))).toThrow('The "avc1" sample description has no "avcC" box.')
    expect(() => demuxMp4(mp4({ entry: sampleEntry('vp09', 64, 48) }))).toThrow(Mp4Error)
  })
})

describe('timing', () => {
  it('applies composition offsets (B-frames) from ctts', () => {
    // Decoding order I P B: presented at 0, 2, 1.
    const data = mp4({ more: [box('ctts', u32(0, 3, 1, 1, 1, 2, 1, 0))], edts: box('edts', box('elst', u32(0, 1, 3, 1, 0x10000))) })
    expect(times(data)).toEqual([0, 2, 1])
    expect(demuxMp4(data).duration).toBeCloseTo(3 / 30, 9)
  })

  it('marks keyframes from stss, every sample without it', () => {
    const data = mp4({ frames: 4, more: [box('stss', u32(0, 3, 1, 3, 99))] })
    expect(demuxMp4(data).samples.map((s) => s.sync)).toEqual([true, false, true, false])
    expect(demuxMp4(mp4()).samples.every((s) => s.sync)).toBe(true)
  })

  it('refuses a track that does not start with a keyframe', () => {
    expect(() => demuxMp4(mp4({ more: [box('stss', u32(0, 1, 2))] }))).toThrow('The video track does not start with a keyframe.')
  })

  it('edit list: an initial empty edit delays the track, the media time shifts it; later edits are ignored', () => {
    // Empty edit of 1 s (movie timescale 1000), then media from time 1 (1/30 s): the first frame is shown at 1 s - 1/30.
    const elst = box('elst', u32(0, 3, 1000, -1, 0x10000, 3000, 1, 0x10000, 500, 2, 0x10000))
    const track = demuxMp4(mp4({ edts: box('edts', elst) }))
    expect(track.samples.map((s) => s.time)).toEqual([0, 1, 2].map((i) => (i - 1) / 30 + 1))
  })

  it('edit list version 1: 64-bit durations and media times', () => {
    const elst = box('elst', u32(0x01000000, 2, 0, 500, -1, -1, 0x10000, 0, 3000, 0, 2, 0x10000))
    expect(demuxMp4(mp4({ edts: box('edts', elst) })).samples.map((s) => s.time)).toEqual([0, 1, 2].map((i) => (i - 2) / 30 + 0.5))
  })

  it('without a movie header, an empty edit adds no delay', () => {
    const elst = box('elst', u32(0, 2, 1000, -1, 0x10000, 3000, 0, 0x10000))
    expect(times(mp4({ mvhd: null, edts: box('edts', elst) }))).toEqual([0, 1, 2])
  })

  it('reads a version 1 media header and movie header', () => {
    const mdhd = box('mdhd', u32(0x01000000, 0, 0, 0, 0, 60, 0, 6))
    const mvhd = box('mvhd', u32(0x01000000, 0, 0, 0, 0, 1000, 0, 0), new Uint8Array(80))
    const elst = box('elst', u32(0, 1, 500, -1, 0x10000))
    const track = demuxMp4(mp4({ mdhd, mvhd, edts: box('edts', elst) }))
    expect(track.samples.map((s) => s.time)).toEqual([0.5, 0.5 + 1 / 60, 0.5 + 2 / 60])
    expect(track.samples[0]!.duration).toBeCloseTo(1 / 60, 12)
  })

  it('refuses a track without a timescale, or whose time-to-sample table is too short', () => {
    expect(() => demuxMp4(mp4({ mdhd: box('mdhd', u32(0, 0, 0, 0, 3, 0)) }))).toThrow('The video track has no timescale.')
    expect(() => demuxMp4(mp4({ stbl: { stts: box('stts', u32(0, 1, 2, 1)) } }))).toThrow(
      'The time-to-sample table is shorter than the sample list.',
    )
  })
})

describe('rotation (track matrix)', () => {
  it.each([
    [[1, 0, 0, 1], 0],
    [[0, 1, -1, 0], 90],
    [[-1, 0, 0, -1], 180],
    [[0, -1, 1, 0], 270],
  ] as const)('matrix %j: %i degrees', ([a, b, c, d], degrees) => {
    expect(demuxMp4(mp4({ tkhd: tkhd(a, b, c, d) })).rotation).toBe(degrees)
  })

  it('reads the matrix of a version 1 track header', () => {
    expect(demuxMp4(mp4({ tkhd: tkhd(0, 1, -1, 0, 1) })).rotation).toBe(90)
  })
})

describe('boxes and sample tables', () => {
  it('64-bit chunk offsets (co64), and 64-bit box sizes', () => {
    const base = mp4()
    const offset = demuxMp4(base).samples[0]!.offset
    // co64 is 4 bytes longer than stco: the mdat payload moves by 4.
    const data = mp4({ stbl: { stco: null, co64: box('co64', u32(0, 1, 0, offset + 4)) } })
    expect(demuxMp4(data).samples.map((s) => s.offset)).toEqual([offset + 4, offset + 14, offset + 24])

    // The same moov with a 16-byte header (size 1, then the 64-bit size).
    const moovAt = 24
    const view = new DataView(base.buffer)
    const moovSize = view.getUint32(moovAt)
    const large = concat(base.subarray(0, moovAt), u32(1), enc.encode('moov'), u32(0, moovSize + 8), base.subarray(moovAt + 8))
    // Every chunk offset after the header moves by 8.
    const stco = large.findIndex((_, i) => enc.encode('stco').every((c, k) => large[i + k] === c))
    new DataView(large.buffer).setUint32(stco + 12, offset + 8)
    expect(demuxMp4(large).samples[0]!.offset).toBe(offset + 8)
  })

  it('a last box of size 0 extends to the end of the file', () => {
    const base = mp4()
    const mdatAt = base.length - 38
    expect(new TextDecoder().decode(base.subarray(mdatAt + 4, mdatAt + 8))).toBe('mdat')
    new DataView(base.buffer).setUint32(mdatAt, 0)
    expect(demuxMp4(base).samples).toHaveLength(3)
  })

  it('skips non-video tracks and boxes before the video track', () => {
    const audio = box('trak', box('mdia', box('hdlr', u32(0, 0), enc.encode('soun'), new Uint8Array(13))))
    const empty = box('trak', box('tkhd', new Uint8Array(84)))
    expect(demuxMp4(mp4({ before: [box('udta', new Uint8Array(4)), audio, empty] })).codec).toBe('avc1.640028')
  })

  it('a track with no samples', () => {
    const track = demuxMp4(mp4({ frames: 0, stbl: { stsz: box('stsz', u32(0, 0, 0)), stts: box('stts', u32(0, 0)), stsc: box('stsc', u32(0, 0)) } }))
    expect(track.samples).toEqual([])
    expect(track.duration).toBe(0)
  })

  it('variable sample sizes, several chunks and sample-to-chunk runs', () => {
    const at = demuxMp4(mp4({ frames: 4 })).samples[0]!.offset
    // Sizes 5, 15, 10, 10; chunks [s0, s1] at `at`, [s2] at `at + 20`, [s3] at `at + 30` (all inside the file).
    const data = mp4({
      frames: 4,
      stbl: {
        stsz: box('stsz', u32(0, 0, 4, 5, 15, 10, 10)),
        stsc: box('stsc', u32(0, 2, 1, 2, 1, 2, 1, 1)),
        stco: box('stco', u32(0, 3, at, at + 20, at + 30)),
      },
    })
    const track = demuxMp4(data)
    expect(track.samples.map((s) => [s.offset - at, s.size])).toEqual([[0, 5], [5, 15], [20, 10], [30, 10]])
  })
})

describe('errors', () => {
  it('not an MP4, no moov, fragmented, no video track', () => {
    expect(() => demuxMp4(new Uint8Array(4))).toThrow('This is not an MP4 file.')
    expect(() => demuxMp4(concat(box('ftyp', enc.encode('isom')), box('mdat', new Uint8Array(4))))).toThrow(
      'The file has no "moov" box (not an MP4 file, or truncated).',
    )
    expect(() => demuxMp4(concat(box('ftyp', enc.encode('iso5')), box('moof', new Uint8Array(8))))).toThrow(
      'Fragmented MP4 files are not supported.',
    )
    expect(() => demuxMp4(mp4({ handler: 'soun' }))).toThrow('The file has no video track.')
  })

  it('missing boxes of the video track', () => {
    expect(() => demuxMp4(mp4({ mdhd: null }))).toThrow('The video track has no "mdhd" box.')
    expect(() => demuxMp4(mp4({ stbl: { stsd: null } }))).toThrow('The video track has no "stsd" box.')
    expect(() => demuxMp4(mp4({ stbl: { stsc: null } }))).toThrow('The video track has no "stsc" box.')
    expect(() => demuxMp4(mp4({ stbl: { stts: null } }))).toThrow('The video track has no "stts" box.')
    expect(() => demuxMp4(mp4({ stbl: { stsz: null } }))).toThrow('The video track has no sample size table.')
    expect(() => demuxMp4(mp4({ stbl: { stco: null } }))).toThrow('The video track has no chunk offset table.')
    expect(() => demuxMp4(mp4({ tkhd: box('free') }))).toThrow('The video track has no "tkhd" box.')
  })

  it('a sample description without entries', () => {
    expect(() => demuxMp4(mp4({ stsd: box('stsd', u32(0, 0)) }))).toThrow('The video track has no sample description.')
    expect(() => demuxMp4(mp4({ stsd: box('stsd', u32(0, 1)) }))).toThrow('The video track has no sample description.')
  })

  it('a truncated stz2, a sample beyond the end of the file, a sample-to-chunk table that is too short', () => {
    expect(() => demuxMp4(mp4({ stbl: { stsz: null, stz2: box('stz2', u32(0, 8)) } }))).toThrow('The "stz2" box is truncated.')
    const base = mp4()
    const offset = demuxMp4(base).samples[0]!.offset
    expect(() => demuxMp4(mp4({ stbl: { stco: box('stco', u32(0, 1, offset + 20)) } }))).toThrow(
      'The file is truncated: a sample lies beyond its end.',
    )
    expect(() => demuxMp4(mp4({ stbl: { stsc: box('stsc', u32(0, 1, 1, 2, 1)) } }))).toThrow(
      'The sample-to-chunk table does not cover every sample.',
    )
  })

  it('stops reading boxes at a malformed header', () => {
    // A box claiming more bytes than the file: the top level has only ftyp, hence no moov.
    const data = concat(box('ftyp', enc.encode('isom')), u32(1000), enc.encode('moov'))
    expect(() => demuxMp4(data)).toThrow(/no "moov" box/)
    // A 64-bit size header cut short, and a size below the header size.
    expect(() => demuxMp4(concat(box('ftyp', enc.encode('isom')), u32(1), enc.encode('moov')))).toThrow(/no "moov" box/)
    expect(() => demuxMp4(concat(box('ftyp', enc.encode('isom')), u32(4), enc.encode('moov')))).toThrow(/no "moov" box/)
  })
})

/** 16-bit big-endian words. */
function u16(...words: number[]): Uint8Array {
  const out = new Uint8Array(words.length * 2)
  words.forEach((w, i) => new DataView(out.buffer).setUint16(i * 2, w))
  return out
}

interface Sound {
  version?: number
  channels?: number
  sampleSize?: number
  rate?: number
  /** QuickTime version 2: the rate as a float64 and the channels as a 32-bit word. */
  rate64?: number
  channels32?: number
}

/** A SoundSampleEntry of `type` (version 0, 1 or 2 fields), then its boxes. */
function soundEntry(type: string, o: Sound, ...boxes: Uint8Array[]): Uint8Array {
  const version = o.version ?? 0
  const head = concat(new Uint8Array(6), u16(1), u16(version, 0), new Uint8Array(4), u16(o.channels ?? 2, o.sampleSize ?? 16, 0, 0), u32((o.rate ?? 48000) * 65536))
  const more = version === 1 ? new Uint8Array(16) : version === 2 ? new Uint8Array(36) : new Uint8Array(0)
  if (version === 2) {
    const view = new DataView(more.buffer)
    view.setFloat64(4, o.rate64 ?? 48000)
    view.setUint32(12, o.channels32 ?? 2)
  }
  return box(type, head, more, ...boxes)
}

const ESDS = box('esds', u32(0), bytes(3, 25, 0, 1, 0, 4, 17, 0x40, 0x15))
const aac = () => soundEntry('mp4a', {}, ESDS)

interface AudioOptions {
  entry?: Uint8Array
  samples?: number
  edts?: Uint8Array
  stbl?: Record<string, Uint8Array | null>
  mdhd?: Uint8Array
}

/** A file with the video track of `mp4()` and an audio track of `samples` 4-byte samples of 1024 ticks at 48 kHz. */
function withAudio(o: AudioOptions = {}): Uint8Array {
  const n = o.samples ?? 4
  const trak = (chunkOffset: number) => {
    const tables: Record<string, Uint8Array | null> = {
      stsd: box('stsd', u32(0, 1), o.entry ?? aac()),
      stts: box('stts', u32(0, 1, n, 1024)),
      stsc: box('stsc', u32(0, 1, 1, n, 1)),
      stsz: box('stsz', u32(0, 4, n)),
      stco: box('stco', u32(0, 1, chunkOffset)),
      ...o.stbl,
    }
    const stbl = box('stbl', ...Object.values(tables).filter((b): b is Uint8Array => b !== null))
    const hdlr = box('hdlr', u32(0, 0), enc.encode('soun'), new Uint8Array(13))
    const mdhd = o.mdhd ?? box('mdhd', u32(0, 0, 0, 48000, n * 1024, 0))
    return box('trak', tkhd(1, 0, 0, 1), ...(o.edts ? [o.edts] : []), box('mdia', mdhd, hdlr, box('minf', stbl)))
  }
  // The audio samples point at the start of the media data (the video's 30 bytes hold them).
  const at = demuxMp4(mp4({ before: [trak(0)] })).samples[0]!.offset
  return mp4({ before: [trak(at)] })
}

describe('audio track', () => {
  it('reads an AAC track: format, channels, rate, samples, and the encoder delay of the edit list', () => {
    const data = withAudio({ edts: box('edts', box('elst', u32(0, 1, 3000, 1024, 0x10000))) })
    const track = demuxMp4Audio(data)!
    expect([track.format, track.channels, track.sampleRate, track.timescale]).toEqual(['mp4a', 2, 48000, 48000])
    expect(track.samples.map((s) => s.time * 48000)).toEqual([-1024, 0, 1024, 2048].map((t) => expect.closeTo(t, 6)))
    expect(track.samples.every((s) => s.size === 4 && s.sync)).toBe(true)
    expect(track.duration).toBeCloseTo(3072 / 48000, 9)
    // The video track is read as before.
    expect(demuxMp4(data).samples).toHaveLength(3)
  })

  it('rewrites the description as a version 0 entry holding the configuration box as is', () => {
    const entry = demuxMp4Audio(withAudio())!.sampleEntry
    expect([...entry]).toEqual([...aac()])
    // QuickTime version 1, `esds` inside a `wave` box: the same entry.
    const quicktime = soundEntry('mp4a', { version: 1 }, box('wave', box('frma', enc.encode('mp4a')), ESDS))
    expect([...demuxMp4Audio(withAudio({ entry: quicktime }))!.sampleEntry]).toEqual([...aac()])
  })

  it('QuickTime version 2: the rate and channels of the extended fields; above 65535 Hz the entry rate is 0', () => {
    const opus = soundEntry('Opus', { version: 2, channels: 3, rate: 1, rate64: 96000, channels32: 6 }, box('dOps', bytes(0, 6)))
    const track = demuxMp4Audio(withAudio({ entry: opus }))!
    expect([track.format, track.channels, track.sampleRate]).toEqual(['Opus', 6, 96000])
    expect([...track.sampleEntry]).toEqual([...soundEntry('Opus', { channels: 6, rate: 0 }, box('dOps', bytes(0, 6)))])
  })

  it('a rate of 0 is taken from the timescale; FLAC is read too', () => {
    const flac = soundEntry('fLaC', { rate: 0, sampleSize: 0 }, box('dfLa', u32(0)))
    const track = demuxMp4Audio(withAudio({ entry: flac, mdhd: box('mdhd', u32(0, 0, 0, 44100, 4096, 0)) }))!
    expect([track.format, track.sampleRate, track.timescale]).toEqual(['fLaC', 44100, 44100])
    expect([...track.sampleEntry]).toEqual([...soundEntry('fLaC', { rate: 44100 }, box('dfLa', u32(0)))])
  })

  it('a file without an audio track, or with an empty one', () => {
    expect(demuxMp4Audio(mp4())).toBeUndefined()
    const empty = withAudio({ samples: 0, stbl: { stsz: box('stsz', u32(0, 0, 0)), stts: box('stts', u32(0, 0)), stsc: box('stsc', u32(0, 0)) } })
    expect(demuxMp4Audio(empty)!.samples).toEqual([])
  })

  it('refuses other codecs, encrypted tracks, broken descriptions and tables, naming the audio track', () => {
    const fails = (o: AudioOptions) => () => demuxMp4Audio(withAudio(o))
    expect(fails({ entry: soundEntry('twos', {}) })).toThrow('Unsupported audio codec "twos" (supported: AAC, Opus, FLAC).')
    expect(fails({ entry: soundEntry('enca', {}) })).toThrow('Encrypted audio tracks are not supported.')
    expect(fails({ entry: soundEntry('mp4a', {}) })).toThrow('The "mp4a" sample description has no "esds" box.')
    expect(fails({ entry: box('mp4a', new Uint8Array(20)) })).toThrow('The "mp4a" sample description is truncated.')
    expect(fails({ entry: box('mp4a', soundEntry('mp4a', { version: 1 }).subarray(8, 44)) })).toThrow('The "mp4a" sample description is truncated.')
    expect(fails({ entry: soundEntry('mp4a', { version: 3 }, ESDS) })).toThrow('The "mp4a" sample description has an unknown version (3).')
    expect(fails({ stbl: { stsz: null } })).toThrow('The audio track has no sample size table.')
    expect(fails({ stbl: { stsd: box('stsd', u32(0, 0)) } })).toThrow('The audio track has no sample description.')
    expect(fails({ mdhd: box('mdhd', u32(0, 0, 0, 0, 0, 0)) })).toThrow('The audio track has no timescale.')
    expect(fails({ stbl: { stsz: box('stsz', u32(0, 1000, 4)) } })).toThrow(/The audio track's samples add up to 4000 bytes/)
    expect(() => demuxMp4Audio(new Uint8Array(4))).toThrow(Mp4Error)
  })
})
