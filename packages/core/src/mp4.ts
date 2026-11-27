/**
 * Minimal MP4 / MOV (ISO BMFF) demuxer for the offline video source (#32): finds the first video track and lists its
 * samples (offset, size, timestamps, keyframes) so that WebCodecs can decode them. No dependency: the format subset
 * needed (one progressive video track, `moov` anywhere in the file) is small, and a full demuxer library would weigh
 * more than the rest of the source code.
 *
 * The first audio track is read too (`demuxMp4Audio`), for the export to copy it into its MP4 without decoding it
 * (#137): its samples and a sample description another MP4 can hold.
 *
 * Not supported: fragmented MP4 (`moof`), encrypted tracks, several sample descriptions. Video codecs: H.264
 * (`avc1`, `avc3`), H.265 (`hvc1`, `hev1`), VP9 (`vp09`), AV1 (`av01`). Audio codecs: AAC (`mp4a`), Opus, FLAC.
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

export interface Mp4AudioTrack {
  /** Sample description type: `mp4a` (AAC), `Opus` or `fLaC`. */
  readonly format: string
  readonly channels: number
  /** Samples per second (the media timescale when the description does not say). */
  readonly sampleRate: number
  /** Ticks per second of the sample times in the file. */
  readonly timescale: number
  /**
   * The sample description rewritten as an ISO BMFF `SoundSampleEntry` (version 0) with its configuration box
   * (`esds`, `dOps`, `dfLa`), whatever the file had (a QuickTime version 1 or 2 description, `esds` in a `wave` box):
   * the `stsd` entry of an MP4 holding these samples.
   */
  readonly sampleEntry: Uint8Array
  /** Duration in seconds (last sample end). */
  readonly duration: number
  /**
   * Samples in decoding order (the presentation order for audio). The edit list is applied as for the video: the
   * first samples of AAC (the encoder delay) have negative times.
   */
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
  const { view, moov, movieTimescale } = movie(data)
  const track = firstTrack(view, moov, 'vide')
  if (!track) throw new Mp4Error('The file has no video track.')
  return readVideoTrack(view, data, track.trak, track.mdia, movieTimescale)
}

/**
 * The first audio track of `data` (a whole MP4 or MOV file), `undefined` when it has none. Throws `Mp4Error` when the
 * file or the audio track cannot be read, or for an audio codec other than AAC, Opus and FLAC.
 */
export function demuxMp4Audio(data: Uint8Array): Mp4AudioTrack | undefined {
  const { view, moov, movieTimescale } = movie(data)
  const track = firstTrack(view, moov, 'soun')
  return track && readAudioTrack(view, data, track.trak, track.mdia, movieTimescale)
}

function movie(data: Uint8Array): { view: DataView; moov: Box; movieTimescale: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const top = children(view, 0, data.byteLength)
  if (top.some((b) => b.type === 'moof') && !top.some((b) => b.type === 'moov')) throw new Mp4Error('Fragmented MP4 files are not supported.')
  const moov = top.find((b) => b.type === 'moov')
  if (!moov) throw new Mp4Error(top.length === 0 ? 'This is not an MP4 file.' : 'The file has no "moov" box (not an MP4 file, or truncated).')
  return { view, moov, movieTimescale: readMvhdTimescale(view, find(view, moov, 'mvhd')) }
}

function firstTrack(view: DataView, moov: Box, handler: 'vide' | 'soun'): { trak: Box; mdia: Box } | undefined {
  for (const trak of children(view, moov.start, moov.end).filter((b) => b.type === 'trak')) {
    const mdia = find(view, trak, 'mdia')
    const hdlr = mdia && find(view, mdia, 'hdlr')
    if (hdlr && hdlr.end - hdlr.start >= 12 && fourcc(view, hdlr.start + 8) === handler) return { trak, mdia }
  }
  return undefined
}

