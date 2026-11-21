import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig, type Plugin } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/**
 * Self-hosted tracking assets, served from the playground origin (no CDN at runtime):
 * URL prefix → local directory and the files to publish from it.
 */
const SELF_HOSTED: Array<{ prefix: string; dir: string; files: RegExp; hint?: string; nested?: boolean }> = [
  {
    // The classic loader (main thread); the ES module loader for module workers (`wasmLoader: 'module'`, #6 spike).
    prefix: 'mediapipe/wasm/',
    dir: dirname(require.resolve('@mediapipe/tasks-vision/vision_wasm_internal.wasm')),
    files: /^vision_wasm(_module)?_internal\.(js|wasm)$/,
  },
  {
    // LiteRT.js runtime (#83 spike): single-threaded, threaded (pthreads, cross-origin isolated pages only) and JSPI
    // builds; `loadLiteRt()` picks one from this directory.
    prefix: 'litert/wasm/',
    dir: dirname(require.resolve('@litertjs/core/wasm/litert_wasm_internal.wasm')),
    files: /^litert_wasm(_threaded|_jspi|_compat)?_internal\.(js|wasm)$/,
  },
  {
    // Test clips (#77), committed at the repository root; played with `?source=<clip>`.
    prefix: 'test-media/',
    dir: resolve(here, '../../test-media'),
    files: /^[\w-]+\.mp4$/,
  },
  // Built-in resources (#65), lazy-loaded by URL: `assetsBaseUrl` is `<base>builtins/` (see @ouaf/builtins).
  ...['fonts', 'luts', 'emoji'].map((dir) => ({
    prefix: `builtins/${dir}/`,
    dir: resolve(here, '../../packages/builtins/assets', dir),
    files: /^[\w-]+\.(woff2|cube|png|json)$/,
  })),
  {
    // Filter folders (demos #37, test fixtures), committed at the repository root: `/filters/<id>/manifest.json`.
    prefix: 'filters/',
    dir: resolve(here, '../../filters'),
    files: /\.(json|png|webp|jpe?g|avif|svg|ktx2|mp4|webm|glb|gltf|bin|cube|frag|glsl|woff2?|ttf|otf|ogg|mp3|wav|opus|js)$/,
    nested: true,
  },
  {
    // Downloaded by `npm run fetch-models` (gitignored).
    prefix: 'models/',
    dir: resolve(here, 'models'),
    files: /\.(task|tflite)$/,
    hint: 'run `npm run fetch-models` to download the models',
  },
]

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.woff2': 'font/woff2',
  '.cube': 'text/plain; charset=utf-8',
}

function listFiles(dir: string, files: RegExp, nested = false): string[] {
  if (!existsSync(dir)) return []
  if (!nested) return readdirSync(dir).filter((name) => files.test(name))
  return (readdirSync(dir, { recursive: true }) as string[]).map((name) => name.split(sep).join('/')).filter((name) => files.test(name))
}

/** A file name, or a relative path when `nested`, without `..` or anything unusual. */
const SAFE_NAME = /^[\w.-]+$/
const SAFE_PATH = /^[\w-][\w.-]*(\/[\w-][\w.-]*)*$/

/** Serves `SELF_HOSTED` in dev and copies it into the build output. */
function selfHostedAssets(): Plugin {
  let base = '/'
  return {
    name: 'ouaf-self-hosted-assets',
    configResolved(config) {
      base = config.base
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? ''
        for (const { prefix, dir, files, nested } of SELF_HOSTED) {
          if (!path.startsWith(base + prefix)) continue
          const name = decodeURIComponent(path.slice(base.length + prefix.length))
          const file = join(dir, name)
          // A plain 404 rather than Vite's SPA fallback (index.html), so a missing model fails clearly.
          if (!(nested ? SAFE_PATH : SAFE_NAME).test(name) || !files.test(name) || !existsSync(file) || !statSync(file).isFile()) {
            res.statusCode = 404
            res.end(`Not found: ${path}`)
            return
          }
          const size = statSync(file).size
          res.setHeader('Content-Type', CONTENT_TYPES[extname(name)] ?? 'application/octet-stream')
          res.setHeader('Accept-Ranges', 'bytes')
          // Byte ranges: Safari refuses to play a video without them, and seeking needs them everywhere.
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
          if (range && (range[1] || range[2])) {
            const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
            const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
            if (start > end || start >= size) {
              res.statusCode = 416
              res.setHeader('Content-Range', `bytes */${size}`)
              res.end()
              return
            }
            res.statusCode = 206
            res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
            res.setHeader('Content-Length', end - start + 1)
            createReadStream(file, { start, end }).pipe(res)
            return
          }
          res.setHeader('Content-Length', size)
          createReadStream(file).pipe(res)
          return
        }
        next()
      })
    },
    generateBundle() {
      for (const { prefix, dir, files, hint, nested } of SELF_HOSTED) {
        const names = listFiles(dir, files, nested)
        if (names.length === 0 && hint) this.warn(`No file in ${dir}: ${hint}.`)
        for (const name of names) {
          this.emitFile({ type: 'asset', fileName: prefix + name, source: readFileSync(join(dir, name)) })
        }
      }
    },
  }
}

