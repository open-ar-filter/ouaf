/**
 * Engine page (`/engine.html`): drives `@ouaf/core`'s public API, the way a host would. Used by the browser tests
 * (`window.ouaf`) and by the layer-type work as a harness, until the playground app (#36) is rebuilt on the engine.
 */
import {
  BACKEND_STORE_PREFIX,
  CameraSource,
  VideoFileSource,
  createDefaultFaceTracker,
  createEngine,
  memorySource,
  throttlePlugin,
  type Engine,
  type EngineStats,
  type LiteRtTrackerOptions,
  type PerformanceEvent,
  type TrackingThrottle,
  type VideoSource,
} from '@ouaf/core'
import * as core from '@ouaf/core'
import { renderDemos } from './demos.ts'
import { renderParams } from './params-panel.ts'
import { createPerfPanel } from './perf-panel.ts'
import { playgroundPlugin } from './test-plugin.ts'

declare global {
  interface Window {
    /** Test hook: the engine, the `@ouaf/core` module and what the engine reported. */
    ouaf?: {
      engine: Engine
      core: typeof core
      memorySource: typeof memorySource
      stats: EngineStats | undefined
      frames: number
      warnings: string[]
      errors: string[]
      events: Array<{ name: string; faceId: number; side: string | null }>
      /** `performance` events (spec §16.3), oldest first. */
      performance: PerformanceEvent[]
      /** Simulated tracking time (`?throttle=<ms>`); set `ms` to change it live. */
      throttle: TrackingThrottle
    }
  }
}

const params = new URLSearchParams(location.search)
const SOURCE = /^[\w-]+$/.test(params.get('source') ?? '') ? params.get('source') : null
const FILTERS = params.getAll('filter')
const MAX_FACES = Math.min(16, Math.max(1, Math.trunc(Number(params.get('maxFaces'))) || 1))
/** `?seed=N`: fixes the seed of random choices (spec §12.5). */
const SEED = /^\d+$/.test(params.get('seed') ?? '') ? Number(params.get('seed')) : undefined
const canvas = document.getElementById('canvas') as HTMLCanvasElement
const video = document.getElementById('video') as HTMLVideoElement
const log = document.getElementById('log') as HTMLPreElement
const startButton = document.getElementById('start') as HTMLButtonElement

/**
 * `?throttle=<ms>`: simulated tracking time per result (slow device, #90), changeable live in the panel. The
 * throttled tracker is always installed (0 = off), so that the panel can turn it on without reloading.
 */
const throttle: TrackingThrottle = { ms: Math.max(0, Number(params.get('throttle')) || 0) }
/**
 * Device adaptation (spec §16): `?adapt=1` / `?adapt=0`. Default: on for the camera or with `?throttle`, off for the
 * test clips otherwise, so that the browser tests do not depend on the speed of the machine.
 */
const ADAPT = params.has('adapt') ? params.get('adapt') !== '0' : !SOURCE || throttle.ms > 0
/** `?signals`: compares the expression signals from blendshapes and from the geometry, live. */
const SIGNALS = params.has('signals')
/**
 * `?backend=litert|GPU|CPU` forces the tracker's backend (our LiteRT.js pipeline in a worker, MediaPipe's GPU or CPU
 * delegate on the main thread); `?backend=measure` forgets the backend measured before on this device (spec §16.4),
 * so that the benchmark runs again. Default: the cached choice, else measured.
 */
const BACKEND = params.get('backend') ?? undefined
/** LiteRT.js tracker fallbacks, to test them: `?crop=canvas` (2D-canvas crops), `?transfer=bitmap` (`ImageBitmap`). */
const LITERT: LiteRtTrackerOptions = {
  ...(params.get('crop') === 'canvas' ? { crop: 'canvas' } : {}),
  ...(params.get('transfer') === 'bitmap' ? { transfer: 'bitmap' } : {}),
}
if (BACKEND === 'measure') {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(BACKEND_STORE_PREFIX)) localStorage.removeItem(key)
  } catch {
    // No storage: nothing was cached.
  }
}
const perf = createPerfPanel(throttle, { signals: SIGNALS })
log.after(perf.element)

const engine = createEngine({
  canvas,
  assetsBaseUrl: new URL('./', document.baseURI).href,
  maxFaces: MAX_FACES,
  plugins: [playgroundPlugin, throttlePlugin(throttle, createDefaultFaceTracker({ liteRt: LITERT })), ...(SIGNALS ? [perf.signalsPlugin] : [])],
  adaptation: ADAPT,
  ...(BACKEND && BACKEND !== 'measure' ? { trackerBackend: BACKEND } : {}),
  ...(SEED === undefined ? {} : { seed: SEED }),
})
perf.attach(engine)
const hook = {
  engine,
  core,
  memorySource,
  stats: undefined as EngineStats | undefined,
  frames: 0,
  warnings: [] as string[],
  errors: [] as string[],
  events: [] as Array<{ name: string; faceId: number; side: string | null }>,
  performance: perf.events,
  throttle,
}
window.ouaf = hook

