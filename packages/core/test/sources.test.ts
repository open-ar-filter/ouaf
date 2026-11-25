import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createFaceFrame, type FaceFrame } from '../src/face.ts'
import { demuxMp4, Mp4Error } from '../src/mp4.ts'
import { deriveSeed, FILE_SOURCE_SEED, SeededRandom, checkSeed } from '../src/random.ts'
import { TrackingHub } from '../src/engine/tracking.ts'
import type { FrameTracker } from '../src/engine/plugin.ts'

const clip = (name: string) => new Uint8Array(readFileSync(new URL(`../../../test-media/${name}`, import.meta.url)))

describe('demuxMp4', () => {
  it('lists the frames of an H.264 clip with B-frames, in decoding order, at their presentation times', () => {
    const track = demuxMp4(clip('pesquet-closeup-360.mp4'))
    expect(track.codec).toBe('avc1.4d401e')
    expect(track.description?.[0]).toBe(1) // avcC configurationVersion
    expect([track.codedWidth, track.codedHeight, track.rotation]).toEqual([360, 640, 0])
    expect(track.samples).toHaveLength(93)
    expect(track.duration).toBeCloseTo(3.1, 9)
    // Decoding order differs from presentation order (ffprobe: pts 0, 0.1333, 0.0667, 0.0333, 0.1…).
    expect(track.samples.slice(0, 5).map((s) => Math.round(s.time * 30))).toEqual([0, 4, 2, 1, 3])
    expect(track.samples[0]).toMatchObject({ offset: 1936, size: 12731, sync: true })
    expect(track.samples.filter((s) => s.sync).length).toBeGreaterThan(0)
    const times = track.samples.map((s) => s.time).sort((a, b) => a - b)
    times.forEach((t, i) => expect(t).toBeCloseTo(i / 30, 9))
  })

  it('reads every committed clip', () => {
    for (const name of ['two-faces.mp4', 'pesquet-talk-360.mp4', 'no-face.mp4']) {
      const track = demuxMp4(clip(name))
      expect(track.codec).toMatch(/^avc1\./)
      expect(track.samples.length).toBeGreaterThan(60)
    }
  })

  it('rejects what it cannot read with an explicit error', () => {
    expect(() => demuxMp4(new Uint8Array(64))).toThrow(Mp4Error)
    expect(() => demuxMp4(new TextEncoder().encode('<!doctype html><html></html>'))).toThrow(/not an MP4/)
    const truncated = clip('no-face.mp4').slice(0, 5000)
    expect(() => demuxMp4(truncated)).toThrow(Mp4Error)
  })
})

/** A box: 32-bit size, fourcc, payload. */
function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const size = 8 + payload.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(size)
  new DataView(out.buffer).setUint32(0, size)
  out.set(new TextEncoder().encode(type), 4)
  let p = 8
  for (const part of payload) {
    out.set(part, p)
    p += part.length
  }
  return out
}

/** Big-endian 32-bit words. */
function u32(...words: number[]): Uint8Array {
  const out = new Uint8Array(words.length * 4)
  words.forEach((w, i) => new DataView(out.buffer).setUint32(i * 4, w))
  return out
}

type Tables = Partial<Record<'stts' | 'stsc' | 'stsz' | 'stco' | 'edts', Uint8Array>> & {
  readonly more?: readonly Uint8Array[]
}

/**
 * A synthetic one-track H.264 MP4 of `frames` 10-byte samples in one chunk, at 30 fps (no picture data: the demuxer
 * does not decode). `tables` replaces sample tables by forged ones (`stsz` may be an `stz2` box, `stco` a `co64`),
 * `more` adds boxes to `stbl` and `edts` adds an edit list box.
 */
