/**
 * Spike #83: MediaPipe's face models on another runtime (LiteRT.js: multithreaded wasm, WebGPU) vs MediaPipe
 * tasks-vision. Page: `spikes/runtime.html`, served cross-origin isolated (COOP/COEP, see vite.config.ts) so wasm
 * threads are available.
 *
 * URL options:
 * - `runtime=litert|mediapipe` (default `litert`);
 * - `accel=wasm|webgpu` (litert, default `wasm`);
 * - `threads=N` (litert wasm; default min(4, cores) when cross-origin isolated, else 1; 1 = single-threaded build);
 * - `delegate=CPU|GPU` (mediapipe, default GPU);
 * - `blendshapes=0` (both runtimes: skip the blendshapes model);
 * - `detect=always` (litert: run the detector on every frame, to measure it);
 * - `crop=gpu` (litert: rotated landmark crop on WebGL2, only the crop read back, instead of the 2D canvas);
 * - `detcrop=canvas|gpu` (litert: same choice for the detector's 128×128 letterbox; default: as `crop`, so
 *   `crop=gpu&detcrop=canvas` is the variant measured on the Redmi Note 11S before the detector crop moved to WebGL2);
 * - `mode=main|worker` (litert, default `main`; `worker=1` works too): detection, landmarks and blendshapes in a
 *   dedicated worker (`litert.worker.ts`), frames transferred as in the #6 spike; falls back to the main thread, with
 *   a warning, when the worker cannot start;
 * - `transfer=videoframe|bitmap` (worker: `new VideoFrame(video)` or `createImageBitmap(video)`, default
 *   `videoframe`);
 * - `schedule=eager` (litert: start the next run as soon as one ends instead of waiting for the next frame callback;
 *   runs then no longer snap to the display's 16.7 ms ticks. Main thread: on the video's current frame, after one
 *   rendering step. Worker: right away when a frame newer than the one analysed has been presented, otherwise on the
 *   next frame callback);
 * - `coi=0` (serve the page without cross-origin isolation: what isolation itself changes);
 * - `source=<clip>&autostart`, `window=N` as on the other pages.
 */
import { CameraError, CameraSource, FrameScheduler, VideoFileSource, createFaceFrame, createFrameSample, type Delegate, type FaceTracker } from '@ouaf/core'
import { createPerf } from '../../perf.ts'
import type { Roi } from './geometry.ts'
import { createFaceResult, createLiteRtPipeline, LANDMARKS, type Accelerator, type Crop, type LiteRtOptions, type LiteRtPipeline, type StageTimings } from './litert-pipeline.ts'
import { createWorkerPipeline, type Transfer, type WorkerPipeline } from './worker-client.ts'

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing #${id}`)
  return el as T
}

// --- Options -----------------------------------------------------------------------------------------------------
const params = new URLSearchParams(location.search)
const SOURCE = /^[\w-]+$/.test(params.get('source') ?? '') ? params.get('source') : null
const RUNTIME: 'litert' | 'mediapipe' = params.get('runtime') === 'mediapipe' ? 'mediapipe' : 'litert'
const ACCEL: Accelerator = params.get('accel') === 'webgpu' ? 'webgpu' : 'wasm'
const CORES = navigator.hardwareConcurrency || 1
const THREADS = Math.min(16, Math.max(1, Math.trunc(Number(params.get('threads'))) || (crossOriginIsolated ? Math.min(4, CORES) : 1)))
const DELEGATE: Delegate = params.get('delegate')?.toUpperCase() === 'CPU' ? 'CPU' : 'GPU'
const BLENDSHAPES = params.get('blendshapes') !== '0'
const DETECT = params.get('detect') === 'always' ? 'always' : 'track'
const CROP: Crop = params.get('crop') === 'gpu' ? 'gpu' : 'canvas'
const DETECTOR_CROP: Crop = params.get('detcrop') === 'gpu' ? 'gpu' : params.get('detcrop') === 'canvas' ? 'canvas' : CROP
const SCHEDULE = params.get('schedule') === 'eager' ? 'eager' : 'frame'
const REQUESTED_MODE = RUNTIME === 'litert' && (params.get('mode') === 'worker' || params.get('worker') === '1') ? 'worker' : 'main'
const TRANSFER: Transfer = params.get('transfer') === 'bitmap' ? 'bitmap' : 'videoframe'
/** Where the pipeline actually runs: the worker variant falls back to `main` when the worker cannot start. */
let mode: 'main' | 'worker' = REQUESTED_MODE
/**
 * Main thread, `schedule=eager`: a run is only chained right away when the previous one lasted at least this long: a
 * new camera frame (30 fps) has arrived by then; a shorter run waits for the next frame callback so that no frame is
 * analysed twice. (The worker variant checks for a newer presented frame instead.)
 */
