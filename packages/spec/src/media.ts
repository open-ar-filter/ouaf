/**
 * File format detection and dimensions read from headers only (spec §10.4: size and dimensions are checked before
 * decoding). No image library: each reader parses the few bytes it needs and returns undefined on anything odd.
 */

export type Format =
  | 'png' | 'jpeg' | 'webp' | 'avif' | 'svg' | 'ktx2' | 'gif' | 'heic'
  | 'mp4' | 'webm'
  | 'glb' | 'gltf'
  | 'ogg' | 'mp3' | 'wav'
  | 'woff2' | 'woff' | 'sfnt' | 'ttc'
  | 'zip' | 'json' | 'text'

/** §10.4: images ≤ 4096 px per side (the textures embedded in a model included). */
export const IMAGE_MAX_SIDE = 4096
/** §10.4: videos ≤ 1080p (long side × short side, either orientation). */
export const VIDEO_MAX = { long: 1920, short: 1080 } as const

export interface MediaInfo {
  format: Format
  width?: number
  height?: number
  /** Video codec as a short name: "h264", "hevc", "vp8", "vp9", "av1", or the raw fourcc / codec id. */
  codec?: string
  /** Ogg stream: Opus (true) or another codec. */
  opus?: boolean
}

const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len))
const be16 = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0)
const be32 = (b: Uint8Array, at: number) => (((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)) >>> 0
const le16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8)
const le24 = (b: Uint8Array, at: number) => le16(b, at) | ((b[at + 2] ?? 0) << 16)
const le32 = (b: Uint8Array, at: number) => (le24(b, at) | ((b[at + 3] ?? 0) << 24)) >>> 0
const starts = (b: Uint8Array, bytes: number[], at = 0) => bytes.every((v, i) => b[at + i] === v)

/** Identifies a file from its first bytes and reads what is cheap to read (dimensions, codec). */
export function sniff(b: Uint8Array): MediaInfo | undefined {
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return ascii(b, 12, 4) === 'IHDR' ? { format: 'png', width: be32(b, 16), height: be32(b, 20) } : { format: 'png' }
  }
  if (starts(b, [0xff, 0xd8, 0xff])) return { format: 'jpeg', ...jpegSize(b) }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return { format: 'webp', ...webpSize(b) }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return { format: 'wav' }
  if (starts(b, [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { format: 'ktx2', width: le32(b, 20), height: le32(b, 24) }
  }
  if (ascii(b, 0, 4) === 'GIF8') return { format: 'gif', width: le16(b, 6), height: le16(b, 8) }
  if (ascii(b, 4, 4) === 'ftyp') return isobmff(b)
  if (starts(b, [0x1a, 0x45, 0xdf, 0xa3])) return { format: 'webm', ...webmInfo(b) }
  if (ascii(b, 0, 4) === 'glTF') return { format: 'glb' }
  if (ascii(b, 0, 4) === 'OggS') return { format: 'ogg', opus: ascii(b, 28, 8) === 'OpusHead' }
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)) return { format: 'mp3' }
  if (ascii(b, 0, 4) === 'wOF2') return { format: 'woff2' }
  if (ascii(b, 0, 4) === 'wOFF') return { format: 'woff' }
  if (starts(b, [0, 1, 0, 0]) || ascii(b, 0, 4) === 'OTTO' || ascii(b, 0, 4) === 'true') return { format: 'sfnt' }
  if (ascii(b, 0, 4) === 'ttcf') return { format: 'ttc' }
  if (starts(b, [0x50, 0x4b, 0x03, 0x04])) return { format: 'zip' }
  return textFormat(b)
}

function textFormat(b: Uint8Array): MediaInfo | undefined {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, 4096))
  } catch {
    // A multi-byte character may be cut at 4096 bytes: retry on a shorter prefix.
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, 4093))
    } catch {
      return undefined
    }
  }
  if (text.includes('\u0000')) return undefined
  const head = text.replace(/^\uFEFF/, '').trimStart()
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) return { format: 'svg' }
  if (head.startsWith('{') || head.startsWith('[')) return { format: 'json' }
  return { format: 'text' }
}

function jpegSize(b: Uint8Array): { width?: number; height?: number } {
  let p = 2
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) return {}
    const m = b[p + 1]!
    if (m === 0xff) {
      p++ // fill byte
      continue
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      p += 2
      continue
    }
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: be16(b, p + 5), width: be16(b, p + 7) }
    if (m === 0xda || m === 0xd9) return {} // start of scan / end of image before any frame header
    p += 2 + be16(b, p + 2)
  }
  return {}
}

function webpSize(b: Uint8Array): { width?: number; height?: number } {
  const chunk = ascii(b, 12, 4)
  if (chunk === 'VP8 ' && starts(b, [0x9d, 0x01, 0x2a], 23)) return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff }
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    const bits = le32(b, 21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 }
  return {}
}

// ---------------------------------------------------------------------------------------------
// ISO base media (MP4, AVIF, HEIC)

interface Box {
  type: string
  start: number // payload start
  end: number
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let p = start
  while (p + 8 <= end) {
    let size = be32(b, p)
    const type = ascii(b, p + 4, 4)
    let header = 8
    if (size === 1) {
      // 64-bit size: the high word must be 0 for any file we can hold in memory.
      if (be32(b, p + 8) !== 0) return
      size = be32(b, p + 12)
      header = 16
    } else if (size === 0) size = end - p
    if (size < header || p + size > end) return
    yield { type, start: p + header, end: p + size }
    p += size
  }
}

const child = (b: Uint8Array, box: Box | undefined, type: string, skip = 0) =>
  box ? [...boxes(b, box.start + skip, box.end)].find((x) => x.type === type) : undefined

