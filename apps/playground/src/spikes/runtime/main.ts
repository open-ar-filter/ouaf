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
 * - `coi=0` (serve the page without cross-origin isolation: what isolation itself changes);
 * - `source=<clip>&autostart`, `window=N` as on the other pages.
 */
import { CameraError, CameraSource, FrameScheduler, VideoFileSource, createFaceFrame, createFrameSample, type Delegate, type FaceTracker } from '@ouaf/core'
import { createPerf } from '../../perf.ts'
import { createFaceResult, createLiteRtPipeline, LANDMARKS, type Accelerator, type LiteRtPipeline } from './litert-pipeline.ts'

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
  const variants: Array<[string, Record<string, string | null>]> = [
    ['MediaPipe GPU', { runtime: 'mediapipe', delegate: null, accel: null, threads: null }],
    ['MediaPipe CPU', { runtime: 'mediapipe', delegate: 'CPU', accel: null, threads: null }],
    ['LiteRT wasm ×1', { runtime: null, accel: null, threads: '1', delegate: null }],
    ['LiteRT wasm ×N', { runtime: null, accel: null, threads: null, delegate: null }],
    ['LiteRT WebGPU', { runtime: null, accel: 'webgpu', threads: null, delegate: null }],
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
    : `LiteRT.js ${ACCEL}${ACCEL === 'wasm' ? `, ${THREADS} thread${THREADS > 1 ? 's' : ''}` : ''}, detector ${DETECT === 'always' ? 'every frame' : 'when no face is tracked'}`
row('Variant', `${variant} · blendshapes ${BLENDSHAPES ? 'on' : 'off'}`)
const runtimeRow = row('Runtime', 'not started')
const sourceRow = row('Source', 'not started')
const faceRow = row('Face', '—')
const checkRow = row('Check vs MediaPipe', 'not run (press “Check” with a face in view)')

// --- Measurements ------------------------------------------------------------------------------------------------
/**
 * Extra recorder columns (docs/perf/session-format.md). `pipelineMs`: time from frame to result of a pipeline run
 * completed since the previous frame (NaN otherwise), `dropped`: 1 when the frame was not analysed because the
 * previous run was still going.
 */
const COLUMNS = ['pipelineMs', 'detectMs', 'cropMs', 'landmarksMs', 'blendshapesMs', 'readMs', 'dropped', 'presence'] as const
type Column = (typeof COLUMNS)[number]

let runtimeDescription = ''
const perf = createPerf({
  columns: COLUMNS,
  live: [
    { column: 'pipelineMs', label: 'pipeline', kind: 'ms' },
    { column: 'detectMs', label: 'detect', kind: 'ms' },
    { column: 'cropMs', label: 'crop', kind: 'ms' },
    { column: 'landmarksMs', label: 'lmk', kind: 'ms' },
    { column: 'blendshapesMs', label: 'bs', kind: 'ms' },
    { column: 'readMs', label: 'read', kind: 'ms' },
    { column: 'dropped', label: 'drop/fr', kind: 'count' },
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
  }),
})
if (perf) $<HTMLDivElement>('perf').append(perf.element)

const sample = createFrameSample()
const extra = Object.fromEntries(COLUMNS.map((c) => [c, NaN])) as Record<Column, number>
sample.extra = extra

/** Recent pipeline timings, for automated runs (`window.__spike83`). */
const recent: Record<'pipelineMs' | 'detectMs' | 'cropMs' | 'landmarksMs' | 'blendshapesMs' | 'readMs', number[]> = {
  pipelineMs: [],
  detectMs: [],
  cropMs: [],
  landmarksMs: [],
  blendshapesMs: [],
  readMs: [],
}
let frames = 0
let droppedFrames = 0
function remember(key: keyof typeof recent, value: number) {
  if (!Number.isFinite(value)) return
  const list = recent[key]
  list.push(value)
  if (list.length > 2000) list.shift()
}

// --- Runtimes ----------------------------------------------------------------------------------------------------
const result = createFaceResult()
const mpFrame = createFaceFrame(1)
let litert: LiteRtPipeline | undefined
let mediapipe: FaceTracker | undefined

