/**
 * Spike #7 — shared WebGL context with MediaPipe (GPU-side masks). Page: `spikes/gl-share.html`.
 *
 * Camera → MediaPipe ImageSegmenter (selfie segmenter, VIDEO mode, confidence mask) → three.js render that blurs and
 * tints the background behind the person. Variants by URL (see `readOptions`), recorded with the playground
 * performance panel plus the spike's extra columns (docs/perf/session-format.md).
 */
import { CameraError, CameraSource, FrameScheduler, createFrameSample, type Delegate } from '@ouaf/core'
import { createPerf } from '../../perf.ts'
import { resetTimings, type FrameTimings, type MaskPipeline, type SpikeOptions } from './pipeline.ts'
import { describeContexts, installProbe, type ContextCounts } from './probe.ts'

// Before anything creates a context or loads MediaPipe.
const probe = installProbe()

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing #${id}`)
  return el as T
}

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value ?? '') ? (value as T) : fallback
}

/**
 * URL options:
 * - `path=shared|cpu|webgpu` (default `shared`);
 * - `delegate=GPU|CPU` — segmenter delegate (default GPU);
 * - `reset=both|after|none` — shared path: `renderer.resetState()` before and after MediaPipe (default), only
 *   after, or never (to see what breaks);
 * - `copy=canvas|readback` — webgpu path: GPU copy through MediaPipe's canvas (default) or CPU readback;
 * - `effect=blur|tint`, `view=composite|mask` (mask view: alignment by eye);
 * - `face=off|own|shared` — also run a FaceLandmarker on its own context or on the shared canvas (bonus);
 * - `gpu=low-power|high-performance` — webgpu path: adapter power preference (dual-GPU machines);
 * - `flip=0|1` — force the GPU mask orientation (debug).
 */
function readOptions(): SpikeOptions {
  const p = new URLSearchParams(location.search)
  const flip = p.get('flip')
  return {
    path: pick(p.get('path'), ['shared', 'cpu', 'webgpu'], 'shared'),
    delegate: p.get('delegate')?.toUpperCase() === 'CPU' ? 'CPU' : ('GPU' satisfies Delegate),
    reset: pick(p.get('reset'), ['both', 'after', 'none'], 'both'),
    copy: pick(p.get('copy'), ['canvas', 'readback'], 'canvas'),
    effect: pick(p.get('effect'), ['blur', 'tint'], 'blur'),
    view: pick(p.get('view'), ['composite', 'mask'], 'composite'),
    face: pick(p.get('face'), ['off', 'own', 'shared'], 'off'),
    powerPreference: (['low-power', 'high-performance'] as const).find((v) => v === p.get('gpu')),
    maskFlipY: flip === '1' ? true : flip === '0' ? false : undefined,
  }
}

const options = readOptions()

const status = $<HTMLDListElement>('status')
const startButton = $<HTMLButtonElement>('start')
const checkButton = $<HTMLButtonElement>('check')
const stopButton = $<HTMLButtonElement>('stop')
const stage = $<HTMLDivElement>('stage')
const video = $<HTMLVideoElement>('video')
const big = $<HTMLDivElement>('big')

function row(label: string, value: string) {
  const dt = document.createElement('dt')
  dt.textContent = label
  const dd = document.createElement('dd')
  dd.textContent = value
  status.append(dt, dd)
  return dd
}

row('Variant', new URLSearchParams(location.search).toString() || '(defaults: path=shared)')
const pathRow = row('Path', options.path)
const maskRow = row('Mask', '—')
const contextsRow = row('Contexts', '—')
const checkRow = row('Alignment check', 'not run (press “Check alignment” with a person in view)')
const errorRow = row('Status', window.isSecureContext ? 'idle' : 'not a secure context: open the https:// URL')

/** Extra recorder columns, recorded from `FrameSample.extra` by name (docs/perf/session-format.md). */
const COLUMNS = ['segmentationMs', 'transferMs', 'uploadMs', 'pipelineMs', 'readbacks', 'readbackBytes', 'syncCalls', 'maskReads'] as const
type Column = (typeof COLUMNS)[number]

let pipeline: MaskPipeline | undefined
let pipelineContexts = ''
const perf = createPerf({
  columns: COLUMNS,
  live: [
    { column: 'segmentationMs', label: 'seg', kind: 'ms' },
    { column: 'transferMs', label: 'xfer', kind: 'ms' },
    { column: 'uploadMs', label: 'upload', kind: 'ms' },
    { column: 'readbacks', label: 'rb/fr', kind: 'count' },
    { column: 'maskReads', label: 'mask rd/fr', kind: 'count' },
    { column: 'syncCalls', label: 'sync/fr', kind: 'count' },
  ],
  app: () => ({
    spike: 'gl-share (#7)',
    ...(pipeline?.details() ?? {}),
    contexts: describeContexts(probe.contexts),
    pipelineContexts,
  }),
})
if (perf) $<HTMLDivElement>('perf').append(perf.element)

