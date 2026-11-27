/**
 * Minimal MP4 muxer for the frame-exact export (#137): one video track of encoded frames (WebCodecs
 * `EncodedVideoChunk`s) into a progressive MP4 whose `moov` comes before the `mdat` ("fast start"), so that the file
 * has its duration and its sample index from the first bytes: a browser plays and seeks it at once. No dependency,
 * like the demuxer of `mp4.ts`, which reads these files back (the unit tests round-trip through it).
 *
 * Codecs: H.264 (`avc1`, with the `avcC` record the encoder gives as `decoderConfig.description`) and VP9 (`vp09`).
 * Frames are added in decoding order with their presentation times; frames reordered by the encoder (B-frames) get
 * composition offsets. The first frame shown starts at 0.
 *
 * An audio track already encoded (the export copies the clip's, #137) can go with it: its samples are written as
 * given, interleaved with the frames, and an edit list starts it at its time on the video's timeline and stops it
 * where the video stops.
 */

export interface Mp4WriterTrack {
  /** WebCodecs codec string: `avc1.*` or `vp09.*`. */
  readonly codec: string
  /** Size of the coded frames, in pixels. */
  readonly width: number
  readonly height: number
  /** Codec configuration record: the `avcC` payload for H.264 (required), ignored for VP9. */
  readonly description?: Uint8Array | undefined
}

/** Encoded audio to write next to the video (`finish`). */
export interface Mp4WriterAudio {
  /** The `stsd` entry: a `SoundSampleEntry` box with its configuration box (`Mp4AudioTrack.sampleEntry`). */
  readonly sampleEntry: Uint8Array
  /** Ticks per second of the track (the sample rate, or the source track's timescale). */
  readonly timescale: number
  /**
   * Samples in decoding order, with their presentation time on the same timeline as the frames' (s) and their
   * duration (s). Negative times (AAC encoder delay) are kept and skipped at playback by the edit list.
   */
  readonly samples: readonly Mp4WriterAudioSample[]
}

export interface Mp4WriterAudioSample {
  readonly data: Uint8Array
  readonly time: number
  readonly duration: number
}

/** Ticks per second of the track: 90 kHz holds 24, 25, 30, 50, 60 fps and their NTSC variants exactly. */
const TIMESCALE = 90000
/** Ticks per second of the movie header (durations only). */
const MOVIE_TIMESCALE = 1000
const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]

export class Mp4Writer {
  readonly #track: Mp4WriterTrack
  readonly #entry: Uint8Array
  readonly #data: Uint8Array[] = []
  /** Presentation times in ticks, in decoding order. */
  readonly #times: number[] = []
  readonly #sync: boolean[] = []

  constructor(track: Mp4WriterTrack) {
    if (!(track.width > 0 && track.height > 0 && track.width <= 0xffff && track.height <= 0xffff)) {
      throw new RangeError(`Invalid frame size ${track.width}×${track.height}.`)
    }
    this.#track = track
    this.#entry = sampleEntry(track)
  }

  /** Frames added so far. */
  get frameCount(): number {
    return this.#data.length
  }

