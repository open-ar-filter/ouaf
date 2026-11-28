/**
 * Synthetic test material: minimal but well-formed headers of each format, and a small zip writer.
 * No real images or videos are involved.
 */
import { crc32, deflateRawSync, deflateSync } from 'node:zlib'

const enc = new TextEncoder()
export const bytes = (s: string) => enc.encode(s)

export function concat(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)))
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0))
  let o = 0
  for (const a of arrays) {
    out.set(a, o)
    o += a.length
  }
  return out
}

const u16be = (v: number) => [(v >> 8) & 0xff, v & 0xff]
const u32be = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
const u16le = (v: number) => [v & 0xff, (v >> 8) & 0xff]
const u32le = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]

/** A valid RGBA PNG (fully transparent) of the given size. */
export function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) =>
    concat(u32be(data.length), bytes(type), data, u32be(crc32(concat(bytes(type), data))))
  const raw = new Uint8Array(height * (1 + width * 4)) // filter byte 0 + transparent pixels per row
  return concat(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    chunk('IHDR', concat(u32be(width), u32be(height), [8, 6, 0, 0, 0])),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  )
}

/** JPEG header only: SOI, APP0, SOF0 with the size, EOI. */
export function jpeg(width: number, height: number): Uint8Array {
  return concat(
    [0xff, 0xd8],
    [0xff, 0xe0, ...u16be(16)], bytes('JFIF\0'), [1, 1, 0, 0, 1, 0, 1, 0, 0],
    [0xff, 0xc0, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    [0xff, 0xd9],
  )
}

/** Lossless WebP header (VP8L). */
export function webpLossless(width: number, height: number): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  return concat(bytes('RIFF'), u32le(26), bytes('WEBPVP8L'), u32le(10), [0x2f], u32le(bits), [0, 0, 0, 0, 0])
}

/** Extended WebP header (VP8X). */
export function webpExtended(width: number, height: number): Uint8Array {
  const u24 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff]
  return concat(bytes('RIFF'), u32le(22), bytes('WEBPVP8X'), u32le(10), [0, 0, 0, 0], u24(width - 1), u24(height - 1))
}

export interface Ktx2Options {
  /** Default 0 (Basis Universal). */
  vkFormat?: number
  /** Default 0 (none). */
  supercompression?: number
  /** Default 166 (UASTC). */
  colorModel?: number
  /** Default 2 (sRGB). */
  transfer?: number
  /** Default 1. */
  faces?: number
  layers?: number
  depth?: number
  premultiplied?: boolean
}

/**
 * KTX2 header, level index and basic data format descriptor, without texel data: a UASTC sRGB 2D texture by default
 * (spec §10.2), the fields set by `o` otherwise.
 */
export function ktx2(width: number, height: number, o: Ktx2Options = {}): Uint8Array {
  const dfdOffset = 80 + 24 // one level
  const dfd = concat(
    u32le(28), u32le(0), u16le(2), u16le(24),
    [o.colorModel ?? 166, 1, o.transfer ?? 2, o.premultiplied ? 1 : 0],
    [0, 0, 0, 0], [16, 0, 0, 0, 0, 0, 0, 0],
  )
  return concat(
    [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a],
    u32le(o.vkFormat ?? 0), u32le(1), u32le(width), u32le(height), u32le(o.depth ?? 0), u32le(o.layers ?? 0), u32le(o.faces ?? 1),
    u32le(1), u32le(o.supercompression ?? 0), u32le(dfdOffset), u32le(dfd.length), u32le(0), u32le(0), new Uint8Array(16),
    new Uint8Array(24), dfd,
  )
}

const box = (type: string, ...payload: Array<Uint8Array | number[]>) => {
  const body = concat(...payload)
  return concat(u32be(8 + body.length), bytes(type), body)
}

/** AVIF still image: ftyp + meta/iprp/ipco/ispe. */
export function avif(width: number, height: number): Uint8Array {
  return concat(
    box('ftyp', bytes('avif'), u32be(0), bytes('mif1')),
    box('meta', u32be(0), box('iprp', box('ipco', box('ispe', u32be(0), u32be(width), u32be(height))))),
  )
}

