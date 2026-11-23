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
import { RESULT_FLOATS, type FrameMessage, type FromWorker, type InitMessage, type StreamMessage, type ToWorker } from './protocol.ts'

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
  else if (msg.type === 'frame') onFrame(msg)
  else if (msg.type === 'stream') openStream(msg)
})

/**
 * Camera frames read here straight from the track (`StreamMessage`): the newest one is kept (older ones are closed at
 * once, so that the camera never waits for us), and a frame message without a frame runs on it.
 */
interface CameraStream {
  readonly reader: ReadableStreamDefaultReader<VideoFrame>
  latest: VideoFrame | undefined
  waiting: ((frame: VideoFrame | undefined) => void) | undefined
  done: boolean
}
let stream: CameraStream | undefined

function openStream(msg: StreamMessage): void {
  closeStream()
  const s: CameraStream = { reader: msg.readable.getReader(), latest: undefined, waiting: undefined, done: false }
  stream = s
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await s.reader.read()
        if (done || stream !== s) {
          value?.close()
          break
        }
        const waiting = s.waiting
        s.waiting = undefined
        if (waiting) waiting(value)
        else {
          s.latest?.close()
          s.latest = value
        }
      }
    } catch {
      // The track ended or the stream was cancelled.
    }
    s.done = true
    s.waiting?.(undefined)
    s.waiting = undefined
  })()
}

function closeStream(): void {
  const s = stream
  stream = undefined
  if (!s) return
  s.latest?.close()
  s.latest = undefined
  s.waiting?.(undefined)
  s.waiting = undefined
  s.reader.cancel().catch(() => {})
}

/** The newest camera frame, or the next one; undefined once the stream has ended. */
function nextStreamFrame(): Promise<VideoFrame | undefined> {
  const s = stream
  if (!s || s.done) return Promise.resolve(undefined)
  const latest = s.latest
  s.latest = undefined
  if (latest) return Promise.resolve(latest)
  return new Promise((resolve) => (s.waiting = resolve))
}

/** Why a camera frame cannot stand for the element's (another size, or rotated / flipped by metadata), if so. */
function streamMismatch(frame: VideoFrame, width: number, height: number): string | undefined {
  const meta = frame as VideoFrame & { rotation?: number; flip?: boolean }
  if (meta.rotation || meta.flip) return `the camera's frames are ${meta.rotation ? `rotated by ${meta.rotation}°` : 'flipped'}`
  if (frame.displayWidth !== width || frame.displayHeight !== height) return `the camera's frames are ${frame.displayWidth}×${frame.displayHeight}, the video ${width}×${height}`
  return undefined
}

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

const wallNow = (): number => performance.timeOrigin + performance.now()
/** A frame received while a run is in progress: the newest one, run next. */
let next: { msg: FrameMessage; receivedAt: number } | undefined
let running = false
/** When the last result was posted: the worker is idle from then until the next run starts. */
let lastPostedAt = Number.NaN

function onFrame(msg: FrameMessage): void {
  const receivedAt = wallNow()
  if (!running) {
    void run(msg, receivedAt)
    return
  }
  // Busy: keep the newest frame only. A reset asked by the dropped one carries over.
  if (next) {
    msg.reset ||= next.msg.reset
    drop(next.msg)
  }
  next = { msg, receivedAt }
}

/** Returns a frame that will not run, with its buffer. */
function drop(msg: FrameMessage): void {
  msg.frame?.close()
  const now = wallNow()
  post(
    {
      type: 'result',
      id: msg.id,
      buffer: msg.buffer,
      found: false,
      hasBlendshapes: false,
      dropped: true,
      timings: { detectMs: NaN, uploadMs: NaN, cropMs: NaN, landmarksMs: NaN, blendshapesMs: NaN },
      warnings: [],
      receivedAt: now,
      startedAt: now,
      idleMs: NaN,
      postedAt: now,
    },
    [msg.buffer],
  )
}

async function run(msg: FrameMessage, receivedAt: number): Promise<void> {
  running = true
  const startedAt = wallNow()
  const idleMs = startedAt - Math.max(lastPostedAt, receivedAt)
  const out = new Float32Array(msg.buffer, 0, RESULT_FLOATS)
  let error: string | undefined
  let unusable: string | undefined
  const frame = msg.frame ?? (await nextStreamFrame())
  try {
    if (!pipeline) throw new Error('The face tracker is not ready.')
    if (!frame) throw new Error('The camera stream has ended.')
    if (!msg.frame) unusable = streamMismatch(frame as VideoFrame, msg.width, msg.height)
    if (unusable) {
      closeStream()
      result.found = false
      result.hasBlendshapes = false
    } else {
      if (msg.reset) pipeline.reset()
      await pipeline.run(frame, msg.width, msg.height, msg.blendshapes, result)
    }
  } catch (err) {
    result.found = false
    result.hasBlendshapes = false
    error = errorText(err)
  } finally {
    frame?.close()
  }
  if (result.found) {
    out.set(result.landmarks, 0)
    out.set(result.blendshapes, result.landmarks.length)
  }
  lastPostedAt = wallNow()
  post(
    {
      type: 'result',
      id: msg.id,
      buffer: msg.buffer,
      found: result.found,
      hasBlendshapes: result.hasBlendshapes,
      timings: { ...(pipeline?.timings ?? { detectMs: NaN, uploadMs: NaN, cropMs: NaN, landmarksMs: NaN, blendshapesMs: NaN }) },
      warnings: pending.splice(0),
      receivedAt,
      startedAt,
      // Idle before this run: waiting for a frame from the page (not counted for a queued frame).
      idleMs: Number.isNaN(idleMs) ? 0 : Math.max(0, idleMs),
      postedAt: lastPostedAt,
      ...(error ? { error } : {}),
      ...(unusable ? { streamUnusable: unusable } : {}),
    },
    [msg.buffer],
  )
  running = false
  const queued = next
  next = undefined
  if (queued) void run(queued.msg, queued.receivedAt)
}