function syntheticMp4(frames: number, tables: Tables = {}): Uint8Array {
  const avcC = box('avcC', new Uint8Array([1, 0x42, 0xc0, 0x1e, 0xff, 0xe0, 0]))
  const avc1 = box('avc1', new Uint8Array(24), u32((64 << 16) | 48), new Uint8Array(50), avcC)
  const stbl = box(
    'stbl',
    box('stsd', u32(0, 1), avc1),
    tables.stts ?? box('stts', u32(0, 1, frames, 1)),
    tables.stsc ?? box('stsc', u32(0, 1, 1, frames, 1)),
    tables.stsz ?? box('stsz', u32(0, 10, frames)),
    tables.stco ?? box('stco', u32(0, 1, 0)), // chunk offset patched below
    ...(tables.more ?? []),
  )
  const hdlr = box('hdlr', u32(0, 0), new TextEncoder().encode('vide'), new Uint8Array(13))
  const mdia = box('mdia', box('mdhd', u32(0, 0, 0, 30, frames, 0)), hdlr, box('minf', stbl))
  const tkhd = box('tkhd', new Uint8Array(40), u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000), u32(0, 0))
  const trak = box('trak', tkhd, ...(tables.edts ? [tables.edts] : []), mdia)
  const moov = box('moov', box('mvhd', u32(0, 0, 0, 1000, 0), new Uint8Array(80)), trak)
  const mdat = box('mdat', new Uint8Array(frames * 10))
  const file = new Uint8Array(moov.length + mdat.length)
  file.set(moov)
  file.set(mdat, moov.length)
  if (!tables.stco) new DataView(file.buffer).setUint32(boxAt(file, 'stco') + 16, moov.length + 8) // mdat payload
  return file
}

/** Offset of the first box of `type` (its size field). */
function boxAt(file: Uint8Array, type: string): number {
  const code = new TextEncoder().encode(type)
  for (let i = 4; i + 4 <= file.length; i++) if (code.every((c, k) => file[i + k] === c)) return i - 4
  throw new Error(`No "${type}" box.`)
}