/** MP4 with one video track whose sample entry has the given fourcc ("avc1", "hvc1"…) and coded size. */
export function mp4(fourcc: string, width: number, height: number): Uint8Array {
  const entry = box(fourcc, new Uint8Array(6), u16be(1), new Uint8Array(16), u16be(width), u16be(height), new Uint8Array(50))
  const stsd = box('stsd', u32be(0), u32be(1), entry)
  const hdlr = box('hdlr', u32be(0), u32be(0), bytes('vide'), new Uint8Array(13))
  return concat(
    box('ftyp', bytes('isom'), u32be(512), bytes('isomavc1')),
    box('moov', box('trak', box('tkhd', new Uint8Array(84)), box('mdia', hdlr, box('minf', box('stbl', stsd))))),
    box('mdat', new Uint8Array(16)),
  )
}

/** WebM with one video track. */
export function webm(codecId: string, width: number, height: number): Uint8Array {
  const size = (n: number) => [0x80 | n] // 1-byte EBML size (n < 127)
  const el = (id: number[], ...payload: Array<Uint8Array | number[]>) => {
    const body = concat(...payload)
    return concat(id, size(body.length), body)
  }
  const video = el([0xe0], el([0xb0], u16be(width)), el([0xba], u16be(height)))
  const track = el([0xae], el([0x83], [1]), el([0x86], bytes(codecId)), video)
  return concat(
    el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], bytes('webm'))),
    // Segment with an unknown size, as written by live encoders.
    [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    el([0x16, 0x54, 0xae, 0x6b], track),
    el([0x1f, 0x43, 0xb6, 0x75], [0xe7, 0x81, 0]),
  )
}

/** GLB container with the given glTF JSON. */
export function glb(json: unknown, version = 2): Uint8Array {
  let text = JSON.stringify(json)
  while (text.length % 4) text += ' '
  const data = bytes(text)
  return concat(bytes('glTF'), u32le(version), u32le(20 + data.length), u32le(data.length), bytes('JSON'), data)
}

/** A .cube 3D LUT of the given size (identity). */
export function cube(size: number, rows = size ** 3): string {
  const lines = ['TITLE "identity"', `LUT_3D_SIZE ${size}`]
  for (let i = 0; i < rows; i++) {
    const r = i % size
    const g = Math.floor(i / size) % size
    const b = Math.floor(i / size / size) % size
    lines.push([r, g, b].map((v) => (v / (size - 1)).toFixed(4)).join(' '))
  }
  return `${lines.join('\n')}\n`
}

export interface ZipFile {
  data: Uint8Array | string
  /** Unix file type and mode, e.g. 0o120777 for a symbolic link. */
  mode?: number
  store?: boolean
}

/** Minimal zip writer (deflate or store, Unix modes), enough to build test packages. */
export function zip(files: Record<string, Uint8Array | string | ZipFile>): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const [name, f] of Object.entries(files)) {
    const file: ZipFile = typeof f === 'string' || f instanceof Uint8Array ? { data: f } : f
    const data = typeof file.data === 'string' ? bytes(file.data) : file.data
    const store = file.store ?? data.length < 64
    const packed = store ? data : deflateRawSync(data)
    const nameBytes = bytes(name)
    const crc = crc32(data)
    const common = [...u16le(store ? 0 : 8), ...u16le(0), ...u16le(0), ...u32le(crc), ...u32le(packed.length), ...u32le(data.length), ...u16le(nameBytes.length), ...u16le(0)]
    const local = concat(u32le(0x04034b50), u16le(20), u16le(0x800), common, nameBytes, packed)
    const mode = file.mode ?? 0o100644
    centrals.push(concat(u32le(0x02014b50), u16le((3 << 8) | 20), u16le(20), u16le(0x800), common, u16le(0), u16le(0), u16le(0), u32le((mode << 16) >>> 0), u32le(offset), nameBytes))
    locals.push(local)
    offset += local.length
  }
  const cd = concat(...centrals)
  const n = centrals.length
  return concat(...locals, cd, u32le(0x06054b50), u16le(0), u16le(0), u16le(n), u16le(n), u32le(cd.length), u32le(offset), u16le(0))
}
