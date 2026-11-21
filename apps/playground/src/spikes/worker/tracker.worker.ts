/**
 * Tracking worker (#6 spike): MediaPipe FaceLandmarker in a module worker.
 *
 * - Module worker (Vite serves workers as ES modules in dev, and the build uses `worker.format: 'es'`), so the ES
 *   module wasm loader is used (`wasmLoader: 'module'` → `vision_wasm_module_internal.js`): the classic loader
 *   needs `importScripts`, which module workers do not have.
 * - MediaPipe runs on WebGL even with the CPU delegate (the input frame is uploaded as a texture). There is no
 *   document in a worker, so an `OffscreenCanvas` is passed explicitly (MediaPipe would otherwise try
 *   `document.createElement('canvas')` on browsers it does not trust with OffscreenCanvas, Safari < 17).
 * - One frame at a time: the page never sends a frame before the previous result came back. The frame (`VideoFrame`
 *   or `ImageBitmap`) is closed here; the result buffer goes back to the page.
 */
import { createFaceTracker, faceFrameView, type FaceTracker } from '@ouaf/core'
import { HEADER_ERROR, HEADER_FRAME_ID, HEADER_INFERENCE_MS, HEADER_WORKER_MS, type FromWorker, type ToWorker } from './protocol.ts'

/** The dedicated worker global scope, typed loosely (the project compiles against the DOM lib only). */
interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (e: MessageEvent<ToWorker>) => void): void
  addEventListener(type: 'securitypolicyviolation', listener: (e: SecurityPolicyViolationEvent) => void): void
  fetch: typeof fetch
}
const scope = self as unknown as WorkerScope

const post = (message: FromWorker, transfer: Transferable[] = []) => scope.postMessage(message, transfer)
const errorText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

// --- Usage metrics check (docs/privacy.md) ---------------------------------------------------------------------
// A worker loaded from a URL does NOT get the page's <meta> CSP: only the CSP header of its own script response
// applies (the playground's dev and preview servers send it on every response, see vite.config.ts). Report what
// happens to MediaPipe's metrics request, so each browser can be checked (observation only, nothing is blocked here).
const TELEMETRY_HOST = 'odml.pa.googleapis.com'
let violationSeen = false
scope.addEventListener('securitypolicyviolation', (e) => {
  if (!e.blockedURI.includes(TELEMETRY_HOST)) return
  violationSeen = true
  post({ type: 'telemetry', outcome: 'blocked', detail: `CSP ${e.effectiveDirective}` })
})
const originalFetch = scope.fetch.bind(scope)
scope.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (!url.includes(TELEMETRY_HOST)) return originalFetch(input, init)
  try {
    const res = await originalFetch(input, init)
    post({ type: 'telemetry', outcome: 'sent', detail: `HTTP ${res.status}` })
    return res
  } catch (err) {
    // A CSP refusal rejects the fetch before the violation event is dispatched: wait for it before calling it a
    // network failure.
    setTimeout(() => {
      if (!violationSeen) post({ type: 'telemetry', outcome: 'failed', detail: errorText(err) })
    }, 500)
    throw err
  }
}

// --- Tracking ----------------------------------------------------------------------------------------------------
let tracker: FaceTracker | undefined
let maxFaces = 1
let errorReported = false

scope.addEventListener('message', (e) => {
  const msg = e.data
  if (msg.type === 'init') void init(msg)
  else if (msg.type === 'frame') onFrame(msg)
})

async function init(msg: Extract<ToWorker, { type: 'init' }>) {
  maxFaces = msg.maxFaces
  const warnings: string[] = []
  if (typeof OffscreenCanvas !== 'function') {
    post({ type: 'error', message: 'OffscreenCanvas is not available in workers in this browser.', fatal: true })
    return
  }
  try {
    tracker = await createFaceTracker({
      maxFaces: msg.maxFaces,
      delegate: msg.delegate,
      wasmBaseUrl: msg.wasmBaseUrl,
      modelUrl: msg.modelUrl,
      wasmLoader: 'module',
      canvas: new OffscreenCanvas(1, 1),
      onWarning: (message, cause) => warnings.push(cause ? `${message} (${errorText(cause)})` : message),
    })
  } catch (err) {
    post({ type: 'error', message: errorText(err), fatal: true })
    return
  }
  post({ type: 'ready', delegate: tracker.delegate, warnings })
}

function onFrame(msg: Extract<ToWorker, { type: 'frame' }>) {
  const received = performance.now()
  const out = faceFrameView(msg.buffer, maxFaces)
  out.header[HEADER_FRAME_ID] = msg.id
  out.header[HEADER_ERROR] = 0
  let inference = 0
  try {
    if (tracker) {
      const t = performance.now()
      tracker.detect(msg.frame, msg.timestampMs, msg.mediaTime, out)
      inference = performance.now() - t
    } else out.count = 0
  } catch (err) {
    out.count = 0
    out.header[HEADER_ERROR] = 1
    if (!errorReported) post({ type: 'error', message: errorText(err), fatal: false })
    errorReported = true
  } finally {
    msg.frame.close()
  }
  out.header[HEADER_INFERENCE_MS] = inference
  out.header[HEADER_WORKER_MS] = performance.now() - received
  post({ type: 'result', buffer: msg.buffer }, [msg.buffer])
}
