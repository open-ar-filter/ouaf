/**
 * The LiteRT.js face tracker's worker (docs/decisions/tracking-worker.md): detection, landmarks and blendshapes run
 * here, crops on WebGL2 on an `OffscreenCanvas` (2D canvas fallback), so that the page only captures frames.
 *
 * Loading LiteRT.js 2.6.0 in a module worker: its loader runs the Emscripten script with `importScripts`, which
 * throws in module workers. The script is fetched first (asynchronously, the build chosen as LiteRT.js would) and
 * `importScripts` is replaced, for the duration of the load, by an indirect `eval` of that text in the global scope,
 * which is what `importScripts` does. `Module.locateFile` (Emscripten's own hook) points it at the `.wasm` next to
 * the script, since in a worker it would resolve it against this worker's URL. Single-threaded build only: no
 * pthread workers to redirect (the spike's third shim).
 */
import { supportsFeature } from '@litertjs/core'
import { createPipeline, createPipelineResult, type Pipeline } from './pipeline.ts'
import { RESULT_FLOATS, type FrameMessage, type FromWorker, type InitMessage, type ToWorker } from './protocol.ts'

/** The dedicated worker global scope, typed loosely (the project compiles against the DOM lib only). */
interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (e: MessageEvent<ToWorker>) => void): void
  importScripts?: (...urls: string[]) => void
  Module?: { locateFile(path: string): string }
}
const scope = self as unknown as WorkerScope
const post = (message: FromWorker, transfer: Transferable[] = []) => scope.postMessage(message, transfer)
const errorText = (err: unknown): string => (err instanceof Error ? (err.cause ? `${err.message} ${errorText(err.cause)}` : err.message) : String(err))

let pipeline: Pipeline | undefined
/** Warnings not reported yet: sent with `ready`, then with the next result (WebGL context lost). */
const pending: string[] = []
const result = createPipelineResult()

scope.addEventListener('message', (e) => {
  const msg = e.data
  if (msg.type === 'init') void init(msg)
  else if (msg.type === 'frame') void onFrame(msg)
})

/** Makes `loadLiteRt` work in a module worker (see above); returns the URL to give it. */
async function prepareLoader(assetsBaseUrl: string): Promise<{ url: string; restore(): void }> {
  const base = new URL('litert/wasm/', assetsBaseUrl).href
  const name = (await supportsFeature('relaxedSimd')) ? 'litert_wasm_internal.js' : 'litert_wasm_compat_internal.js'
  const url = new URL(name, base).href
  const res = await fetch(url)
  if (!res.ok || res.headers.get('content-type')?.includes('text/html')) throw new Error(`Could not download ${url}: HTTP ${res.status}.`)
  const text = `${await res.text()}\n//# sourceURL=${url}`
  const original = scope.importScripts
  scope.importScripts = (...urls: string[]) => {
    for (const u of urls) {
      if (u !== url) throw new Error(`Unexpected script ${u} (expected ${url}).`)
      // Indirect eval: global scope, sloppy mode, like a classic script (its top-level `var`s become globals).
      ;(0, eval)(text)
    }
  }
  scope.Module = { locateFile: (path: string) => new URL(path, base).href }
  return {
    url,
    restore() {
      if (original) scope.importScripts = original
      else delete scope.importScripts
      delete scope.Module
    },
  }
}

function hasWebGl2(): boolean {
  try {
    return new OffscreenCanvas(1, 1).getContext('webgl2') !== null
  } catch {
    return false
  }
}

async function init(msg: InitMessage): Promise<void> {
  try {
    if (typeof OffscreenCanvas !== 'function') throw new Error('OffscreenCanvas is not available in workers in this browser.')
    let crop = msg.crop
    if (crop === 'gpu' && !hasWebGl2()) {
      pending.push('No WebGL2 on OffscreenCanvas in workers here: face crops on a 2D canvas (slower).')
      crop = 'canvas'
    }
    const loader = await prepareLoader(msg.assetsBaseUrl)
    try {
      pipeline = await createPipeline({ assetsBaseUrl: msg.assetsBaseUrl, crop, liteRtUrl: loader.url }, (w) => pending.push(w))
    } finally {
      loader.restore()
    }
    post({ type: 'ready', crop: pipeline.crop, warnings: pending.splice(0) })
  } catch (err) {
    post({ type: 'error', message: errorText(err) })
  }
}

async function onFrame(msg: FrameMessage): Promise<void> {
  const out = new Float32Array(msg.buffer, 0, RESULT_FLOATS)
  let error: string | undefined
  try {
    if (!pipeline) throw new Error('The face tracker is not ready.')
    if (msg.reset) pipeline.reset()
    await pipeline.run(msg.frame, msg.width, msg.height, msg.blendshapes, result)
  } catch (err) {
    result.found = false
    result.hasBlendshapes = false
    error = errorText(err)
  } finally {
    msg.frame.close()
  }
  if (result.found) {
    out.set(result.landmarks, 0)
    out.set(result.blendshapes, result.landmarks.length)
  }
  post(
    {
      type: 'result',
      id: msg.id,
      buffer: msg.buffer,
      found: result.found,
      hasBlendshapes: result.hasBlendshapes,
      timings: { ...(pipeline?.timings ?? { detectMs: NaN, cropMs: NaN, landmarksMs: NaN, blendshapesMs: NaN }) },
      warnings: pending.splice(0),
      ...(error ? { error } : {}),
    },
    [msg.buffer],
  )
}