const EAGER_MIN_MS = 30

// --- Status ------------------------------------------------------------------------------------------------------
const status = $<HTMLDListElement>('status')
const startButton = $<HTMLButtonElement>('start')
const checkButton = $<HTMLButtonElement>('check')
const stopButton = $<HTMLButtonElement>('stop')
const stage = $<HTMLDivElement>('stage')
const video = $<HTMLVideoElement>('video')

function row(label: string, value: string) {
  const dt = document.createElement('dt')
  dt.textContent = label
  const dd = document.createElement('dd')
  dd.textContent = value
  status.append(dt, dd)
  return dd
}

/** Links to the main variants, keeping the other URL options. */
function variantLinks() {
  const nav = $<HTMLElement>('variants')
  const litert = { runtime: null, accel: null, threads: null, delegate: null }
  const variants: Array<[string, Record<string, string | null>]> = [
    ['MediaPipe GPU', { runtime: 'mediapipe', delegate: null, accel: null, threads: null, mode: null }],
    ['MediaPipe CPU', { runtime: 'mediapipe', delegate: 'CPU', accel: null, threads: null, mode: null }],
    ['LiteRT wasm ×1', { ...litert, threads: '1' }],
    ['LiteRT wasm ×N', litert],
    ['LiteRT WebGPU', { ...litert, accel: 'webgpu' }],
    ['LiteRT ×N, GPU crops', { ...litert, crop: 'gpu', detcrop: null, mode: null, schedule: null }],
    ['… in a worker', { ...litert, crop: 'gpu', detcrop: null, mode: 'worker', schedule: null }],
    ['… worker, eager', { ...litert, crop: 'gpu', detcrop: null, mode: 'worker', schedule: 'eager' }],
  ]
  for (const [label, set] of variants) {
    const p = new URLSearchParams(location.search)
    for (const [k, v] of Object.entries(set)) {
      if (v === null) p.delete(k)
      else p.set(k, v)
    }
    const a = document.createElement('a')
    a.href = `?${p}`
    a.textContent = label
    nav.append(a)
  }
  const all = document.createElement('a')
  all.href = './'
  all.textContent = 'all spikes'
  nav.append(all)
}
variantLinks()

const webgpu = 'gpu' in navigator
row('Isolation', `crossOriginIsolated ${crossOriginIsolated ? 'yes' : 'no'} · SharedArrayBuffer ${typeof SharedArrayBuffer === 'function' ? 'yes' : 'no'} · ${CORES} cores · WebGPU ${webgpu ? 'yes' : 'no'}`)
const variant =
  RUNTIME === 'mediapipe'
    ? `MediaPipe tasks-vision, delegate ${DELEGATE}`
    : `LiteRT.js ${ACCEL}${ACCEL === 'wasm' ? `, ${THREADS} thread${THREADS > 1 ? 's' : ''}` : ''}, detector ${DETECT === 'always' ? 'every frame' : 'when no face is tracked'}, ` +
      `crop ${CROP}, detector crop ${DETECTOR_CROP}, schedule ${SCHEDULE}, ` +
      (REQUESTED_MODE === 'worker' ? `worker (${TRANSFER})` : 'main thread')
row('Variant', `${variant} · blendshapes ${BLENDSHAPES ? 'on' : 'off'}`)
const runtimeRow = row('Runtime', 'not started')
const warningsRow = row('Warnings', '—')
const sourceRow = row('Source', 'not started')
const faceRow = row('Face', '—')
const checkRow = row('Check vs MediaPipe', 'not run (press “Check” with a face in view)')