  /** Adds an encoded frame, in decoding order: `time` is its presentation time in seconds. The bytes are kept as given. */
  add(data: Uint8Array, time: number, sync: boolean): void {
    if (!Number.isFinite(time)) throw new RangeError(`time must be a finite number of seconds, got ${time}`)
    if (this.#data.length === 0 && !sync) throw new RangeError('The first frame must be a keyframe.')
    this.#data.push(data)
    this.#times.push(Math.round(time * TIMESCALE))
    this.#sync.push(sync)
  }

  /**
   * The MP4 file. `end` (s) is when the last frame shown stops, i.e. the video's duration measured from the first
   * frame's time; default: one frame later, at the interval of the two frames before (1/30 s for a single frame).
   * `audio`: a second track, cut at the end of the video (samples starting after it are left out).
   */
  finish(end?: number, audio?: Mp4WriterAudio): Blob {
    const n = this.#data.length
    if (n === 0) throw new RangeError('No frame to write.')
    // Presentation times from 0; decoding times are the same times sorted, so each frame is decoded no later than
    // shown and the offsets stay small. Without reordering every offset is 0 and the `ctts` box is left out.
    let first = Infinity
    for (const t of this.#times) first = Math.min(first, t)
    const pts = this.#times.map((t) => t - first)
    const dts = [...pts].sort((a, b) => a - b)
    const last = dts[n - 1]!
    const fallback = n > 1 ? last - dts[n - 2]! : Math.round(TIMESCALE / 30)
    let endTicks = end === undefined ? last + fallback : Math.round(end * TIMESCALE) - first
    if (!(endTicks > last)) endTicks = last + Math.max(1, fallback)
    const durations = dts.map((t, i) => (i + 1 < n ? dts[i + 1]! : endTicks) - t)
    const offsets = pts.map((t, i) => t - dts[i]!)
    const video: TrackTables = { durations, sizes: this.#data.map((d) => d.byteLength), chunks: [], chunkOffsets: [] }
    const sound = audio && audioTables(audio, first / TIMESCALE, endTicks / TIMESCALE)

    // The media data: frames and runs of audio samples in time order, one frame or one run per chunk.
    const parts: Uint8Array[] = []
    let p = 0
    const chunk = (tables: TrackTables, data: readonly Uint8Array[]) => {
      tables.chunks.push(data.length)
      tables.chunkOffsets.push(p)
      for (const d of data) {
        parts.push(d)
        p += d.byteLength
      }
    }
    let a = 0
    const audioUntil = (time: number) => {
      if (!sound) return
      const run: Uint8Array[] = []
      while (a < sound.samples.length && sound.times[a]! < time) run.push(sound.samples[a++]!.data)
      if (run.length > 0) chunk(sound.tables, run)
    }
    for (let i = 0; i < n; i++) {
      audioUntil(dts[i]! / TIMESCALE)
      chunk(video, [this.#data[i]!])
    }
    audioUntil(Infinity)

    const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii(fourcc(this.#entry)), ascii('mp41'))
    const large = p + 16 > 0xffffffff
    const mdatHeader = large ? concat(u32(1), ascii('mdat'), u64(p + 16)) : concat(u32(p + 8), ascii('mdat'))
    const build = (base: number) => this.#moov(video, offsets, endTicks, sound, base, base + p > 0xffffffff)
    // The chunk offsets depend on the size of the `moov`, which does not depend on their values.
    const size = build(0).byteLength
    const moov = build(ftyp.byteLength + size + mdatHeader.byteLength)
    return new Blob([ftyp as BlobPart, moov as BlobPart, mdatHeader as BlobPart, ...(parts as BlobPart[])], { type: 'video/mp4' })
  }

  #moov(video: TrackTables, offsets: number[], endTicks: number, sound: AudioTables | undefined, base: number, co64: boolean): Uint8Array {
    const { width, height } = this.#track
    const movieDuration = Math.round((endTicks * MOVIE_TIMESCALE) / TIMESCALE)

    const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_TIMESCALE), u32(movieDuration), u32(0x10000), u16(0x100), zeros(10), matrix(), zeros(24), u32(sound ? 3 : 2))
    const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), zeros(4), u32(movieDuration), zeros(8), u16(0), u16(0), u16(0), zeros(2), matrix(), u32(width * 0x10000), u32(height * 0x10000))
    const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(endTicks), u16(0x55c4 /* "und" */), u16(0))
    const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('vide'), zeros(12), ascii('VideoHandler\0'))
    const vmhd = fullBox('vmhd', 0, 1, zeros(8))

    const stsd = fullBox('stsd', 0, 0, u32(1), this.#entry)
    const reordered = offsets.some((o) => o !== 0)
    const ctts = reordered ? fullBox('ctts', 1, 0, ...runs(offsets, (count, offset) => concat(u32(count), i32(offset)))) : undefined
    const keys = this.#sync.every(Boolean) ? undefined : this.#sync.flatMap((s, i) => (s ? [i + 1] : []))
    const stss = keys && fullBox('stss', 0, 0, u32(keys.length), ...keys.map(u32))
    const stbl = sampleTable(stsd, video, base, co64, ...(ctts ? [ctts] : []), ...(stss ? [stss] : []))
    const mdia = box('mdia', mdhd, hdlr, box('minf', vmhd, dataInformation(), stbl))
    const tracks = [box('trak', tkhd, mdia)]
    if (sound) tracks.push(audioTrack(sound, base, co64))
    return box('moov', mvhd, ...tracks)
  }
}

/** Sample sizes and durations of a track, and its chunks (sample count and offset from the start of the media data). */
interface TrackTables {
  readonly durations: number[]
  readonly sizes: number[]
  readonly chunks: number[]
  readonly chunkOffsets: number[]
}

interface AudioTables {
  readonly entry: Uint8Array
  readonly timescale: number
  readonly samples: readonly Mp4WriterAudioSample[]
  /** Presentation times on the video's timeline from its first frame (s), to interleave the samples. */
  readonly times: number[]
  readonly tables: TrackTables
  /** Media time shown at the start (ticks of the track), the delay before it (s), and how long it plays (s). */
  readonly mediaTime: number
  readonly delay: number
  readonly length: number
  readonly mediaDuration: number
}

/** The audio samples that start before the video ends (`end`, s), on the timeline of the first frame (`origin`, s). */
function audioTables(audio: Mp4WriterAudio, origin: number, end: number): AudioTables | undefined {
  const { timescale } = audio
  if (!(Number.isInteger(timescale) && timescale > 0)) throw new RangeError(`The audio timescale must be a positive integer, got ${timescale}`)
  if (audio.sampleEntry.byteLength < 8) throw new RangeError('The audio sample entry is not a box.')
  const samples = audio.samples.filter((s) => s.time - origin < end)
  if (samples.length === 0) return undefined
  const times = samples.map((s) => s.time - origin)
  for (const t of times) if (!Number.isFinite(t)) throw new RangeError(`An audio sample time must be a finite number of seconds, got ${t}`)
  // Decoding times from the presentation times, in ticks from the first sample: gaps in the source stay.
  const ticks = times.map((t) => Math.round(t * timescale))
  const start = ticks[0]!
  const dts = ticks.map((t) => t - start)
  const durations = dts.map((t, i) => (i + 1 < dts.length ? Math.max(0, dts[i + 1]! - t) : Math.max(1, Math.round(samples[i]!.duration * timescale))))
  const mediaDuration = dts.at(-1)! + durations.at(-1)!
  const mediaTime = Math.max(0, -start)
  const delay = Math.max(0, start) / timescale
  const length = Math.min((mediaDuration - mediaTime) / timescale, end - delay)
  return {
    entry: audio.sampleEntry,
    timescale,
    samples,
    times,
    tables: { durations, sizes: samples.map((s) => s.data.byteLength), chunks: [], chunkOffsets: [] },
    mediaTime,
    delay,
    length,
    mediaDuration,
  }
}

function audioTrack(sound: AudioTables, base: number, co64: boolean): Uint8Array {
  const delay = Math.round(sound.delay * MOVIE_TIMESCALE)
  const length = Math.max(0, Math.round(sound.length * MOVIE_TIMESCALE))
  const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(2), zeros(4), u32(delay + length), zeros(8), u16(0), u16(0), u16(0x100), zeros(2), matrix(), u32(0), u32(0))
  // The edit list: an empty edit for a late start, then the media from the first sample shown, up to the video's end.
  const edits = [...(delay > 0 ? [concat(u32(delay), i32(-1), u32(0x10000))] : []), concat(u32(length), i32(sound.mediaTime), u32(0x10000))]
  const edts = box('edts', fullBox('elst', 0, 0, u32(edits.length), ...edits))
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(sound.timescale), u32(sound.mediaDuration), u16(0x55c4 /* "und" */), u16(0))
  const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('soun'), zeros(12), ascii('SoundHandler\0'))
  const smhd = fullBox('smhd', 0, 0, u16(0), u16(0))
  const stbl = sampleTable(fullBox('stsd', 0, 0, u32(1), sound.entry), sound.tables, base, co64)
  return box('trak', tkhd, edts, box('mdia', mdhd, hdlr, box('minf', smhd, dataInformation(), stbl)))
}

