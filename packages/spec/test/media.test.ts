/**
 * Header sniffing (spec §10.4): the less common layouts of each format, and malformed headers, on synthetic bytes.
 * The common cases are in packages/cli/test/media.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { sniff } from '../src/index.ts'

const enc = new TextEncoder()
const bytes = (s: string) => enc.encode(s)
function concat(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)))
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0))
  let o = 0
  for (const a of arrays) (out.set(a, o), (o += a.length))
  return out
}
const u16be = (v: number) => [(v >> 8) & 0xff, v & 0xff]
const u32be = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
const u16le = (v: number) => [v & 0xff, (v >> 8) & 0xff]
const u32le = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
const box = (type: string, ...payload: Array<Uint8Array | number[]>) => {
  const body = concat(...payload)
  return concat(u32be(8 + body.length), bytes(type), body)
}

describe('images', () => {
  it('a PNG without IHDR first has no size', () => {
    expect(sniff(concat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(0), bytes('IEND'), u32be(0)))).toEqual({ format: 'png' })
  })

  describe('JPEG: walks the markers to the frame header', () => {
    const sof = (marker: number, w: number, h: number) => [0xff, marker, ...u16be(11), 8, ...u16be(h), ...u16be(w), 1, 1, 0x11, 0]
    const soi = [0xff, 0xd8]

    it('skips fill bytes, restart markers and tables (DHT is not a frame header)', () => {
      const dht = [0xff, 0xc4, ...u16be(4), 0, 0]
      const data = concat(soi, [0xff, 0xff], [0xff, 0xd0], dht, sof(0xc2, 320, 200), new Uint8Array(4))
      expect(sniff(data)).toEqual({ format: 'jpeg', width: 320, height: 200 })
    })

    it('no size when the scan starts before any frame header, or a marker is broken', () => {
      expect(sniff(concat(soi, [0xff, 0xda, ...u16be(8)], new Uint8Array(16)))).toEqual({ format: 'jpeg' })
      expect(sniff(concat(soi, [0xff, 0xe0, ...u16be(4), 0, 0], [0x00, 0xc0], new Uint8Array(16)))).toEqual({ format: 'jpeg' })
      expect(sniff(concat(soi, [0xff, 0xe0, ...u16be(200)], new Uint8Array(16)))).toEqual({ format: 'jpeg' })
    })
  })

  describe('WebP', () => {
    it('lossy (VP8): 14-bit width and height after the start code', () => {
      const vp8 = concat(bytes('RIFF'), u32le(30), bytes('WEBPVP8 '), u32le(18), [0, 0, 0], [0x9d, 0x01, 0x2a], u16le(0xc000 | 640), u16le(480), new Uint8Array(8))
      expect(sniff(vp8)).toEqual({ format: 'webp', width: 640, height: 480 })
    })

    it('no size for a broken VP8 / VP8L header or another chunk', () => {
      const vp8 = concat(bytes('RIFF'), u32le(30), bytes('WEBPVP8 '), u32le(18), new Uint8Array(20))
      expect(sniff(vp8)).toEqual({ format: 'webp' })
      const vp8l = concat(bytes('RIFF'), u32le(26), bytes('WEBPVP8L'), u32le(10), [0x00], new Uint8Array(9))
      expect(sniff(vp8l)).toEqual({ format: 'webp' })
      expect(sniff(concat(bytes('RIFF'), u32le(12), bytes('WEBPALPH'), new Uint8Array(8)))).toEqual({ format: 'webp' })
    })
  })
})

describe('ISO base media: MP4, AVIF, HEIC', () => {
  const ftyp = (...brands: string[]) => box('ftyp', bytes(brands[0]!), u32be(0), ...brands.slice(1).map(bytes))
  const hdlr = (kind: string) => box('hdlr', u32be(0), u32be(0), bytes(kind), new Uint8Array(13))
  const entry = (fourcc: string, w: number, h: number) => box(fourcc, new Uint8Array(24), u16be(w), u16be(h), new Uint8Array(50))
  const trak = (kind: string, stbl: Uint8Array) => box('trak', box('mdia', hdlr(kind), box('minf', stbl)))
  const stsd = (...entries: Uint8Array[]) => box('stbl', box('stsd', u32be(0), u32be(entries.length), ...entries))

  it('the first video track, after an audio track and other boxes', () => {
    const data = concat(
      ftyp('isom', 'mp41'),
      box('moov', box('mvhd', new Uint8Array(100)), trak('soun', stsd(entry('mp4a', 0, 0))), trak('vide', stsd(entry('av01', 1080, 1920)))),
    )
    expect(sniff(data)).toEqual({ format: 'mp4', codec: 'av1', width: 1080, height: 1920 })
  })

  it('an unknown sample entry gives its fourcc as codec', () => {
    expect(sniff(concat(ftyp('isom'), box('moov', trak('vide', stsd(entry('mp4v', 640, 360))))))).toMatchObject({ codec: 'mp4v', width: 640 })
  })

  it('no video information without moov, video track or sample entry', () => {
    expect(sniff(concat(ftyp('isom'), box('mdat', new Uint8Array(8))))).toEqual({ format: 'mp4' })
    expect(sniff(concat(ftyp('isom'), box('moov', trak('soun', stsd(entry('mp4a', 0, 0))))))).toEqual({ format: 'mp4' })
    expect(sniff(concat(ftyp('isom'), box('moov', trak('vide', stsd()))))).toEqual({ format: 'mp4' })
    expect(sniff(concat(ftyp('isom'), box('moov', box('trak', box('mdia', hdlr('vide'))))))).toEqual({ format: 'mp4' })
  })

  it('reads 64-bit box sizes, and a last box whose size is 0 (to the end of the file)', () => {
    const moov = box('moov', trak('vide', stsd(entry('avc1', 320, 240))))
    const large = concat(u32be(1), bytes('moov'), u32be(0), u32be(16 + moov.length - 8), moov.subarray(8))
    expect(sniff(concat(ftyp('isom'), large))).toEqual({ format: 'mp4', codec: 'h264', width: 320, height: 240 })
    const toEnd = concat(u32be(0), moov.subarray(4))
    expect(sniff(concat(ftyp('isom'), toEnd))).toEqual({ format: 'mp4', codec: 'h264', width: 320, height: 240 })
  })

  it('stops at a box larger than 4 GB or beyond the end of the file', () => {
    const huge = concat(u32be(1), bytes('moov'), u32be(1), u32be(0))
    expect(sniff(concat(ftyp('isom'), huge))).toEqual({ format: 'mp4' })
    expect(sniff(concat(u32be(4096), bytes('ftyp'), bytes('isom')))).toEqual({ format: 'mp4' })
  })

  it('HEIC by its brands, unless also an isom file; AVIF sequences (avis)', () => {
    expect(sniff(ftyp('heic', 'mif1'))).toEqual({ format: 'heic' })
    expect(sniff(ftyp('mif1', 'heix'))).toEqual({ format: 'heic' })
    expect(sniff(ftyp('mif1', 'isom'))).toEqual({ format: 'mp4' })
    expect(sniff(ftyp('avis', 'msf1'))).toEqual({ format: 'avif' })
  })

  it('AVIF: the largest ispe, none when it is missing or too short', () => {
    const ispe = (w: number, h: number) => box('ispe', u32be(0), u32be(w), u32be(h))
    const meta = (...props: Uint8Array[]) => box('meta', u32be(0), box('iprp', box('ipco', ...props)))
    expect(sniff(concat(ftyp('avif'), meta(ispe(512, 512), ispe(1024, 768))))).toEqual({ format: 'avif', width: 1024, height: 768 })
    expect(sniff(concat(ftyp('avif'), meta(box('ispe', u32be(0), u32be(5)))))).toEqual({ format: 'avif' })
    expect(sniff(concat(ftyp('avif'), box('free', new Uint8Array(4))))).toEqual({ format: 'avif' })
  })
})

describe('WebM', () => {
  const el = (id: number[], ...payload: Array<Uint8Array | number[]>) => {
    const body = concat(...payload)
    return concat(id, [0x80 | body.length], body)
  }
  const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], bytes('webm')))
  const track = (type: number, codec: Uint8Array, video?: Uint8Array) => el([0xae], el([0x83], [type]), el([0x86], codec), ...(video ? [video] : []))
  const video = (w: number, h: number) => el([0xe0], el([0xb0], u16be(w)), el([0xba], u16be(h)))
  const webm = (...tracks: Uint8Array[]) => concat(header, el([0x18, 0x53, 0x80, 0x67], el([0x16, 0x54, 0xae, 0x6b], ...tracks)))

  it('the first video track, after an audio track; codec names', () => {
    expect(sniff(webm(track(2, bytes('A_OPUS')), track(1, bytes('V_AV1'), video(640, 480)), track(1, bytes('V_VP8'), video(2, 2)))))
      .toEqual({ format: 'webm', codec: 'av1', width: 640, height: 480 })
    expect(sniff(webm(track(1, bytes('V_MPEG4/ISO/AVC'), video(16, 16))))).toMatchObject({ codec: 'h264' })
  })

  it('an unknown codec id is given as is, without trailing NULs; a track without size has none', () => {
    expect(sniff(webm(track(1, concat(bytes('V_THEORA'), [0, 0]))))).toEqual({ format: 'webm', codec: 'V_THEORA' })
  })

  it('stops at the first cluster and at a broken element id', () => {
    const cluster = el([0x1f, 0x43, 0xb6, 0x75], [0xe7, 0x81, 0])
    const late = concat(header, el([0x18, 0x53, 0x80, 0x67], cluster, el([0x16, 0x54, 0xae, 0x6b], track(1, bytes('V_VP9'), video(8, 8)))))
    expect(sniff(late)).toEqual({ format: 'webm' })
    expect(sniff(concat(header, [0x00, 0x81, 0x00]))).toEqual({ format: 'webm' })
  })
})

describe('other formats', () => {
  it('audio, fonts and zip by their magic bytes', () => {
    expect(sniff(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]))).toEqual({ format: 'mp3' })
    expect(sniff(bytes('OggS\0\x02' + '\0'.repeat(22) + 'Vorbis\0\0'))).toEqual({ format: 'ogg', opus: false })
    expect(sniff(bytes('wOFF\0\x01\0\0'))).toEqual({ format: 'woff' })
    expect(sniff(Uint8Array.from([0, 1, 0, 0, 0, 0x10]))).toEqual({ format: 'sfnt' })
    expect(sniff(bytes('true\0\x10'))).toEqual({ format: 'sfnt' })
    expect(sniff(bytes('ttcf\0\x01\0\0'))).toEqual({ format: 'ttc' })
    expect(sniff(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0]))).toEqual({ format: 'zip' })
  })

  it('text: SVG after a BOM or a doctype, JSON lists, binary with NUL is not text', () => {
    expect(sniff(bytes('﻿<svg viewBox="0 0 1 1"></svg>'))).toEqual({ format: 'svg' })
    expect(sniff(bytes('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg>'))).toEqual({ format: 'svg' })
    expect(sniff(bytes('<svgx>'))).toEqual({ format: 'text' })
    expect(sniff(bytes('[1, 2]'))).toEqual({ format: 'json' })
    expect(sniff(bytes('abc\0def'))).toBeUndefined()
  })

  it('text whose 4096th byte cuts a multi-byte character is still text; invalid UTF-8 is not', () => {
    const cut = concat(bytes('a'.repeat(4095)), bytes('é'), bytes('more'))
    expect(sniff(cut)).toEqual({ format: 'text' })
    expect(sniff(concat(bytes('a'.repeat(10)), [0xc3, 0x28]))).toBeUndefined()
  })
})
