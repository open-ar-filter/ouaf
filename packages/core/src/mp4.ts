/**
 * Minimal MP4 / MOV (ISO BMFF) demuxer for the offline video source (#32): finds the first video track and lists its
 * samples (offset, size, timestamps, keyframes) so that WebCodecs can decode them. No dependency: the format subset
 * needed (one progressive video track, `moov` anywhere in the file) is small, and a full demuxer library would weigh
 * more than the rest of the source code.
 *
 * Not supported: fragmented MP4 (`moof`), encrypted tracks, several sample descriptions. Codecs: H.264 (`avc1`,
 * `avc3`), H.265 (`hvc1`, `hev1`), VP9 (`vp09`), AV1 (`av01`).
 */

export interface Mp4Sample {
  /** Byte range in the file. */
  readonly offset: number
  readonly size: number
  /** Presentation time in seconds (edit list applied: the first frame shown is at 0, as in a `<video>`). */
  readonly time: number
  /** Duration in seconds. */
  readonly duration: number
  /** Keyframe (decoding can start here). */
  readonly sync: boolean
}

export interface Mp4VideoTrack {
  /** WebCodecs codec string (`avc1.4d401f`). */
  readonly codec: string
  /** Codec configuration record (`avcC`, `hvcC`, `av1C` payload), the decoder's `description`. */
  readonly description: Uint8Array | undefined
  /** Size of the coded frames. */
  readonly codedWidth: number
  readonly codedHeight: number
  /** Clockwise rotation to apply for display (track matrix): 0, 90, 180 or 270. */
  readonly rotation: 0 | 90 | 180 | 270
  /** Duration in seconds (last frame end). */
  readonly duration: number
  /** Samples in decoding order. */
  readonly samples: readonly Mp4Sample[]
}

/** The file is not an MP4 the demuxer can read; the message says why. */
export class Mp4Error extends Error {
  override readonly name = 'Mp4Error'
}

