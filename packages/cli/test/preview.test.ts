/**
 * `ouaf preview` without a browser: arguments, reference sets, filter loading, exit codes and output, with the
 * renderer replaced. The real rendering (headless Chromium, determinism) is tested in `e2e/preview.spec.ts`.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../src/cli.ts'
import { EXIT, type Io } from '../src/command.ts'
import { createPreview } from '../src/commands/preview.ts'
import { bundlePage, loadFilters, PreviewSetupError, type PreviewOptions, type PreviewResult, type PreviewShot } from '../src/preview.ts'
import { DEFAULT_REFERENCES, inputReference, loadReferences, ReferenceError } from '../src/preview/references.ts'
import { png } from './helpers.ts'

const fixtures = join(import.meta.dirname, 'fixtures')
const repo = join(import.meta.dirname, '../../..')

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ouaf-preview-'))
  await writeFile(join(dir, 'still.png'), png(8, 8))
  await writeFile(join(dir, 'clip.mp4'), new Uint8Array(16))
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const shot = (reference: string, extra: Partial<PreviewShot> = {}): PreviewShot => ({
  ok: true,
  reference,
  screenshot: `out/${reference}.png`,
  width: 360,
  height: 640,
  pixelsSha256: 'ab'.repeat(32),
  changed: 0.05,
  faces: 1,
  framesRendered: 26,
  time: 1,
  filters: ['valid'],
  warnings: [],
  errors: [],
  perf: {
    loadMs: 100,
    firstFrameMs: 900,
    frameMs: { mean: 50, p50: 48, p95: 60, max: 70 },
    engineFrameMs: 5,
    tracker: 'MediaPipe GPU, main thread',
    renderWidth: 720,
    renderHeight: 1280,
    renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)',
  },
  ...extra,
})

/** Runs the command with a fake renderer that records its options and renders every reference with `make`. */
async function preview(args: string[], make: (options: PreviewOptions) => Partial<PreviewResult> = () => ({})) {
  const calls: PreviewOptions[] = []
  const command = createPreview({
    env: {},
    preview: async (options) => {
      calls.push(options)
      const filters = await loadFilters(options.filters)
      if (filters.some((f) => !f.zip)) return { filters, shots: [], browser: null }
      return { filters, shots: options.references.map((r) => shot(r.id)), browser: '159.0.0.0', ...make(options) }
    },
  })
  const out: string[] = []
  const err: string[] = []
  const io: Io = { out: (t) => out.push(t), err: (t) => err.push(t) }
  // Through the dispatcher, which turns a UsageError into exit code 2.
  const code = await run(['preview', ...args], io, [command])
  return { code, out: out.join('\n'), err: err.join('\n'), calls }
}

