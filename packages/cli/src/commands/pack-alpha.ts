import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, UsageError, type Command } from '../command.ts'
import { findFfmpeg, spawnRunner, ToolError, type ProcessRunner } from '../ffmpeg.ts'
import { checkOptions, PACK_DEFAULTS, packAlpha, PackError, PackInputError, resolveInput, type PackResult } from '../pack-alpha.ts'

export interface PackAlphaDeps {
  /** Runs ffmpeg and ffprobe (default: child processes). */
  runner?: ProcessRunner
  /** Environment, for OUAF_FFMPEG (default: process.env). */
  env?: Record<string, string | undefined>
}

const HELP = `Usage: ouaf pack-alpha <input> -o <output.mp4> [options]

Converts a video with transparency into an H.264 MP4 with packed alpha (spec §10.2): the color on the left half,
the alpha mask on the right half. Declare it with "alpha": "packed"; it plays with transparency in every browser,
iOS Safari included (transparent WebM does not).

Input (needs ffmpeg and ffprobe, built with libx264):
  - a video with an alpha channel: WebM VP8/VP9 with alpha, ProRes 4444 (.mov), HEVC with alpha (recent ffmpeg)
  - a folder of RGBA PNG frames numbered in sequence (frame_0001.png, frame_0002.png…),
    or a pattern such as frames/%04d.png

Output defaults, for phones:
  - at most ${PACK_DEFAULTS.maxHeight} px high and ${Math.round((PACK_DEFAULTS.maxHeight * 16) / 9)} px wide (packed frame), never upscaled, even dimensions
  - H.264 Main profile, 4:2:0, BT.709, CRF ${PACK_DEFAULTS.crf}, a keyframe every second
  - the source frame rate, at most ${PACK_DEFAULTS.maxFps} fps (PNG sequences: ${PACK_DEFAULTS.sequenceFps} fps)
  - no audio, no metadata

Options:
  -o, --output <file.mp4>  Output file (required)
  --max-height <px>        Maximum output height, ≤ 1080 (default ${PACK_DEFAULTS.maxHeight}); the width stays ≤ 16/9 of it
  --fps <n>                Output frame rate (for a PNG sequence: its frame rate)
  --crf <0-51>             Quality: lower is better and larger (default ${PACK_DEFAULTS.crf})
  --overwrite              Replace the output file if it exists
  --ffmpeg <path>          ffmpeg binary (default: OUAF_FFMPEG, else ffmpeg on the PATH); ffprobe is
                           looked up next to it
  --json                   Print the result as JSON
  -h, --help               Show this help

Exit codes:
  0  written
  1  the conversion failed: ffmpeg missing, input without alpha or unreadable, ffmpeg error
  2  usage error: bad arguments, missing input, output exists`

export function createPackAlpha(deps: PackAlphaDeps = {}): Command {
  const runner = deps.runner ?? spawnRunner
  const env = deps.env ?? process.env
  const command: Command = {
    name: 'pack-alpha',
    summary: 'Convert a video with transparency (WebM, ProRes 4444, PNG frames) into a packed-alpha MP4',
    help: HELP,

    async run(args, io) {
      const { values, positionals } = (() => {
        try {
          return parseArgs({
            args,
            allowPositionals: true,
            options: {
              output: { type: 'string', short: 'o' },
              'max-height': { type: 'string' },
              fps: { type: 'string' },
              crf: { type: 'string' },
              overwrite: { type: 'boolean' },
              ffmpeg: { type: 'string' },
              json: { type: 'boolean' },
              help: { type: 'boolean', short: 'h' },
            },
          })
        } catch (e) {
          throw new UsageError((e as Error).message)
        }
      })()
      if (values.help) {
        io.out(HELP)
        return EXIT.OK
      }
      if (positionals.length !== 1) throw new UsageError(positionals.length ? 'Expected a single input.' : 'Missing the input video or PNG folder.')
      if (!values.output) throw new UsageError('Missing the output file: -o <output.mp4>.')
      const number = (name: string, value: string | undefined) => {
        if (value === undefined) return undefined
        const n = Number(value)
        if (value.trim() === '' || !Number.isFinite(n)) throw new UsageError(`--${name} expects a number, got "${value}".`)
        return n
      }
      const options = {
        input: positionals[0]!,
        output: values.output,
        maxHeight: number('max-height', values['max-height']) ?? PACK_DEFAULTS.maxHeight,
        crf: number('crf', values.crf) ?? PACK_DEFAULTS.crf,
        overwrite: values.overwrite ?? false,
        ...(values.fps !== undefined ? { fps: number('fps', values.fps)! } : {}),
      }
      const fail = (code: string, message: string, hint?: string) => {
        if (values.json) io.out(JSON.stringify({ ok: false, error: { code, message, ...(hint ? { hint } : {}) } }, null, 2))
        else io.err(`ouaf pack-alpha: ${message}${hint ? `\n${hint}` : ''}`)
        return EXIT.FAILED
      }
      try {
        // The arguments first: a usage error is one (exit 2) with or without ffmpeg installed.
        await checkOptions(options)
        await resolveInput(options.input)
        const tools = await findFfmpeg(runner, values.ffmpeg ?? env.OUAF_FFMPEG ?? 'ffmpeg')
        const result = await packAlpha(runner, tools, options)
        io.out(values.json ? JSON.stringify({ ok: true, ...json(result) }, null, 2) : summary(result))
        return EXIT.OK
      } catch (e) {
        if (e instanceof PackInputError) throw new UsageError(e.message)
        if (e instanceof PackError) return fail(e.code, e.message, e.hint)
        if (e instanceof ToolError) return fail(e.code, e.message)
        throw e
      }
    },
  }
  return command
}

export const packAlphaCommand = createPackAlpha()

function json(r: PackResult) {
  return {
    input: r.input,
    output: r.output,
    source: r.source,
    width: r.plan.width * 2,
    height: r.plan.height,
    colorWidth: r.plan.width,
    fps: r.plan.fps,
    gop: r.plan.gop,
    crf: r.plan.crf,
    bytes: r.bytes,
    asset: { src: `assets/${basename(r.output)}`, alpha: 'packed' },
  }
}

const fmtFps = (fps: number | undefined) => (fps === undefined ? '? fps' : `${Math.round(fps * 100) / 100} fps`)

function summary(r: PackResult): string {
  const s = r.source
  const what = s.kind === 'png-sequence' ? `${s.frames ? `${s.frames} ` : ''}PNG frames` : s.codec.toUpperCase()
  const size = r.bytes < 1e6 ? `${Math.max(1, Math.round(r.bytes / 1e3))} kB` : `${(r.bytes / 1e6).toFixed(1)} MB`
  const p = r.plan
  return `Wrote ${r.output}: ${p.width * 2}×${p.height} (color ${p.width}×${p.height} + mask), H.264, ${fmtFps(p.fps)}, ` +
    `keyframe every ${p.gop} frames, ${size}.
From ${r.input} (${what}, ${s.width}×${s.height}, ${fmtFps(s.fps)}).

Declare it in manifest.json with packed alpha (spec §10.2), e.g.:
  "assets": { "${basename(r.output, '.mp4')}": { "src": "assets/${basename(r.output)}", "alpha": "packed" } }`
}