const warnings: string[] = []
function warn(message: string) {
  console.warn(`[spike #83] ${message}`)
  warnings.push(message)
  warningsRow.textContent = `⚠ ${warnings.slice(-3).join(' · ')}`
  warningsRow.style.color = '#e53935'
  perf?.note(message)
}

// --- Measurements ------------------------------------------------------------------------------------------------
/**
 * Extra recorder columns (docs/perf/session-format.md). `pipelineMs`: time from start to result of a pipeline run
 * completed since the previous frame (NaN otherwise); `dropped`: 1 when a presented frame was never analysed (a newer
 * one replaced it while the pipeline was busy); `latencyMs`: frame callback of the analysed frame → result;
 * `resultAgeMs`: age of the result drawn in this frame; `ioMs` (worker): run time seen by the page minus the worker's.
 */
const COLUMNS = [
  'runs',
  'pipelineMs',
  'detectMs',
  'detectCropMs',
  'cropMs',
  'landmarksMs',
  'blendshapesMs',
  'readMs',
  'dropped',
  'presence',
  'latencyMs',
  'resultAgeMs',
  'ioMs',
] as const
type Column = (typeof COLUMNS)[number]

let runtimeDescription = ''
let litert: LiteRtPipeline | undefined
let mediapipe: FaceTracker | undefined
const workerPipeline = () => (mode === 'worker' ? (litert as WorkerPipeline | undefined) : undefined)

const perf = createPerf({
  columns: COLUMNS,
  live: [
    // Completed pipeline runs per second: the tracking rate, apart from the rendering frame rate.
    { column: 'runs', label: 'track Hz', kind: 'rate' },
    { column: 'pipelineMs', label: 'pipeline', kind: 'ms' },
    { column: 'detectMs', label: 'detect', kind: 'ms' },
    { column: 'detectCropMs', label: 'dcrop', kind: 'ms' },
    { column: 'cropMs', label: 'crop', kind: 'ms' },
    { column: 'landmarksMs', label: 'lmk', kind: 'ms' },
    { column: 'blendshapesMs', label: 'bs', kind: 'ms' },
    { column: 'readMs', label: 'read', kind: 'ms' },
    { column: 'dropped', label: 'drop/fr', kind: 'count' },
    { column: 'latencyMs', label: 'latency', kind: 'ms' },
    { column: 'resultAgeMs', label: 'age', kind: 'ms' },
    { column: 'ioMs', label: 'xfer', kind: 'ms' },
  ],
  app: () => ({
    spike: 'runtime (#83)',
    runtime: RUNTIME,
    variant,
    description: runtimeDescription,
    crossOriginIsolated,
    cores: CORES,
    threads: RUNTIME === 'litert' && ACCEL === 'wasm' ? THREADS : 0,
    blendshapes: BLENDSHAPES,
    crop: RUNTIME === 'litert' ? CROP : '',
    detectorCrop: RUNTIME === 'litert' ? DETECTOR_CROP : '',
    schedule: RUNTIME === 'litert' ? SCHEDULE : '',
    requestedMode: REQUESTED_MODE,
    mode,
    transfer: workerPipeline()?.transfer ?? '',
    workerCrossOriginIsolated: workerPipeline()?.ready.crossOriginIsolated ?? '',
    warnings: warnings.join(' | '),
  }),
})
if (perf) $<HTMLDivElement>('perf').append(perf.element)

const sample = createFrameSample()
const extra = Object.fromEntries(COLUMNS.map((c) => [c, NaN])) as Record<Column, number>
sample.extra = extra

