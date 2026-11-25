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
    // LiteRT.js runtime of the face tracker's worker (#165): the single-threaded build, with relaxed SIMD or without
    // (`_compat_`), picked by the worker (packages/core/src/litert/face.worker.ts).
    prefix: 'litert/wasm/',
    dir: dirname(require.resolve('@litertjs/core/wasm/litert_wasm_internal.wasm')),
    files: /^litert_wasm(_compat)?_internal\.(js|wasm)$/,
  },
  {
    // Draco decoder of the model layer (#21), fetched by the engine from `<assetsBaseUrl>draco/` the first time a
    // Draco-compressed model loads (packages/core/src/layers/model/assets.ts).
    prefix: 'draco/',
    dir: dirname(require.resolve('three/examples/jsm/libs/draco/gltf/draco_decoder.wasm')),
    files: /^draco_(wasm_wrapper\.js|decoder\.wasm)$/,
  },
  {
    // Test clips (#77), committed at the repository root; played with `?source=<clip>`.
    prefix: 'test-media/',
    dir: resolve(here, '../../test-media'),
    files: /^[\w-]+\.mp4$/,
  },
  // Built-in resources (#65), lazy-loaded by URL: `assetsBaseUrl` is `<base>builtins/` (see @ouaf/builtins).
  ...['fonts', 'luts'].map((dir) => ({
    prefix: `builtins/${dir}/`,
    dir: resolve(here, '../../packages/builtins/assets', dir),
    files: /^[\w-]+\.(woff2|cube)$/,
  })),
  {
    // Filter folders (demos #37, test fixtures), committed at the repository root: `/filters/<id>/manifest.json`; and
    // the packages built from them with `ouaf pack` (`/filters/<id>.ouaf`, gitignored).
    prefix: 'filters/',
    dir: resolve(here, '../../filters'),
    files: /\.(json|png|webp|jpe?g|avif|svg|ktx2|mp4|webm|glb|gltf|bin|cube|frag|glsl|woff2?|ttf|otf|ogg|mp3|wav|opus|js|ouaf)$/,
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
  '.ouaf': 'application/zip',
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

/**
 * The malicious filters' sink (#27, `e2e/evil.spec.ts`): records every request that reaches `/__evil__/…` (HTTP, or a
 * WebSocket upgrade) and answers it as a willing accomplice (200, any origin allowed), so a request that gets out of
 * the sandbox both succeeds and is seen here. `GET /__evil-sink__?token=<t>` lists the hits whose URL contains `t`.
 * Dev server only: the build has no sink.
 */
function evilSink(): Plugin {
  const hits: Array<{ method: string; url: string }> = []
  return {
    name: 'ouaf-evil-sink',
    configureServer(server) {
      server.httpServer?.on('upgrade', (req) => {
        if (req.url?.startsWith('/__evil__/')) hits.push({ method: 'UPGRADE', url: req.url })
      })
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (url.startsWith('/__evil-sink__')) {
          const token = new URL(url, 'https://localhost').searchParams.get('token') ?? ''
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(hits.filter((h) => h.url.includes(token))))
          return
        }
        if (!url.startsWith('/__evil__/')) return next()
        hits.push({ method: req.method ?? '', url })
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'text/javascript')
        res.end('export default 1\n')
      })
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

// getUserMedia requires a secure context: serve over HTTPS (self-signed certificate) and listen on
// every interface so a phone on the same network can open the playground.
export default defineConfig({
  plugins: [basicSsl({ name: 'ouaf-playground' }), selfHostedAssets(), evilSink()],
  server: { host: true, port: 5173, headers: HEADERS },
  preview: { host: true, port: 4173, headers: HEADERS },
  build: { target: 'es2023', rolldownOptions: { input: pages() } },
  // Module workers, as in dev (the #6 worker imports MediaPipe lazily, which a classic IIFE worker cannot split).
  worker: { format: 'es' },
})