/** `stbl` of a track: its description, `stts`, the boxes given (`ctts`, `stss`), `stsc`, `stsz` and chunk offsets. */
function sampleTable(stsd: Uint8Array, t: TrackTables, base: number, co64: boolean, ...more: Uint8Array[]): Uint8Array {
  const stts = fullBox('stts', 0, 0, ...runs(t.durations, (count, delta) => concat(u32(count), u32(delta))))
  // Sample-to-chunk: one entry where the samples per chunk change.
  const stscEntries: Uint8Array[] = []
  t.chunks.forEach((count, i) => {
    if (i === 0 || count !== t.chunks[i - 1]) stscEntries.push(concat(u32(i + 1), u32(count), u32(1)))
  })
  const stsc = fullBox('stsc', 0, 0, u32(stscEntries.length), ...stscEntries)
  const stsz = fullBox('stsz', 0, 0, u32(0), u32(t.sizes.length), ...t.sizes.map(u32))
  const chunkOffsets = t.chunkOffsets.map((o) => o + base)
  const stco = co64 ? fullBox('co64', 0, 0, u32(chunkOffsets.length), ...chunkOffsets.map(u64)) : fullBox('stco', 0, 0, u32(chunkOffsets.length), ...chunkOffsets.map(u32))
  return box('stbl', stsd, stts, ...more, stsc, stsz, stco)
}

