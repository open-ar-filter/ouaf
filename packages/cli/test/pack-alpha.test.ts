/**
 * `ouaf pack-alpha` with a mocked process runner: no ffmpeg needed. The real conversion is covered by
 * pack-alpha.ffmpeg.test.ts (skipped without ffmpeg) and the browser test e2e/sticker.spec.ts.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../src/cli.ts'
import { EXIT } from '../src/command.ts'
import { createPackAlpha } from '../src/commands/pack-alpha.ts'
import { ffprobePath, type ProcessResult, type ProcessRunner } from '../src/ffmpeg.ts'
import { filterGraph, plan, pngSequence } from '../src/pack-alpha.ts'

interface Stream {
  codec_name: string
  pix_fmt: string
  width: number
  height: number
  avg_frame_rate?: string
  tags?: Record<string, string>
}

const ENCODERS = ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)\n'

/** A fake ffmpeg/ffprobe: records the calls, answers ffprobe with `stream`, and writes the output file. */
function fakeTools(stream: Stream | undefined, overrides: { encoders?: string; encodeCode?: number; missing?: string } = {}) {
  const calls: Array<{ bin: string; args: string[] }> = []
  const ok = (stdout = ''): ProcessResult => ({ code: 0, stdout, stderr: '' })
  const runner: ProcessRunner = async (bin, args) => {
    calls.push({ bin, args })
    if (overrides.missing && bin.endsWith(overrides.missing)) throw Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' })
    if (args.includes('-version')) return ok(`${bin.includes('ffprobe') ? 'ffprobe' : 'ffmpeg'} version 7.1\n`)
    if (args.includes('-encoders')) return ok(overrides.encoders ?? ENCODERS)
    if (bin.includes('ffprobe')) return ok(JSON.stringify({ streams: stream ? [stream] : [] }))
    if (overrides.encodeCode) return { code: overrides.encodeCode, stdout: '', stderr: 'Error while filtering\n' }
    await writeFile(args.at(-1)!, 'fake mp4')
    return ok()
  }
  const encode = () => calls.find((c) => c.args.includes('-filter_complex'))?.args
  return { runner, calls, encode }
}

const VP9_ALPHA: Stream = { codec_name: 'vp9', pix_fmt: 'yuv420p', width: 512, height: 512, avg_frame_rate: '25/1', tags: { ALPHA_MODE: '1' } }
const PRORES: Stream = { codec_name: 'prores', pix_fmt: 'yuva444p12le', width: 1920, height: 1080, avg_frame_rate: '60000/1001' }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ouaf-pack-alpha-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function cli(runner: ProcessRunner, ...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await run(['pack-alpha', ...argv], { out: (t) => out.push(t), err: (t) => err.push(t) }, [createPackAlpha({ runner, env: {} })])
  return { code, out: out.join('\n'), err: err.join('\n') }
}

/** The value after `flag` in an argument list. */
const arg = (args: string[] | undefined, flag: string) => args?.[args.indexOf(flag) + 1]

