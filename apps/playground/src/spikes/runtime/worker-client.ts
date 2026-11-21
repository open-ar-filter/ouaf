/**
 * Page side of the LiteRT.js worker (#83 spike, `mode=worker`): the same `LiteRtPipeline` interface as the
 * main-thread pipeline, so the page loop, the MediaPipe check and the benchmark hook work unchanged. A run captures
 * the video's current frame (`new VideoFrame(video)`, or `createImageBitmap(video)` with `transfer=bitmap`, as in
 * the #6 spike), transfers it with a result buffer, and resolves when the worker sends the buffer back.
 */
import type { FaceResult, LiteRtOptions, LiteRtPipeline, StageTimings } from './litert-pipeline.ts'
import { RESULT_FLOATS, type FromWorker, type ReadyMessage, type ToWorker } from './protocol.ts'

export type Transfer = 'videoframe' | 'bitmap'

/** Main-thread and transfer costs of the last run (ms), apart from the pipeline stages. */
export interface WorkerIo {
  /** Frame capture on the main thread (`new VideoFrame(video)` or until the `createImageBitmap` promise resolves). */
  captureMs: number
  /** `postMessage` call sending the frame. */
  postMs: number
  /** Handling the result message on the main thread (copy into the result). */
  receiveMs: number
  /** Frame message received → result posted, in the worker. */
  workerMs: number
}

export interface WorkerPipeline extends LiteRtPipeline {
  readonly transfer: Transfer
  readonly ready: ReadyMessage
  readonly io: WorkerIo
  /** Pthreads started by the wasm runtime in the worker so far. */
  readonly pthreads: number
}

const INIT_TIMEOUT_MS = 60_000
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function createWorkerPipeline(options: LiteRtOptions, requestedTransfer: Transfer, onWarning: (message: string) => void): Promise<WorkerPipeline> {
  if (typeof Worker !== 'function') throw new Error('Web Workers are not available')
  let transfer = requestedTransfer
  if (transfer === 'videoframe' && typeof VideoFrame !== 'function') {
    onWarning('VideoFrame is not supported here: frames are sent as ImageBitmap')
    transfer = 'bitmap'
  }
  // A module worker, bundled by Vite (`worker.format: 'es'` in vite.config.ts), served with the COEP header.
  const worker = new Worker(new URL('./litert.worker.ts', import.meta.url), { type: 'module', name: 'ouaf-litert' })
  let ready: ReadyMessage
  try {
    ready = await new Promise<ReadyMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the LiteRT.js worker did not start in time')), INIT_TIMEOUT_MS)
      worker.onerror = (e) => {
        clearTimeout(timer)
        reject(new Error(`the LiteRT.js worker failed to load${e.message ? `: ${e.message}` : ''}`))
      }
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const msg = e.data
        if (msg.type === 'ready') {
          clearTimeout(timer)
          resolve(msg)
        } else if (msg.type === 'error' && msg.fatal) {
          clearTimeout(timer)
          reject(new Error(`worker: ${msg.message}`))
        }
      }
      worker.postMessage({ type: 'init', options } satisfies ToWorker)
    })
  } catch (err) {
    worker.terminate()
    throw err
  }
  for (const w of ready.warnings) onWarning(`worker: ${w}`)

  const free: ArrayBuffer[] = [new ArrayBuffer(RESULT_FLOATS * 4), new ArrayBuffer(RESULT_FLOATS * 4)]
  const timings: StageTimings = { detectMs: NaN, detectCropMs: NaN, cropMs: NaN, landmarksMs: NaN, blendshapesMs: NaN, readMs: NaN }
  const io: WorkerIo = { captureMs: NaN, postMs: NaN, receiveMs: NaN, workerMs: NaN }
  let pthreads = 0
  let nextId = 0
  let pending: { id: number; out: FaceResult; resolve: () => void; reject: (err: Error) => void } | undefined
  let disposed = false

  worker.onerror = (e) => {
    onWarning(`worker error: ${e.message}`)
    pending?.reject(new Error(`worker error: ${e.message}`))
    pending = undefined
  }
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const msg = e.data
    if (msg.type === 'error') {
      onWarning(`worker: ${msg.message}`)
      return
    }
    if (msg.type !== 'result') return
    const t = performance.now()
    const p = pending
    if (!p || p.id !== msg.id) {
      free.push(msg.buffer)
      return
    }
    pending = undefined
    const data = new Float32Array(msg.buffer, 0, RESULT_FLOATS)
    const out = p.out
    out.found = msg.found
    out.presence = msg.presence
    out.roi = msg.roi
    out.landmarks.set(data.subarray(0, out.landmarks.length))
    out.blendshapes.set(data.subarray(out.landmarks.length, out.landmarks.length + out.blendshapes.length))
    Object.assign(timings, msg.timings)
    io.workerMs = msg.workerMs
    pthreads = msg.pthreads
    free.push(msg.buffer)
    io.receiveMs = performance.now() - t
    p.resolve()
  }

  /** Posts a captured frame; resolves when its result has been copied into `out`. */
  function send(frame: VideoFrame | ImageBitmap, buffer: ArrayBuffer, width: number, height: number, out: FaceResult): Promise<void> {
    if (disposed) {
      frame.close()
      return Promise.reject(new Error('worker pipeline disposed'))
    }
    const t = performance.now()
    const id = ++nextId
    const done = new Promise<void>((resolve, reject) => (pending = { id, out, resolve, reject }))
    worker.postMessage({ type: 'frame', id, frame, width, height, buffer } satisfies ToWorker, [frame, buffer])
    io.postMs = performance.now() - t
    return done
  }

  return {
    description: `${ready.description}, in a worker (${transfer})`,
    timings,
    io,
    transfer,
    ready,
    get pthreads() {
      return pthreads
    },
    reset() {
      worker.postMessage({ type: 'reset' } satisfies ToWorker)
    },
    // Not `async`: with a VideoFrame, capture and post happen synchronously in the caller (the frame callback), so
    // their cost is measured there and not after the rest of the callback.
    run(source, width, height, out) {
      if (disposed) return Promise.reject(new Error('worker pipeline disposed'))
      if (pending) return Promise.reject(new Error('a worker run is already in flight'))
      if (!(source instanceof HTMLVideoElement)) return Promise.reject(new Error('the worker pipeline takes the video element'))
      const buffer = free.pop() ?? new ArrayBuffer(RESULT_FLOATS * 4)
      const failed = (err: unknown) => {
        free.push(buffer)
        return Promise.reject(new Error(`frame capture (${transfer}) failed: ${errorText(err)}`, { cause: err }))
      }
      const t = performance.now()
      if (transfer === 'videoframe') {
        let frame: VideoFrame
        try {
          // The timestamp only labels the frame; the video's current frame is captured either way.
          frame = new VideoFrame(source, { timestamp: Math.round(source.currentTime * 1e6) })
        } catch (err) {
          return failed(err)
        }
        io.captureMs = performance.now() - t
        return send(frame, buffer, width, height, out)
      }
      // createImageBitmap resolves later: only the call is main-thread time (as in the #6 spike).
      const bitmap = createImageBitmap(source)
      io.captureMs = performance.now() - t
      return bitmap.then((b) => send(b, buffer, width, height, out), failed)
    },
    dispose() {
      disposed = true
      pending?.reject(new Error('worker pipeline disposed'))
      pending = undefined
      worker.terminate()
    },
  }
}
