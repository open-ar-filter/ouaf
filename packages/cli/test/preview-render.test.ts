/**
 * `previewFilters` with Playwright and the page bundler replaced by fakes: no Chromium is launched. Covers the setup
 * errors (missing model, Playwright or Chromium), the private origin the page is served from (what it answers, what
 * it blocks), the job sent to the page for each reference, the screenshots written and the failures reported. The
 * real rendering is tested in `e2e/preview.spec.ts`.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { packFolder } from '../src/pack.ts'
import type { PreviewJob, PreviewPageOutcome } from '../src/preview/protocol.ts'
import type { Reference } from '../src/preview/references.ts'
import { CHROMIUM_ARGS, filterLabel, loadFilters, PREVIEW_ORIGIN, previewFilters, PreviewSetupError, type PreviewOptions } from '../src/preview.ts'
import { png } from './helpers.ts'

interface Fulfilled {
  status: number
  body: string | Buffer
  contentType: string
  headers?: Record<string, string>
}
interface FakeRoute {
  request(): { url(): string }
  abort(reason: string): Promise<void>
  fulfill(r: Fulfilled): Promise<void>
}
type Handler = (route: FakeRoute) => Promise<unknown>

/** What the fake browser does, set by each test; what it saw, read by each test. */
const fake = vi.hoisted(() => ({
  playwrightMissing: false,
  launchError: undefined as Error | undefined,
  /** URLs the page requests when it loads, answered by the route handler of its context. */
  requests: [] as string[],
  /** Errors thrown in the page while it loads. */
  pageErrors: [] as string[],
  render: undefined as ((job: PreviewJob) => Promise<PreviewPageOutcome>) | undefined,
  waitError: undefined as Error | undefined,
  // Seen:
  launches: [] as unknown[],
  jobs: [] as PreviewJob[],
  answers: new Map<string, { aborted?: string; fulfilled?: Fulfilled }>(),
  contexts: { opened: 0, closed: 0 },
  browserClosed: 0,
  bundled: 0,
}))

vi.mock('playwright', () => {
  const page = (handler: () => Handler | undefined) => {
    const listeners: Array<(e: Error) => void> = []
    return {
      on: (event: string, f: (e: Error) => void) => event === 'pageerror' && listeners.push(f),
      goto: async () => {
        for (const url of fake.requests) {
          const answer: { aborted?: string; fulfilled?: Fulfilled } = {}
          await handler()!({
            request: () => ({ url: () => url }),
            abort: async (reason) => void (answer.aborted = reason),
            fulfill: async (r) => void (answer.fulfilled = r),
          })
          fake.answers.set(url, answer)
        }
        for (const message of fake.pageErrors) for (const f of listeners) f(new Error(message))
      },
      // The functions run in the page: here, against a fake window whose ouafPreview is the fake renderer.
      waitForFunction: async (f: () => boolean) => {
        if (fake.waitError) throw fake.waitError
        ;(globalThis as { window?: unknown }).window = { ouafPreview: { render: (job: PreviewJob) => fake.render!(job) } }
        if (!f()) throw new Error('page.waitForFunction: never true')
      },
      evaluate: async (f: (job: PreviewJob) => Promise<PreviewPageOutcome>, job: PreviewJob) => {
        fake.jobs.push(job)
        return f(job)
      },
    }
  }
  const browser = {
    version: () => '140.0.7339.16',
    close: async () => void fake.browserClosed++,
    newContext: async () => {
      fake.contexts.opened++
      let handler: Handler | undefined
      return {
        route: async (_pattern: string, h: Handler) => void (handler = h),
        newPage: async () => page(() => handler),
        close: async () => void fake.contexts.closed++,
      }
    },
  }
  const chromium = {
    launch: async (options: unknown) => {
      fake.launches.push(options)
      if (fake.launchError) throw fake.launchError
      return browser
    },
  }
  return {
    get chromium() {
      if (fake.playwrightMissing) throw new Error('Cannot find package playwright')
      return chromium
    },
  }
})
vi.mock('playwright-core', () => ({
  get chromium() {
    throw new Error('Cannot find package playwright-core')
  },
}))
// The page bundle: a fake one (the real bundle is tested in preview.test.ts). Filters are still bundled for real.
vi.mock('rolldown', async (importOriginal) => {
  const real = await importOriginal<typeof import('rolldown')>()
  return {
    ...real,
    rolldown: async (options: { input?: unknown }) => {
      if (!options.input || typeof options.input !== 'object' || !('page' in options.input)) return real.rolldown(options as never)
      fake.bundled++
      return {
        generate: async () => ({
          output: [
            { type: 'chunk', fileName: 'page.js', code: 'window.ouafPreview = {}' },
            { type: 'chunk', fileName: 'face-worker.js', code: 'importScripts()' },
            { type: 'asset', fileName: 'ignored.txt', source: '' },
          ],
        }),
        close: async () => {},
      }
    },
  }
})