/** Recent pipeline timings, for automated runs (`window.__spike83`). */
const RECENT = ['pipelineMs', 'detectMs', 'detectCropMs', 'cropMs', 'landmarksMs', 'blendshapesMs', 'readMs', 'latencyMs', 'resultAgeMs', 'ioMs'] as const
const recent = Object.fromEntries(RECENT.map((k) => [k, [] as number[]])) as Record<(typeof RECENT)[number], number[]>
let frames = 0
let droppedFrames = 0
let completedRuns = 0
function remember(key: keyof typeof recent, value: number) {
  if (!Number.isFinite(value)) return
  const list = recent[key]
  list.push(value)
  if (list.length > 2000) list.shift()
}

// --- Runtimes ----------------------------------------------------------------------------------------------------
const result = createFaceResult()
const mpFrame = createFaceFrame(1)

async function ensureRuntime(): Promise<boolean> {
  if (litert || mediapipe) return true
  runtimeRow.textContent = 'loading…'
  const t = performance.now()
  try {
    if (RUNTIME === 'litert') {
      const options: LiteRtOptions = {
        accelerator: ACCEL,
        threads: THREADS,
        blendshapes: BLENDSHAPES,
        detect: DETECT,
        crop: CROP,
        detectorCrop: DETECTOR_CROP,
        assetBase: new URL('../', document.baseURI).href,
      }
      if (REQUESTED_MODE === 'worker') {
        try {
          litert = await createWorkerPipeline(options, TRANSFER, warn)
        } catch (err) {
          console.error('[spike #83] worker pipeline failed:', err)
          warn(`worker unavailable (${err instanceof Error ? err.message : String(err)}): the pipeline runs on the main thread`)
          mode = 'main'
        }
      }
      litert ??= await createLiteRtPipeline(options)
      runtimeDescription = litert.description
      const w = workerPipeline()
      if (w) runtimeDescription += ` · worker crossOriginIsolated ${w.ready.crossOriginIsolated ? 'yes' : 'no'}`
    } else {
      const { createFaceTracker } = await import('@ouaf/core')
      mediapipe = await createFaceTracker({
        maxFaces: 1,
        delegate: DELEGATE,
        blendshapes: BLENDSHAPES,
        wasmBaseUrl: new URL('../mediapipe/wasm/', document.baseURI).href,
        modelUrl: new URL('../models/face_landmarker.task', document.baseURI).href,
      })
      runtimeDescription = `MediaPipe ${mediapipe.delegate}`
    }
  } catch (err) {
    console.error('[spike #83] runtime initialization failed:', err)
    // Only for a missing model (MediaPipe's message; LiteRT.js downloads already say so), not "model compilation
    // failed (webgpu)" on a browser without WebGPU.
    const hint = /face model/.test(String(err)) ? ' — run `npm run fetch-models`' : ''
    runtimeRow.textContent = `unavailable: ${err instanceof Error ? err.message : String(err)}${hint}`
    return false
  }
  runtimeRow.textContent = `ready: ${runtimeDescription} (loaded in ${(performance.now() - t).toFixed(0)} ms)`
  return true
}

// --- Drawing -----------------------------------------------------------------------------------------------------
const canvas = document.createElement('canvas')
const ctx = canvas.getContext('2d')!

function draw(width: number, height: number) {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  ctx.drawImage(video, 0, 0, width, height)
  const dot = Math.max(1.5, width / 400)
  ctx.fillStyle = '#00e676'
  if (RUNTIME === 'mediapipe') {
    if (mpFrame.count > 0) {
      for (let i = 0; i < LANDMARKS; i++) ctx.fillRect(mpFrame.landmarks[i * 3]! * width - dot / 2, mpFrame.landmarks[i * 3 + 1]! * height - dot / 2, dot, dot)
    }
    return
  }
  if (result.found) {
    for (let i = 0; i < LANDMARKS; i++) ctx.fillRect(result.landmarks[i * 3]! - dot / 2, result.landmarks[i * 3 + 1]! - dot / 2, dot, dot)
  }
  const roi = result.roi
  if (roi) {
    ctx.save()
    ctx.strokeStyle = result.found ? '#ffeb3b' : '#f44336'
    ctx.lineWidth = dot
    ctx.translate(roi.cx, roi.cy)
    ctx.rotate(roi.rotation)
    ctx.strokeRect(-roi.size / 2, -roi.size / 2, roi.size, roi.size)
    ctx.restore()
  }
}

