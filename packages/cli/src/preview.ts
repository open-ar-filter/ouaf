/**
 * `ouaf preview`: renders a filter stack on reference frames in headless Chromium (Playwright) and writes a
 * screenshot per reference, with perf stats (#30).
 *
 * Serving: nothing listens on a port and no dev server is needed. The page (`preview/page.ts`, with `@ouaf/core`) is
 * bundled in memory with Rolldown, the bundler `ouaf pack` already uses, and every request of the browser is answered
 * by Playwright's request interception: the page and its bundle, the engine's self-hosted files (MediaPipe wasm, face
 * model, Draco decoder, built-in fonts and LUTs), the reference clips and the filters, packed in memory. The page
 * lives on a private origin (`https://ouaf-preview.localhost`); any other request is aborted, so the browser never
 * reaches the network (docs/privacy.md).
 *
 * Determinism: the page renders in the file regime (spec §12.1, §12.5), like the browser tests (`e2e/demos.spec.ts`),
 * with software WebGL (SwiftShader), so that the same inputs give the same pixels on the same machine and Chromium
 * build; see `ouaf preview --help`.
 */
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'
import type { Browser, BrowserContext, Route } from 'playwright'
import { packFolder, PackSourceError } from './pack.ts'
import type { PreviewJob, PreviewPageOutcome, PreviewPageResult } from './preview/protocol.ts'
import { IMAGE_TYPES, VIDEO_TYPES, type Reference } from './preview/references.ts'
import { SourceError } from './source.ts'
import { validatePath, type PackageReport } from './validate.ts'

/** The private origin of the preview page: only answered by request interception, never resolved. */
export const PREVIEW_ORIGIN = 'https://ouaf-preview.localhost'
/** Default longer side of the screenshots (px); 0 keeps the render size. */
export const PREVIEW_MAX_SIZE = 640
/** Time limit of one reference: page load, filters, frames (ms). */
export const PREVIEW_TIMEOUT_MS = 120_000
/** Default folder of the face model files (`npm run fetch-models`), in the repository. */
export const DEFAULT_MODELS = fileURLToPath(new URL('../../../apps/playground/models/', import.meta.url))
/** The file the built-in face tracker needs (`packages/core/src/engine/builtin.ts`). */
const FACE_MODEL = 'face_landmarker.task'

/**
 * Chromium flags. Software WebGL (SwiftShader) whatever the machine has: the same rendering everywhere this
 * Chromium build runs, the condition of pixel-identical screenshots. Fixed scale factor and color profile.
 */
export const CHROMIUM_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--force-device-scale-factor=1',
  '--force-color-profile=srgb',
  '--autoplay-policy=no-user-gesture-required',
]

/** Cannot run at all (missing Playwright or Chromium, missing model, bad input): a usage error, exit code 2. */
export class PreviewSetupError extends Error {
  hint: string | undefined
  constructor(message: string, hint?: string) {
    super(message)
    this.hint = hint
  }
}

export interface PreviewFilter {
  /** What the user passed. */
  input: string
  /** `filter.ts` / `filter.js` when the folder was packed from it. */
  entry?: string
  /** Validation report (`ouaf validate` / `ouaf pack`). */
  report: PackageReport
  /** The package, when it has no errors. */
  zip?: Uint8Array
}

export interface PreviewShot extends Omit<PreviewPageResult, 'png'> {
  ok: true
  reference: string
  /** Where the PNG was written. */
  screenshot: string
}

export interface PreviewShotFailure {
  ok: false
  reference: string
  error: string
  warnings: string[]
  errors: string[]
}

export interface PreviewOptions {
  /** Filter folders or `.ouaf` files, bottom of the stack first. */
  filters: string[]
  references: Reference[]
  /** Folder of the screenshots (created). */
  outDir: string
  /** Longer side of the screenshots (px); 0: the render size. Default `PREVIEW_MAX_SIZE`. */
  maxSize?: number
  seed?: number
  /** Overrides each reference's `maxFaces`. */
  maxFaces?: number
  /** Folder of the face model files. Default `DEFAULT_MODELS`. */
  modelsDir?: string
  timeoutMs?: number
  /** Called before each reference (progress on stderr). */
  onReference?: (reference: Reference, index: number) => void
}

export interface PreviewResult {
  /** The filters rendered, with their validation reports. */
  filters: PreviewFilter[]
  /** One per reference, in order; empty when a filter is invalid (nothing is rendered then). */
  shots: Array<PreviewShot | PreviewShotFailure>
  /** Chromium version. */
  browser: string | null
}

/** Validates and packs each filter as `ouaf validate` / `ouaf pack` do. Throws PreviewSetupError for a bad path. */
export async function loadFilters(inputs: string[]): Promise<PreviewFilter[]> {
  const out: PreviewFilter[] = []
  for (const input of inputs) {
    if (!existsSync(input)) throw new PreviewSetupError(`${input}: no such file or folder.`)
    try {
      if (statSync(input).isDirectory()) {
        const r = await packFolder(input)
        out.push({ input, report: r.report, ...(r.entry ? { entry: r.entry } : {}), ...(r.zip ? { zip: r.zip } : {}) })
      } else {
        const report = await validatePath(input)
        out.push({ input, report, ...(report.ok ? { zip: new Uint8Array(await readFile(input)) } : {}) })
      }
    } catch (e) {
      if (e instanceof PackSourceError || e instanceof SourceError) throw new PreviewSetupError(e.message)
      throw e
    }
  }
  return out
}