function dataInformation(): Uint8Array {
  return box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)))
}

/** The `stsd` entry of the track: a VisualSampleEntry and its configuration box. */
function sampleEntry(track: Mp4WriterTrack): Uint8Array {
  const kind = track.codec.slice(0, 4)
  let config: Uint8Array
  if (kind === 'avc1') {
    if (!track.description || track.description.byteLength === 0) throw new RangeError('An H.264 track needs its avcC record (decoderConfig.description).')
    config = box('avcC', track.description)
  } else if (kind === 'vp09') {
    const m = /^vp09\.(\d\d)\.(\d\d)\.(\d\d)/.exec(track.codec)
    if (!m) throw new RangeError(`Invalid VP9 codec string "${track.codec}".`)
    const [profile, level, depth] = [Number(m[1]), Number(m[2]), Number(m[3])]
    // 4:2:0 (chroma at the luma sample), BT.709, limited range: what the browsers' VP9 encoders produce.
    config = fullBox('vpcC', 1, 0, u8(profile), u8(level), u8((depth << 4) | (1 << 1)), u8(1), u8(1), u8(1), u16(0))
  } else throw new RangeError(`Unsupported codec "${track.codec}" (supported: avc1, vp09).`)
  const compressor = zeros(32)
  return box(
    kind,
    zeros(6), u16(1), // reserved, data_reference_index
    zeros(16), // pre_defined, reserved
    u16(track.width), u16(track.height),
    u32(0x480000), u32(0x480000), // 72 dpi
    zeros(4), u16(1), compressor, u16(0x18), u16(0xffff), // frame_count, compressorname, depth, pre_defined
    config,
  )
}

/** Run-length entries of a table (`stts`, `ctts`): consecutive equal values in one entry. */
function runs(values: number[], entry: (count: number, value: number) => Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  let i = 0
  while (i < values.length) {
    let j = i + 1
    while (j < values.length && values[j] === values[i]) j++
    out.push(entry(j - i, values[i]!))
    i = j
  }
  return [u32(out.length), ...out]
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payload = concat(...parts)
  return concat(u32(payload.byteLength + 8), ascii(type), payload)
}

function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(type, u32(((version & 0xff) << 24) | (flags & 0xffffff)), ...parts)
}

function fourcc(entry: Uint8Array): string {
  return String.fromCharCode(entry[4]!, entry[5]!, entry[6]!, entry[7]!)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let size = 0
  for (const p of parts) size += p.byteLength
  const out = new Uint8Array(size)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

function matrix(): Uint8Array {
  return concat(...IDENTITY.map(u32))
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}

function zeros(n: number): Uint8Array {
  return new Uint8Array(n)
}

function u8(value: number): Uint8Array {
  return Uint8Array.of(value)
}

function u16(value: number): Uint8Array {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff)
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value >>> 0)
  return out
}

function i32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setInt32(0, value)
  return out
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8)
  const view = new DataView(out.buffer)
  view.setUint32(0, Math.floor(value / 4294967296))
  view.setUint32(4, value >>> 0)
  return out
}