function readVideoTrack(view: DataView, data: Uint8Array, trak: Box, mdia: Box, movieTimescale: number): Mp4VideoTrack {
  const t: Track = { kind: 'video', view, trak, mdia }
  const timescale = readTimescale(t)
  const stbl = need(t, need(t, mdia, 'minf'), 'stbl')

  // Sample description: the codec and its configuration.
  const entry = firstEntry(t, stbl)
  const codedWidth = view.getUint16(entry.start + 24)
  const codedHeight = view.getUint16(entry.start + 26)
  const { codec, description } = readCodec(view, data, entry)

  const { samples, duration } = readSamples(t, data, timescale, movieTimescale)
  if (samples.length > 0 && !samples[0]!.sync) throw new Mp4Error('The video track does not start with a keyframe.')

  return { codec, description, codedWidth, codedHeight, rotation: readRotation(view, need(t, trak, 'tkhd')), duration, samples }
}

function readAudioTrack(view: DataView, data: Uint8Array, trak: Box, mdia: Box, movieTimescale: number): Mp4AudioTrack {
  const t: Track = { kind: 'audio', view, trak, mdia }
  const timescale = readTimescale(t)
  const entry = firstEntry(t, need(t, need(t, mdia, 'minf'), 'stbl'))
  const description = readSoundEntry(view, data, entry, timescale)
  const { samples, duration } = readSamples(t, data, timescale, movieTimescale)
  return { ...description, timescale, duration, samples }
}

/** A track being read: its kind names it in the messages. */
interface Track {
  readonly kind: 'video' | 'audio'
  readonly view: DataView
  readonly trak: Box
  readonly mdia: Box
}

function readTimescale(t: Track): number {
  const mdhd = need(t, t.mdia, 'mdhd')
  const timescale = t.view.getUint8(mdhd.start) === 1 ? t.view.getUint32(mdhd.start + 20) : t.view.getUint32(mdhd.start + 12)
  if (!timescale) throw new Mp4Error(`The ${t.kind} track has no timescale.`)
  return timescale
}

/** The only sample description of the track. */
function firstEntry(t: Track, stbl: Box): Box {
  const stsd = need(t, stbl, 'stsd')
  const entry = t.view.getUint32(stsd.start + 4) < 1 ? undefined : children(t.view, stsd.start + 8, stsd.end)[0]
  if (!entry) throw new Mp4Error(`The ${t.kind} track has no sample description.`)
  return entry
}

