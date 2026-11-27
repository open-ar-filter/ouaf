/**
 * Output and argument handling of `ouaf validate`, `ouaf pack` and `ouaf preview` beyond their own test files: the
 * text and JSON outputs in their less common shapes, options read from the environment, and the report helpers.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../src/cli.ts'
import { EXIT, type Command, type Io } from '../src/command.ts'
import { pack } from '../src/commands/pack.ts'
import { createPreview } from '../src/commands/preview.ts'
import { validate } from '../src/commands/validate.ts'
import { loadFilters, PreviewSetupError, type PreviewOptions, type PreviewResult, type PreviewShot } from '../src/preview.ts'
import { displayPath, formatReport } from '../src/report.ts'
import type { PackageReport } from '../src/validate.ts'
import { png } from './helpers.ts'

const fixtures = join(import.meta.dirname, 'fixtures')
const valid = join(fixtures, 'valid')

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ouaf-commands-'))
  await writeFile(join(dir, 'still.png'), png(8, 8))
  await writeFile(join(dir, 'clip.mp4'), new Uint8Array(16))
})
afterAll(() => rm(dir, { recursive: true, force: true }))

async function cli(commands: Command[], ...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const io: Io = { out: (t) => out.push(t), err: (t) => err.push(t) }
  const code = await run(argv, io, commands)
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('ouaf validate', () => {
  it('one input; help; --json', async () => {
    expect((await cli([validate], 'validate', 'a', 'b')).err).toContain('Expected a single folder or .ouaf file.')
    expect((await cli([validate], 'validate', '-h')).out).toContain('Exit codes:')
    const json = await cli([validate], 'validate', valid, '--json', '--no-glsl')
    expect(json.code).toBe(EXIT.OK)
    expect(JSON.parse(json.out)).toMatchObject({ format: 1, ok: true, kind: 'folder' })
  })
})

describe('ouaf pack', () => {
  const data = `id: 'x', name: 'X', version: '1.0.0', license: 'CC0-1.0', requires: {}`

  it('refuses an output inside assets/ and one that is not .ouaf; one folder only; help', async () => {
    expect((await cli([pack], 'pack', valid, '-o', join(valid, 'assets', 'x.ouaf'))).err).toContain('is inside the filter\'s assets/ folder')
    expect((await cli([pack], 'pack', valid, '-o', join(dir, 'x.zip'))).err).toContain('The output must be a .ouaf file')
    expect((await cli([pack], 'pack', 'a', 'b')).err).toContain('Expected a single folder.')
    expect((await cli([pack], 'pack', '--help')).out).toContain('Usage: ouaf pack')
  })

  it('reports hidden files left out, the files written and the entry packed', async () => {
    const src = join(dir, 'scripted')
    await mkdir(join(src, 'assets'), { recursive: true })
    await writeFile(join(src, 'filter.js'), `export default { ${data}, layers: [], update() {} }\n`)
    await writeFile(join(src, 'assets', '.DS_Store'), 'x')
    await writeFile(join(src, 'assets', '.hidden'), 'x')
    const out = join(dir, 'out', 'scripted.ouaf')
    const r = await cli([pack], 'pack', src, '-o', out)
    expect(r.code).toBe(EXIT.OK)
    expect(r.out).toContain('Left out 2 hidden files: assets/.DS_Store, assets/.hidden.')
    expect(r.out).toMatch(new RegExp(`Wrote ${out.replaceAll('/', '\\/')}: 2 files, 1 kB \\(from filter\\.js\\)\\.$`))
  })

  it('a single hidden file, a single packed file', async () => {
    const src = join(dir, 'data-only')
    await mkdir(join(src, 'assets'), { recursive: true })
    await writeFile(join(src, 'filter.js'), `export default { ${data}, layers: [] }\n`)
    await writeFile(join(src, 'assets', '.keep'), '')
    const r = await cli([pack], 'pack', src, '-o', join(dir, 'data-only.ouaf'))
    expect(r.out).toContain('Left out 1 hidden file: assets/.keep.')
    expect(r.out).toContain(': 1 file, 1 kB (from filter.js).')
  })

  it('--json: the entry, and a null output when nothing is written', async () => {
    const src = join(dir, 'broken-js')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'filter.js'), `export default { ${data}, layers: [{ type: 'nope' }] }\n`)
    const r = await cli([pack], 'pack', src, '-o', join(dir, 'broken.ouaf'), '--json')
    expect(r.code).toBe(EXIT.FAILED)
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, output: null, entry: 'filter.js', packageFiles: ['manifest.json'], hidden: [] })
    const text = await cli([pack], 'pack', src, '-o', join(dir, 'broken.ouaf'))
    expect(text.out.split('\n').pop()).toBe('broken.ouaf was not written.')
  })

  it('a package over 1 MB is given in MB', async () => {
    const src = join(dir, 'big')
    await mkdir(join(src, 'assets'), { recursive: true })
    // Random-looking bytes do not deflate: the archive stays over 1 MB.
    let x = 2463534242
    const noise = Uint8Array.from({ length: 1_200_000 }, () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), x & 0xff))
    await writeFile(join(src, 'assets', 'noise.bin'), noise)
    await writeFile(join(src, 'manifest.json'), JSON.stringify({ ouaf: '1', id: 'big', name: 'Big', version: '1.0.0', license: 'CC0-1.0', requires: {}, layers: [] }))
    const r = await cli([pack], 'pack', src, '-o', join(dir, 'big.ouaf'))
    expect(r.code).toBe(EXIT.OK)
    expect(r.out).toMatch(/Wrote .*big\.ouaf: 2 files, 1\.2 MB\.$/)
  })
})

describe('ouaf preview', () => {
  const shot = (reference: string, extra: Partial<PreviewShot> = {}): PreviewShot => ({
    ok: true,
    reference,
    screenshot: `out/${reference}.png`,
    width: 360,
    height: 640,
    pixelsSha256: 'ab'.repeat(32),
    changed: 0,
    faces: 2,
    framesRendered: 10,
    time: 0,
    filters: ['valid'],
    events: [],
    signals: {},
    warnings: [],
    errors: [],
    perf: { loadMs: 1, firstFrameMs: 2, frameMs: { mean: 3, p50: 3, p95: 4, max: 5 }, engineFrameMs: null, tracker: null, renderWidth: 1, renderHeight: 1, renderer: null },
    ...extra,
  })

  /** The command with a renderer that loads the filters and answers with `make`. */
  function command(make: (o: PreviewOptions) => Partial<PreviewResult>, env: Record<string, string> = {}, progress?: (t: string) => void) {
    const calls: PreviewOptions[] = []
    const c = createPreview({
      env,
      ...(progress ? { progress } : {}),
      preview: async (options) => {
        calls.push(options)
        options.references.forEach((r, i) => options.onReference?.(r, i))
        const filters = await loadFilters(options.filters)
        return { filters, shots: options.references.map((r) => shot(r.id)), browser: null, ...make(options) }
      },
    })
    return { c, calls }
  }

  it('help', async () => {
    const { c } = command(() => ({}))
    const r = await cli([c], 'preview', '--help')
    expect(r.code).toBe(EXIT.OK)
    expect(r.out).toContain('Usage: ouaf preview <filter>...')
  })

  it('the models folder: --models, else OUAF_MODELS, else the default', async () => {
    const env = command(() => ({}), { OUAF_MODELS: '/models/env' })
    await cli([env.c], 'preview', valid, '--input', join(dir, 'still.png'))
    expect(env.calls[0]!.modelsDir).toBe('/models/env')
    await cli([env.c], 'preview', valid, '--input', join(dir, 'still.png'), '--models', '/models/flag')
    expect(env.calls[1]!.modelsDir).toBe('/models/flag')
    const none = command(() => ({}))
    await cli([none.c], 'preview', valid, '--input', join(dir, 'still.png'))
    expect(none.calls[0]).not.toHaveProperty('modelsDir')
  })

  it('progress lines, except with --json', async () => {
    const lines: string[] = []
    const { c } = command(() => ({}), {}, (t) => lines.push(t))
    await cli([c], 'preview', valid, '--ref', 'talk', '--ref', 'no-face')
    expect(lines).toEqual(['[1/2] talk…', '[2/2] no-face…'])
    await cli([c], 'preview', valid, '--ref', 'talk', '--json')
    expect(lines).toHaveLength(2)
  })

  it('--input with --max-faces and an image: frames in the JSON, no browser', async () => {
    const { c, calls } = command(() => ({}))
    const r = await cli([c], 'preview', valid, '--input', join(dir, 'still.png'), '--max-faces', '3', '--json')
    expect(calls[0]!.references).toMatchObject([{ id: 'still', kind: 'image', maxFaces: 3 }])
    const json = JSON.parse(r.out)
    expect(json.browser).toBeNull()
    expect(json.references[0]).toMatchObject({ id: 'still', kind: 'image', frames: 10, maxFaces: 3, ok: true })
    expect(json.references[0]).not.toHaveProperty('from')
    expect(json.references[0]).not.toHaveProperty('expectedFaces')
  })

  it('a reference of the set: the faces it documents and its description in the JSON', async () => {
    const { c } = command(() => ({}))
    const json = JSON.parse((await cli([c], 'preview', valid, '--ref', 'no-face', '--ref', 'two-faces', '--json')).out)
    // In the order of the set.
    expect(json.references[0]).toMatchObject({ id: 'two-faces', maxFaces: 2, expectedFaces: 2 })
    expect(json.references[1]).toMatchObject({ id: 'no-face', expectedFaces: 0, description: expect.stringMatching(/without a face/) })
  })

  it('a setup error without a hint', async () => {
    const { c } = command(() => {
      throw new PreviewSetupError('Cannot start Chromium: crashed')
    })
    const r = await cli([c], 'preview', valid, '--input', join(dir, 'still.png'))
    expect(r.code).toBe(EXIT.USAGE)
    expect(r.err).toBe('ouaf preview: Cannot start Chromium: crashed\nSee ouaf preview --help.')
  })

  it('every reference failed: the filters given, a failed shot in the JSON, no renderer', async () => {
    const failed = { ok: false as const, reference: 'clip', error: 'Timed out after 120 s.', warnings: ['w'], errors: [] }
    const { c } = command(() => ({ shots: [failed], browser: '140.0' }))
    const text = await cli([c], 'preview', valid, '--input', join(dir, 'clip.mp4'))
    expect(text.code).toBe(EXIT.FAILED)
    expect(text.out).toContain(`${valid} on 1 reference: 0 screenshots in ouaf-preview/ (Chromium 140.0)`)
    expect(text.out).toContain('  clip  failed: Timed out after 120 s.\n    warning: w')
    const json = JSON.parse((await cli([c], 'preview', valid, '--input', join(dir, 'clip.mp4'), '--json')).out)
    expect(json).toMatchObject({ ok: false, browser: { name: 'chromium', version: '140.0', renderer: null } })
    expect(json.references[0]).toEqual({
      id: 'clip', input: expect.stringMatching(/clip\.mp4$/), kind: 'video', from: 0.5, time: 1, maxFaces: 1,
      ok: false, error: 'Timed out after 120 s.', warnings: ['w'], errors: [],
    })
  })

  it('text: faces in the plural, an unknown browser version, multi-line errors indented', async () => {
    const { c } = command(() => ({ shots: [shot('still', { errors: ['line 1\nline 2'] })] }))
    const r = await cli([c], 'preview', valid, '--input', join(dir, 'still.png'))
    expect(r.code).toBe(EXIT.FAILED)
    expect(r.out).toContain('valid on 1 reference: 1 screenshot in ouaf-preview/ (Chromium ?)')
    expect(r.out).toContain('360×640, 2 faces, 0.0 % of the pixels changed')
    expect(r.out).toContain('    error: line 1\n      line 2')
  })

  it('--param and --event-threshold: parsed and passed on; malformed ones are usage errors', async () => {
    const { c, calls } = command(() => ({}))
    const still = ['preview', valid, '--input', join(dir, 'still.png')]
    expect((await cli([c], ...still, '--param', 'name=Sam', '--param', 'size=1.5', '--event-threshold', 'mouthOpen=0.25')).code).toBe(EXIT.OK)
    expect(calls[0]!.params).toEqual(new Map([['name', 'Sam'], ['size', '1.5']]))
    expect(calls[0]!.eventThresholds).toEqual(new Map([['mouthOpen', 0.25]]))
    await cli([c], ...still)
    expect(calls[1]).not.toHaveProperty('params')
    expect(calls[1]).not.toHaveProperty('eventThresholds')
    for (const [args, message] of [
      [['--param', 'size'], '--param expects <name>=<value>, got "size".'],
      [['--event-threshold', 'mouthClose=0.2'], '"mouthClose" has no threshold of its own'],
      [['--event-threshold', 'smile=2'], '--event-threshold smile expects a number from 0 to 1, got "2".'],
    ] as const) {
      const r = await cli([c], ...still, ...args)
      expect(r.code).toBe(EXIT.USAGE)
      expect(r.err).toContain(message)
    }
    expect(calls).toHaveLength(2)
  })

  it('events and signal peaks: in the JSON of each reference, and against the handled thresholds in the text', async () => {
    const events = [
      { filter: 'valid', name: 'faceEnter', time: 0.5, face: 1 },
      { filter: 'valid', name: 'mouthOpen', time: 0.8, face: 1 },
      { filter: 'valid', name: 'wink', time: 0.9, face: 1, side: 'left' as const },
    ]
    const signals = { jawOpen: { peak: 0.41, time: 0.8 } }
    const { c } = command(({ filters }) => ({
      filters: filters.map(() => ({ input: valid, report: { input: valid, kind: 'folder' as const, ok: true, errors: [], warnings: [], skipped: [], stats: { files: 1, bytes: 1 } }, params: { name: 'Sam' }, thresholds: { mouthOpen: 0.25, smile: 0.5 } })),
      shots: [shot('still', { events, signals })],
    }))
    const text = await cli([c], 'preview', valid, '--input', join(dir, 'still.png'))
    expect(text.out).toContain('    events: mouthOpen at 0.80 s (face 1), wink (left) at 0.90 s (face 1)\n' +
      '    mouthOpen (threshold 0.25): fired 1×; jawOpen peak 0.41 at 0.80 s\n' +
      '    smile (threshold 0.5): did not fire; mouthSmile: no face tracked')
    const json = JSON.parse((await cli([c], 'preview', valid, '--input', join(dir, 'still.png'), '--json')).out)
    expect(json.filters[0]).toMatchObject({ params: { name: 'Sam' }, thresholds: { mouthOpen: 0.25, smile: 0.5 } })
    expect(json.references[0]).toMatchObject({ events, signals })
  })

  it('text: a long list of events is cut, no line without events or handled thresholds', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ filter: 'valid', name: 'blink', time: i / 10, face: 1 }))
    const { c } = command(() => ({ shots: [shot('a', { events: many }), shot('b', { events: [{ filter: 'valid', name: 'faceEnter', time: 0, face: 1 }] })] }))
    const r = await cli([c], 'preview', valid, '--ref', 'talk', '--ref', 'no-face')
    expect(r.out).toMatch(/blink at 0\.70 s \(face 1\), and 2 more\n/)
    expect(r.out).not.toContain('faceEnter')
    expect(r.out.match(/^ {4}events: /gm)).toHaveLength(1)
  })
})

