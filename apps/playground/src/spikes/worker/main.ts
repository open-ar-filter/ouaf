/**
 * Spike #6 page: the playground pipeline (camera → tracking → renderer → perf panel and recorder) with tracking
 * either on the main thread or in a worker, plus the measurements needed to compare them.
 *
 * URL options:
 * - `mode=worker` (default) | `main`;
 * - `transfer=videoframe` (default) | `bitmap` — how the frame reaches the worker (`new VideoFrame(video)` or
 *   `createImageBitmap(video)`);
 * - `load=N` — N ms of synthetic busy work on the main thread per frame (a busy host page), default 0;
 * - `maxFaces=N` (1–8, default 2), `delegate=CPU`, and the renderer options of the main page (`anchors=0`, `res`…).
 */
import {
  CameraError,
  CameraSource,
  FrameScheduler,
  VERSION,
  createDistribution,
  createFaceFrame,
  createFrameSample,
  type FacingMode,
} from '@ouaf/core'
import { createPerf } from '../../perf.ts'
import { createRenderer, type PlaygroundRenderer } from '../../render.ts'
import { requestedDelegate } from '../../tracking.ts'
import { busyWait, COLUMNS, observeLongTasks, RollingExtras, SampleExtras, startLagProbe, type Column } from './metrics.ts'
import { createVariant, type Mode, type TrackingVariant, type Transfer } from './variants.ts'

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing #${id}`)
  return el as T
}

// --- Options -----------------------------------------------------------------------------------------------------
const params = new URLSearchParams(location.search)
const MODE: Mode = params.get('mode') === 'main' ? 'main' : 'worker'
const TRANSFER: Transfer = params.get('transfer') === 'bitmap' ? 'bitmap' : 'videoframe'
const LOAD_MS = Math.min(200, Math.max(0, Number(params.get('load')) || 0))
const MAX_FACES = Math.min(8, Math.max(1, Math.trunc(Number(params.get('maxFaces'))) || 2))
const DELEGATE = requestedDelegate()

// --- Status ------------------------------------------------------------------------------------------------------
const status = $<HTMLDListElement>('status')
const startButton = $<HTMLButtonElement>('start')
const flipButton = $<HTMLButtonElement>('flip')
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

/** Links to the other variants, keeping the other URL options. */
function variantLinks() {
  const nav = $<HTMLElement>('variants')
  const variants: Array<[string, Record<string, string | null>]> = [
    ['main thread', { mode: 'main', transfer: null }],
    ['worker · VideoFrame', { mode: 'worker', transfer: 'videoframe' }],
    ['worker · ImageBitmap', { mode: 'worker', transfer: 'bitmap' }],
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
    const current = set.mode === MODE && (MODE === 'main' || set.transfer === TRANSFER)
    if (current) a.setAttribute('aria-current', 'page')
    nav.append(a)
  }
}
variantLinks()

row('@ouaf/core', VERSION)
row('Secure context', window.isSecureContext ? 'yes' : 'no — camera unavailable, open the https:// URL')
row('Variant', `${MODE}${MODE === 'worker' ? ` · transfer ${TRANSFER}` : ''} · load ${LOAD_MS} ms · maxFaces ${MAX_FACES}`)
const trackerRow = row('Tracker', 'not started')
const cameraRow = row('Camera', 'not started')
const telemetryRow = row('MediaPipe metrics', 'none yet (first request after about a minute)')
const warningsRow = row('Warnings', '—')

const warnings: string[] = []
function warn(message: string) {
  console.warn(`[spike #6] ${message}`)
  warnings.push(message)
  warningsRow.textContent = warnings.slice(-3).join(' · ')
  perf?.note(message)
}

let telemetry = 'none'
function onTelemetry(where: string, outcome: string, detail: string) {
  const next = `${outcome} (${where}, ${detail})`
  // The header and the <meta> policy both report the same refusal.
  if (next === telemetry) return
  telemetry = next
  telemetryRow.textContent = telemetry
  perf?.note(`MediaPipe metrics ${telemetry}`)
}
// Main mode: the page's own CSP reports the blocked request.
document.addEventListener('securitypolicyviolation', (e) => {
  if (e.blockedURI.includes('odml.pa.googleapis.com')) onTelemetry('page', 'blocked', `CSP ${e.effectiveDirective}`)
})