// --- Loop --------------------------------------------------------------------------------------------------------
let source: CameraSource | VideoFileSource | undefined
let scheduler: FrameScheduler | undefined
let busy = false
/** check(), bench(), analyse() use the pipeline directly: the frame loop starts no run meanwhile (seeks present frames). */
let manual = 0
/** Runs completed since the last frame callback, consumed by the next one (values of the last run, counts summed). */
let completed: { pipelineMs: number; runs: number; timings: StageTimings; latencyMs: number; ioMs: number; mainMs: number } | undefined
/** A presented frame (its callback's `now`) not analysed yet: the pipeline was busy when its callback came. */
let pendingFrame: number | undefined
/** Callback `now` of the latest frame, and of the frame whose result is in `result`. */
let latestFrameNow = NaN
let resultFrameNow = NaN
let shownAt = -Infinity

/**
 * Starts a LiteRT run on the video's current frame (`frameNow`: its frame callback time). With `schedule=eager`, the
 * next run starts when this one ends instead of on the next frame callback: on the main thread after one rendering
 * step; in the worker variant right away, if a newer frame has been presented meanwhile. Several runs can then
 * complete between two callbacks: `completed.runs` counts them.
 */
function startRun(p: LiteRtPipeline, frameNow: number) {
  busy = true
  pendingFrame = undefined
  const started = performance.now()
  void p
    .run(video, video.videoWidth, video.videoHeight, result)
    .then(() => {
      const finished = performance.now()
      const w = workerPipeline()
      completedRuns++
      resultFrameNow = frameNow
      completed = {
        pipelineMs: finished - started,
        runs: (completed?.runs ?? 0) + 1,
        timings: { ...p.timings },
        latencyMs: finished - frameNow,
        ioMs: w ? finished - started - w.io.workerMs : NaN,
        // Worker: main-thread cost of the run (capture, post, result handling).
        mainMs: (completed?.mainMs ?? 0) + (w ? w.io.captureMs + w.io.postMs + w.io.receiveMs : 0),
      }
    })
    .catch((err: unknown) => {
      console.error('[spike #83] pipeline run failed:', err)
      runtimeRow.textContent = `run failed: ${err instanceof Error ? err.message : String(err)}`
    })
    .finally(() => {
      busy = false
      // check() and bench() pause the video: the chain stops there, as it does on stop().
      const chain = () => SCHEDULE === 'eager' && litert === p && scheduler !== undefined && !video.paused
      if (!chain()) return
      if (mode === 'worker') {
        // The main thread stays free: no need to yield, only to avoid analysing the same frame twice.
        if (pendingFrame !== undefined) startRun(p, pendingFrame)
        return
      }
      // Yield to one rendering step first (frame callbacks then requestAnimationFrame, then the paint), then start
      // the next run in a task of its own: a plain setTimeout chain starves rendering (≈ 1 fps on the Redmi).
      if (performance.now() - started >= EAGER_MIN_MS) {
        requestAnimationFrame(() =>
          setTimeout(() => {
            if (!busy && chain()) startRun(p, latestFrameNow)
          }, 0),
        )
      }
    })
}

function stop() {
  scheduler?.dispose()
  source?.dispose()
  scheduler = undefined
  source = undefined
  canvas.remove()
  startButton.disabled = false
  checkButton.disabled = stopButton.disabled = true
}