const lines = new Map<string, string>()
const show = (key: string, value: string) => {
  lines.set(key, value)
  log.textContent = [...lines].map(([k, v]) => `${k}: ${v}`).join('\n')
}
engine.on('stats', (s) => {
  hook.stats = s
  hook.frames += Math.round(s.fps)
  show('stats', `${s.fps.toFixed(1)} fps, tracking ${s.trackingHz.toFixed(1)} Hz, ${s.faces} face(s), ${s.frameMs.toFixed(2)} ms/frame, ${s.width}×${s.height}, ${s.tracker ?? 'no tracker'}`)
})
engine.on('warning', (w) => {
  hook.warnings.push(w.message)
  show(`warning ${hook.warnings.length}`, w.message)
})
engine.on('error', (e) => {
  hook.errors.push(e.message)
  show(`error ${hook.errors.length}`, e.message)
})
show('plugins', [...engine.plugins].map(([n, v]) => `${n}@${v}`).join(', '))

async function start(): Promise<void> {
  startButton.disabled = true
  let source: VideoSource
  try {
    source = SOURCE
      ? await VideoFileSource.open(new URL(`test-media/${SOURCE}.mp4`, document.baseURI).href, { video, mirror: params.get('mirror') === '1' })
      : await CameraSource.open({ facingMode: 'user', video })
    await engine.setSource(source)
    show('source', SOURCE ? `test-media/${SOURCE}.mp4` : 'camera')
    // A folder URL, or a `.ouaf` package URL (`?filter=/filters/crown.ouaf`).
    for (const url of FILTERS) await addFilter(url, url)
  } catch (error) {
    hook.errors.push(String(error))
    show('error', error instanceof Error ? error.message : String(error))
    startButton.disabled = false
  }
}

/** Adds a filter on top of the stack, logs its expression events and refreshes the params panel. */
async function addFilter(src: string | File, label: string): Promise<void> {
  const handle = await engine.addFilter(src)
  show(`filter ${handle.index}`, `${handle.id} (${label})${handle.warnings.length ? ` — ${handle.warnings.join('; ')}` : ''}`)
  // Expression events delivered to the filter (spec §13): counts and the last one.
  const counts = new Map<string, number>()
  handle.on('expression', (e) => {
    perf.expression(e)
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1)
    hook.events.push(e)
    const last = `${e.name}${e.side ? ` (${e.side})` : ''}, face ${e.faceId}`
    show(`events ${handle.id}`, `last: ${last} — ${[...counts].map(([n, c]) => `${n} ×${c}`).join(', ')}`)
  })
  renderParams(document.getElementById('params') as HTMLElement, engine.filters, (message) => show('param error', message))
}

/** Opens `.ouaf` packages chosen in the file picker or dropped on the page (read locally, nothing is uploaded). */
async function openPackages(files: Iterable<File>): Promise<void> {
  for (const file of files) {
    try {
      await addFilter(file, file.name)
    } catch (error) {
      hook.errors.push(String(error))
      show('error', error instanceof Error ? error.message : String(error))
    }
  }
}
const picker = document.getElementById('open') as HTMLInputElement
picker.addEventListener('change', () => {
  void openPackages([...(picker.files ?? [])]).finally(() => (picker.value = ''))
})
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
})
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files.length) return
  e.preventDefault()
  void openPackages(e.dataTransfer.files)
})

// Diagnostic: the media time the engine receives for each frame (it drives smoothing, prediction and transitions).
let lastMediaTime = -1
let stuckFrames = 0
const onVideoFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
  stuckFrames = meta.mediaTime === lastMediaTime ? stuckFrames + 1 : 0
  lastMediaTime = meta.mediaTime
  show('media time', `${meta.mediaTime.toFixed(3)} s${stuckFrames > 5 ? ` (not advancing: fine for a camera, the engine times live sources with the clock)` : ''}`)
  video.requestVideoFrameCallback(onVideoFrame)
}
if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onVideoFrame)

startButton.addEventListener('click', () => void start())

// The demo filters (#37): open by default when the page has no filter to show.
const demos = document.getElementById('demos') as HTMLDetailsElement
demos.open = FILTERS.length === 0
renderDemos(demos.querySelector('div')!).catch((error: unknown) => show('demos', error instanceof Error ? error.message : String(error)))

// Outputs (#33): the last photo or video, as a download link (nothing leaves the page).
const output = document.getElementById('output') as HTMLAnchorElement
const recordButton = document.getElementById('record') as HTMLButtonElement
const offer = (blob: Blob, name: string) => {
  if (output.href) URL.revokeObjectURL(output.href)
  output.href = URL.createObjectURL(blob)
  output.download = `${name}.${blob.type.includes('mp4') ? 'mp4' : blob.type.includes('webm') ? 'webm' : (blob.type.split('/')[1] ?? 'bin')}`
  output.textContent = `${output.download} (${blob.type}, ${Math.round(blob.size / 1024)} KB)`
  output.hidden = false
}
const outputError = (error: unknown) => show('output error', error instanceof Error ? error.message : String(error))
document.getElementById('snapshot')!.addEventListener('click', () => engine.snapshot().then((b) => offer(b, 'snapshot'), outputError))
let recording: ReturnType<Engine['record']> | undefined
recordButton.addEventListener('click', () => {
  if (recording) {
    void recording.stop().then((b) => offer(b, 'recording'), outputError)
    recording = undefined
    recordButton.textContent = 'Record'
    return
  }
  try {
    recording = engine.record()
    recordButton.textContent = 'Stop'
    show('recording', recording.mimeType)
  } catch (error) {
    outputError(error)
  }
})
if (params.has('autostart') && SOURCE) void start()