async function ensureRuntime(): Promise<boolean> {
  if (litert || mediapipe) return true
  runtimeRow.textContent = 'loading…'
  const t = performance.now()
  try {
    if (RUNTIME === 'litert') {
      litert = await createLiteRtPipeline({ accelerator: ACCEL, threads: THREADS, blendshapes: BLENDSHAPES, detect: DETECT })
      runtimeDescription = litert.description
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
    const hint = /model|tflite|task/i.test(String(err)) ? ' — run `npm run fetch-models`' : ''
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
/** Result of a LiteRT run completed since the last frame callback, consumed by the next one. */
let completed: { pipelineMs: number } | undefined
let shownAt = -Infinity

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

  scheduler = new FrameScheduler(video, (frame) => {
    const width = video.videoWidth
    const height = video.videoHeight
    for (const c of COLUMNS) extra[c] = NaN
    sample.now = frame.now
    sample.mediaTime = frame.mediaTime
    frames++

    const t = performance.now()
    if (mediapipe) {
      mediapipe.detect(video, frame.now, frame.mediaTime, mpFrame)
      extra.pipelineMs = performance.now() - t
      remember('pipelineMs', extra.pipelineMs)
      sample.faces = mpFrame.count
    } else if (litert) {
      if (completed) {
        extra.pipelineMs = completed.pipelineMs
        const s = litert.timings
        extra.detectMs = s.detectMs
        extra.cropMs = s.cropMs
        extra.landmarksMs = s.landmarksMs
        extra.blendshapesMs = s.blendshapesMs
        extra.readMs = s.readMs
        extra.presence = result.presence
        for (const key of Object.keys(recent) as (keyof typeof recent)[]) remember(key, extra[key])
        completed = undefined
      }
      if (busy) {
        extra.dropped = 1
        droppedFrames++
      } else {
        extra.dropped = 0
        busy = true
        const p = litert
        const started = performance.now()
        void p
          .run(video, width, height, result)
          .then(() => (completed = { pipelineMs: performance.now() - started }))
          .catch((err: unknown) => {
            console.error('[spike #83] pipeline run failed:', err)
            runtimeRow.textContent = `run failed: ${err instanceof Error ? err.message : String(err)}`
          })
          .finally(() => (busy = false))
      }
      sample.faces = result.found ? 1 : 0
    }
    // Main-thread time spent in tracking during this callback (the synchronous part of a LiteRT run).
    sample.trackingMs = performance.now() - t

    const r = performance.now()
    draw(width, height)
    sample.renderMs = performance.now() - r
    perf?.record(sample)

    if (frame.now - shownAt > 500) {
      shownAt = frame.now
      faceRow.textContent =
        RUNTIME === 'mediapipe'
          ? `${mpFrame.count} face(s)`
          : `${result.found ? 'tracked' : 'none'} · presence ${result.presence.toFixed(2)}${result.roi ? ` · ROI ${result.roi.size.toFixed(0)} px, ${((result.roi.rotation * 180) / Math.PI).toFixed(0)}°` : ''}`
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
 * Runs our pipeline and MediaPipe on the same (paused) frame and compares them: landmark distance normalized by the
 * face size, and blendshape differences. MediaPipe runs in IMAGE mode (detector on every call): it can miss a face in
 * profile that both tracking pipelines keep.
 */
async function check(resume = true): Promise<string> {
  if (!litert) return 'only for runtime=litert'
  const wasPlaying = !video.paused
  video.pause()
  try {
    // Wait for the running pipeline, then analyse the paused frame twice: the second run uses the ROI tracked
    // from the first one, as in steady state.
    while (busy) await new Promise((r) => setTimeout(r, 5))
    const width = video.videoWidth
    const height = video.videoHeight
    const ours = createFaceResult()
    await litert.run(video, width, height, ours)
    await litert.run(video, width, height, ours)
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
  } finally {
    if (wasPlaying && resume) void video.play()
  }
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

/**
 * Deterministic micro-benchmark for the browser tests: pauses the video (at `atSeconds` when given), runs the pipeline
 * once to find the face and its ROI, then `runs` times on that frame. Returns the median landmark model time and how
 * often a face was found.
 */
async function bench(runs: number, atSeconds?: number): Promise<{ landmarksMs: number; found: number; runs: number }> {
  if (!litert) throw new Error('only for runtime=litert, once started')
  video.pause()
  while (busy) await new Promise((r) => setTimeout(r, 5))
  if (atSeconds !== undefined) {
    const seeked = new Promise((r) => video.addEventListener('seeked', r, { once: true }))
    video.currentTime = atSeconds
    await seeked
  }
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
    get runtime() {
      return runtimeRow.textContent
    },
    check,
    bench,
    threads: RUNTIME === 'litert' && ACCEL === 'wasm' ? THREADS : 0,
  },
})
