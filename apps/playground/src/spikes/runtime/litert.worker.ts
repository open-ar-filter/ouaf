/**
 * LiteRT.js face pipeline in a module worker (#83 spike, `mode=worker`): detection, landmarks and blendshapes run
 * here, with the WebGL2 crops on an OffscreenCanvas, so that the page only captures frames and renders.
 *
 * Wasm threads from a worker: the page is cross-origin isolated, and this script is served with the same COEP
 * header (vite.config.ts), so `crossOriginIsolated` holds here too and the threaded build loads. Its pthreads are
 * nested workers, started from this one. Three shims make LiteRT.js 2.6.0's loader work in a module worker:
 *
 * - `importScripts` throws in module workers, and LiteRT.js loads its Emscripten script with it in any worker: it
 *   is replaced by a synchronous fetch (XHR, allowed in workers) evaluated in the global scope, which is what
 *   `importScripts` does;
 * - the Emscripten script then takes this worker's URL as its own (`self.location.href`), so `Module.locateFile`
 *   points it at the `.wasm` next to the real script;
 * - for the same reason it would start its pthreads on this worker's script: `Worker` is wrapped so that workers
 *   named `em-pthread` load the Emscripten script instead (it then runs in pthread mode). The wrapper also counts
 *   the pthreads started (`start_routine` messages), reported with each result.
 *
 * Fallbacks (reported as warnings in the `ready` message): one thread when the worker is not cross-origin isolated,
 * canvas crops when WebGL2 is not available on an OffscreenCanvas here. Without OffscreenCanvas at all the worker
 * fails, and the page falls back to the main thread.
 */
import { createFaceResult, createLiteRtPipeline, type LiteRtOptions, type LiteRtPipeline } from './litert-pipeline.ts'
import { RESULT_FLOATS, type FromWorker, type ToWorker } from './protocol.ts'

/** The dedicated worker global scope, typed loosely (the project compiles against the DOM lib only). */
interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (e: MessageEvent<ToWorker>) => void): void
  importScripts?: (...urls: string[]) => void
  Module?: { locateFile(path: string): string }
  Worker: typeof Worker
  crossOriginIsolated: boolean
}
const scope = self as unknown as WorkerScope
const post = (message: FromWorker, transfer: Transferable[] = []) => scope.postMessage(message, transfer)
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// --- LiteRT.js loader shims (see above) ----------------------------------------------------------------------------
let pthreads = 0

function installLoaderShims(wasmBase: string) {
  scope.importScripts = (...urls: string[]) => {
    for (const url of urls) {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', url, false)
      xhr.send()
      if (xhr.status !== 200) throw new Error(`${url}: HTTP ${xhr.status}`)
      // Indirect eval: global scope, sloppy mode, like a classic script (its top-level `var`s become globals).
      ;(0, eval)(`${xhr.responseText}\n//# sourceURL=${url}`)
    }
  }
  scope.Module = { locateFile: (path: string) => new URL(path, wasmBase).href }
  const threadedScript = new URL('litert_wasm_threaded_internal.js', wasmBase).href
  const NativeWorker = scope.Worker
  scope.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(options?.name === 'em-pthread' ? threadedScript : url, options)
    }
    override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
      if (message && typeof message === 'object' && 'start_routine' in message) pthreads++
      super.postMessage(message, transfer as Transferable[])
    }
  }
}

// --- Pipeline -------------------------------------------------------------------------------------------------------
let pipeline: LiteRtPipeline | undefined
const result = createFaceResult()

scope.addEventListener('message', (e) => {
  const msg = e.data
  if (msg.type === 'init') void init(msg.options)
  else if (msg.type === 'frame') void onFrame(msg)
  else if (msg.type === 'reset') pipeline?.reset()
})

function webgl2() {
  try {
    return new OffscreenCanvas(1, 1).getContext('webgl2') !== null
  } catch {
    return false
  }
}

async function init(requested: LiteRtOptions) {
  if (typeof OffscreenCanvas !== 'function') {
    post({ type: 'error', message: 'OffscreenCanvas is not available in workers in this browser', fatal: true })
    return
  }
  const warnings: string[] = []
  const options = { ...requested }
  const isolated = scope.crossOriginIsolated === true
  if (options.accelerator === 'wasm' && options.threads > 1 && !isolated) {
    warnings.push(`the worker is not cross-origin isolated: ${options.threads} threads requested, 1 used`)
    options.threads = 1
  }
  if ((options.crop === 'gpu' || options.detectorCrop === 'gpu') && !webgl2()) {
    warnings.push('no WebGL2 on OffscreenCanvas in this worker: crops on a 2D canvas instead')
    options.crop = options.detectorCrop = 'canvas'
  }
  installLoaderShims(new URL('litert/wasm/', options.assetBase).href)
  try {
    pipeline = await createLiteRtPipeline(options)
  } catch (err) {
    post({ type: 'error', message: errorText(err), fatal: true })
    return
  }
  post({ type: 'ready', description: pipeline.description, options, crossOriginIsolated: isolated, warnings })
}

async function onFrame(msg: Extract<ToWorker, { type: 'frame' }>) {
  const received = performance.now()
  const out = new Float32Array(msg.buffer, 0, RESULT_FLOATS)
  try {
    if (!pipeline) throw new Error('pipeline not ready')
    await pipeline.run(msg.frame, msg.width, msg.height, result)
  } catch (err) {
    result.found = false
    post({ type: 'error', message: errorText(err), fatal: false })
  } finally {
    msg.frame.close()
  }
  out.set(result.landmarks, 0)
  out.set(result.blendshapes, result.landmarks.length)
  const timings = pipeline ? { ...pipeline.timings } : { detectMs: NaN, detectCropMs: NaN, cropMs: NaN, landmarksMs: NaN, blendshapesMs: NaN, readMs: NaN }
  post(
    {
      type: 'result',
      id: msg.id,
      buffer: msg.buffer,
      found: result.found,
      presence: result.presence,
      roi: result.roi && { ...result.roi },
      timings,
      workerMs: performance.now() - received,
      pthreads,
    },
    [msg.buffer],
  )
}