async function start() {
  stop()
  startButton.disabled = true
  sourceRow.textContent = 'opening…'
  try {
    source = SOURCE
      ? await VideoFileSource.open(new URL(`../test-media/${SOURCE}.mp4`, document.baseURI).href, { video })
      : await CameraSource.open({ facingMode: 'user', video })
  } catch (err) {
    sourceRow.textContent = err instanceof CameraError ? `${err.code}: ${err.message}` : String(err)
    startButton.disabled = false
    return
  }
  sourceRow.textContent = `${source.width}×${source.height} ${SOURCE ? `file test-media/${SOURCE}.mp4` : 'camera'}`
  if (!(await ensureRuntime())) {
    startButton.disabled = false
    return
  }
  stage.append(canvas)
  stopButton.disabled = checkButton.disabled = false
  perf?.setInfo({
    delegate: RUNTIME === 'mediapipe' ? mediapipe?.delegate : ACCEL === 'webgpu' ? 'GPU' : 'CPU',
    videoWidth: source.width,
    videoHeight: source.height,
    renderWidth: source.width,
    renderHeight: source.height,
    maxFaces: 1,
  })
  litert?.reset()
  pendingFrame = undefined
  resultFrameNow = NaN

  scheduler = new FrameScheduler(video, (frame) => {
    const width = video.videoWidth
    const height = video.videoHeight
    for (const c of COLUMNS) extra[c] = NaN
    sample.now = frame.now
    sample.mediaTime = frame.mediaTime
    frames++
    latestFrameNow = frame.now

    const t = performance.now()
    let mainMs = NaN
    if (mediapipe) {
      mediapipe.detect(video, frame.now, frame.mediaTime, mpFrame)
      extra.pipelineMs = performance.now() - t
      extra.runs = 1
      remember('pipelineMs', extra.pipelineMs)
      sample.faces = mpFrame.count
    } else if (litert) {
      extra.runs = completed?.runs ?? 0
      if (completed) {
        extra.pipelineMs = completed.pipelineMs
        const s = completed.timings
        extra.detectMs = s.detectMs
        extra.detectCropMs = s.detectCropMs
        extra.cropMs = s.cropMs
        extra.landmarksMs = s.landmarksMs
        extra.blendshapesMs = s.blendshapesMs
        extra.readMs = s.readMs
        extra.presence = result.presence
        extra.latencyMs = completed.latencyMs
        extra.ioMs = completed.ioMs
        if (mode === 'worker') mainMs = completed.mainMs
        completed = undefined
      }
      // The frame left pending at the previous callback was never analysed: a newer one replaces it.
      extra.dropped = pendingFrame !== undefined ? 1 : 0
      droppedFrames += extra.dropped
      pendingFrame = undefined
      if (busy) pendingFrame = frame.now
      else if (manual === 0) startRun(litert, frame.now)
      if (Number.isFinite(resultFrameNow)) extra.resultAgeMs = frame.now - resultFrameNow
      for (const key of RECENT) remember(key, extra[key])
      sample.faces = result.found ? 1 : 0
    }
    // Main-thread time spent in tracking for this frame: MediaPipe's detect, the synchronous part of a main-thread
    // LiteRT run; in the worker variant, capture + post + result handling of the runs completed since the last frame.
    sample.trackingMs = mode === 'worker' ? (Number.isFinite(mainMs) ? mainMs : 0) : performance.now() - t

    const r = performance.now()
    draw(width, height)
    sample.renderMs = performance.now() - r
    perf?.record(sample)

    if (frame.now - shownAt > 500) {
      shownAt = frame.now
      faceRow.textContent =
        RUNTIME === 'mediapipe'
          ? `${mpFrame.count} face(s)`
          : `${result.found ? 'tracked' : 'none'} · presence ${result.presence.toFixed(2)}${result.roi ? ` · ROI ${result.roi.size.toFixed(0)} px, ${((result.roi.rotation * 180) / Math.PI).toFixed(0)}°` : ''}` +
            (workerPipeline() ? ` · ${workerPipeline()!.pthreads} pthreads in the worker` : '')
    }
  })
  scheduler.start()
}

// --- Check against MediaPipe -------------------------------------------------------------------------------------
type Landmarker = import('@mediapipe/tasks-vision').FaceLandmarker
let reference: Promise<Landmarker> | undefined

/** A separate MediaPipe FaceLandmarker in IMAGE mode (CPU), so it does not disturb the VIDEO-mode one. */
function referenceLandmarker(): Promise<Landmarker> {
  reference ??= (async () => {
    const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
    const fileset = await FilesetResolver.forVisionTasks(new URL('../mediapipe/wasm', document.baseURI).href)
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: new URL('../models/face_landmarker.task', document.baseURI).href, delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 1,
      outputFaceBlendshapes: true,
    })
  })()
  return reference
}