// --- Measurements ------------------------------------------------------------------------------------------------
const extras = new SampleExtras()
const live = new RollingExtras()
// Run for the whole life of the page, like the perf panel.
startLagProbe((lag) => extras.maxNext('lagMs', lag))
const stopLongTasks = observeLongTasks((ms) => extras.addNext('longTaskMs', ms))

let variant: TrackingVariant | undefined
const perf = createPerf({
  columns: COLUMNS,
  app: () => ({
    spike: '6-worker-vs-main',
    mode: MODE,
    transfer: variant?.transfer ?? (MODE === 'worker' ? TRANSFER : 'none'),
    loadMs: LOAD_MS,
    requestedDelegate: DELEGATE,
    videoFrame: typeof VideoFrame === 'function',
    offscreenCanvas: typeof OffscreenCanvas === 'function',
    longTasks: stopLongTasks !== undefined,
    telemetry,
    warnings: warnings.join(' | '),
  }),
})
if (perf) $<HTMLDivElement>('perf').append(perf.element)

// --- Live panel (phone-readable) ---------------------------------------------------------------------------------
const PANEL_STYLE = `
.spike6 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 12px; margin-top: 6px;
  padding-top: 6px; border-top: 1px solid GrayText; font-size: 15px; }
.spike6 b { font-weight: 600; opacity: .7; margin-right: 4px; }
.spike6 .wide { grid-column: 1 / -1; }
`
const panel = document.createElement('div')
panel.className = 'spike6'
const cells = new Map<string, HTMLElement>()
for (const [key, label, wide] of [
  ['variant', 'variant', true],
  ['inference', 'infer', false],
  ['latency', 'latency', false],
  ['age', 'age', false],
  ['sent', 'sent/s', false],
  ['dropped', 'drop', false],
  ['missed', 'missed/s', false],
  ['lag', 'lag p95/max', false],
  ['long', 'longtask', false],
  ['load', 'load', false],
] as const) {
  const div = document.createElement('div')
  if (wide) div.className = 'wide'
  const b = document.createElement('b')
  b.textContent = label
  const span = document.createElement('span')
  span.textContent = '—'
  div.append(b, span)
  panel.append(div)
  cells.set(key, span)
}
const legend = document.createElement('div')
legend.className = 'wide'
legend.style.opacity = '.7'
legend.textContent =
  'track = main-thread tracking time (worker: capture + post + receive) · infer, latency, age: p50/p95 ms · ' +
  'drop = frames not sent, worker busy · missed = camera frames without a callback'
panel.append(legend)
const style = document.createElement('style')
style.textContent = PANEL_STYLE
perf?.element.append(style, panel)

const dist = createDistribution()
const fmt = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '—')
function pair(column: Column, now: number) {
  live.compute(column, now, dist)
  return `${fmt(dist.p50)}/${fmt(dist.p95)}`
}
function setCell(key: string, text: string) {
  const c = cells.get(key)
  if (c) c.textContent = text
}
function refreshPanel() {
  const now = performance.now()
  setCell('variant', `${MODE}${variant?.transfer ? ` · ${variant.transfer}` : ''} · ${variant?.delegate ?? '?'}`)
  setCell('inference', pair('inferenceMs', now))
  const latency = pair('latencyMs', now)
  live.compute('cameraLatencyMs', now, dist)
  setCell('latency', Number.isFinite(dist.p50) ? `${latency} · cam ${fmt(dist.p50)}` : latency)
  setCell('age', pair('resultAgeMs', now))
  const d = live.compute('dropped', now, dist)
  const perSecond = (n: number) => (d.spanMs > 0 ? (n * 1000) / d.spanMs : NaN)
  // Samples with dropped = 0 were sent to the tracker.
  setCell('sent', fmt(perSecond(d.samples - d.sum)))
  setCell('dropped', d.samples > 0 ? `${fmt((100 * d.sum) / d.samples, 0)} %` : '—')
  const m = live.compute('missed', now, dist)
  setCell('missed', Number.isFinite(dist.mean) ? fmt(perSecond(m.sum)) : 'n/a')
  live.compute('lagMs', now, dist)
  setCell('lag', `${fmt(dist.p95)}/${fmt(dist.max)}`)
  const l = live.compute('longTaskMs', now, dist)
  setCell('long', stopLongTasks ? `${fmt(perSecond(l.sum), 0)} ms/s` : 'n/a')
  setCell('load', `${LOAD_MS} ms/frame`)
}
setInterval(refreshPanel, 250)