describe('reference sets', () => {
  it('the default set lists clips of test-media/ that exist', async () => {
    const refs = await loadReferences(DEFAULT_REFERENCES)
    expect(refs.map((r) => r.id)).toEqual(['talk', 'walk', 'two-faces', 'no-face'])
    for (const r of refs) {
      expect(existsSync(r.file)).toBe(true)
      expect(r.file.startsWith(join(repo, 'test-media'))).toBe(true)
      expect(r.kind).toBe('video')
      expect(r.from).toBeLessThanOrEqual(r.time)
    }
    expect(refs.find((r) => r.id === 'two-faces')!.maxFaces).toBe(2)
  })

  it('reports a bad set', async () => {
    const write = async (data: unknown) => {
      const file = join(dir, 'refs.json')
      await writeFile(file, JSON.stringify(data))
      return loadReferences(file)
    }
    await expect(write({})).rejects.toThrow(/expected \{ "references"/)
    await expect(write({ references: [{ id: 'a b', file: 'still.png' }] })).rejects.toThrow(/"id"/)
    await expect(write({ references: [{ id: 'a', file: 'missing.png' }] })).rejects.toThrow(/no such file/)
    await expect(write({ references: [{ id: 'a', file: 'refs.json' }] })).rejects.toThrow(/neither a clip/)
    await expect(write({ references: [{ id: 'a', file: 'clip.mp4' }] })).rejects.toThrow(/needs "time"/)
    await expect(write({ references: [{ id: 'a', file: 'clip.mp4', from: 2, time: 1 }] })).rejects.toThrow(/"from"/)
    await expect(write({ references: [{ id: 'a', file: 'still.png' }, { id: 'a', file: 'still.png' }] })).rejects.toThrow(/duplicate/)
    const [image] = await write({ references: [{ id: 'still', file: 'still.png', frames: 3, maxFaces: 2 }] })
    expect(image).toMatchObject({ id: 'still', kind: 'image', frames: 3, maxFaces: 2, file: join(dir, 'still.png') })
  })

  it('an input file is one reference', () => {
    expect(inputReference(join(dir, 'clip.mp4'))).toMatchObject({ id: 'clip', kind: 'video', from: 0.5, time: 1, maxFaces: 1 })
    expect(inputReference(join(dir, 'clip.mp4'), { at: 0.2 })).toMatchObject({ from: 0, time: 0.2 })
    expect(inputReference(join(dir, 'still.png'), { maxFaces: 3 })).toMatchObject({ id: 'still', kind: 'image', maxFaces: 3 })
    expect(() => inputReference(join(dir, 'clip.mp4'), { at: 1, from: 2 })).toThrow(ReferenceError)
    expect(() => inputReference(join(dir, 'nope.mp4'))).toThrow(/no such file/)
  })
})

describe('filters', () => {
  it('validates and packs each filter; a missing one is a setup error', async () => {
    const [valid, broken] = await loadFilters([join(fixtures, 'valid'), join(fixtures, 'broken')])
    expect(valid!.report.ok).toBe(true)
    expect(valid!.zip).toBeInstanceOf(Uint8Array)
    expect(broken!.report.ok).toBe(false)
    expect(broken!.zip).toBeUndefined()
    await expect(loadFilters([join(dir, 'missing')])).rejects.toThrow(PreviewSetupError)
  })

  it('bundles the page with the engine, without network imports', async () => {
    const bundle = await bundlePage()
    const page = bundle.get('page.js')!
    expect(page).toContain('ouafPreview')
    // The face tracker's worker, a second entry (Rolldown does not emit workers).
    expect(bundle.get('face-worker.js')).toContain('importScripts')
    for (const code of bundle.values()) expect(code).not.toMatch(/\bimport\s*\(?\s*["']https?:/)
  }, 60_000)
})

describe('ouaf preview', () => {
  const valid = join(fixtures, 'valid')

  it('renders every reference of the default set, or those chosen', async () => {
    const all = await preview([valid, '-o', 'out'])
    expect(all.code).toBe(EXIT.OK)
    expect(all.calls[0]!.references.map((r) => r.id)).toEqual(['talk', 'walk', 'two-faces', 'no-face'])
    expect(all.calls[0]!.outDir).toBe('out')
    expect(all.out).toMatch(/valid on 4 references: 4 screenshots in out\/ \(Chromium 159\.0\.0\.0, SwiftShader\)/)
    expect(all.out).toMatch(/^ {2}talk {7}out\/talk\.png {7}360×640, 1 face, 5\.0 % of the pixels changed; frame 48 ms \(p95 60\)/m)
    const some = await preview([valid, '--ref', 'walk', '--ref', 'talk', '--seed', '7', '--max-size', '0', '--max-faces', '2'])
    expect(some.calls[0]).toMatchObject({ seed: 7, maxSize: 0, maxFaces: 2, outDir: 'ouaf-preview' })
    expect(some.calls[0]!.references.map((r) => r.id)).toEqual(['talk', 'walk'])
  })

  it('stacks the filters in the order given', async () => {
    const r = await preview([valid, join(fixtures, 'valid'), '--ref', 'talk'])
    expect(r.calls[0]!.filters).toEqual([valid, join(fixtures, 'valid')])
  })

  it('takes a clip or an image with --input', async () => {
    const clip = await preview([valid, '--input', join(dir, 'clip.mp4'), '--at', '2', '--from', '1.5'])
    expect(clip.calls[0]!.references).toMatchObject([{ id: 'clip', kind: 'video', from: 1.5, time: 2 }])
    const image = await preview([valid, '--input', join(dir, 'still.png')])
    expect(image.calls[0]!.references).toMatchObject([{ id: 'still', kind: 'image' }])
  })

  it('exit code 2 for usage errors', async () => {
    expect((await preview([])).code).toBe(EXIT.USAGE)
    expect((await preview([valid, '--ref', 'nope'])).err).toMatch(/Unknown reference "nope"\. References: talk, walk/)
    expect((await preview([valid, '--at', '1'])).code).toBe(EXIT.USAGE)
    expect((await preview([valid, '--input', join(dir, 'still.png'), '--ref', 'talk'])).code).toBe(EXIT.USAGE)
    expect((await preview([valid, '--input', join(dir, 'missing.mp4')])).code).toBe(EXIT.USAGE)
    expect((await preview([valid, '--max-faces', '0'])).code).toBe(EXIT.USAGE)
    expect((await preview([valid, '--seed', '-1'])).code).toBe(EXIT.USAGE)
    expect((await preview([valid, '--bogus'])).code).toBe(EXIT.USAGE)
    expect((await preview([join(dir, 'missing')])).code).toBe(EXIT.USAGE)
    const setup = await preview([valid], () => {
      throw new PreviewSetupError('ouaf preview needs Playwright, which is not installed.', 'npm install --save-dev playwright')
    })
    expect(setup.code).toBe(EXIT.USAGE)
    expect(setup.err).toContain('npm install --save-dev playwright')
  })

  it('exit code 1 when a filter is invalid (nothing rendered) or fails while rendering', async () => {
    const invalid = await preview([join(fixtures, 'broken')])
    expect(invalid.code).toBe(EXIT.FAILED)
    expect(invalid.out).toContain('Nothing rendered: fix the errors above.')
    const failed = await preview([valid, '--ref', 'talk'], () => ({ shots: [{ ok: false, reference: 'talk', error: 'Filter "valid": shader does not compile:\nline 4', warnings: [], errors: [] }] }))
    expect(failed.code).toBe(EXIT.FAILED)
    expect(failed.out).toContain('  talk  failed: Filter "valid": shader does not compile:\n      line 4')
    const error = await preview([valid, '--ref', 'talk'], () => ({ shots: [shot('talk', { errors: ['tracking failed'] })] }))
    expect(error.code).toBe(EXIT.FAILED)
    expect(error.out).toContain('    error: tracking failed')
  })

  it('--strict fails on warnings', async () => {
    const warned = () => ({ shots: [shot('talk', { warnings: ['slow script'] })] })
    expect((await preview([valid, '--ref', 'talk'], warned)).code).toBe(EXIT.OK)
    expect((await preview([valid, '--ref', 'talk', '--strict'], warned)).code).toBe(EXIT.FAILED)
  })

  it('--json prints the filters, the screenshots and the perf stats', async () => {
    const r = await preview([valid, '--ref', 'two-faces', '--json', '-o', 'out'])
    expect(r.code).toBe(EXIT.OK)
    const json = JSON.parse(r.out)
    expect(json).toMatchObject({
      format: 1,
      ok: true,
      outDir: 'out',
      browser: { name: 'chromium', version: '159.0.0.0' },
      filters: [{ input: valid, ok: true, errors: [], warnings: [] }],
      references: [{
        id: 'two-faces',
        input: 'test-media/two-faces-stacked.mp4',
        kind: 'video',
        from: 0.5,
        time: 1.5,
        maxFaces: 2,
        ok: true,
        screenshot: 'out/two-faces.png',
        pixelsSha256: 'ab'.repeat(32),
        faces: 1,
        perf: { firstFrameMs: 900, frameMs: { p50: 48 } },
      }],
    })
    const invalid = JSON.parse((await preview([join(fixtures, 'broken'), '--json'])).out)
    expect(invalid).toMatchObject({ ok: false, references: [] })
    expect(invalid.filters[0].errors.length).toBeGreaterThan(0)
  })
})