interface Box {
  readonly type: string
  /** Payload range (after the header). */
  readonly start: number
  readonly end: number
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts'])

/** Parses `data` (a whole MP4 or MOV file) and returns its first video track. Throws `Mp4Error`. */
export function demuxMp4(data: Uint8Array): Mp4VideoTrack {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const top = children(view, 0, data.byteLength)
  if (top.some((b) => b.type === 'moof') && !top.some((b) => b.type === 'moov')) throw new Mp4Error('Fragmented MP4 files are not supported.')
  const moov = top.find((b) => b.type === 'moov')
  if (!moov) throw new Mp4Error(top.length === 0 ? 'This is not an MP4 file.' : 'The file has no "moov" box (not an MP4 file, or truncated).')
  const movieTimescale = readMvhdTimescale(view, find(view, moov, 'mvhd'))

  for (const trak of children(view, moov.start, moov.end).filter((b) => b.type === 'trak')) {
    const mdia = find(view, trak, 'mdia')
    const hdlr = mdia && find(view, mdia, 'hdlr')
    if (!hdlr || fourcc(view, hdlr.start + 8) !== 'vide') continue
    return readVideoTrack(view, data, trak, mdia, movieTimescale)
  }
  throw new Mp4Error('The file has no video track.')
}

function readVideoTrack(view: DataView, data: Uint8Array, trak: Box, mdia: Box, movieTimescale: number): Mp4VideoTrack {
  const mdhd = need(view, mdia, 'mdhd')
  const timescale = view.getUint8(mdhd.start) === 1 ? view.getUint32(mdhd.start + 20) : view.getUint32(mdhd.start + 12)
  if (!timescale) throw new Mp4Error('The video track has no timescale.')
  const stbl = need(view, need(view, mdia, 'minf'), 'stbl')

  // Sample description: the codec and its configuration.
  const stsd = need(view, stbl, 'stsd')
  if (view.getUint32(stsd.start + 4) < 1) throw new Mp4Error('The video track has no sample description.')
  const entry = children(view, stsd.start + 8, stsd.end)[0]
  if (!entry) throw new Mp4Error('The video track has no sample description.')
  const codedWidth = view.getUint16(entry.start + 24)
  const codedHeight = view.getUint16(entry.start + 26)
  const { codec, description } = readCodec(view, data, entry)

  // Sample tables.
  const sizes = readSizes(view, stbl, data.byteLength)
  const n = sizes.length
  const offsets = readOffsets(view, stbl, sizes)
  const dts = new Float64Array(n)
  const durations = new Float64Array(n)
  {
    const stts = need(view, stbl, 'stts')
    let i = 0
    let t = 0
    const count = tableCount(view, stts, 4, 8)
    for (let e = 0; e < count && i < n; e++) {
      const p = stts.start + 8 + e * 8
      const samples = view.getUint32(p)
      const delta = view.getUint32(p + 4)
      for (let k = 0; k < samples && i < n; k++, i++) {
        dts[i] = t
        durations[i] = delta
        t += delta
      }
    }
    if (i < n) throw new Mp4Error('The time-to-sample table is shorter than the sample list.')
  }
  const cts = Float64Array.from(dts)
  const ctts = find(view, stbl, 'ctts')
  if (ctts) {
    let i = 0
    const count = tableCount(view, ctts, 4, 8)
    for (let e = 0; e < count && i < n; e++) {
      const p = ctts.start + 8 + e * 8
      const samples = view.getUint32(p)
      const offset = view.getInt32(p + 4) // signed in version 1; version 0 offsets never reach 2³¹ in practice
      for (let k = 0; k < samples && i < n; k++, i++) cts[i] = dts[i]! + offset
    }
  }
  const sync = new Uint8Array(n)
  const stss = find(view, stbl, 'stss')
  if (stss) {
    const count = tableCount(view, stss, 4, 4)
    for (let e = 0; e < count; e++) {
      const k = view.getUint32(stss.start + 8 + e * 4) - 1
      if (k >= 0 && k < n) sync[k] = 1
    }
  } else sync.fill(1)

  // Edit list: the media time shown first (B-frame delay) and an initial empty edit.
  let shift = 0
  let delay = 0
  const edts = find(view, trak, 'edts')
  const elst = edts && find(view, edts, 'elst')
  if (elst) {
    const v1 = view.getUint8(elst.start) === 1
    const count = tableCount(view, elst, 4, v1 ? 20 : 12)
    let p = elst.start + 8
    for (let e = 0; e < count; e++) {
      const segment = v1 ? readU64(view, p) : view.getUint32(p)
      const mediaTime = v1 ? Number(view.getBigInt64(p + 8)) : view.getInt32(p + 4)
      p += v1 ? 20 : 12
      if (mediaTime === -1) {
        delay += movieTimescale ? segment / movieTimescale : 0
        continue
      }
      shift = mediaTime
      break // later edits (cuts, repeats) are ignored: the track plays from there to its end
    }
  }

  const samples: Mp4Sample[] = new Array(n)
  let duration = 0
  for (let i = 0; i < n; i++) {
    const time = (cts[i]! - shift) / timescale + delay
    const d = durations[i]! / timescale
    samples[i] = { offset: offsets[i]!, size: sizes[i]!, time, duration: d, sync: sync[i] === 1 }
    duration = Math.max(duration, time + d)
    if (offsets[i]! + sizes[i]! > data.byteLength) throw new Mp4Error('The file is truncated: a sample lies beyond its end.')
  }
  if (n > 0 && !samples[0]!.sync) throw new Mp4Error('The video track does not start with a keyframe.')

  return { codec, description, codedWidth, codedHeight, rotation: readRotation(view, need(view, trak, 'tkhd')), duration, samples }
}

function readCodec(view: DataView, data: Uint8Array, entry: Box): { codec: string; description: Uint8Array | undefined } {
  // VisualSampleEntry: 78 bytes of fields, then the configuration boxes.
  const boxes = children(view, entry.start + 78, entry.end)
  const config = (type: string) => {
    const b = boxes.find((x) => x.type === type)
    if (!b) throw new Mp4Error(`The "${entry.type}" sample description has no "${type}" box.`)
    return b
  }
  switch (entry.type) {
    case 'avc1':
    case 'avc3': {
      const b = config('avcC')
      return { codec: `${entry.type}.${hex(view.getUint8(b.start + 1))}${hex(view.getUint8(b.start + 2))}${hex(view.getUint8(b.start + 3))}`, description: data.slice(b.start, b.end) }
    }
    case 'hvc1':
    case 'hev1': {
      const b = config('hvcC')
      const p = b.start
      const byte1 = view.getUint8(p + 1)
      const space = ['', 'A', 'B', 'C'][byte1 >> 6]!
      const tier = byte1 & 0x20 ? 'H' : 'L'
      const profile = byte1 & 0x1f
      let compat = view.getUint32(p + 2)
      let reversed = 0
      for (let i = 0; i < 32; i++, compat >>>= 1) reversed = (reversed << 1) | (compat & 1)
      const level = view.getUint8(p + 12)
      const constraints: number[] = []
      for (let i = 0; i < 6; i++) constraints.push(view.getUint8(p + 6 + i))
      while (constraints.length > 0 && constraints.at(-1) === 0) constraints.pop()
      const tail = constraints.map((c) => `.${c.toString(16)}`).join('')
      return { codec: `${entry.type}.${space}${profile}.${(reversed >>> 0).toString(16)}.${tier}${level}${tail}`, description: data.slice(b.start, b.end) }
    }
    case 'vp09': {
      const b = config('vpcC')
      const p = b.start + 4 // full box
      const profile = view.getUint8(p)
      const level = view.getUint8(p + 1)
      const depth = view.getUint8(p + 2) >> 4
      return { codec: `vp09.${pad(profile)}.${pad(level)}.${pad(depth)}`, description: undefined }
    }
    case 'av01': {
      const b = config('av1C')
      const byte1 = view.getUint8(b.start + 1)
      const byte2 = view.getUint8(b.start + 2)
      const depth = byte2 & 0x20 ? 12 : byte2 & 0x40 ? 10 : 8
      return { codec: `av01.${byte1 >> 5}.${pad(byte1 & 0x1f)}${byte2 & 0x80 ? 'H' : 'M'}.${pad(depth)}`, description: data.slice(b.start, b.end) }
    }
    case 'encv':
      throw new Mp4Error('Encrypted video tracks are not supported.')
    default:
      throw new Mp4Error(`Unsupported video codec "${entry.type}" (supported: H.264, H.265, VP9, AV1).`)
  }
}

/**
 * Sample sizes from `stsz` or `stz2`. The count is checked before the table is allocated: every sample takes at least
 * one byte of the file, and a variable-size table must hold one entry per sample. Without this check a 20-byte
 * constant-size `stsz` could declare 2³² − 1 samples and make the engine allocate tens of gigabytes (#123).
 */
function readSizes(view: DataView, stbl: Box, fileSize: number): Uint32Array {
  const stsz = find(view, stbl, 'stsz')
  if (stsz) {
    if (stsz.end - stsz.start < 12) throw new Mp4Error('The "stsz" box is truncated.')
    const fixed = view.getUint32(stsz.start + 4)
    const count = fixed ? view.getUint32(stsz.start + 8) : tableCount(view, stsz, 8, 4)
    checkSampleCount(count, fileSize)
    const sizes = new Uint32Array(count)
    if (fixed) sizes.fill(fixed)
    else for (let i = 0; i < count; i++) sizes[i] = view.getUint32(stsz.start + 12 + i * 4)
    return sizes
  }
  const stz2 = find(view, stbl, 'stz2')
  if (!stz2) throw new Mp4Error('The video track has no sample size table.')
  if (stz2.end - stz2.start < 12) throw new Mp4Error('The "stz2" box is truncated.')
  const field = view.getUint8(stz2.start + 7)
  if (field !== 4 && field !== 8 && field !== 16) throw new Mp4Error(`The "stz2" box has an invalid field size (${field}).`)
  const count = view.getUint32(stz2.start + 8)
  if (Math.ceil((count * field) / 8) > stz2.end - stz2.start - 12) throw tooManyEntries(stz2, count)
  checkSampleCount(count, fileSize)
  const sizes = new Uint32Array(count)
  const p = stz2.start + 12
  for (let i = 0; i < count; i++) {
    if (field === 16) sizes[i] = view.getUint16(p + i * 2)
    else if (field === 8) sizes[i] = view.getUint8(p + i)
    else sizes[i] = (view.getUint8(p + (i >> 1)) >> (i & 1 ? 0 : 4)) & 0xf
  }
  return sizes
}

function readOffsets(view: DataView, stbl: Box, sizes: Uint32Array): Float64Array {
  const n = sizes.length
  const stco = find(view, stbl, 'stco')
  const co64 = stco ? undefined : find(view, stbl, 'co64')
  const table = stco ?? co64
  if (!table) throw new Mp4Error('The video track has no chunk offset table.')
  const chunkCount = tableCount(view, table, 4, stco ? 4 : 8)
  const chunk = (k: number) => (stco ? view.getUint32(table.start + 8 + k * 4) : readU64(view, table.start + 8 + k * 8))

  const stsc = need(view, stbl, 'stsc')
  const runs = tableCount(view, stsc, 4, 12)
  const offsets = new Float64Array(n)
  let i = 0
  for (let r = 0; r < runs && i < n; r++) {
    const p = stsc.start + 8 + r * 12
    const first = view.getUint32(p) - 1
    const perChunk = view.getUint32(p + 4)
    // Chunks past the offset table do not exist: stopping there also bounds the loop when `perChunk` is 0.
    const last = Math.min(r + 1 < runs ? view.getUint32(p + 12) - 1 : chunkCount, chunkCount)
    for (let c = first; c < last && i < n; c++) {
      let offset = chunk(c)
      for (let k = 0; k < perChunk && i < n; k++, i++) {
        offsets[i] = offset
        offset += sizes[i]!
      }
    }
  }
  if (i < n) throw new Mp4Error('The sample-to-chunk table does not cover every sample.')
  return offsets
}

/**
 * Entry count of a sample table: the 32-bit count at `countAt` (from the payload start, after the full-box header),
 * followed by entries of `entryBytes` each. Checked against the box payload before any loop, so that a forged count
 * fails at once instead of reading the bytes after the box.
 */
function tableCount(view: DataView, box: Box, countAt: number, entryBytes: number): number {
  const entries = box.start + countAt + 4
  if (entries > box.end) throw new Mp4Error(`The "${box.type}" box is truncated.`)
  const count = view.getUint32(entries - 4)
  if (count * entryBytes > box.end - entries) throw tooManyEntries(box, count)
  return count
}

function tooManyEntries(box: Box, count: number): Mp4Error {
  return new Mp4Error(`The "${box.type}" box declares ${count} entries, more than it holds (corrupt or forged file).`)
}

/** Every sample takes at least one byte of the file. */
function checkSampleCount(count: number, fileSize: number): void {
  if (count > fileSize) throw new Mp4Error(`The video track declares ${count} samples, more than a ${fileSize}-byte file can hold (corrupt or forged file).`)
}

function readRotation(view: DataView, tkhd: Box): 0 | 90 | 180 | 270 {
  const matrix = tkhd.start + (view.getUint8(tkhd.start) === 1 ? 52 : 40)
  const a = view.getInt32(matrix) / 65536
  const b = view.getInt32(matrix + 4) / 65536
  const degrees = (Math.round((Math.atan2(b, a) * 180) / Math.PI / 90) * 90 + 360) % 360
  return degrees as 0 | 90 | 180 | 270
}

function readMvhdTimescale(view: DataView, mvhd: Box | undefined): number {
  if (!mvhd) return 0
  return view.getUint8(mvhd.start) === 1 ? view.getUint32(mvhd.start + 20) : view.getUint32(mvhd.start + 12)
}

/** Boxes between `start` and `end`. Stops at the first malformed header. */
function children(view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = []
  let p = start
  while (p + 8 <= end) {
    let size = view.getUint32(p)
    const type = fourcc(view, p + 4)
    let header = 8
    if (size === 1) {
      if (p + 16 > end) break
      size = readU64(view, p + 8)
      header = 16
    } else if (size === 0) size = end - p
    if (size < header || p + size > end) break
    boxes.push({ type, start: p + header, end: p + size })
    p += size
  }
  return boxes
}

function find(view: DataView, parent: Box, type: string): Box | undefined {
  if (!CONTAINERS.has(parent.type)) return undefined
  return children(view, parent.start, parent.end).find((b) => b.type === type)
}

function need(view: DataView, parent: Box, type: string): Box {
  const box = find(view, parent, type)
  if (!box) throw new Mp4Error(`The video track has no "${type}" box.`)
  return box
}

function fourcc(view: DataView, p: number): string {
  return String.fromCharCode(view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2), view.getUint8(p + 3))
}

function readU64(view: DataView, p: number): number {
  return view.getUint32(p) * 4294967296 + view.getUint32(p + 4)
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, '0')
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
