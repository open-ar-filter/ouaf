import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig, type Plugin } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/**
 * Self-hosted tracking assets, served from the playground origin (no CDN at runtime):
 * URL prefix → local directory and the files to publish from it.
 */
const SELF_HOSTED: Array<{ prefix: string; dir: string; files: RegExp; hint?: string }> = [
  {
    // The classic loader (main thread); the ES module loader for module workers (`wasmLoader: 'module'`, #6 spike).
    prefix: 'mediapipe/wasm/',
    dir: dirname(require.resolve('@mediapipe/tasks-vision/vision_wasm_internal.wasm')),
    files: /^vision_wasm(_module)?_internal\.(js|wasm)$/,
  },
  {
    // Test clips (#77), committed at the repository root; played with `?source=<clip>`.
    prefix: 'test-media/',
    dir: resolve(here, '../../test-media'),
    files: /^[\w-]+\.mp4$/,
  },
  {
    // Downloaded by `npm run fetch-models` (gitignored).
    prefix: 'models/',
    dir: resolve(here, 'models'),
    files: /\.task$/,
    hint: 'run `npm run fetch-models` to download the face model',
  },
]

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.mp4': 'video/mp4',
}

function listFiles(dir: string, files: RegExp): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => files.test(name)) : []
}

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
        for (const { prefix, dir, files } of SELF_HOSTED) {
          if (!path.startsWith(base + prefix)) continue
          const name = decodeURIComponent(path.slice(base.length + prefix.length))
          const file = join(dir, name)
          // A plain 404 rather than Vite's SPA fallback (index.html), so a missing model fails clearly.
          if (!/^[\w.-]+$/.test(name) || !files.test(name) || !existsSync(file)) {
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
      for (const { prefix, dir, files, hint } of SELF_HOSTED) {
        const names = listFiles(dir, files)
        if (names.length === 0 && hint) this.warn(`No file in ${dir}: ${hint}.`)
        for (const name of names) {
          this.emitFile({ type: 'asset', fileName: prefix + name, source: readFileSync(join(dir, name)) })
        }
      }
    },
  }
}

/** Extra pages: every `spikes/*.html` is a separate entry (one page per phase 0 spike). */
function pages(): Record<string, string> {
  const input: Record<string, string> = { main: resolve(here, 'index.html') }
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
  plugins: [basicSsl({ name: 'ouaf-playground' }), selfHostedAssets()],
  server: { host: true, port: 5173, headers: HEADERS },
  preview: { host: true, port: 4173, headers: HEADERS },
  build: { target: 'es2023', rolldownOptions: { input: pages() } },
  // Module workers, as in dev (the #6 worker imports MediaPipe lazily, which a classic IIFE worker cannot split).
  worker: { format: 'es' },
})
