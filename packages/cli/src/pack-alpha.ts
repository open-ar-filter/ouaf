/**
 * `ouaf pack-alpha`: turns a video with an alpha channel (WebM VP8/VP9 with alpha, ProRes 4444, HEVC with alpha) or a
 * PNG sequence into an H.264 MP4 with packed alpha (spec §10.2): the color on the left half, the alpha mask (gray) on
 * the right half, which plays with transparency in every browser, iOS Safari included.
 *
 * The work is done by ffmpeg; this module probes the input, plans the output size and builds the ffmpeg arguments.
 */
import { readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { tail, ToolError, type Ffmpeg, type ProcessRunner } from './ffmpeg.ts'
import { VIDEO_MAX } from './validate.ts'

export const PACK_DEFAULTS = {
  /** Height of the output (px) at most; 720p is the mobile recommendation of spec §10.4. */
  maxHeight: 720,
  /** Frame rate at most when none is given: phones decode 30 fps videos comfortably. */
  maxFps: 30,
  /** Frame rate of a PNG sequence when none is given. */
  sequenceFps: 30,
  /** x264 constant rate factor: 0 lossless … 51 worst; 20 keeps the mask edges clean. */
  crf: 20,
} as const

export interface PackAlphaOptions {
  input: string
  output: string
  /** The output is at most this tall (px), and at most 16/9 of it wide (the §10.4 box, either orientation). */
  maxHeight: number
  /** Output frame rate; for a PNG sequence, its frame rate. Default: the source's, at most 30 (30 for PNGs). */
  fps?: number
  crf: number
  /** Replace the output file when it exists. */
  overwrite: boolean
}

/** What the input is, from the file system (before ffprobe). */
export type InputSource =
  | { kind: 'video'; path: string }
  | { kind: 'png-sequence'; pattern: string; start?: number; frames?: number }

/** Bad input or output path, or a bad option: exit code 2. */
export class PackInputError extends Error {}

/** The conversion could not be done (no alpha, unreadable input, ffmpeg failure): exit code 1. */
export class PackError extends Error {
  readonly code: string
  readonly hint: string | undefined
  constructor(code: string, message: string, hint?: string) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

export interface SourceInfo {
  /** ffprobe codec name: vp9, prores, hevc, png… */
  codec: string
  pixFmt: string
  width: number
  height: number
  /** Frame rate, if known. */
  fps: number | undefined
  /** Whether the decoded frames carry an alpha channel. */
  alpha: boolean
  /** ffmpeg decoder to force, for VP8/VP9 with alpha (the native decoders drop the alpha). */
  decoder: string | undefined
}

export interface PackPlan {
  /** Color half (px); the output is twice as wide. */
  width: number
  height: number
  fps: number
  /** Keyframe interval (frames): one per second, so that seeking and looping stay cheap. */
  gop: number
  crf: number
}

export interface PackResult {
  input: string
  output: string
  source: SourceInfo & { kind: InputSource['kind']; frames?: number }
  plan: PackPlan
  bytes: number
}

const PNG_NUMBERED = /^(.*?)(\d+)\.png$/i

/** Resolves the input path: a video file, a folder of numbered PNGs, or a printf pattern such as `frames/%04d.png`. */
export async function resolveInput(input: string): Promise<InputSource> {
  if (/%0?\d*d/.test(basename(input))) {
    if (extname(input).toLowerCase() !== '.png') throw new PackInputError(`"${input}": a sequence pattern must name PNG files.`)
    return { kind: 'png-sequence', pattern: input }
  }
  const info = await stat(input).catch(() => undefined)
  if (!info) throw new PackInputError(`"${input}" does not exist.`)
  if (info.isFile()) {
    if (extname(input).toLowerCase() === '.png') {
      throw new PackInputError(`"${input}" is a single image: use it as an image sticker, or pass the folder of a PNG sequence.`)
    }
    return { kind: 'video', path: input }
  }
  if (!info.isDirectory()) throw new PackInputError(`"${input}" is neither a file nor a folder.`)
  return pngSequence(input, await readdir(input))
}

/** The ffmpeg image pattern of a folder of PNG frames numbered in sequence (frame_0001.png, frame_0002.png…). */
export function pngSequence(dir: string, names: string[]): InputSource {
  const pngs = names.filter((n) => extname(n).toLowerCase() === '.png').sort()
  if (!pngs.length) throw new PackInputError(`"${dir}" contains no PNG file.`)
  const parsed = pngs.map((n) => PNG_NUMBERED.exec(n))
  const first = parsed[0]
  const bad = pngs.find((_, i) => !parsed[i] || parsed[i]![1] !== first?.[1])
  if (!first || bad !== undefined) {
    throw new PackInputError(`"${dir}": every PNG must be named <prefix><number>.png with the same prefix ("${bad ?? pngs[0]}" is not).`)
  }
  const digits = parsed.map((m) => m![2]!)
  const width = digits[0]!.length
  const padded = digits.every((d) => d.length === width)
  if (!padded && digits.some((d) => d.length > 1 && d.startsWith('0'))) {
    throw new PackInputError(`"${dir}": frame numbers mix padded and unpadded widths.`)
  }
  const numbers = digits.map(Number).sort((a, b) => a - b)
  const gap = numbers.findIndex((n, i) => i > 0 && n !== numbers[i - 1]! + 1)
  if (gap > 0) throw new PackInputError(`"${dir}": frame ${numbers[gap - 1]! + 1} is missing (frames must be numbered without gaps).`)
  const prefix = first[1]!.replaceAll('%', '%%')
  return {
    kind: 'png-sequence',
    pattern: join(dir, `${prefix}${padded && width > 1 ? `%0${width}d` : '%d'}.png`),
    start: numbers[0]!,
    frames: numbers.length,
  }
}

/** ffmpeg / ffprobe input arguments (options and `-i`), without the decoder. */
function inputArgs(source: InputSource, fps: number | undefined): string[] {
  if (source.kind === 'video') return ['-i', source.path]
  return [
    '-f', 'image2',
    '-framerate', String(fps ?? PACK_DEFAULTS.sequenceFps),
    ...(source.start !== undefined ? ['-start_number', String(source.start)] : []),
    '-i', source.pattern,
  ]
}

interface ProbeJson {
  streams?: Array<{
    codec_name?: string
    pix_fmt?: string
    width?: number
    height?: number
    avg_frame_rate?: string
    r_frame_rate?: string
    tags?: Record<string, string>
  }>
}

/** Pixel formats with an alpha channel (ffmpeg names): yuva*, rgba, bgra, argb, abgr, ya8/ya16, gbrap*, pal8. */
const ALPHA_PIX_FMT = /^(yuva|rgba|bgra|argb|abgr|ya\d|gbrap|pal8)/

function rate(value: string | undefined): number | undefined {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(value ?? '')
  if (!m) return undefined
  const r = Number(m[1]) / Number(m[2] ?? 1)
  return Number.isFinite(r) && r > 0 ? r : undefined
}

/** Reads the first video stream of the input with ffprobe. */
export async function probe(runner: ProcessRunner, tools: Ffmpeg, source: InputSource, fps?: number): Promise<SourceInfo> {
  const r = await runner(tools.ffprobe, [
    '-v', 'error', ...inputArgs(source, fps),
    '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height,avg_frame_rate,r_frame_rate:stream_tags',
    '-of', 'json',
  ])
  const label = source.kind === 'video' ? source.path : source.pattern
  if (r.code !== 0) throw new PackError('unreadable-input', `ffprobe could not read "${label}":\n${tail(r.stderr)}`)
  let json: ProbeJson
  try {
    json = JSON.parse(r.stdout) as ProbeJson
  } catch {
    throw new PackError('unreadable-input', `ffprobe returned unexpected output for "${label}".`)
  }
  const s = json.streams?.[0]
  if (!s || !s.width || !s.height) throw new PackError('no-video', `"${label}" has no video stream.`)
  const codec = s.codec_name ?? 'unknown'
  const pixFmt = s.pix_fmt ?? 'unknown'
  // VP8/VP9 store the alpha as a side stream that only libvpx decodes; the container flags it with alpha_mode.
  const vpxAlpha = (codec === 'vp9' || codec === 'vp8') &&
    Object.entries(s.tags ?? {}).some(([k, v]) => k.toLowerCase() === 'alpha_mode' && v === '1')
  return {
    codec,
    pixFmt,
    width: s.width,
    height: s.height,
    fps: source.kind === 'png-sequence' ? (fps ?? PACK_DEFAULTS.sequenceFps) : rate(s.avg_frame_rate) ?? rate(s.r_frame_rate),
    alpha: vpxAlpha || ALPHA_PIX_FMT.test(pixFmt),
    decoder: vpxAlpha ? (codec === 'vp9' ? 'libvpx-vp9' : 'libvpx') : undefined,
  }
}

const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2)

/**
 * Output size and timing: the packed frame (2 × width by height) fits in maxHeight × 16/9·maxHeight, never upscaled,
 * with even dimensions (4:2:0 chroma, and the mask starts on a chroma sample).
 */
export function plan(source: Pick<SourceInfo, 'width' | 'height' | 'fps'>, options: Pick<PackAlphaOptions, 'maxHeight' | 'fps' | 'crf'>): PackPlan {
  const maxWidth = Math.round((options.maxHeight * 16) / 9)
  const scale = Math.min(1, options.maxHeight / source.height, maxWidth / (2 * source.width))
  const fps = options.fps ?? Math.min(source.fps ?? PACK_DEFAULTS.maxFps, PACK_DEFAULTS.maxFps)
  return {
    width: even(source.width * scale),
    height: even(source.height * scale),
    fps,
    gop: Math.max(1, Math.round(fps)),
    crf: options.crf,
  }
}

/** Frame rate as ffmpeg reads it: integers as such, the NTSC rates as exact fractions. */
function fpsArg(fps: number): string {
  if (Number.isInteger(fps)) return String(fps)
  for (const base of [24, 30, 60]) if (Math.abs(fps - (base * 1000) / 1001) < 0.01) return `${base * 1000}/1001`
  return String(fps)
}

/**
 * The filter graph: straight-alpha RGBA, scaled in premultiplied space (no dark or colored fringes from the
 * transparent pixels), then the color and the alpha (as gray) side by side, converted to BT.709 limited range.
 */
export function filterGraph(p: PackPlan, changeFps: boolean): string {
  const color = [
    ...(changeFps ? [`fps=${fpsArg(p.fps)}`] : []),
    'format=gbrap',
    'premultiply=inplace=1',
    `scale=${p.width}:${p.height}:flags=lanczos`,
    'unpremultiply=inplace=1',
    'format=gbrap',
    'split[c][a]',
  ].join(',')
  return `[0:v]${color};[a]alphaextract,format=gbrp[mask];[c]format=gbrp[rgb];` +
    '[rgb][mask]hstack=inputs=2,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]'
}

/** The ffmpeg command line that writes `output` (MP4, H.264, no audio, no metadata). */
export function ffmpegArgs(source: InputSource, info: SourceInfo, p: PackPlan, output: string): string[] {
  const changeFps = source.kind === 'video' && (info.fps === undefined || Math.abs(info.fps - p.fps) > 0.01)
  return [
    '-hide_banner', '-nostdin', '-v', 'error', '-y',
    ...(info.decoder ? ['-c:v', info.decoder] : []),
    ...inputArgs(source, source.kind === 'png-sequence' ? p.fps : undefined),
    '-filter_complex', filterGraph(p, changeFps),
    '-map', '[v]', '-an', '-sn', '-dn',
    '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'main', '-crf', String(p.crf),
    // A keyframe every second, none in between (no scene-cut keyframes): seeks and loops land on one quickly.
    '-g', String(p.gop), '-keyint_min', String(p.gop), '-sc_threshold', '0',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    // No metadata (a phone video carries its location) and no encoder version: the same input gives the same file.
    '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact',
    '-movflags', '+faststart', '-f', 'mp4', output,
  ]
}

/** Checks the options that do not depend on the input. */
export async function checkOptions(o: PackAlphaOptions): Promise<void> {
  if (extname(o.output).toLowerCase() !== '.mp4') throw new PackInputError(`The output must be an .mp4 file ("${o.output}").`)
  if (!Number.isInteger(o.maxHeight) || o.maxHeight < 16 || o.maxHeight > VIDEO_MAX.short) {
    throw new PackInputError(`--max-height must be an integer from 16 to ${VIDEO_MAX.short} (spec §10.4: videos ≤ 1080p).`)
  }
  if (o.fps !== undefined && !(o.fps > 0 && o.fps <= 120)) throw new PackInputError('--fps must be a number above 0 and at most 120.')
  if (!Number.isInteger(o.crf) || o.crf < 0 || o.crf > 51) throw new PackInputError('--crf must be an integer from 0 to 51.')
  const out = await stat(o.output).catch(() => undefined)
  if (out?.isDirectory()) throw new PackInputError(`"${o.output}" is a folder.`)
  if (out && !o.overwrite) throw new PackInputError(`"${o.output}" already exists (use --overwrite to replace it).`)
}

/** Probes, plans and encodes. Writes to a temporary file next to the output, renamed once ffmpeg succeeded. */
export async function packAlpha(runner: ProcessRunner, tools: Ffmpeg, o: PackAlphaOptions): Promise<PackResult> {
  await checkOptions(o)
  const source = await resolveInput(o.input)
  const info = await probe(runner, tools, source, o.fps)
  if (!info.alpha) {
    throw new PackError('no-alpha', `"${o.input}" has no alpha channel (${info.codec}, ${info.pixFmt}).`, noAlphaHint(info))
  }
  const p = plan(info, o)
  const partial = `${o.output}.partial`
  const r = await runner(tools.ffmpeg, ffmpegArgs(source, info, p, partial)).catch(async (e: unknown) => {
    await rm(partial, { force: true })
    throw e instanceof ToolError ? e : new PackError('encode-failed', `Could not run ffmpeg: ${(e as Error).message}`)
  })
  if (r.code !== 0) {
    await rm(partial, { force: true })
    throw new PackError('encode-failed', `ffmpeg failed (exit code ${r.code}):\n${tail(r.stderr)}`)
  }
  const size = await stat(partial).catch(() => undefined)
  if (!size?.isFile() || !size.size) {
    await rm(partial, { force: true })
    throw new PackError('encode-failed', 'ffmpeg exited without writing the output.')
  }
  await rename(partial, o.output)
  return {
    input: o.input,
    output: o.output,
    source: { ...info, kind: source.kind, ...(source.kind === 'png-sequence' && source.frames ? { frames: source.frames } : {}) },
    plan: p,
    bytes: size.size,
  }
}

function noAlphaHint(info: SourceInfo): string {
  switch (info.codec) {
    case 'hevc':
      return 'Either the video has no alpha layer, or this ffmpeg cannot decode it (HEVC alpha needs a recent ffmpeg). ' +
        'Update ffmpeg, or export the animation as ProRes 4444, WebM VP9 with alpha or a PNG sequence.'
    case 'prores':
      return 'Export with the ProRes 4444 profile and an alpha channel ("RGB + Alpha"); 422 profiles have no alpha.'
    case 'vp8':
    case 'vp9':
      return 'Export the WebM with an alpha channel (e.g. ffmpeg -c:v libvpx-vp9 -pix_fmt yuva420p).'
    case 'png':
      return 'Export the frames as RGBA PNGs (with transparency).'
    default:
      return 'Supported inputs with alpha: WebM VP8/VP9 with alpha, ProRes 4444, HEVC with alpha (recent ffmpeg), PNG sequences.'
  }
}