type Chromium = typeof import('playwright').chromium

/** Playwright, an optional peer dependency of `@ouaf/cli`: `playwright` or `playwright-core`. */
async function loadChromium(): Promise<Chromium> {
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return ((await import(name)) as typeof import('playwright')).chromium
    } catch {}
  }
  throw new PreviewSetupError(
    'ouaf preview needs Playwright, which is not installed.',
    'Install it next to @ouaf/cli, with its Chromium: npm install --save-dev playwright && npx playwright install chromium',
  )
}

async function launch(chromium: Chromium): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true, args: CHROMIUM_ARGS })
  } catch (e) {
    const message = (e as Error).message
    if (/Executable doesn't exist|browserType\.launch: .*(install|not found)/i.test(message)) {
      const hint = 'Run: npx playwright install chromium (add --with-deps on Linux if system libraries are missing)'
      throw new PreviewSetupError('Playwright\'s Chromium is not installed.', hint)
    }
    throw new PreviewSetupError(`Cannot start Chromium: ${message.split('\n')[0]}`)
  }
}

const here = dirname(fileURLToPath(import.meta.url))

/** Bundles the preview page and `@ouaf/core` into ES modules, in memory: file name → code. */
export async function bundlePage(): Promise<Map<string, string>> {
  const build = await rolldown({
    input: join(here, 'preview/page.ts'),
    platform: 'browser',
    transform: { target: 'es2023' },
    onLog: () => {},
  })
  try {
    const { output } = await build.generate({ format: 'esm', entryFileNames: 'page.js', chunkFileNames: '[name]-[hash].js' })
    return new Map(output.filter((o) => o.type === 'chunk').map((o) => [o.fileName, o.code]))
  } finally {
    await build.close()
  }
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<!-- Nothing leaves the page (docs/privacy.md); also blocks MediaPipe's usage metrics. -->
<meta http-equiv="Content-Security-Policy" content="connect-src 'self'">
<title>ouaf preview</title>
<style>html, body { margin: 0; background: #000; } canvas { display: block; }</style>
</head>
<body>
<canvas id="canvas"></canvas>
<script type="module" src="/page.js"></script>
</body>
</html>`

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.ouaf': 'application/zip',
  '.woff2': 'font/woff2',
  '.cube': 'text/plain; charset=utf-8',
  ...IMAGE_TYPES,
  ...VIDEO_TYPES,
}
const contentType = (path: string) => CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'

/** A folder the page reads files from: `<prefix><name>` for the names that match `files`. */
interface Mount {
  prefix: string
  dir: string
  files: RegExp
}

/**
 * The engine's self-hosted files under its `assetsBaseUrl` (the page's origin), laid out as the playground serves
 * them (apps/playground/vite.config.ts): MediaPipe's wasm, the Draco decoder, the built-in fonts and LUTs, the model.
 */
function engineMounts(modelsDir: string): Mount[] {
  // Resolved from @ouaf/core, whose dependencies they are.
  const core = createRequire(createRequire(import.meta.url).resolve('@ouaf/core'))
  const dirOf = (file: string) => dirname(core.resolve(file))
  const builtins = resolve(dirOf('@ouaf/builtins'), '../assets')
  return [
    { prefix: '/mediapipe/wasm/', dir: dirOf('@mediapipe/tasks-vision/vision_wasm_internal.wasm'), files: /^vision_wasm(_module)?_internal\.(js|wasm)$/ },
    { prefix: '/draco/', dir: dirOf('three/examples/jsm/libs/draco/gltf/draco_decoder.wasm'), files: /^draco_(wasm_wrapper\.js|decoder\.wasm)$/ },
    { prefix: '/builtins/fonts/', dir: join(builtins, 'fonts'), files: /^[\w-]+\.woff2$/ },
    { prefix: '/builtins/luts/', dir: join(builtins, 'luts'), files: /^[\w-]+\.cube$/ },
    { prefix: '/models/', dir: modelsDir, files: /^[\w.-]+\.(task|tflite)$/ },
  ]
}

/**
 * What the private origin serves: the page and its bundle, files in memory (the packed filters, the current
 * reference) and the engine's files on disk. Installed on each browser context with `route`.
 */
class PreviewOrigin {
  readonly files = new Map<string, Uint8Array | string>()
  #mounts: Mount[]

  constructor(bundle: Map<string, string>, modelsDir: string) {
    this.files.set('/index.html', PAGE)
    for (const [name, code] of bundle) this.files.set(`/${name}`, code)
    this.#mounts = engineMounts(modelsDir)
  }

  /** Answers every request of `context`: this origin from memory and disk; any other URL is aborted and noted. */
  async route(context: BrowserContext, blocked: string[]): Promise<void> {
    await context.route('**/*', async (route: Route) => {
      const url = new URL(route.request().url())
      if (url.origin !== PREVIEW_ORIGIN) {
        blocked.push(url.href)
        return route.abort('blockedbyclient')
      }
      const path = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)
      const body = this.files.get(path) ?? await this.#read(path)
      if (body === undefined) return route.fulfill({ status: 404, body: `Not found: ${path}`, contentType: 'text/plain' })
      return route.fulfill({
        status: 200,
        body: typeof body === 'string' ? body : Buffer.from(body),
        contentType: contentType(path),
        headers: { 'Cache-Control': 'no-store' },
      })
    })
  }

  async #read(path: string): Promise<Uint8Array | undefined> {
    const mount = this.#mounts.find((m) => path.startsWith(m.prefix))
    const name = mount ? path.slice(mount.prefix.length) : ''
    if (!mount || !mount.files.test(name) || !existsSync(join(mount.dir, name))) return undefined
    return new Uint8Array(await readFile(join(mount.dir, name)))
  }
}

/** Renders the filters on each reference; writes `<outDir>/<reference>.png`. */
export async function previewFilters(options: PreviewOptions): Promise<PreviewResult> {
  const filters = await loadFilters(options.filters)
  if (filters.some((f) => !f.zip)) return { filters, shots: [], browser: null }

  const modelsDir = resolve(options.modelsDir ?? DEFAULT_MODELS)
  if (!existsSync(join(modelsDir, FACE_MODEL))) {
    throw new PreviewSetupError(
      `The face model is missing: ${join(modelsDir, FACE_MODEL)}.`,
      `In the Ouaf repository, run: npm run fetch-models (or point --models / OUAF_MODELS to a folder with ${FACE_MODEL})`,
    )
  }
  const chromium = await loadChromium()
  const origin = new PreviewOrigin(await bundlePage(), modelsDir)
  const browser = await launch(chromium)
  const shots: Array<PreviewShot | PreviewShotFailure> = []
  try {
    await mkdir(options.outDir, { recursive: true })
    filters.forEach((f, i) => origin.files.set(`/filters/${i}.ouaf`, f.zip!))
    const maxSize = options.maxSize ?? PREVIEW_MAX_SIZE
    for (const [i, ref] of options.references.entries()) {
      options.onReference?.(ref, i)
      const url = `/references/${i}${extname(ref.file).toLowerCase()}`
      origin.files.set(url, new Uint8Array(await readFile(ref.file)))
      const job: PreviewJob = {
        filters: filters.map((_, j) => `/filters/${j}.ouaf`),
        frames: ref.kind === 'video' ? { kind: 'video', url, from: ref.from, time: ref.time } : { kind: 'image', url, frames: ref.frames },
        maxFaces: options.maxFaces ?? ref.maxFaces,
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(maxSize > 0 ? { maxSize } : {}),
      }
      const outcome = await renderReference(browser, origin, job, options.timeoutMs ?? PREVIEW_TIMEOUT_MS)
      origin.files.delete(url)
      if (!outcome.ok) {
        shots.push({ ok: false, reference: ref.id, error: outcome.error, warnings: outcome.warnings, errors: outcome.errors })
        continue
      }
      const { png, ok: _, ...rest } = outcome
      const screenshot = join(options.outDir, `${ref.id}.png`)
      await writeFile(screenshot, Buffer.from(png, 'base64'))
      shots.push({ ok: true, reference: ref.id, screenshot, ...rest })
    }
    return { filters, shots, browser: browser.version() }
  } finally {
    await browser.close()
  }
}

/** One reference in a fresh context and page: nothing carries over from the previous one. */
async function renderReference(browser: Browser, origin: PreviewOrigin, job: PreviewJob, timeoutMs: number): Promise<PreviewPageOutcome> {
  const context = await browser.newContext({ viewport: { width: 800, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' })
  const blocked: string[] = []
  const pageErrors: string[] = []
  let timer: NodeJS.Timeout | undefined
  try {
    await origin.route(context, blocked)
    const page = await context.newPage()
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(`${PREVIEW_ORIGIN}/`)
    await page.waitForFunction(() => !!window.ouafPreview, undefined, { timeout: timeoutMs })
    const timeout = new Promise<PreviewPageOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: `Timed out after ${timeoutMs / 1000} s.`, warnings: [], errors: [] }), timeoutMs)
    })
    const outcome = await Promise.race([page.evaluate((j) => window.ouafPreview!.render(j), job), timeout])
    outcome.errors.push(...pageErrors)
    // Requests to another origin (none expected): reported, they were aborted.
    for (const url of new Set(blocked)) outcome.warnings.push(`Blocked a request to ${url} (the preview never uses the network).`)
    return outcome
  } catch (e) {
    return { ok: false, error: (e as Error).message.split('\n')[0]!, warnings: [], errors: pageErrors }
  } finally {
    clearTimeout(timer)
    await context.close()
  }
}

/** Default output folder: `ouaf-preview/` in the current folder. */
export const DEFAULT_OUT_DIR = 'ouaf-preview'

/** Short name of a filter input, for messages. */
export const filterLabel = (input: string) => basename(input.replace(/[\\/]+$/, ''))
