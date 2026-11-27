/// <reference types="vite/client" />
/**
 * Engine page (`/engine.html`), the playground (#36): drives `@ouaf/core`'s public API, the way a host would, and
 * reloads the filters of `filters/` when their files change. Used by the browser tests (`window.ouaf`).
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
  type FilterHandle,
  type LiteRtTrackerOptions,
  type OuafPlugin,
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
      /**
       * Raw tracking results so far, and the media time of the frame the last one describes (live sources: the clock
       * time of its frame callback, s): a test can wait for results of a frame it presented.
       */
      results: { count: number; time: number }
      /** Hot reloads of filters done (#36): a test can wait for the next one. */
      reloads: number
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
/**
 * LiteRT.js tracker options, to test its fallbacks: `?crop=canvas` (2D-canvas crops), `?transfer=bitmap` (`ImageBitmap`),
 * `?queue=0` (one frame at a time: no frame queued in the worker while it runs), `?frames=element` (camera frames
 * captured from the `<video>`, not read from the track in the worker), `?readback=sync` (each WebGL2 crop read back
 * before its landmark model runs; default: while the model runs on the previous frame, results one frame late).
 */
const LITERT: LiteRtTrackerOptions = {
  ...(params.get('crop') === 'canvas' ? { crop: 'canvas' } : {}),
  ...(params.get('transfer') === 'bitmap' ? { transfer: 'bitmap' } : {}),
  ...(params.get('queue') === '0' ? { queue: false } : {}),
  ...(params.get('frames') === 'element' ? { frames: 'element' } : {}),
  ...(params.get('readback') === 'sync' ? { readback: 'sync' } : {}),
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

/** Counts the tracking results (`window.ouaf.results`), from a landmark modifier: it sees each raw result once. */
const results = { count: 0, time: -1 }
const resultsPlugin: OuafPlugin = {
  name: 'playground-results',
  version: '1.0.0',
  setup(api) {
    api.registerLandmarkModifier({
      id: 'playground-results',
      modify(faces) {
        results.count++
        results.time = faces.mediaTime
      },
    })
  },
}

const engine = createEngine({
  canvas,
  assetsBaseUrl: new URL('./', document.baseURI).href,
  maxFaces: MAX_FACES,
  plugins: [playgroundPlugin, resultsPlugin, throttlePlugin(throttle, createDefaultFaceTracker({ liteRt: LITERT })), ...(SIGNALS ? [perf.signalsPlugin] : [])],
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
  results,
  reloads: 0,
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

/** How long a start step may take before the page says it is stuck (a camera still held by another tab or app). */
const STEP_WARNING_MS = 10_000

async function start(): Promise<void> {
  startButton.disabled = true
  let source: VideoSource
  // Each step of the start is shown, and one that hangs says so: a camera that never opens otherwise left the page
  // silently on "no tracker".
  let step = ''
  let since = 0
  const begin = (name: string) => {
    step = name
    since = performance.now()
    show('start', `${name}…`)
  }
  const watchdog = setInterval(() => {
    const waited = performance.now() - since
    if (step && waited > STEP_WARNING_MS) show('start', `${step}: no answer after ${Math.round(waited / 1000)} s (is the camera used by another tab or app? reload the page)`)
  }, 1000)
  try {
    begin(SOURCE ? `opening test-media/${SOURCE}.mp4` : 'opening the camera')
    source = SOURCE
      ? await VideoFileSource.open(new URL(`test-media/${SOURCE}.mp4`, document.baseURI).href, { video, mirror: params.get('mirror') === '1' })
      : await CameraSource.open({ facingMode: 'user', video })
    begin('starting the engine on the source')
    await engine.setSource(source)
    show('source', SOURCE ? `test-media/${SOURCE}.mp4` : 'camera')
    // A folder URL, or a `.ouaf` package URL (`?filter=/filters/crown.ouaf`).
    for (const url of FILTERS) {
      begin(`loading the filter ${url} (and starting face tracking)`)
      await addFilter(url, url)
    }
    step = ''
    show('start', 'done')
  } catch (error) {
    step = ''
    show('start', `failed: ${error instanceof Error ? error.message : String(error)}`)
    hook.errors.push(String(error))
    show('error', error instanceof Error ? error.message : String(error))
    startButton.disabled = false
  } finally {
    clearInterval(watchdog)
  }
}

/** Where each filter of the stack was loaded from (a URL, or a file opened in the page): what a hot reload reloads. */
const sources = new Map<FilterHandle, string | File>()

/**
 * Changes of the stack run one after the other: a hot reload waits for the filters still loading (their handle, and
 * so their URL, is known only once `engine.addFilter` resolves), and two quick saves do not reload at the same time.
 */
let stackTasks: Promise<unknown> = Promise.resolve()
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = stackTasks.then(task, task)
  stackTasks = run.catch(() => {})
  return run
}

/** Adds a filter on top of the stack, logs its expression events and refreshes the params panel. */
function addFilter(src: string | File, label: string): Promise<void> {
  return serial(() => loadFilter(src, label))
}

async function loadFilter(src: string | File, label: string): Promise<void> {
  let handle: FilterHandle
  try {
    handle = await engine.addFilter(src)
  } catch (error) {
    if (typeof src === 'string') await showReport(src, error)
    throw error
  }
  hideReport()
  wire(handle, src, label)
  renderParams(document.getElementById('params') as HTMLElement, engine.filters, (message) => show('param error', message))
}

/** Logs a filter of the stack and its expression events (spec §13): counts and the last one. */
function wire(handle: FilterHandle, src: string | File, label: string): void {
  sources.set(handle, src)
  show(`filter ${handle.index}`, `${handle.id} (${label})${handle.warnings.length ? ` — ${handle.warnings.join('; ')}` : ''}`)
  const counts = new Map<string, number>()
  handle.on('expression', (e) => {
    perf.expression(e)
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1)
    hook.events.push(e)
    const last = `${e.name}${e.side ? ` (${e.side})` : ''}, face ${e.faceId}`
    show(`events ${handle.id}`, `last: ${last} — ${[...counts].map(([n, c]) => `${n} ×${c}`).join(', ')}`)
  })
}

// Hot reload (#36, dev server only): the server sends `ouaf:filter-change` with the URL of a filter whose files
// changed (`vite.config.ts`, `devFilters`); `filter.ts` folders are packed by the server on each load.
const banner = document.getElementById('banner') as HTMLPreElement
const pathOf = (url: string) => new URL(url, document.baseURI).pathname

/** Shows why `url` failed to load: the validation report of its folder when the dev server has one. */
async function showReport(url: string, error: unknown): Promise<void> {
  let text = error instanceof Error ? error.message : String(error)
  if (import.meta.hot && !pathOf(url).endsWith('.ouaf')) {
    try {
      const report = (await (await fetch(`${import.meta.env.BASE_URL}__ouaf__/report?filter=${encodeURIComponent(pathOf(url))}`)).json()) as { ok: boolean; text: string }
      if (!report.ok) text = report.text
    } catch {
      // No report: the engine's error says enough.
    }
  }
  banner.textContent = `${url} did not load; the previous version stays on screen.\n${text}`
  banner.hidden = false
}
const hideReport = () => {
  banner.hidden = true
  banner.textContent = ''
}

/**
 * Reloads every filter of the stack loaded from `url`: the whole stack is loaded again and swapped in one frame
 * (`engine.setFilters`), the source keeps playing. The parameter values set in the page and the enabled states are
 * kept (a value the new version refuses is dropped); scripts restart. On failure the stack stays as it was and the
 * banner says why. A stack with a filter the page did not load (added through `window.ouaf.engine`) is left alone.
 */
async function reload(url: string): Promise<void> {
  const stack = engine.filters.slice()
  const changed = (h: FilterHandle) => {
    const src = sources.get(h)
    return typeof src === 'string' && pathOf(src) === pathOf(url)
  }
  if (!stack.some(changed)) return
  if (stack.some((h) => !sources.has(h))) {
    show('reload', `${url} changed; not reloaded: a filter of the stack was added outside the page`)
    return
  }
  let fresh: FilterHandle[]
  try {
    // The others keep their values; the changed ones get theirs back one by one, below.
    fresh = await engine.setFilters(stack.map((h) => (changed(h) ? { src: sources.get(h)! } : { src: sources.get(h)!, params: h.params })))
  } catch (error) {
    await showReport(url, error)
    return
  }
  hideReport()
  for (const [i, old] of stack.entries()) {
    const handle = fresh[i]!
    if (changed(old)) {
      for (const [name, value] of Object.entries(old.params)) {
        // Only the values set in the page: a default the author just changed must show.
        const def = old.manifest.params?.[name]
        if (def && 'default' in def && JSON.stringify(def.default) === JSON.stringify(value)) continue
        try {
          handle.setParam(name, value, { transition: 0 })
        } catch {
          // Removed, or no longer valid in the new version: the new default applies.
        }
      }
    }
    handle.enabled = old.enabled
    const src = sources.get(old)!
    sources.delete(old)
    wire(handle, src, typeof src === 'string' ? src : src.name)
  }
  renderParams(document.getElementById('params') as HTMLElement, engine.filters, (message) => show('param error', message))
  hook.reloads++
  show('reload', `${url} at ${new Date().toLocaleTimeString()}`)
}

if (import.meta.hot) {
  // Editors write a file in several steps: one reload per burst.
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  import.meta.hot.on('ouaf:filter-change', ({ url }: { url: string }) => {
    clearTimeout(pending.get(url))
    pending.set(url, setTimeout(() => {
      pending.delete(url)
      void serial(() => reload(url))
    }, 150))
  })
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