describe('demuxMp4 on forged files (#123)', () => {
  const forged = (tables: Tables) => () => demuxMp4(syntheticMp4(3, tables))

  it('reads the synthetic file the forged ones derive from', () => {
    const track = demuxMp4(syntheticMp4(3))
    expect(track.codec).toBe('avc1.42c01e')
    expect([track.codedWidth, track.codedHeight]).toEqual([64, 48])
    expect(track.samples.map((s) => [s.size, Math.round(s.time * 30), s.sync])).toEqual([
      [10, 0, true],
      [10, 1, true],
      [10, 2, true],
    ])
    expect(track.samples[1]!.offset - track.samples[0]!.offset).toBe(10)
  })

  it('refuses a constant-size stsz declaring 2³² − 1 samples at once, before allocating its tables', () => {
    const start = performance.now()
    // An Mp4Error (not a RangeError from a failed allocation) shows that the count was refused before
    // `new Uint32Array`.
    expect(forged({ stsz: box('stsz', u32(0, 10, 0xffffffff)) })).toThrow(Mp4Error)
    expect(forged({ stsz: box('stsz', u32(0, 10, 0xffffffff)) })).toThrow(
      /4294967295 samples, more than a \d+-byte file/,
    )
    expect(performance.now() - start).toBeLessThan(500)
  })

  it('refuses a constant-size count above the file size and a variable-size count above its payload', () => {
    const size = syntheticMp4(3).length
    expect(forged({ stsz: box('stsz', u32(0, 1, size + 1)) })).toThrow(/samples, more than/)
    expect(forged({ stsz: box('stsz', u32(0, 0, 4, 10, 10, 10)) })).toThrow(/"stsz" box declares 4 entries/)
    expect(forged({ stsz: box('stsz', u32(0, 0, 0xffffffff)) })).toThrow(/"stsz" box declares 4294967295 entries/)
    expect(forged({ stsz: box('stsz', u32(0)) })).toThrow(/"stsz" box is truncated/)
  })

  it('refuses sample sizes that add up to more than the file', () => {
    const size = syntheticMp4(3).length
    // Fewer samples than bytes, but at 100 bytes each they cannot all fit.
    expect(forged({ stsz: box('stsz', u32(0, 100, Math.ceil(size / 50))) })).toThrow(/samples add up to/)
    expect(forged({ stsz: box('stsz', u32(0, 0, 3, size, 10, 10)) })).toThrow(/samples add up to/)
    const sizes16 = new Uint8Array(6)
    new DataView(sizes16.buffer).setUint16(0, size)
    new DataView(sizes16.buffer).setUint16(2, 10)
    expect(forged({ stsz: box('stz2', u32(0, 16, 3), sizes16) })).toThrow(/samples add up to/)
  })

  it('checks stz2 against its payload and field size', () => {
    const stz2 = (field: number, count: number, ...bytes: number[]) =>
      box('stz2', u32(0, field, count), new Uint8Array(bytes))
    expect(demuxMp4(syntheticMp4(3, { stsz: stz2(8, 3, 10, 10, 10) })).samples.map((s) => s.size)).toEqual([10, 10, 10])
    expect(demuxMp4(syntheticMp4(3, { stsz: stz2(4, 3, 0xaa, 0xa0) })).samples.map((s) => s.size)).toEqual([10, 10, 10])
    expect(forged({ stsz: stz2(4, 5, 0xaa, 0xa0) })).toThrow(/"stz2" box declares 5 entries/)
    expect(forged({ stsz: stz2(16, 0xffffffff, 0, 10) })).toThrow(/"stz2" box declares 4294967295 entries/)
    expect(forged({ stsz: stz2(12, 3, 0, 0, 0, 0, 0) })).toThrow(/invalid field size/)
  })

  it('checks the entry count of the other tables against their payload before looping', () => {
    expect(forged({ stts: box('stts', u32(0, 0xffffffff, 3, 1)) })).toThrow(/"stts" box declares 4294967295 entries/)
    expect(forged({ stts: box('stts', u32(0, 2, 3, 1)) })).toThrow(/"stts" box declares 2 entries/)
    expect(forged({ stts: box('stts', u32(0)) })).toThrow(/"stts" box is truncated/)
    expect(forged({ stsc: box('stsc', u32(0, 0xffffffff, 1, 3, 1)) })).toThrow(/"stsc" box declares/)
    expect(forged({ stco: box('stco', u32(0, 0xffffffff, 0)) })).toThrow(/"stco" box declares/)
    expect(forged({ stco: box('co64', u32(0, 2, 0, 0)) })).toThrow(/"co64" box declares 2 entries/)
    expect(forged({ more: [box('ctts', u32(0, 0xffffffff, 3, 0))] })).toThrow(/"ctts" box declares/)
    expect(forged({ more: [box('stss', u32(0, 2, 1))] })).toThrow(/"stss" box declares 2 entries/)
    expect(forged({ edts: box('edts', box('elst', u32(0, 0xffffffff, 3, 0, 0x10000))) })).toThrow(/"elst" box declares/)
    // 16 bytes: one version 0 entry, not a version 1 one.
    expect(forged({ edts: box('edts', box('elst', u32(0x01000000, 1, 0, 3, 0, 0))) })).toThrow(
      /"elst" box declares 1 entries/,
    )
  })

  it('stops at the end of the chunk table on an empty sample-to-chunk run', () => {
    // 0 samples per chunk over chunks 1 to 2³² − 2, past the 1-chunk offset table: the loop stops at the table end.
    expect(forged({ stsc: box('stsc', u32(0, 2, 1, 0, 1, 0xffffffff, 3, 1)) })).toThrow(/does not cover every sample/)
  })
})

describe('SeededRandom', () => {
  it('gives the same sequence for the same seed, in [0, 1)', () => {
    const a = new SeededRandom(42)
    const b = new SeededRandom(42)
    const xs = Array.from({ length: 1000 }, () => a.next())
    expect(Array.from({ length: 1000 }, () => b.next())).toEqual(xs)
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length
    expect(mean).toBeGreaterThan(0.45)
    expect(mean).toBeLessThan(0.55)
    a.reseed(42)
    expect(a.next()).toBe(xs[0])
    expect(new SeededRandom(43).next()).not.toBe(xs[0])
  })

  it('derives independent seeds per filter and layer', () => {
    const seeds = new Set([deriveSeed(FILE_SOURCE_SEED, 'a'), deriveSeed(FILE_SOURCE_SEED, 'b'), deriveSeed(FILE_SOURCE_SEED, 'a', 0), deriveSeed(FILE_SOURCE_SEED, 'a', 1), deriveSeed(1, 'a')])
    expect(seeds.size).toBe(5)
    expect(deriveSeed(7, 'ab', 'c')).not.toBe(deriveSeed(7, 'a', 'bc'))
    expect(deriveSeed(7, 'x')).toBe(deriveSeed(7, 'x'))
  })

  it('checks host seeds', () => {
    expect(checkSeed(0)).toBe(0)
    expect(checkSeed(4294967295)).toBe(4294967295)
    expect(() => checkSeed(-1)).toThrow(RangeError)
    expect(() => checkSeed(1.5)).toThrow(RangeError)
  })
})