describe('ouaf pack-alpha', () => {
  it('converts a WebM VP9 with alpha: libvpx decoder, H.264, keyframe every second, no audio or metadata', async () => {
    const input = join(dir, 'fire.webm')
    await writeFile(input, 'webm')
    const t = fakeTools(VP9_ALPHA)
    const r = await cli(t.runner, input, '-o', join(dir, 'fire.mp4'))
    expect(r.err).toBe('')
    expect(r.code).toBe(EXIT.OK)
    const args = t.encode()!
    // The decoder must come before -i: the native VP9 decoder drops the alpha.
    expect(args.indexOf('-c:v')).toBeLessThan(args.indexOf('-i'))
    expect(arg(args, '-c:v')).toBe('libvpx-vp9')
    expect(args).toEqual(expect.arrayContaining(['-an', '-map_metadata', '-1', '+faststart', 'libx264']))
    expect(arg(args, '-profile:v')).toBe('main')
    expect(arg(args, '-crf')).toBe('20')
    expect([arg(args, '-g'), arg(args, '-keyint_min'), arg(args, '-sc_threshold')]).toEqual(['25', '25', '0'])
    // 512×512 color → 1024×512 packed frame, within 1280×720: not scaled down, frame rate kept.
    expect(arg(args, '-filter_complex')).toContain('scale=512:512:')
    expect(arg(args, '-filter_complex')).not.toContain('fps=')
    expect(await readFile(join(dir, 'fire.mp4'), 'utf8')).toBe('fake mp4')
    expect(r.out).toContain('1024×512 (color 512×512 + mask)')
    expect(r.out).toContain('"fire": { "src": "assets/fire.mp4", "alpha": "packed" }')
  })

  it('scales a 1080p ProRes 4444 down to the 720p box and caps the frame rate at 30 fps', async () => {
    const input = join(dir, 'smoke.mov')
    await writeFile(input, 'mov')
    const t = fakeTools(PRORES)
    const r = await cli(t.runner, input, '-o', join(dir, 'smoke.mp4'), '--json')
    expect(r.code).toBe(EXIT.OK)
    const json = JSON.parse(r.out)
    // 16:9 color, packed 32:9: limited by the width, 1280 / 2 = 640 → 640×360.
    expect(json).toMatchObject({ ok: true, width: 1280, height: 360, colorWidth: 640, fps: 30, gop: 30 })
    expect(json.asset).toEqual({ src: 'assets/smoke.mp4', alpha: 'packed' })
    const args = t.encode()!
    expect(args).not.toContain('libvpx-vp9')
    expect(arg(args, '-filter_complex')).toContain('fps=30,')
  })

  it('reads a folder of numbered PNGs as a sequence at --fps', async () => {
    const frames = join(dir, 'frames')
    await mkdir(frames)
    for (const n of [7, 8, 9]) await writeFile(join(frames, `walk_${String(n).padStart(3, '0')}.png`), 'png')
    const t = fakeTools({ codec_name: 'png', pix_fmt: 'rgba', width: 301, height: 199 })
    const r = await cli(t.runner, frames, '-o', join(dir, 'walk.mp4'), '--fps', '12', '--crf', '18')
    expect(r.code).toBe(EXIT.OK)
    const args = t.encode()!
    expect(args.slice(args.indexOf('-f'), args.indexOf('-i') + 2)).toEqual(
      ['-f', 'image2', '-framerate', '12', '-start_number', '7', '-i', join(frames, 'walk_%03d.png')])
    // Odd sizes become even.
    expect(arg(args, '-filter_complex')).toContain('scale=300:198:')
    expect(arg(args, '-crf')).toBe('18')
    expect(r.out).toContain('3 PNG frames')
  })

  it('fails with exit 1 and install hints when ffmpeg or ffprobe is missing', async () => {
    const input = join(dir, 'a.webm')
    await writeFile(input, 'webm')
    for (const missing of ['ffmpeg', 'ffprobe']) {
      const r = await cli(fakeTools(VP9_ALPHA, { missing }).runner, input, '-o', join(dir, 'a.mp4'))
      expect(r.code).toBe(EXIT.FAILED)
      expect(r.err).toContain(`"${missing}" was not found`)
      expect(r.err).toContain('brew install ffmpeg')
      expect(r.err).toContain('--ffmpeg <path>')
    }
    const r = await cli(fakeTools(VP9_ALPHA, { encoders: '' }).runner, input, '-o', join(dir, 'a.mp4'), '--json')
    expect(r.code).toBe(EXIT.FAILED)
    expect(JSON.parse(r.out).error.code).toBe('no-libx264')
  })

  it('uses --ffmpeg, then OUAF_FFMPEG, with ffprobe next to it', async () => {
    const input = join(dir, 'a.webm')
    await writeFile(input, 'webm')
    const t = fakeTools(VP9_ALPHA)
    const out: string[] = []
    const cmd = createPackAlpha({ runner: t.runner, env: { OUAF_FFMPEG: '/opt/ff/bin/ffmpeg' } })
    expect(await cmd.run([input, '-o', join(dir, 'a.mp4')], { out: (s) => out.push(s), err: (s) => out.push(s) })).toBe(EXIT.OK)
    expect(new Set(t.calls.map((c) => c.bin))).toEqual(new Set(['/opt/ff/bin/ffmpeg', '/opt/ff/bin/ffprobe']))
    expect(ffprobePath('ffmpeg')).toBe('ffprobe')
    expect(ffprobePath('C:\\ffmpeg\\bin\\ffmpeg.exe')).toBe('C:\\ffmpeg\\bin\\ffprobe.exe')
    expect(ffprobePath('./ffmpeg')).toBe('./ffprobe')
  })

  it('rejects an input without alpha, with a hint per codec', async () => {
    const input = join(dir, 'clip.mp4')
    await writeFile(input, 'mp4')
    const hevc = await cli(fakeTools({ codec_name: 'hevc', pix_fmt: 'yuv420p', width: 64, height: 64 }).runner, input, '-o', join(dir, 'out.mp4'))
    expect(hevc.code).toBe(EXIT.FAILED)
    expect(hevc.err).toContain('has no alpha channel (hevc, yuv420p)')
    expect(hevc.err).toContain('ProRes 4444')
    const vp9 = await cli(fakeTools({ ...VP9_ALPHA, tags: {} }).runner, input, '-o', join(dir, 'out.mp4'), '--json')
    expect(JSON.parse(vp9.out)).toMatchObject({ ok: false, error: { code: 'no-alpha' } })
  })

  it('reports an ffmpeg failure with exit 1 and leaves no partial file', async () => {
    const input = join(dir, 'a.webm')
    await writeFile(input, 'webm')
    const r = await cli(fakeTools(VP9_ALPHA, { encodeCode: 1 }).runner, input, '-o', join(dir, 'a.mp4'))
    expect(r.code).toBe(EXIT.FAILED)
    expect(r.err).toContain('ffmpeg failed (exit code 1)')
    expect(r.err).toContain('Error while filtering')
    await expect(readFile(join(dir, 'a.mp4'))).rejects.toThrow()
    await expect(readFile(join(dir, 'a.mp4.partial'))).rejects.toThrow()
  })

  it('usage errors (exit 2): missing input or output, existing output, bad options', async () => {
    const input = join(dir, 'a.webm')
    await writeFile(input, 'webm')
    await writeFile(join(dir, 'exists.mp4'), 'x')
    const { runner } = fakeTools(VP9_ALPHA)
    const cases: Array<[string[], string]> = [
      [[], 'Missing the input'],
      [[input], 'Missing the output'],
      [[join(dir, 'nope.webm'), '-o', join(dir, 'o.mp4')], 'does not exist'],
      [[input, '-o', join(dir, 'o.webm')], 'must be an .mp4'],
      [[input, '-o', join(dir, 'exists.mp4')], '--overwrite'],
      [[input, '-o', join(dir, 'o.mp4'), '--max-height', '1440'], 'from 16 to 1080'],
      [[input, '-o', join(dir, 'o.mp4'), '--crf', 'high'], '--crf expects a number'],
      [[input, '-o', join(dir, 'o.mp4'), '--fps', '0'], '--fps must be'],
      [[join(dir, 'frames', 'x.png'), '-o', join(dir, 'o.mp4')], 'does not exist'],
      [[input, '-o', join(dir, 'o.mp4'), '--bogus'], "Unknown option '--bogus'"],
    ]
    for (const [argv, message] of cases) {
      const r = await cli(runner, ...argv)
      expect.soft(r.code, argv.join(' ')).toBe(EXIT.USAGE)
      expect.soft(r.err, argv.join(' ')).toContain(message)
    }
    const r = await cli(runner, input, '-o', join(dir, 'exists.mp4'), '--overwrite')
    expect(r.code).toBe(EXIT.OK)
  })

  it('reports a usage error before looking for ffmpeg', async () => {
    const input = join(dir, 'a.webm')
    await writeFile(input, 'webm')
    const { runner, calls } = fakeTools(VP9_ALPHA, { missing: 'ffmpeg' })
    const usage = await cli(runner, join(dir, 'nope.webm'), '-o', join(dir, 'o.mp4'))
    expect([usage.code, calls.length]).toEqual([EXIT.USAGE, 0])
    expect(usage.err).toContain('does not exist')
    // Valid arguments: ffmpeg is what is missing.
    expect((await cli(runner, input, '-o', join(dir, 'o.mp4'))).code).toBe(EXIT.FAILED)
  })

  it('prints its help', async () => {
    const r = await cli(fakeTools(undefined).runner, '--help')
    expect(r.code).toBe(EXIT.OK)
    expect(r.out).toContain('Usage: ouaf pack-alpha <input> -o <output.mp4>')
  })
})