describe('report helpers', () => {
  const report = (extra: Partial<PackageReport>): PackageReport => ({
    input: 'f', kind: 'folder', ok: true, errors: [], warnings: [], skipped: [], stats: { files: 0, bytes: 0 }, ...extra,
  })

  it('displayPath: inside a zip, in memory, in the current folder, under a folder', () => {
    expect(displayPath({ input: 'hat.ouaf', kind: 'zip' }, 'assets/a.png')).toBe('hat.ouaf!/assets/a.png')
    expect(displayPath({ input: '<memory>', kind: 'memory' }, 'manifest.json')).toBe('manifest.json')
    expect(displayPath({ input: '.', kind: 'folder' }, 'manifest.json')).toBe('manifest.json')
    expect(displayPath({ input: 'filters/hat///', kind: 'folder' }, 'manifest.json')).toBe('filters/hat/manifest.json')
  })

  it('formatReport: locations with and without line, column and file; plural counts', () => {
    const text = formatReport(report({
      ok: false,
      errors: [
        { severity: 'error', code: 'a', file: '', path: '', message: 'Package.' },
        { severity: 'error', code: 'b', file: 'manifest.json', path: '/id', line: 3, message: 'Line only.' },
      ],
      warnings: [{ severity: 'warning', code: 'c', file: 'x.png', path: '', line: 1, column: 2, message: 'W.', hint: 'H.' }],
    }))
    expect(text.split('\n')).toEqual([
      'f — error [a] Package.',
      'f/manifest.json:3 /id — error [b] Line only.',
      'f/x.png:1:2 — warning [c] W.',
      '    → H.',
      'f: 2 errors, 1 warning.',
    ])
    expect(formatReport(report({ warnings: [1, 2].map(() => ({ severity: 'warning' as const, code: 'w', file: '', path: '', message: 'm' })) })).split('\n').pop())
      .toBe('f: valid (2 warnings).')
    expect(formatReport(report({ ok: false, errors: [{ severity: 'error', code: 'e', file: '', path: '', message: 'm' }] })).split('\n').pop()).toBe('f: 1 error.')
  })
})