/** A tracker that writes `count = mediaTime` and resolves when the test says so. */
function asyncTracker() {
  const pending: Array<() => void> = []
  const calls: string[] = []
  const tracker: FrameTracker = {
    description: 'fake',
    track(_input, _ts, mediaTime, out: FaceFrame) {
      calls.push(`track ${mediaTime}`)
      return new Promise<void>((resolve) => {
        pending.push(() => {
          out.count = 1
          out.mediaTime = mediaTime
          resolve()
        })
      })
    },
    trackImage(_input, mediaTime, out) {
      calls.push(`image ${mediaTime}`)
      out.count = 1
      out.mediaTime = mediaTime
    },
    reset: () => void calls.push('reset'),
    configure: () => {},
    dispose: () => {},
  }
  return { tracker, pending, calls }
}

async function hub(tracker: FrameTracker) {
  const onError = vi.fn()
  const h = new TrackingHub({ impl: { id: 'fake', create: async () => tracker }, env: { assetsBaseUrl: '/', warn: () => {} }, maxFaces: 1, modifiers: [], onError })
  await h.setNeeds({ face: true, blendshapes: false })
  return { h, onError }
}

const input = {} as HTMLCanvasElement

describe('TrackingHub (file sources)', () => {
  it('track() waits for the call in flight, then resolves with this frame as the front result', async () => {
    const { tracker, pending, calls } = asyncTracker()
    const { h } = await hub(tracker)
    h.submit(input, 0, 1) // a live submit still in flight
    let done = false
    const tracked = h.track(input, 2000, 2).then(() => (done = true))
    await Promise.resolve()
    expect(calls).toEqual(['track 1'])
    pending.shift()!()
    await vi.waitFor(() => expect(calls).toEqual(['track 1', 'track 2']))
    expect(done).toBe(false)
    pending.shift()!()
    await tracked
    expect(h.faces.mediaTime).toBe(2)
    expect(h.results).toBe(2)
  })

  it('measures the rate on the clock of the results, whatever the media time of the frames', async () => {
    const { tracker } = asyncTracker()
    const { h } = await hub(tracker)
    let clock = 50_000
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      // Frames 1/30 s apart in media time, each tracked in 10 ms: 100 results a second.
      for (let i = 0; i < 20; i++) {
        clock += 10
        await h.track(input, (i * 1000) / 30, i / 30, true)
      }
      expect(h.rateHz).toBeCloseTo(100, 5)
      expect(h.pipelineMs).toBe(0)
    } finally {
      now.mockRestore()
    }
  })

  it('tracks still images with trackImage and resets the tracker on demand', async () => {
    const { tracker, calls } = asyncTracker()
    const { h } = await hub(tracker)
    await h.resetTracker()
    await h.track(input, 0, 0, true)
    expect(calls).toEqual(['reset', 'image 0'])
    expect(h.faces.count).toBe(1)
  })

  it('clear() empties the result and drops a call in flight', async () => {
    const { tracker, pending } = asyncTracker()
    const { h } = await hub(tracker)
    h.submit(input, 0, 1)
    const before = h.results
    h.clear()
    expect(h.faces.count).toBe(0)
    pending.shift()!()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.faces.count).toBe(0) // the old source's result is not shown
    expect(h.results).toBe(before + 1)
  })

  it('reports a failing track() and resolves', async () => {
    const tracker: FrameTracker = { description: 'x', track: () => Promise.reject(new Error('boom')), configure: () => {}, dispose: () => {} }
    const { h, onError } = await hub(tracker)
    await h.track(input, 0, 0)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }))
    await h.track(input, 1, 1) // not stuck busy
    expect(onError).toHaveBeenCalledTimes(2)
  })
})