/**
 * Runs `fn` with the pipeline to itself: no new run from the frame loop, the run in flight finished (the eager chain
 * stops on a paused video).
 */
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  manual++
  try {
    while (busy) await new Promise((r) => setTimeout(r, 5))
    return await fn()
  } finally {
    manual--
  }
}

/**
 * Runs our pipeline and MediaPipe on the same (paused) frame and compares them: landmark distance normalized by the
 * face size, and blendshape differences. MediaPipe runs in IMAGE mode (detector on every call): it can miss a face in
 * profile that both tracking pipelines keep.
 */
async function check(resume = true): Promise<string> {
  const p = litert
  if (!p) return 'only for runtime=litert'
  const wasPlaying = !video.paused
  video.pause()
  try {
    return await exclusive(() => compare(p))
  } finally {
    if (wasPlaying && resume) void video.play()
  }
}

/** check() on the paused frame, run twice: the second run uses the ROI tracked from the first, as in steady state. */
async function compare(p: LiteRtPipeline): Promise<string> {
  const width = video.videoWidth
  const height = video.videoHeight
  const ours = createFaceResult()
  await p.run(video, width, height, ours)
  await p.run(video, width, height, ours)
  const mp = (await referenceLandmarker()).detect(video)
  const theirs = mp.faceLandmarks[0]
  if (!theirs) return `MediaPipe found no face (ours: ${ours.found ? 'found' : 'none'})`
  if (!ours.found) return `our pipeline found no face (presence ${ours.presence.toFixed(2)}), MediaPipe did`
  // Both results on the paused frame: ours in green, MediaPipe's in magenta.
  draw(width, height)
  ctx.fillStyle = '#ff00ff'
  const dot = Math.max(1.5, width / 400)
  for (const p of theirs) ctx.fillRect(p.x * width - dot / 2, p.y * height - dot / 2, dot, dot)
  ctx.fillStyle = '#00e676'
  for (let i = 0; i < LANDMARKS; i++) ctx.fillRect(ours.landmarks[i * 3]! - dot / 2, ours.landmarks[i * 3 + 1]! - dot / 2, dot, dot)
  // Normalized by the face size (long side of MediaPipe's landmark box): stable in profile, unlike the eye distance.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const p of theirs) {
    x0 = Math.min(x0, p.x * width)
    x1 = Math.max(x1, p.x * width)
    y0 = Math.min(y0, p.y * height)
    y1 = Math.max(y1, p.y * height)
  }
  const face = Math.max(x1 - x0, y1 - y0)
  let sum = 0
  let max = 0
  for (let i = 0; i < LANDMARKS; i++) {
    const d = Math.hypot(ours.landmarks[i * 3]! - theirs[i]!.x * width, ours.landmarks[i * 3 + 1]! - theirs[i]!.y * height)
    sum += d
    max = Math.max(max, d)
  }
  let verdict = `landmarks: mean ${((sum / LANDMARKS / face) * 100).toFixed(1)} %, max ${((max / face) * 100).toFixed(1)} % of the face size (${face.toFixed(0)} px)`
  const categories = mp.faceBlendshapes[0]?.categories
  if (BLENDSHAPES && categories) {
    let bsSum = 0
    let bsMax = 0
    let bsName = ''
    for (const c of categories) {
      const d = Math.abs((ours.blendshapes[c.index] ?? 0) - c.score)
      bsSum += d
      if (d > bsMax) {
        bsMax = d
        bsName = c.categoryName
      }
    }
    verdict += ` · blendshapes: mean |Δ| ${(bsSum / categories.length).toFixed(3)}, max ${bsMax.toFixed(3)} (${bsName})`
  }
  return verdict
}

startButton.addEventListener('click', () => void start())
stopButton.addEventListener('click', stop)
checkButton.addEventListener('click', () => {
  checkRow.textContent = 'running…'
  void check()
    .catch((err: unknown) => `failed: ${err instanceof Error ? err.message : String(err)}`)
    .then((verdict) => {
      checkRow.textContent = verdict
      perf?.note(`check vs MediaPipe: ${verdict}`)
      console.info('[spike #83]', verdict)
    })
})
if (SOURCE !== null && params.has('autostart')) void start()

