/**
 * `ouaf pack-alpha` step by step, with a fake process runner (no ffmpeg): input resolution, ffprobe output parsing,
 * the ffmpeg command line, option checks, failures of the encoder and the command's output.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../src/cli.ts'
import { EXIT } from '../src/command.ts'
import { createPackAlpha } from '../src/commands/pack-alpha.ts'
import { ToolError, type Ffmpeg, type ProcessResult, type ProcessRunner } from '../src/ffmpeg.ts'
import {
  checkOptions, ffmpegArgs, packAlpha, PackError, PackInputError, plan, probe, resolveInput, type PackAlphaOptions, type SourceInfo,
} from '../src/pack-alpha.ts'

const tools: Ffmpeg = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', version: 'ffmpeg version 7.1' }
const ok = (stdout = ''): ProcessResult => ({ code: 0, stdout, stderr: '' })
const probeAnswer = (stream: Record<string, unknown> | undefined): ProcessRunner => async () => ok(JSON.stringify({ streams: stream ? [stream] : [] }))

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ouaf-pack-alpha-steps-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('resolveInput', () => {
  it('a printf pattern must name PNG files; it is not checked on disk', async () => {
    expect(await resolveInput(join(dir, 'frames', '%04d.png'))).toEqual({ kind: 'png-sequence', pattern: join(dir, 'frames', '%04d.png') })
    expect(await resolveInput('f/frame_%d.PNG')).toMatchObject({ kind: 'png-sequence' })
    await expect(resolveInput('f/%04d.jpg')).rejects.toThrow(new PackInputError('"f/%04d.jpg": a sequence pattern must name PNG files.'))
  })

  it('a video file, a single PNG (refused), a folder of PNGs, something else', async () => {
    await writeFile(join(dir, 'a.mov'), 'x')
    await writeFile(join(dir, 'one.PNG'), 'x')
    expect(await resolveInput(join(dir, 'a.mov'))).toEqual({ kind: 'video', path: join(dir, 'a.mov') })
    await expect(resolveInput(join(dir, 'one.PNG'))).rejects.toThrow(/is a single image: use it as an image sticker/)
    await mkdir(join(dir, 'seq'))
    await writeFile(join(dir, 'seq', 'f1.png'), 'x')
    await writeFile(join(dir, 'seq', 'f2.png'), 'x')
    expect(await resolveInput(join(dir, 'seq'))).toEqual({ kind: 'png-sequence', pattern: join(dir, 'seq', 'f%d.png'), start: 1, frames: 2 })
    await expect(resolveInput('/dev/null')).rejects.toThrow('"/dev/null" is neither a file nor a folder.')
  })
})

describe('probe', () => {
  const video = { kind: 'video' as const, path: 'in.webm' }

  it('reports ffprobe failures, unexpected output and inputs without video', async () => {
    const failed: ProcessRunner = async () => ({ code: 1, stdout: '', stderr: 'a\nin.webm: Invalid data found when processing input\n' })
    await expect(probe(failed, tools, video)).rejects.toThrow(new PackError('unreadable-input', 'ffprobe could not read "in.webm":\na\nin.webm: Invalid data found when processing input'))
    await expect(probe(async () => ok('not json'), tools, video)).rejects.toThrow('ffprobe returned unexpected output for "in.webm".')
    await expect(probe(probeAnswer(undefined), tools, video)).rejects.toMatchObject({ code: 'no-video', message: '"in.webm" has no video stream.' })
    await expect(probe(async () => ok('{}'), tools, video)).rejects.toMatchObject({ code: 'no-video' })
    await expect(probe(probeAnswer({ codec_name: 'vp9', width: 0, height: 10 }), tools, video)).rejects.toMatchObject({ code: 'no-video' })
  })

  it('reads the codec, the alpha and the frame rate; libvpx for VP8/VP9 alpha', async () => {
    expect(await probe(probeAnswer({ codec_name: 'vp8', pix_fmt: 'yuv420p', width: 4, height: 2, r_frame_rate: '24/1', tags: { alpha_mode: '1' } }), tools, video))
      .toEqual({ codec: 'vp8', pixFmt: 'yuv420p', width: 4, height: 2, fps: 24, alpha: true, decoder: 'libvpx' })
    // An alpha_mode tag on another codec, or set to 0, does not count.
    expect(await probe(probeAnswer({ codec_name: 'h264', pix_fmt: 'yuv420p', width: 4, height: 2, tags: { alpha_mode: '1' } }), tools, video))
      .toMatchObject({ alpha: false, decoder: undefined, fps: undefined })
    expect(await probe(probeAnswer({ codec_name: 'vp9', pix_fmt: 'yuv420p', width: 4, height: 2, tags: { ALPHA_MODE: '0' } }), tools, video))
      .toMatchObject({ alpha: false })
    // Unknown codec and pixel format; a rate of 0/0 is no rate.
    expect(await probe(probeAnswer({ width: 4, height: 2, avg_frame_rate: '0/0', r_frame_rate: '30000/1001' }), tools, video))
      .toMatchObject({ codec: 'unknown', pixFmt: 'unknown', fps: 30000 / 1001, alpha: false })
    for (const pix of ['rgba', 'yuva444p10le', 'gbrap', 'ya8', 'pal8']) {
      expect((await probe(probeAnswer({ codec_name: 'qtrle', pix_fmt: pix, width: 4, height: 2 }), tools, video)).alpha).toBe(true)
    }
  })

  it('a PNG sequence runs at --fps, 30 fps by default, from its first number', async () => {
    const calls: string[][] = []
    const runner: ProcessRunner = async (_bin, args) => (calls.push(args), ok(JSON.stringify({ streams: [{ codec_name: 'png', pix_fmt: 'rgba', width: 4, height: 2, avg_frame_rate: '25/1' }] })))
    const seq = { kind: 'png-sequence' as const, pattern: 'f/%d.png', start: 7, frames: 3 }
    expect((await probe(runner, tools, seq)).fps).toBe(30)
    expect((await probe(runner, tools, seq, 12)).fps).toBe(12)
    expect(calls[1]).toEqual(expect.arrayContaining(['-f', 'image2', '-framerate', '12', '-start_number', '7', '-i', 'f/%d.png']))
    await probe(runner, tools, { kind: 'png-sequence', pattern: 'f/%d.png' })
    expect(calls[2]).not.toContain('-start_number')
  })
})

describe('ffmpegArgs', () => {
  const info: SourceInfo = { codec: 'vp9', pixFmt: 'yuv420p', width: 64, height: 64, fps: 25, alpha: true, decoder: 'libvpx-vp9' }
  const p = plan(info, { maxHeight: 720, crf: 20 })

  it('forces the alpha decoder before the input, writes an H.264 MP4 without audio or metadata', () => {
    const args = ffmpegArgs({ kind: 'video', path: 'in.webm' }, info, p, 'out.mp4.partial')
    expect(args.slice(0, 9)).toEqual(['-hide_banner', '-nostdin', '-v', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', 'in.webm'])
    expect(args).toEqual(expect.arrayContaining(['-an', '-c:v', 'libx264', '-crf', '20', '-g', '25', '-map_metadata', '-1']))
    expect(args.slice(-3)).toEqual(['-f', 'mp4', 'out.mp4.partial'])
    // Same frame rate: no fps filter.
    expect(args[args.indexOf('-filter_complex') + 1]).toMatch(/^\[0:v\]format=gbrap/)
  })

  it('changes the frame rate of a video above 30 fps, or of unknown rate; never of a PNG sequence', () => {
    const fast = { ...info, fps: 60, decoder: undefined }
    const args = ffmpegArgs({ kind: 'video', path: 'in.mov' }, fast, plan(fast, { maxHeight: 720, crf: 20 }), 'o.mp4')
    expect(args).not.toContain('libvpx-vp9')
    expect(args[args.indexOf('-filter_complex') + 1]).toMatch(/^\[0:v\]fps=30,/)
    const unknown = { ...info, fps: undefined }
    const u = ffmpegArgs({ kind: 'video', path: 'in.mov' }, unknown, plan(unknown, { maxHeight: 720, crf: 20 }), 'o.mp4')
    expect(u[u.indexOf('-filter_complex') + 1]).toMatch(/^\[0:v\]fps=30,/)
    const ntsc = { ...info, fps: 60000 / 1001 }
    const n = ffmpegArgs({ kind: 'video', path: 'in.mov' }, ntsc, plan(ntsc, { maxHeight: 720, crf: 20, fps: 24000 / 1001 }), 'o.mp4')
    expect(n[n.indexOf('-filter_complex') + 1]).toMatch(/^\[0:v\]fps=24000\/1001,/)
    const odd = ffmpegArgs({ kind: 'video', path: 'in.mov' }, info, plan(info, { maxHeight: 720, crf: 20, fps: 12.5 }), 'o.mp4')
    expect(odd[odd.indexOf('-filter_complex') + 1]).toMatch(/^\[0:v\]fps=12\.5,/)
    const seq = ffmpegArgs({ kind: 'png-sequence', pattern: 'f/%d.png', start: 0 }, { ...info, fps: 8, decoder: undefined }, { ...p, fps: 8 }, 'o.mp4')
    expect(seq).toEqual(expect.arrayContaining(['-framerate', '8', '-start_number', '0']))
    expect(seq[seq.indexOf('-filter_complex') + 1]).not.toContain('fps=')
  })
})

describe('checkOptions', () => {
  const o = (extra: Partial<PackAlphaOptions>): PackAlphaOptions => ({ input: 'in.webm', output: join(dir, 'o.mp4'), maxHeight: 720, crf: 20, overwrite: false, ...extra })

  it('limits the height to 1080p (spec §10.4), the frame rate to 120, the CRF to x264\'s range', async () => {
    await expect(checkOptions(o({}))).resolves.toBeUndefined()
    await expect(checkOptions(o({ output: join(dir, 'o.MP4'), maxHeight: 16, crf: 0, fps: 120 }))).resolves.toBeUndefined()
    await expect(checkOptions(o({ maxHeight: 15 }))).rejects.toThrow('--max-height must be an integer from 16 to 1080 (spec §10.4: videos ≤ 1080p).')
    await expect(checkOptions(o({ maxHeight: 720.5 }))).rejects.toThrow(PackInputError)
    await expect(checkOptions(o({ fps: 121 }))).rejects.toThrow('--fps must be a number above 0 and at most 120.')
    await expect(checkOptions(o({ fps: Number.NaN }))).rejects.toThrow(PackInputError)
    await expect(checkOptions(o({ crf: 52 }))).rejects.toThrow('--crf must be an integer from 0 to 51.')
    await expect(checkOptions(o({ crf: 1.5 }))).rejects.toThrow(PackInputError)
  })

  it('refuses an output that is a folder', async () => {
    await mkdir(join(dir, 'out.mp4'))
    await expect(checkOptions(o({ output: join(dir, 'out.mp4'), overwrite: true }))).rejects.toThrow(`"${join(dir, 'out.mp4')}" is a folder.`)
  })
})

describe('packAlpha: encoder failures', () => {
  const stream = { codec_name: 'prores', pix_fmt: 'yuva444p12le', width: 64, height: 64, avg_frame_rate: '25/1' }
  let input: string
  beforeEach(async () => {
    input = join(dir, 'in.mov')
    await writeFile(input, 'x')
  })
  const options = (): PackAlphaOptions => ({ input, output: join(dir, 'out.mp4'), maxHeight: 720, crf: 20, overwrite: false })
  /** ffprobe answers `stream`; ffmpeg does `encode`. */
  const runner = (encode: (args: string[]) => Promise<ProcessResult>): ProcessRunner => async (bin, args) =>
    bin === 'ffprobe' ? ok(JSON.stringify({ streams: [stream] })) : encode(args)

  it('ffmpeg that cannot be run: an encode failure; a ToolError is kept; no partial file', async () => {
    const crash = runner(async (args) => {
      await writeFile(args.at(-1)!, 'half')
      throw new Error('spawn EACCES')
    })
    await expect(packAlpha(crash, tools, options())).rejects.toMatchObject({ code: 'encode-failed', message: 'Could not run ffmpeg: spawn EACCES' })
    await expect(readFile(join(dir, 'out.mp4.partial'))).rejects.toThrow()
    const tool = runner(async () => {
      throw new ToolError('ffmpeg-missing', 'gone')
    })
    await expect(packAlpha(tool, tools, options())).rejects.toBeInstanceOf(ToolError)
  })

  it('ffmpeg that exits 0 without writing anything, or writes an empty file', async () => {
    await expect(packAlpha(runner(async () => ok()), tools, options())).rejects.toThrow('ffmpeg exited without writing the output.')
    const empty = runner(async (args) => (await writeFile(args.at(-1)!, ''), ok()))
    await expect(packAlpha(empty, tools, options())).rejects.toThrow('ffmpeg exited without writing the output.')
    await expect(readFile(join(dir, 'out.mp4.partial'))).rejects.toThrow()
  })

  it('hints, for an input without alpha, how to export one for its codec', async () => {
    const hint = async (codec: string) => {
      const r: ProcessRunner = async () => ok(JSON.stringify({ streams: [{ codec_name: codec, pix_fmt: 'yuv420p', width: 8, height: 8 }] }))
      const e = (await packAlpha(r, tools, options()).catch((x: unknown) => x)) as PackError
      expect(e).toBeInstanceOf(PackError)
      expect(e.code).toBe('no-alpha')
      return e.hint
    }
    expect(await hint('prores')).toMatch(/ProRes 4444 profile/)
    expect(await hint('vp8')).toMatch(/libvpx-vp9 -pix_fmt yuva420p/)
    expect(await hint('png')).toMatch(/RGBA PNGs/)
    expect(await hint('h264')).toMatch(/^Supported inputs with alpha/)
  })

  it('returns the source, the plan and the size; a PNG sequence gives its frame count', async () => {
    await mkdir(join(dir, 'seq'))
    for (const n of [1, 2, 3]) await writeFile(join(dir, 'seq', `f${n}.png`), 'x')
    const r: ProcessRunner = async (bin, args) =>
      bin === 'ffprobe'
        ? ok(JSON.stringify({ streams: [{ codec_name: 'png', pix_fmt: 'rgba', width: 8, height: 8 }] }))
        : (await writeFile(args.at(-1)!, 'mp4!'), ok())
    const result = await packAlpha(r, tools, { ...options(), input: join(dir, 'seq'), fps: 10 })
    expect(result).toMatchObject({ source: { kind: 'png-sequence', frames: 3, fps: 10 }, plan: { width: 8, height: 8, fps: 10, gop: 10 }, bytes: 4 })
    expect(await readFile(join(dir, 'out.mp4'), 'utf8')).toBe('mp4!')
  })
})