// --- Pipeline ----------------------------------------------------------------------------------------------------
let camera: CameraSource | undefined
let scheduler: FrameScheduler | undefined
let renderer: PlaygroundRenderer | undefined
let facingMode: FacingMode = 'user'
let starting: Promise<TrackingVariant | undefined> | undefined
const faces = createFaceFrame(MAX_FACES)
const sample = createFrameSample()
sample.extra = extras.values

/** Creates the tracking variant once; it survives camera switches. */
function ensureVariant(): Promise<TrackingVariant | undefined> {
  starting ??= (async () => {
    trackerRow.textContent = `loading (${MODE})…`
    try {
      const v = await createVariant(MODE, {
        maxFaces: MAX_FACES,
        delegate: DELEGATE,
        transfer: TRANSFER,
        onWarning: warn,
        onTelemetry: (outcome, detail) => onTelemetry('worker', outcome, detail),
      })
      trackerRow.textContent = `ready: ${v.mode}, ${v.delegate}${v.transfer ? `, ${v.transfer}` : ''}`
      variant = v
      return v
    } catch (err) {
      console.error('[spike #6] tracker initialization failed:', err)
      const hint = /face model/.test(String(err)) ? ' — run `npm run fetch-models`' : ''
      trackerRow.textContent = `unavailable: ${err instanceof Error ? err.message : String(err)}${hint}`
      return undefined
    }
  })()
  return starting
}

function stop() {
  scheduler?.dispose()
  renderer?.dispose()
  camera?.dispose()
  scheduler = undefined
  renderer = undefined
  camera = undefined
  video.hidden = true
  flipButton.disabled = stopButton.disabled = true
  startButton.disabled = false
  cameraRow.textContent = 'stopped'
}

async function start() {
  stop()
  startButton.disabled = true
  cameraRow.textContent = 'opening…'
  try {
    camera = await CameraSource.open({ facingMode, video })
  } catch (err) {
    cameraRow.textContent = err instanceof CameraError ? `${err.code}: ${err.message}` : String(err)
    startButton.disabled = false
    return
  }
  flipButton.disabled = stopButton.disabled = false
  const settings = camera.stream.getVideoTracks()[0]?.getSettings()
  cameraRow.textContent = `${camera.width}×${camera.height} @ ${settings?.frameRate?.toFixed(1) ?? '?'} fps, ${camera.mirrored ? 'mirrored' : 'not mirrored'}`

  const tracking = await ensureVariant()

  renderer = createRenderer(camera, { maxFaces: MAX_FACES })
  if (renderer) stage.append(renderer.element)
  else {
    video.hidden = false
    video.classList.toggle('mirrored', camera.mirrored)
  }

  perf?.setInfo({
    delegate: tracking?.delegate,
    videoWidth: camera.width,
    videoHeight: camera.height,
    renderWidth: renderer?.width ?? camera.width,
    renderHeight: renderer?.height ?? camera.height,
    maxFaces: MAX_FACES,
  })
  live.reset()
  faces.count = 0

  let lastPresented: number | undefined
  scheduler = new FrameScheduler(video, (frame) => {
    // Values of asynchronous events since the previous frame (worker result, lag probe, long tasks).
    extras.begin()
    if (stopLongTasks && Number.isNaN(extras.values.longTaskMs)) extras.set('longTaskMs', 0)
    if (frame.presentedFrames !== undefined) {
      if (lastPresented !== undefined) extras.set('missed', Math.max(0, frame.presentedFrames - lastPresented - 1))
      lastPresented = frame.presentedFrames
    }
    sample.now = frame.now
    sample.mediaTime = frame.mediaTime

    // Tracking: detect (main) or capture + post, plus handling the previous result (worker).
    sample.trackingMs = tracking ? tracking.frame(video, frame, faces, extras) : 0
    sample.faces = faces.count
    if (tracking && Number.isFinite(tracking.resultFrameNow)) extras.set('resultAgeMs', frame.now - tracking.resultFrameNow)

    const t = performance.now()
    renderer?.render(faces)
    sample.renderMs = performance.now() - t

    // A busy host page (`?load=N`).
    busyWait(LOAD_MS)

    perf?.record(sample)
    live.record(frame.now, extras.values)
  })
  scheduler.start()
}

startButton.addEventListener('click', () => void start())
stopButton.addEventListener('click', stop)
flipButton.addEventListener('click', () => {
  facingMode = facingMode === 'user' ? 'environment' : 'user'
  void start()
})