/** Samples of the track (offsets, sizes, presentation times with the edit list applied, keyframes). */
function readSamples(t: Track, data: Uint8Array, timescale: number, movieTimescale: number): { samples: Mp4Sample[]; duration: number } {
  const view = t.view
  const stbl = need(t, need(t, t.mdia, 'minf'), 'stbl')
  const sizes = readSizes(t, stbl, data.byteLength)
  const n = sizes.length
  const offsets = readOffsets(t, stbl, sizes)
  const dts = new Float64Array(n)
  const durations = new Float64Array(n)
  {
    const stts = need(t, stbl, 'stts')
    let i = 0
    let time = 0
    const count = tableCount(view, stts, 4, 8)
    for (let e = 0; e < count && i < n; e++) {
      const p = stts.start + 8 + e * 8
      const samples = view.getUint32(p)
      const delta = view.getUint32(p + 4)
      for (let k = 0; k < samples && i < n; k++, i++) {
        dts[i] = time
        durations[i] = delta
        time += delta
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

  // Edit list: the media time shown first (B-frame delay, AAC encoder delay) and an initial empty edit.
  let shift = 0
  let delay = 0
  const edts = find(view, t.trak, 'edts')
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
  return { samples, duration }
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

/** Configuration box of each audio format the export copies (they all play in MP4 in the browsers). */
const AUDIO_CONFIG: Record<string, string> = { mp4a: 'esds', Opus: 'dOps', fLaC: 'dfLa' }

/**
 * An audio sample description, rewritten as an ISO `SoundSampleEntry` (version 0). The fields start after the
 * 8 bytes of every sample entry: version, revision, vendor, channels, sample size, compression id, packet size, rate
 * (16.16). QuickTime adds 16 bytes in version 1, 36 in version 2 (where the rate and channels move), and may put the
 * configuration box in a `wave` box.
 */
function readSoundEntry(view: DataView, data: Uint8Array, entry: Box, timescale: number): Pick<Mp4AudioTrack, 'format' | 'channels' | 'sampleRate' | 'sampleEntry'> {
  const format = entry.type
  const configType = AUDIO_CONFIG[format]
  if (format === 'enca') throw new Mp4Error('Encrypted audio tracks are not supported.')
  if (!configType) throw new Mp4Error(`Unsupported audio codec "${format}" (supported: AAC, Opus, FLAC).`)
  if (entry.end - entry.start < 28) throw new Mp4Error(`The "${format}" sample description is truncated.`)
  const version = view.getUint16(entry.start + 8)
  let channels = view.getUint16(entry.start + 16)
  const sampleSize = view.getUint16(entry.start + 18)
  let sampleRate = view.getUint32(entry.start + 24) / 65536
  const fields = version === 1 ? 44 : version === 2 ? 64 : 28
  if (version > 2) throw new Mp4Error(`The "${format}" sample description has an unknown version (${version}).`)
  if (entry.end - entry.start < fields) throw new Mp4Error(`The "${format}" sample description is truncated.`)
  if (version === 2) {
    sampleRate = view.getFloat64(entry.start + 32)
    channels = view.getUint32(entry.start + 40)
  }
  const boxes = children(view, entry.start + fields, entry.end)
  const wave = boxes.find((b) => b.type === 'wave')
  const config = boxes.find((b) => b.type === configType) ?? (wave && children(view, wave.start, wave.end).find((b) => b.type === configType))
  if (!config) throw new Mp4Error(`The "${format}" sample description has no "${configType}" box.`)
  if (!(sampleRate > 0)) sampleRate = timescale
  const rate = Math.round(sampleRate)
  const sampleEntry = boxBytes(
    format,
    new Uint8Array(6), Uint8Array.of(0, 1), // reserved, data_reference_index
    new Uint8Array(8), // version 0, revision, vendor
    u16(channels), u16(sampleSize || 16), new Uint8Array(4), // pre_defined, reserved
    u16(rate <= 0xffff ? rate : 0), new Uint8Array(2), // rate, 16.16 (0 above 65535 Hz: the timescale has it)
    boxBytes(configType, data.subarray(config.start, config.end)),
  )
  return { format, channels, sampleRate, sampleEntry }
}

/**
 * Sample sizes from `stsz` or `stz2`. The count is checked before the table is allocated: every sample takes at least
 * one byte of the file, and a variable-size table must hold one entry per sample. Without this check a 20-byte
 * constant-size `stsz` could declare 2³² − 1 samples and make the engine allocate tens of gigabytes (#123).
 * Samples do not overlap, so their sizes also add up to at most the file size.
 */
function readSizes(t: Track, stbl: Box, fileSize: number): Uint32Array {
  const view = t.view
  const stsz = find(view, stbl, 'stsz')
  if (stsz) {
    if (stsz.end - stsz.start < 12) throw new Mp4Error('The "stsz" box is truncated.')
    const fixed = view.getUint32(stsz.start + 4)
    const count = fixed ? view.getUint32(stsz.start + 8) : tableCount(view, stsz, 8, 4)
    checkSampleCount(t, count, fileSize)
    if (fixed) checkSampleBytes(t, count * fixed, fileSize)
    const sizes = new Uint32Array(count)
    if (fixed) sizes.fill(fixed)
    else for (let i = 0; i < count; i++) sizes[i] = view.getUint32(stsz.start + 12 + i * 4)
    if (!fixed) checkSampleBytes(t, sum(sizes), fileSize)
    return sizes
  }
  const stz2 = find(view, stbl, 'stz2')
  if (!stz2) throw new Mp4Error(`The ${t.kind} track has no sample size table.`)
  if (stz2.end - stz2.start < 12) throw new Mp4Error('The "stz2" box is truncated.')
  const field = view.getUint8(stz2.start + 7)
  if (field !== 4 && field !== 8 && field !== 16) {
    throw new Mp4Error(`The "stz2" box has an invalid field size (${field}).`)
  }
  const count = view.getUint32(stz2.start + 8)
  if (Math.ceil((count * field) / 8) > stz2.end - stz2.start - 12) throw tooManyEntries(stz2, count)
  checkSampleCount(t, count, fileSize)
  const sizes = new Uint32Array(count)
  const p = stz2.start + 12
  for (let i = 0; i < count; i++) {
    if (field === 16) sizes[i] = view.getUint16(p + i * 2)
    else if (field === 8) sizes[i] = view.getUint8(p + i)
    else sizes[i] = (view.getUint8(p + (i >> 1)) >> (i & 1 ? 0 : 4)) & 0xf
  }
  checkSampleBytes(t, sum(sizes), fileSize)
  return sizes
}

function readOffsets(t: Track, stbl: Box, sizes: Uint32Array): Float64Array {
  const view = t.view
  const n = sizes.length
  const stco = find(view, stbl, 'stco')
  const co64 = stco ? undefined : find(view, stbl, 'co64')
  const table = stco ?? co64
  if (!table) throw new Mp4Error(`The ${t.kind} track has no chunk offset table.`)
  const chunkCount = tableCount(view, table, 4, stco ? 4 : 8)
  const chunk = (k: number) => (stco ? view.getUint32(table.start + 8 + k * 4) : readU64(view, table.start + 8 + k * 8))

  const stsc = need(t, stbl, 'stsc')
  const runs = tableCount(view, stsc, 4, 12)
  const offsets = new Float64Array(n)
  let i = 0
  let previous = -1
  for (let r = 0; r < runs && i < n; r++) {
    const p = stsc.start + 8 + r * 12
    const first = view.getUint32(p) - 1
    const perChunk = view.getUint32(p + 4)
    // Runs come in chunk order (ISO/IEC 14496-12 §8.7.4): each chunk is then visited once, whatever the table says.
    // Without it, runs going back and forth walk the chunk table once each (quadratic on a forged file).
    if (first <= previous) throw new Mp4Error('The sample-to-chunk table is not in chunk order.')
    previous = first
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
function checkSampleCount(t: Track, count: number, fileSize: number): void {
  if (count <= fileSize) return
  throw new Mp4Error(
    `The ${t.kind} track declares ${count} samples, more than a ${fileSize}-byte file can hold (corrupt or forged file).`,
  )
}

/** Samples do not overlap: together they take at most the whole file. */
function checkSampleBytes(t: Track, bytes: number, fileSize: number): void {
  if (bytes <= fileSize) return
  throw new Mp4Error(
    `The ${t.kind} track's samples add up to ${bytes} bytes, more than the ${fileSize}-byte file (corrupt or forged file).`,
  )
}

function sum(values: Uint32Array): number {
  let total = 0
  for (const v of values) total += v
  return total
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

function need(t: Track, parent: Box, type: string): Box {
  const box = find(t.view, parent, type)
  if (!box) throw new Mp4Error(`The ${t.kind} track has no "${type}" box.`)
  return box
}

/** A box of `type` around `parts`, 32-bit size. */
function boxBytes(type: string, ...parts: Uint8Array[]): Uint8Array {
  let size = 8
  for (const p of parts) size += p.byteLength
  const out = new Uint8Array(size)
  new DataView(out.buffer).setUint32(0, size)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  let offset = 8
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

function u16(value: number): Uint8Array {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff)
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