const VIDEO_CODECS: Record<string, string> = { avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', vp09: 'vp9', av01: 'av1' }

function isobmff(b: Uint8Array): MediaInfo {
  const ftyp = [...boxes(b, 0, b.length)][0]
  if (!ftyp) return { format: 'mp4' }
  const brands = [ascii(b, ftyp.start, 4)]
  for (let p = ftyp.start + 8; p + 4 <= ftyp.end; p += 4) brands.push(ascii(b, p, 4))
  if (brands.includes('avif') || brands.includes('avis')) return { format: 'avif', ...avifSize(b) }
  if (brands.some((x) => ['heic', 'heix', 'mif1', 'heim', 'heis'].includes(x)) && !brands.includes('isom')) return { format: 'heic' }
  return { format: 'mp4', ...mp4Video(b) }
}

/** Largest `ispe` (image spatial extent) property: the primary image or its grid, whichever is bigger. */
function avifSize(b: Uint8Array): { width?: number; height?: number } {
  const meta = [...boxes(b, 0, b.length)].find((x) => x.type === 'meta')
  const ipco = child(b, child(b, meta, 'iprp', 4), 'ipco')
  let width = 0
  let height = 0
  if (ipco) {
    for (const x of boxes(b, ipco.start, ipco.end)) {
      if (x.type === 'ispe' && x.end - x.start >= 12) {
        width = Math.max(width, be32(b, x.start + 4))
        height = Math.max(height, be32(b, x.start + 8))
      }
    }
  }
  return width && height ? { width, height } : {}
}

/** Coded size and codec of the first video track (moov/trak/mdia/minf/stbl/stsd). */
function mp4Video(b: Uint8Array): { width?: number; height?: number; codec?: string } {
  const moov = [...boxes(b, 0, b.length)].find((x) => x.type === 'moov')
  if (!moov) return {}
  for (const trak of boxes(b, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue
    const mdia = child(b, trak, 'mdia')
    const hdlr = child(b, mdia, 'hdlr')
    if (!hdlr || ascii(b, hdlr.start + 8, 4) !== 'vide') continue
    const stsd = child(b, child(b, child(b, mdia, 'minf'), 'stbl'), 'stsd')
    // stsd: version/flags (4) + entry count (4), then sample entries (VisualSampleEntry: width at 24, height at 26).
    const entry = stsd ? [...boxes(b, stsd.start + 8, stsd.end)][0] : undefined
    if (!entry) return {}
    return { codec: VIDEO_CODECS[entry.type] ?? entry.type, width: be16(b, entry.start + 24), height: be16(b, entry.start + 26) }
  }
  return {}
}

// ---------------------------------------------------------------------------------------------
// WebM (EBML / Matroska)

const SEGMENT = 0x18538067
const TRACKS = 0x1654ae6b
const TRACK_ENTRY = 0xae
const TRACK_TYPE = 0x83
const CODEC_ID = 0x86
const VIDEO = 0xe0
const PIXEL_WIDTH = 0xb0
const PIXEL_HEIGHT = 0xba
const CLUSTER = 0x1f43b675

function vint(b: Uint8Array, p: number, keepMarker: boolean): { value: number; len: number; unknown: boolean } | undefined {
  const first = b[p]
  if (first === undefined || first === 0) return undefined
  const len = Math.clz32(first) - 23 // 1..8
  if (p + len > b.length) return undefined
  let value = keepMarker ? first : first & (0xff >> len)
  let allOnes = value === 0xff >> len
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[p + i]!
    if (b[p + i] !== 0xff) allOnes = false
  }
  return { value, len, unknown: !keepMarker && allOnes }
}

const uint = (b: Uint8Array, start: number, end: number) => {
  let v = 0
  for (let i = start; i < end; i++) v = v * 256 + b[i]!
  return v
}

function webmInfo(b: Uint8Array): { width?: number; height?: number; codec?: string } {
  const out: { width?: number; height?: number; codec?: string } = {}
  const MASTERS = new Set([SEGMENT, TRACKS, TRACK_ENTRY, VIDEO])
  // Walks the masters we care about; returns false to stop (first cluster reached: tracks come before media data).
  const walk = (start: number, end: number, track: { type?: number; codec?: string; w?: number; h?: number }): boolean => {
    let p = start
    while (p < end) {
      const id = vint(b, p, true)
      const size = id && vint(b, p + id.len, false)
      if (!id || !size) return false
      const data = p + id.len + size.len
      const stop = size.unknown ? end : Math.min(end, data + size.value)
      if (id.value === CLUSTER) return false
      if (id.value === TRACK_ENTRY) {
        const t: { type?: number; codec?: string; w?: number; h?: number } = {}
        walk(data, stop, t)
        if (t.type === 1 && out.codec === undefined) {
          if (t.codec) out.codec = ({ V_VP8: 'vp8', V_VP9: 'vp9', V_AV1: 'av1', 'V_MPEG4/ISO/AVC': 'h264' } as Record<string, string>)[t.codec] ?? t.codec
          if (t.w !== undefined) out.width = t.w
          if (t.h !== undefined) out.height = t.h
        }
      } else if (MASTERS.has(id.value)) {
        if (!walk(data, stop, track)) return false
      } else if (id.value === TRACK_TYPE) track.type = uint(b, data, stop)
      else if (id.value === CODEC_ID) track.codec = ascii(b, data, stop - data).replace(/\0+$/, '')
      else if (id.value === PIXEL_WIDTH) track.w = uint(b, data, stop)
      else if (id.value === PIXEL_HEIGHT) track.h = uint(b, data, stop)
      if (size.unknown) return true
      p = stop
    }
    return true
  }
  walk(0, b.length, {})
  return out
}