const fixtures = join(import.meta.dirname, 'fixtures')

let dir: string
let models: string
let validOuaf: string
let brokenOuaf: string
let still: Reference
let clip: Reference

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ouaf-preview-render-'))
  models = join(dir, 'models')
  await mkdir(models)
  await writeFile(join(models, 'face_landmarker.task'), 'model')
  const packed = await packFolder(join(fixtures, 'valid'))
  validOuaf = join(dir, 'valid.ouaf')
  await writeFile(validOuaf, packed.zip!)
  brokenOuaf = join(dir, 'broken.ouaf')
  await writeFile(brokenOuaf, 'not a zip')
  await writeFile(join(dir, 'still.png'), png(4, 4))
  await writeFile(join(dir, 'clip.mp4'), new Uint8Array(16))
  still = { id: 'still', file: join(dir, 'still.png'), kind: 'image', from: 0, time: 0, frames: 3, maxFaces: 1 }
  clip = { id: 'clip', file: join(dir, 'clip.MP4'), kind: 'video', from: 0.5, time: 1, frames: 0, maxFaces: 2 }
  await writeFile(clip.file, new Uint8Array(16))
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const PNG_BASE64 = Buffer.from(png(2, 2)).toString('base64')

function rendered(job: PreviewJob, extra: Partial<PreviewPageOutcome> = {}): PreviewPageOutcome {
  return {
    ok: true,
    png: PNG_BASE64,
    width: 2,
    height: 2,
    pixelsSha256: 'cd'.repeat(32),
    changed: 0.5,
    faces: job.maxFaces,
    framesRendered: 3,
    time: 1,
    filters: ['valid'],
    warnings: [],
    errors: [],
    perf: { loadMs: 1, firstFrameMs: 2, frameMs: { mean: 3, p50: 3, p95: 4, max: 5 }, engineFrameMs: null, tracker: null, renderWidth: 2, renderHeight: 2, renderer: null },
    ...extra,
  } as PreviewPageOutcome
}

beforeEach(() => {
  Object.assign(fake, {
    playwrightMissing: false,
    launchError: undefined,
    requests: [],
    pageErrors: [],
    render: async (job: PreviewJob) => rendered(job),
    waitError: undefined,
    launches: [],
    jobs: [],
    answers: new Map(),
    contexts: { opened: 0, closed: 0 },
    browserClosed: 0,
    bundled: 0,
  })
})

const options = (extra: Partial<PreviewOptions> = {}): PreviewOptions => ({
  filters: [validOuaf],
  references: [still],
  outDir: join(dir, 'out'),
  modelsDir: models,
  ...extra,
})