describe('ouaf pack-alpha (command output)', () => {
  const ENCODERS = ' V....D libx264              libx264 H.264\n'
  /** A fake ffmpeg that answers -version and -encoders, ffprobe with `stream`, and writes `size` bytes. */
  const fake = (stream: Record<string, unknown>, size = 10, encoders = ENCODERS): ProcessRunner => async (bin, args) => {
    if (args.includes('-version')) return ok('ffmpeg version 7.1\n')
    if (args.includes('-encoders')) return ok(encoders)
    if (bin.includes('ffprobe')) return ok(JSON.stringify({ streams: [stream] }))
    await writeFile(args.at(-1)!, new Uint8Array(size))
    return ok()
  }
  async function cli(runner: ProcessRunner, ...argv: string[]) {
    const out: string[] = []
    const err: string[] = []
    const code = await run(['pack-alpha', ...argv], { out: (t) => out.push(t), err: (t) => err.push(t) }, [createPackAlpha({ runner, env: {} })])
    return { code, out: out.join('\n'), err: err.join('\n') }
  }

  it('one input only', async () => {
    const r = await cli(fake({}), 'a.webm', 'b.webm', '-o', 'o.mp4')
    expect(r.code).toBe(EXIT.USAGE)
    expect(r.err).toContain('Expected a single input.')
  })

  it('summarizes a PNG sequence of unknown frame rate and a large output in MB', async () => {
    await mkdir(join(dir, 'seq'))
    for (const n of [1, 2]) await writeFile(join(dir, 'seq', `f${n}.png`), 'x')
    const r = await cli(fake({ codec_name: 'png', pix_fmt: 'rgba', width: 100, height: 50 }, 2_500_000), join(dir, 'seq'), '-o', join(dir, 'sparkle.mp4'))
    expect(r.code).toBe(EXIT.OK)
    expect(r.out).toContain(`Wrote ${join(dir, 'sparkle.mp4')}: 200×50 (color 100×50 + mask), H.264, 30 fps, keyframe every 30 frames, 2.5 MB.`)
    expect(r.out).toContain(`From ${join(dir, 'seq')} (2 PNG frames, 100×50, 30 fps).`)
    expect(r.out).toContain('"sparkle": { "src": "assets/sparkle.mp4", "alpha": "packed" }')
  })

  it('a video of unknown frame rate; a tiny output is at least 1 kB', async () => {
    await writeFile(join(dir, 'a.mov'), 'x')
    const r = await cli(fake({ codec_name: 'prores', pix_fmt: 'yuva444p10le', width: 64, height: 64 }, 10), join(dir, 'a.mov'), '-o', join(dir, 'a.mp4'))
    expect(r.out).toContain('From ' + join(dir, 'a.mov') + ' (PRORES, 64×64, ? fps).')
    expect(r.out).toContain(', 1 kB.')
  })

  it('--json: the packed size and the asset to declare; ffmpeg problems as JSON errors', async () => {
    await writeFile(join(dir, 'a.mov'), 'x')
    const r = await cli(fake({ codec_name: 'prores', pix_fmt: 'yuva444p10le', width: 64, height: 32, avg_frame_rate: '24/1' }), join(dir, 'a.mov'), '-o', join(dir, 'a.mp4'), '--json')
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, width: 128, height: 32, colorWidth: 64, fps: 24, gop: 24, crf: 20, bytes: 10, asset: { src: 'assets/a.mp4', alpha: 'packed' } })
    const noX264 = await cli(fake({}, 10, ''), join(dir, 'a.mov'), '-o', join(dir, 'b.mp4'), '--json')
    expect(noX264.code).toBe(EXIT.FAILED)
    expect(JSON.parse(noX264.out)).toMatchObject({ ok: false, error: { code: 'no-libx264' } })
    expect(JSON.parse(noX264.out).error).not.toHaveProperty('hint')
  })
})