/** Extra pages: the engine and built-ins pages, and every `spikes/*.html` as a separate entry (one page per phase 0 spike). */
function pages(): Record<string, string> {
  const input: Record<string, string> = {
    main: resolve(here, 'index.html'),
    engine: resolve(here, 'engine.html'),
    builtins: resolve(here, 'builtins.html'),
  }
  const dir = resolve(here, 'spikes')
  for (const name of listFiles(dir, /\.html$/)) input[`spikes/${name.replace(/\.html$/, '')}`] = join(dir, name)
  return input
}

/**
 * Blocks MediaPipe's usage metrics (docs/privacy.md), as the pages' `<meta>` CSP does. Sent as a header too because
 * a worker loaded from a URL does not get the page's `<meta>` policy, only the CSP header of its own script response
 * (the #6 tracking worker). `ws:`/`wss:` for Vite's hot reload.
 */
const HEADERS = { 'Content-Security-Policy': "connect-src 'self' ws: wss:" }

/**
 * Cross-origin isolation (`crossOriginIsolated`, hence `SharedArrayBuffer` and wasm threads) for the pages that need
 * it, not the whole playground: the #83 runtime spike, the LiteRT.js files it loads (its pthread workers run
 * `litert_wasm_threaded_internal.js`, whose response must carry the same embedder policy) and the MediaPipe wasm
 * it uses as the reference. `?coi=0` on the page turns it off, to measure what isolation itself changes.
 * The page's LiteRT.js worker (`mode=worker`) too: a dedicated worker of an isolated page only loads, and only gets
 * `crossOriginIsolated` (hence threads), when its own script response carries the embedder policy
 * (`/src/spikes/runtime/litert.worker.ts` in dev, `/assets/litert.worker-<hash>.js` in the build).
 *
 * WebKit also checks the embedder policy of every module the worker imports (Chromium and Firefox only check the
 * worker script): without the header on them it refuses `litert-pipeline.ts`, `protocol.ts` and Vite's `env.mjs`
 * ("Worker load was blocked by Cross-Origin-Embedder-Policy") and the pipeline falls back to the main thread. Those
 * requests are told apart by `Sec-Fetch-Dest: worker` with a module, not a page, as referrer (dev server only: the
 * build bundles the worker into one script). The header on an imported module does not change the worker's own
 * policy in the other browsers, so the #6 spike's worker, whose modules match too, is unaffected.
 */
const ISOLATED = [/\/spikes\/runtime(\.html)?$/, /\/litert\/wasm\//, /\/mediapipe\/wasm\//, /\/models\//, /\/test-media\//, /\/litert\.worker[\w-]*\.(ts|js)$/]

type Request = { url?: string; headers?: Record<string, string | string[] | undefined> }

/** A static import inside a module worker: fetched as a worker script, from another module (not from a page). */
function isWorkerImport(req: Request): boolean {
  const referer = req.headers?.referer
  if (req.headers?.['sec-fetch-dest'] !== 'worker' || typeof referer !== 'string') return false
  const from = URL.canParse(referer) ? new URL(referer).pathname : ''
  return /\.(ts|js|mjs)$/.test(from)
}

function crossOriginIsolation(): Plugin {
  const middleware = (req: Request, res: { setHeader(name: string, value: string): void }, next: () => void) => {
    const [path = '', query = ''] = (req.url ?? '').split('?')
    if ((ISOLATED.some((re) => re.test(path)) && !/(^|&)coi=0(&|$)/.test(query)) || isWorkerImport(req)) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      // Lets an isolated page load these files whatever its own origin policy is.
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    }
    next()
  }
  return {
    name: 'ouaf-cross-origin-isolation',
    // Before Vite's own middlewares (and the self-hosted assets), so every response of these paths gets the headers.
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  }
}

// getUserMedia requires a secure context: serve over HTTPS (self-signed certificate) and listen on
// every interface so a phone on the same network can open the playground.
export default defineConfig({
  plugins: [basicSsl({ name: 'ouaf-playground' }), crossOriginIsolation(), selfHostedAssets()],
  server: { host: true, port: 5173, headers: HEADERS },
  preview: { host: true, port: 4173, headers: HEADERS },
  build: { target: 'es2023', rolldownOptions: { input: pages() } },
  // Module workers, as in dev (the #6 worker imports MediaPipe lazily, which a classic IIFE worker cannot split).
  worker: { format: 'es' },
})