describe('loadFilters', () => {
  it('validates a .ouaf file and keeps its bytes when it is valid, not when it is invalid', async () => {
    const [valid, broken] = await loadFilters([validOuaf, brokenOuaf])
    expect(valid!.report.ok).toBe(true)
    expect(valid!.entry).toBeUndefined()
    expect(valid!.zip).toEqual(new Uint8Array(await readFile(validOuaf)))
    expect(broken!.report.ok).toBe(false)
    expect(broken!.report.errors[0]!.code).toBe('zip-invalid')
    expect(broken!.zip).toBeUndefined()
  })

  it('a folder that is not a filter, or a path that is neither a folder nor a file, is a setup error', async () => {
    const empty = join(dir, 'empty')
    await mkdir(empty, { recursive: true })
    await expect(loadFilters([empty])).rejects.toThrow(new PreviewSetupError(`${empty}: no filter.ts, filter.js or manifest.json in this folder.`))
    if (existsSync('/dev/null')) await expect(loadFilters(['/dev/null'])).rejects.toThrow(/not a folder or a \.ouaf file/)
  })

  it('records the entry of a folder packed from filter.js', async () => {
    const src = join(dir, 'scripted')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'filter.js'), `export default {
      ouaf: '1', id: 'scripted', name: 'Scripted', version: '1.0.0', license: 'CC0-1.0', requires: {},
      layers: [{ type: 'color', saturation: -1 }],
    }\n`)
    const [f] = await loadFilters([src])
    expect(f!.report.errors).toEqual([])
    expect(f!.entry).toBe('filter.js')
    expect(f!.zip).toBeInstanceOf(Uint8Array)
  })
})

describe('previewFilters: setup', () => {
  it('renders nothing, and does not start a browser, when a filter is invalid', async () => {
    const r = await previewFilters(options({ filters: [validOuaf, brokenOuaf] }))
    expect(r).toMatchObject({ shots: [], browser: null })
    expect(r.filters).toHaveLength(2)
    expect(fake.launches).toEqual([])
  })

  it('needs the face model', async () => {
    const err = await previewFilters(options({ modelsDir: join(dir, 'no-models') })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PreviewSetupError)
    expect((err as PreviewSetupError).message).toBe(`The face model is missing: ${join(dir, 'no-models', 'face_landmarker.task')}.`)
    expect((err as PreviewSetupError).hint).toMatch(/npm run fetch-models/)
    expect(fake.launches).toEqual([])
  })

  it('needs Playwright: playwright or playwright-core', async () => {
    fake.playwrightMissing = true
    const err = await previewFilters(options()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PreviewSetupError)
    expect((err as PreviewSetupError).message).toBe('ouaf preview needs Playwright, which is not installed.')
    expect((err as PreviewSetupError).hint).toMatch(/npm install --save-dev playwright && npx playwright install chromium/)
  })

  it('launches headless Chromium with software WebGL', async () => {
    await previewFilters(options())
    expect(fake.launches).toEqual([{ headless: true, args: CHROMIUM_ARGS }])
    expect(CHROMIUM_ARGS).toContain('--use-angle=swiftshader')
  })

  it('a Chromium that is not installed, or does not start, is a setup error', async () => {
    fake.launchError = new Error('browserType.launch: Executable doesn\'t exist at /x/chrome\n╔═══╗')
    const missing = await previewFilters(options()).catch((e: unknown) => e) as PreviewSetupError
    expect(missing).toBeInstanceOf(PreviewSetupError)
    expect(missing.message).toBe('Playwright\'s Chromium is not installed.')
    expect(missing.hint).toMatch(/npx playwright install chromium/)
    fake.launchError = new Error('browserType.launch: Target page, context or browser has been closed\nlog: …')
    const crashed = await previewFilters(options()).catch((e: unknown) => e) as PreviewSetupError
    expect(crashed).toBeInstanceOf(PreviewSetupError)
    expect(crashed.message).toBe('Cannot start Chromium: browserType.launch: Target page, context or browser has been closed')
    expect(crashed.hint).toBeUndefined()
  })
})