describe('pack-alpha planning', () => {
  const o = { maxHeight: 720, crf: 20 }
  it('fits the packed frame in maxHeight × 16/9·maxHeight, never upscaling', () => {
    expect(plan({ width: 1080, height: 1920, fps: 30 }, o)).toMatchObject({ width: 404, height: 720 }) // portrait
    expect(plan({ width: 1024, height: 1024, fps: 30 }, o)).toMatchObject({ width: 640, height: 640 }) // square
    expect(plan({ width: 200, height: 100, fps: 30 }, o)).toMatchObject({ width: 200, height: 100 }) // small
    expect(plan({ width: 1080, height: 1920, fps: 30 }, { ...o, maxHeight: 1080 })).toMatchObject({ width: 606, height: 1080 })
    expect(plan({ width: 1, height: 1, fps: 30 }, o)).toMatchObject({ width: 2, height: 2 })
  })

  it('keeps the source frame rate up to 30 fps; --fps wins', () => {
    expect(plan({ width: 64, height: 64, fps: 24 }, o)).toMatchObject({ fps: 24, gop: 24 })
    expect(plan({ width: 64, height: 64, fps: 120 }, o)).toMatchObject({ fps: 30, gop: 30 })
    expect(plan({ width: 64, height: 64, fps: undefined }, o)).toMatchObject({ fps: 30 })
    expect(plan({ width: 64, height: 64, fps: 60 }, { ...o, fps: 60 })).toMatchObject({ fps: 60, gop: 60 })
    expect(plan({ width: 64, height: 64, fps: 29.97 }, o)).toMatchObject({ gop: 30 })
  })

  it('puts the color on the left and the alpha as gray on the right, scaled in premultiplied space', () => {
    const g = filterGraph({ width: 100, height: 50, fps: 30000 / 1001, gop: 30, crf: 20 }, true)
    expect(g).toMatch(/^\[0:v\]fps=30000\/1001,format=gbrap,premultiply=inplace=1,scale=100:50:flags=lanczos,unpremultiply/)
    expect(g).toContain('[a]alphaextract')
    expect(g).toContain('[rgb][mask]hstack=inputs=2')
    expect(g).toMatch(/out_color_matrix=bt709:out_range=tv,format=yuv420p\[v\]$/)
  })

  it('derives the image pattern of a PNG folder', () => {
    expect(pngSequence('f', ['b0002.png', 'b0001.png', 'notes.txt'])).toEqual(
      { kind: 'png-sequence', pattern: join('f', 'b%04d.png'), start: 1, frames: 2 })
    expect(pngSequence('f', ['9.png', '10.png', '11.png'])).toMatchObject({ pattern: join('f', '%d.png'), start: 9, frames: 3 })
    expect(pngSequence('f', ['100%_1.png', '100%_2.png'])).toMatchObject({ pattern: join('f', '100%%_%d.png') })
    expect(() => pngSequence('f', [])).toThrow('no PNG')
    expect(() => pngSequence('f', ['a1.png', 'b2.png'])).toThrow('same prefix')
    expect(() => pngSequence('f', ['a1.png', 'a3.png'])).toThrow('frame 2 is missing')
    expect(() => pngSequence('f', ['a01.png', 'a2.png'])).toThrow('padded')
  })
})