let camera: CameraSource | undefined
let scheduler: FrameScheduler | undefined
const sample = createFrameSample()
// Reused every frame (no allocation): one property per extra column.
const extra = Object.fromEntries(COLUMNS.map((c) => [c, NaN])) as Record<Column, number>
sample.extra = extra
const timings: FrameTimings = { trackingMs: NaN, faces: 0, segmentationMs: NaN, transferMs: NaN, uploadMs: NaN, renderMs: NaN }

function stop() {
  scheduler?.dispose()
  pipeline?.dispose()
  pipeline?.canvas.remove()
  camera?.dispose()
  scheduler = undefined
  pipeline = undefined
  camera = undefined
  startButton.disabled = false
  checkButton.disabled = stopButton.disabled = true
}

function diff(after: Readonly<ContextCounts>, before: Readonly<ContextCounts>): ContextCounts {
  return { webgl: after.webgl - before.webgl, webgl2: after.webgl2 - before.webgl2, webgpu: after.webgpu - before.webgpu }
}

async function start() {
  stop()
  startButton.disabled = true
  errorRow.textContent = 'opening the camera…'
  try {
    camera = await CameraSource.open({ facingMode: 'user', video })
  } catch (err) {
    errorRow.textContent = err instanceof CameraError ? `${err.code}: ${err.message}` : String(err)
    startButton.disabled = false
    return
  }
  errorRow.textContent = `loading the ${options.path} pipeline…`
  const before = { ...probe.contexts }
  try {
    pipeline =
      options.path === 'webgpu'
        ? await (await import('./webgpu-pipeline.ts')).createWebGPUPipeline(options, probe, camera.mirrored)
        : await (await import('./webgl-pipeline.ts')).createWebGLPipeline(options, probe, camera.mirrored)
  } catch (err) {
    console.error('[gl-share] pipeline creation failed:', err)
    errorRow.textContent = `pipeline unavailable: ${err instanceof Error ? err.message : String(err)}`
    camera.dispose()
    camera = undefined
    startButton.disabled = false
    return
  }
  pipelineContexts = describeContexts(diff(probe.contexts, before))
  stage.append(pipeline.canvas)
  stopButton.disabled = checkButton.disabled = false
  errorRow.textContent = `running (${camera.width}×${camera.height}, ${camera.mirrored ? 'mirrored' : 'not mirrored'})`
  perf?.setInfo({
    delegate: options.delegate,
    videoWidth: camera.width,
    videoHeight: camera.height,
    renderWidth: camera.width,
    renderHeight: camera.height,
    maxFaces: options.face === 'off' ? 0 : 1,
  })

  const p = pipeline
  let shownAt = -Infinity
  scheduler = new FrameScheduler(video, (frame) => {
    resetTimings(timings)
    const c = probe.counters
    const readbacks = c.readbacks
    const readbackBytes = c.readbackBytes
    const syncCalls = c.syncCalls
    const maskReads = c.maskReads
    const t = performance.now()
    p.frame(video, frame.now, timings)
    const pipelineMs = performance.now() - t

    sample.now = frame.now
    sample.mediaTime = frame.mediaTime
    // Built-in columns: "tracking" = MediaPipe inference (segmentation, plus face tracking when enabled).
    sample.trackingMs = (Number.isNaN(timings.segmentationMs) ? 0 : timings.segmentationMs) + (Number.isNaN(timings.trackingMs) ? 0 : timings.trackingMs)
    sample.renderMs = Number.isNaN(timings.renderMs) ? 0 : timings.renderMs
    sample.faces = timings.faces
    extra.segmentationMs = timings.segmentationMs
    extra.transferMs = timings.transferMs
    extra.uploadMs = timings.uploadMs
    extra.pipelineMs = pipelineMs
    extra.readbacks = c.readbacks - readbacks
    extra.readbackBytes = c.readbackBytes - readbackBytes
    extra.syncCalls = c.syncCalls - syncCalls
    extra.maskReads = c.maskReads - maskReads
    perf?.record(sample)

    if (frame.now - shownAt > 500) {
      shownAt = frame.now
      // Recomputed: some contexts are created lazily (three's WebGPU canvas context on the first render).
      pipelineContexts = describeContexts(diff(probe.contexts, before))
      maskRow.textContent = String(p.details().mask || '—')
      contextsRow.textContent = `${describeContexts(probe.contexts)} created by the page; this pipeline: ${pipelineContexts}`
      const perFrame = c.readbacks - readbacks + c.maskReads - maskReads
      big.textContent = `${options.path}${options.path === 'webgpu' ? `/${options.copy}` : ''} · readbacks this frame: ${perFrame}`
      big.classList.toggle('bad', perFrame > 0)
    }
  })
  scheduler.start()
}

startButton.addEventListener('click', () => void start())
stopButton.addEventListener('click', stop)
checkButton.addEventListener('click', () => {
  if (!pipeline) return
  checkRow.textContent = 'running on the next frame…'
  void pipeline.check().then((verdict) => {
    checkRow.textContent = verdict
    perf?.note(`alignment check: ${verdict}`)
    console.info('[gl-share]', verdict)
  })
})
pathRow.textContent = `${options.path} (delegate ${options.delegate}${options.path === 'shared' ? `, reset ${options.reset}` : ''}${options.path === 'webgpu' ? `, copy ${options.copy}` : ''}, face ${options.face})`