describe('previewFilters: rendering', () => {
  it('sends one job per reference, in a fresh context each, and writes the screenshots', async () => {
    const seen: Array<[string, number]> = []
    const outDir = join(dir, 'shots')
    const r = await previewFilters(options({
      filters: [validOuaf, validOuaf],
      references: [still, clip],
      outDir,
      onReference: (ref, i) => seen.push([ref.id, i]),
    }))
    expect(seen).toEqual([['still', 0], ['clip', 1]])
    expect(fake.jobs).toEqual([
      { filters: ['/filters/0.ouaf', '/filters/1.ouaf'], frames: { kind: 'image', url: '/references/0.png', frames: 3 }, maxFaces: 1, maxSize: 640 },
      { filters: ['/filters/0.ouaf', '/filters/1.ouaf'], frames: { kind: 'video', url: '/references/1.mp4', from: 0.5, time: 1 }, maxFaces: 2, maxSize: 640 },
    ])
    expect(fake.contexts).toEqual({ opened: 2, closed: 2 })
    expect(fake.browserClosed).toBe(1)
    expect(fake.bundled).toBe(1)
    expect(r.browser).toBe('140.0.7339.16')
    expect(r.shots).toEqual([
      expect.objectContaining({ ok: true, reference: 'still', screenshot: join(outDir, 'still.png'), faces: 1, width: 2 }),
      expect.objectContaining({ ok: true, reference: 'clip', screenshot: join(outDir, 'clip.png'), faces: 2 }),
    ])
    expect(r.shots[0]).not.toHaveProperty('png')
    expect(new Uint8Array(await readFile(join(outDir, 'still.png')))).toEqual(png(2, 2))
  })

  it('passes the seed, the faces override and the size; 0 keeps the render size', async () => {
    await previewFilters(options({ seed: 42, maxFaces: 4, maxSize: 0 }))
    expect(fake.jobs[0]).toEqual({ filters: ['/filters/0.ouaf'], frames: { kind: 'image', url: '/references/0.png', frames: 3 }, maxFaces: 4, seed: 42 })
    await previewFilters(options({ maxSize: 320 }))
    expect(fake.jobs[1]!.maxSize).toBe(320)
  })

  it('reports a failed render, an exception and a page that never loads; carries on with the next reference', async () => {
    let n = 0
    fake.render = async (job) => {
      n++
      if (n === 1) return { ok: false, error: 'Filter "valid": shader does not compile', warnings: ['w'], errors: ['e'] }
      if (n === 2) throw new Error('page.evaluate: Target crashed\nstack…')
      return rendered(job)
    }
    const r = await previewFilters(options({ references: [still, clip, still] }))
    expect(r.shots).toEqual([
      { ok: false, reference: 'still', error: 'Filter "valid": shader does not compile', warnings: ['w'], errors: ['e'] },
      { ok: false, reference: 'clip', error: 'page.evaluate: Target crashed', warnings: [], errors: [] },
      expect.objectContaining({ ok: true, reference: 'still' }),
    ])
    expect(fake.contexts).toEqual({ opened: 3, closed: 3 })

    fake.waitError = new Error('page.waitForFunction: Timeout 50ms exceeded.')
    fake.pageErrors = ['ReferenceError: x is not defined']
    const load = await previewFilters(options({ timeoutMs: 50 }))
    expect(load.shots).toEqual([
      { ok: false, reference: 'still', error: 'page.waitForFunction: Timeout 50ms exceeded.', warnings: [], errors: ['ReferenceError: x is not defined'] },
    ])
  })

  it('times out a render that does not finish', async () => {
    fake.render = () => new Promise(() => {})
    const r = await previewFilters(options({ timeoutMs: 30 }))
    expect(r.shots).toEqual([{ ok: false, reference: 'still', error: 'Timed out after 0.03 s.', warnings: [], errors: [] }])
    expect(fake.contexts.closed).toBe(1)
  })

  it('adds page errors to the errors of the result', async () => {
    fake.pageErrors = ['TypeError: boom']
    const r = await previewFilters(options())
    expect(r.shots[0]).toMatchObject({ ok: true, errors: ['TypeError: boom'] })
  })
})