/** Pauses the video (at `atSeconds` when given); call inside `exclusive`. */
async function pauseAt(atSeconds?: number) {
  video.pause()
  if (atSeconds !== undefined) {
    const seeked = new Promise((r) => video.addEventListener('seeked', r, { once: true }))
    video.currentTime = atSeconds
    // WebKit fires `seeked` before the new frame can be drawn: a run started then analyses the previous frame. Wait
    // for the frame callback of the seeked frame as well (the first callback can still be for a frame of the
    // playback), with a timeout in case no new frame comes.
    let waiting = true
    const presented = new Promise<void>((resolve) => {
      if (!('requestVideoFrameCallback' in video)) return resolve()
      const wait = () => video.requestVideoFrameCallback((_, m) => (!waiting || Math.abs(m.mediaTime - atSeconds) < 0.1 ? resolve() : wait()))
      wait()
    })
    await seeked
    await Promise.race([presented, new Promise((r) => setTimeout(r, 500))])
    waiting = false
  }
}

/**
 * Deterministic micro-benchmark for the browser tests: pauses the video (at `atSeconds` when given), runs the pipeline
 * once to find the face and its ROI, then `runs` times on that frame. Returns the median landmark model time and how
 * often a face was found.
 */
function bench(runs: number, atSeconds?: number): Promise<{ landmarksMs: number; found: number; runs: number }> {
  const litert = pipeline()
  return exclusive(async () => {
    await pauseAt(atSeconds)
    litert.reset()
    const width = video.videoWidth
    const height = video.videoHeight
    const out = createFaceResult()
    await litert.run(video, width, height, out)
    const times: number[] = []
    let found = 0
    for (let i = 0; i < runs; i++) {
      await litert.run(video, width, height, out)
      if (out.found) found++
      if (Number.isFinite(litert.timings.landmarksMs)) times.push(litert.timings.landmarksMs)
    }
    times.sort((a, b) => a - b)
    return { landmarksMs: times[Math.floor(times.length / 2)] ?? NaN, found, runs }
  })
}

/**
 * One paused frame (at `atSeconds`), from scratch: the detector's ROI (first run, detector timings) and the landmarks
 * of the second run (tracked ROI, as in steady state). For the browser tests that compare variants.
 */
function analyse(atSeconds: number): Promise<{ detectorRoi: Roi | undefined; detect: StageTimings; found: boolean; landmarks: number[]; blendshapes: number[] }> {
  const litert = pipeline()
  return exclusive(async () => {
    await pauseAt(atSeconds)
    litert.reset()
    const width = video.videoWidth
    const height = video.videoHeight
    const out = createFaceResult()
    await litert.run(video, width, height, out)
    const detectorRoi = out.roi && { ...out.roi }
    const detect = { ...litert.timings }
    await litert.run(video, width, height, out)
    return { detectorRoi, detect, found: out.found, landmarks: Array.from(out.landmarks), blendshapes: Array.from(out.blendshapes) }
  })
}

function pipeline(): LiteRtPipeline {
  if (!litert) throw new Error('only for runtime=litert, once started')
  return litert
}

/** Hook for automated runs (headless measurements, browser tests): recent timings, MediaPipe comparison, bench. */
Object.assign(window, {
  __spike83: {
    recent,
    get frames() {
      return frames
    },
    get dropped() {
      return droppedFrames
    },
    get runs() {
      return completedRuns
    },
    get runtime() {
      return runtimeRow.textContent
    },
    get mode() {
      return mode
    },
    get warnings() {
      return [...warnings]
    },
    get worker() {
      const w = workerPipeline()
      return w ? { crossOriginIsolated: w.ready.crossOriginIsolated, options: w.ready.options, pthreads: w.pthreads, transfer: w.transfer } : undefined
    },
    check,
    bench,
    analyse,
    threads: RUNTIME === 'litert' && ACCEL === 'wasm' ? THREADS : 0,
  },
})