describe('previewFilters: the private origin', () => {
  const answer = (path: string) => fake.answers.get(`${PREVIEW_ORIGIN}${path}`)?.fulfilled

  it('serves the page, its bundle, the filters and the reference from memory', async () => {
    fake.requests = ['/', '/index.html', '/page.js', '/face-worker.js', '/filters/0.ouaf', '/references/0.png'].map((p) => PREVIEW_ORIGIN + p)
    await previewFilters(options())
    const index = answer('/')!
    expect(index).toMatchObject({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'no-store' } })
    expect(index.body).toContain('<script type="module" src="/page.js"></script>')
    // Nothing leaves the page (docs/privacy.md).
    expect(index.body).toContain('connect-src \'self\'')
    expect(answer('/index.html')!.body).toBe(index.body)
    expect(answer('/page.js')).toMatchObject({ status: 200, body: 'window.ouafPreview = {}', contentType: 'text/javascript' })
    expect(answer('/face-worker.js')!.body).toBe('importScripts()')
    const filter = answer('/filters/0.ouaf')!
    expect(filter.contentType).toBe('application/zip')
    expect(new Uint8Array(filter.body as Buffer)).toEqual(new Uint8Array(await readFile(validOuaf)))
    expect(answer('/references/0.png')).toMatchObject({ status: 200, contentType: 'image/png' })
  })

  it('serves the engine files from disk: models, built-in fonts and LUTs, wasm', async () => {
    fake.requests = [
      '/models/face_landmarker.task',
      '/builtins/fonts/sans.woff2',
      '/builtins/luts/noir.cube',
      '/mediapipe/wasm/vision_wasm_internal.wasm',
      '/draco/draco_decoder.wasm',
    ].map((p) => PREVIEW_ORIGIN + p)
    await previewFilters(options())
    expect(answer('/models/face_landmarker.task')).toMatchObject({ status: 200, contentType: 'application/octet-stream' })
    expect(Buffer.from(answer('/models/face_landmarker.task')!.body as Buffer).toString()).toBe('model')
    expect(answer('/builtins/fonts/sans.woff2')).toMatchObject({ status: 200, contentType: 'font/woff2' })
    expect(answer('/builtins/luts/noir.cube')).toMatchObject({ status: 200, contentType: 'text/plain; charset=utf-8' })
    expect((answer('/builtins/luts/noir.cube')!.body as Buffer).toString()).toMatch(/LUT_3D_SIZE/)
    expect(answer('/mediapipe/wasm/vision_wasm_internal.wasm')).toMatchObject({ status: 200, contentType: 'application/wasm' })
    expect(answer('/draco/draco_decoder.wasm')).toMatchObject({ status: 200, contentType: 'application/wasm' })
  })

  it('answers 404 outside the mounts, for names they do not list, and for missing files', async () => {
    const paths = [
      '/nope.js',
      '/models/missing.task',
      '/models/notes.txt',
      '/models/..%2F..%2Fetc%2Fpasswd',
      '/builtins/fonts/../../package.json',
      '/references/1.png',
    ]
    fake.requests = paths.map((p) => PREVIEW_ORIGIN + p)
    await previewFilters(options())
    for (const p of paths) {
      const a = fake.answers.get(PREVIEW_ORIGIN + p)!.fulfilled!
      expect(a.status, p).toBe(404)
      expect(a.contentType).toBe('text/plain')
    }
    expect(fake.answers.get(`${PREVIEW_ORIGIN}/models/..%2F..%2Fetc%2Fpasswd`)!.fulfilled!.body).toBe('Not found: /models/../../etc/passwd')
  })

  it('aborts any other origin and reports each blocked URL once', async () => {
    fake.requests = ['https://cdn.example.com/x.js', 'https://cdn.example.com/x.js', 'http://ouaf-preview.localhost/page.js', 'data:text/plain,hi']
    const r = await previewFilters(options())
    expect(fake.answers.get('https://cdn.example.com/x.js')).toEqual({ aborted: 'blockedbyclient' })
    expect(fake.answers.get('http://ouaf-preview.localhost/page.js')).toEqual({ aborted: 'blockedbyclient' })
    expect(r.shots[0]!.warnings).toEqual([
      'Blocked a request to https://cdn.example.com/x.js (the preview never uses the network).',
      'Blocked a request to http://ouaf-preview.localhost/page.js (the preview never uses the network).',
      'Blocked a request to data:text/plain,hi (the preview never uses the network).',
    ])
  })
})

describe('filterLabel', () => {
  it('is the last part of the path, without trailing separators', () => {
    expect(filterLabel('filters/party-hat/')).toBe('party-hat')
    expect(filterLabel('a\\b\\hat.ouaf')).toMatch(/hat\.ouaf$/)
    expect(filterLabel('hat')).toBe('hat')
  })
})
