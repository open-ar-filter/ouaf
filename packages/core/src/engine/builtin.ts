/**
 * Built-in plugins, installed by default (`EngineOptions.builtins`): the face tracker and the v1 layer types, each as
 * its own plugin.
 *
 * Built-in plugins are official and declare no vocabulary: the v1 vocabulary is already in `createRegistry()`.
 */
import { createFaceTracker, trackerInputHeight, trackerInputWidth } from '../face-tracker.ts'
import type { Delegate, FaceFrame, FaceTracker, TrackerInput } from '../face.ts'
import { BackendBenchmark, currentUserAgent, readStoredBackend, type StoredBackend } from './backend-choice.ts'
import type { BackendInfo, FaceTrackerImpl, FrameTracker, OuafPlugin, TrackerConfig, TrackerEnv } from './plugin.ts'
import { canvasPlugin } from '../layers/canvas/index.ts'
import { colorPlugin } from '../layers/color/index.ts'
import { shaderPlugin } from '../layers/shader/index.ts'
import { modelPlugin } from '../layers/model/index.ts'
import { stickerPlugin } from '../layers/sticker/index.ts'
import { textPlugin } from '../layers/text/index.ts'
import { warpPlugin } from '../layers/warp/index.ts'

const DELEGATES: readonly Delegate[] = ['GPU', 'CPU']

/**
 * Face tracker on MediaPipe tasks-vision, on the main thread (phase 0 tracker). PROVISIONAL: the default tracker
 * becomes our LiteRT.js pipeline in a worker (docs/decisions/face-runtime.md, tracking-worker.md); this one stays as
 * the fallback where the worker cannot run.
 *
 * Backend (spec §16.4): the host's choice (`EngineOptions.trackerBackend`: `CPU` or `GPU`), else the one measured
 * before on this device and browser (local cache), else GPU first and, on the first frames of a live source, a
 * benchmark of the GPU and CPU delegates that keeps the faster one and caches it.
 *
 * Files, under `assetsBaseUrl`: `mediapipe/wasm/vision_wasm_internal.{js,wasm}` and `models/face_landmarker.task`.
 */
export const mediaPipeFaceTracker: FaceTrackerImpl = {
  id: 'mediapipe',
  cost: { typicalMs: 20 },
  async create(config, env) {
    // Blendshapes are always computed: switching them needs a graph rebuild that stalls the main thread for about a
    // second, for no measurable gain (#83: MediaPipe CPU 35.6 ms without, 35.7 ms with). The engine ignores them while
    // the governor has dropped them.
    const open = (delegate: Delegate) =>
      createFaceTracker({
        maxFaces: config.maxFaces,
        wasmBaseUrl: new URL('mediapipe/wasm/', env.assetsBaseUrl).href,
        modelUrl: new URL('models/face_landmarker.task', env.assetsBaseUrl).href,
        blendshapes: true,
        delegate,
        onWarning: env.warn,
      })
    const forced = DELEGATES.find((d) => d === env.backend?.toUpperCase())
    if (env.backend !== undefined && !forced) env.warn(`Unknown tracker backend "${env.backend}" (MediaPipe: CPU or GPU): choosing it by measuring.`)
    const stored = forced ? undefined : readStoredBackend(env.store?.get(), DELEGATES)
    const tracker = await open(forced ?? (stored?.backend as Delegate | undefined) ?? 'GPU')
    let backend: BackendInfo
    let measure: (() => Promise<FaceTracker>) | undefined
    if (forced) backend = { name: tracker.delegate, source: 'forced' }
    else if (stored && stored.backend === tracker.delegate) backend = { name: tracker.delegate, source: 'cached', ...(stored.measuredMs ? { measuredMs: stored.measuredMs } : {}) }
    else if (tracker.delegate === 'CPU') backend = { name: 'CPU', source: 'only' } // no GPU here: nothing to compare
    else {
      backend = { name: 'GPU', source: 'pending' }
      measure = () => open('CPU')
    }
    return new MediaPipeFrameTracker(tracker, config, env, backend, measure)
  },
}

/**
 * `FrameTracker` over the synchronous MediaPipe tracker. `configure` changes the number of faces through
 * `FaceTracker.reconfigure` (asynchronous: a `track` meanwhile waits for it) and the analysis resolution by drawing
 * each frame into a smaller canvas first (spec §16.2). `benchmark` measures the CPU delegate against the GPU one on
 * live frames, the two taking turns, and keeps the faster (spec §16.4).
 */
export class MediaPipeFrameTracker implements FrameTracker {
  readonly #env: TrackerEnv
  #tracker: FaceTracker
  #config: TrackerConfig
  #backend: BackendInfo
  /** Opens the other delegate for the benchmark; `#measure` until it is started. */
  readonly #open: (() => Promise<FaceTracker>) | undefined
  #measure: (() => Promise<FaceTracker>) | undefined
  #bench: { readonly run: BackendBenchmark; readonly trackers: Map<string, FaceTracker> } | undefined
  #measuring = false
  /** Reconfiguration in flight: `track` waits for it. */
  #pending: Promise<void> | undefined
  #canvas: OffscreenCanvas | HTMLCanvasElement | undefined
  #context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null
  #disposed = false

  constructor(tracker: FaceTracker, config: TrackerConfig, env: TrackerEnv, backend?: BackendInfo, measure?: () => Promise<FaceTracker>) {
    this.#tracker = tracker
    this.#config = config
    this.#env = env
    this.#backend = backend ?? { name: tracker.delegate, source: 'only' }
    this.#open = measure
    this.#measure = measure
  }

  get description(): string {
    const b = this.#backend
    const ms = b.measuredMs ? Object.entries(b.measuredMs).map(([name, v]) => `${name} ${v.toFixed(1)} ms`).join(', ') : ''
    const how = this.#measuring ? 'measuring CPU and GPU' : b.source === 'measured' || b.source === 'cached' ? `${b.source}${ms ? `: ${ms}` : ''}` : b.source
    return `MediaPipe ${b.name} (${how}), main thread`
  }

  get backend(): BackendInfo {
    return this.#backend
  }

  get measuring(): boolean {
    return this.#measuring
  }

  benchmark(): void {
    const measure = this.#measure
    if (!measure || this.#disposed) return
    this.#measure = undefined
    this.#measuring = true
    measure().then(
      (other) => {
        if (this.#disposed || !this.#measuring) return other.dispose()
        if (other.delegate === this.#tracker.delegate) {
          // The CPU delegate fell back to... the same one: nothing to compare.
          other.dispose()
          this.#measuring = false
          return
        }
        const trackers = new Map([
          [this.#tracker.delegate, this.#tracker],
          [other.delegate, other],
        ])
        this.#bench = { run: new BackendBenchmark([...trackers.keys()]), trackers }
      },
      (error: unknown) => {
        this.#measuring = false
        this.#backend = { name: this.#tracker.delegate, source: 'only' }
        this.#env.warn('Could not open the CPU face tracker to compare it with the GPU one; keeping the GPU.', error)
      },
    )
  }

  track(input: TrackerInput, timestampMs: number, mediaTime: number, out: FaceFrame): void | Promise<void> {
    // After a still image the landmarker is in IMAGE mode: switch back once (asynchronous), then track.
    if (this.#pending || this.#tracker.runningMode !== 'VIDEO') {
      return (this.#pending ?? Promise.resolve())
        .then(() => this.#tracker.setRunningMode('VIDEO'))
        .then(() => this.#detect(input, timestampMs, mediaTime, out))
    }
    this.#detect(input, timestampMs, mediaTime, out)
  }

  trackImage(input: TrackerInput, mediaTime: number, out: FaceFrame): Promise<void> {
    this.#abortBenchmark()
    return (this.#pending ?? Promise.resolve()).then(() => this.#tracker.detectImage(input, mediaTime, out))
  }

  reset(): Promise<void> {
    // A file source starts: its results must not depend on which backend took which frame (spec §12.5).
    this.#abortBenchmark()
    return (this.#pending ?? Promise.resolve()).then(() => this.#tracker.resetState())
  }

  configure(config: TrackerConfig): void {
    this.#config = config
    if (this.#bench) return // applied to the winner when the benchmark ends
    const tracker = this.#tracker
    if (!this.#pending && config.maxFaces === tracker.numFaces) return
    const done: Promise<void> = (this.#pending ?? Promise.resolve())
      .then(() => tracker.reconfigure({ numFaces: config.maxFaces }))
      .catch((error: unknown) => this.#env.warn('Could not reconfigure the face tracker; it keeps its previous settings.', error))
      .finally(() => {
        if (this.#pending === done) this.#pending = undefined
      })
    this.#pending = done
  }

  dispose(): void {
    this.#disposed = true
    for (const t of this.#bench?.trackers.values() ?? []) if (t !== this.#tracker) t.dispose()
    this.#bench = undefined
    this.#tracker.dispose()
    this.#canvas = undefined
    this.#context = null
  }

  #detect(input: TrackerInput, timestampMs: number, mediaTime: number, out: FaceFrame): void {
    const bench = this.#bench
    const name = bench?.run.next
    const tracker = (name && bench?.trackers.get(name)) || this.#tracker
    const start = bench ? performance.now() : 0
    const width = trackerInputWidth(input)
    const height = trackerInputHeight(input)
    const scale = this.#config.analysisScale
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    if (scale >= 1 || width === 0 || height === 0 || !this.#draw(input, w, h)) tracker.detect(input, timestampMs, mediaTime, out)
    else {
      tracker.detect(this.#canvas!, timestampMs, mediaTime, out)
      // Landmarks are normalized: the result keeps the frame's size (spec §16.2).
      out.width = width
      out.height = height
    }
    if (bench && name) {
      bench.run.add(name, performance.now() - start, out.count > 0)
      if (bench.run.done) this.#finishBenchmark()
    }
  }

  #finishBenchmark(): void {
    const bench = this.#bench!
    const winner = bench.run.winner!
    const measuredMs = bench.run.medians
    for (const [name, t] of bench.trackers) if (name !== winner) t.dispose()
    this.#tracker = bench.trackers.get(winner)!
    this.#bench = undefined
    this.#measuring = false
    this.#backend = { name: winner, source: 'measured', measuredMs }
    const stored: StoredBackend = { backend: winner, measuredMs, userAgent: currentUserAgent(), at: new Date().toISOString() }
    this.#env.store?.set(stored)
    this.configure(this.#config)
  }

  /** Stops a benchmark in progress, keeping the backend it started with; it may run again on a later live source. */
  #abortBenchmark(): void {
    const bench = this.#bench
    if (!bench && !this.#measuring) return
    for (const t of bench?.trackers.values() ?? []) if (t !== this.#tracker) t.dispose()
    this.#bench = undefined
    this.#measuring = false
    if (this.#backend.source === 'pending') this.#measure = this.#open
  }

  /** Draws `input` into the analysis canvas at `w` × `h`; false without a 2D canvas. */
  #draw(input: TrackerInput, w: number, h: number): boolean {
    if (!this.#canvas) {
      if (typeof OffscreenCanvas !== 'undefined') this.#canvas = new OffscreenCanvas(w, h)
      else if (typeof document !== 'undefined') this.#canvas = document.createElement('canvas')
      this.#context = (this.#canvas?.getContext('2d') ?? null) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
    }
    const canvas = this.#canvas
    const ctx = this.#context
    if (!canvas || !ctx) return false
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    ctx.drawImage(input, 0, 0, w, h)
    return true
  }
}

export const facePlugin: OuafPlugin = {
  name: 'face',
  version: '1.0.0',
  official: true,
  setup(api) {
    api.registerTracker(mediaPipeFaceTracker)
  },
}

/** The plugins `createEngine` installs by default, in order. */
export function builtinPlugins(): OuafPlugin[] {
  return [
    facePlugin,
    textPlugin,
    stickerPlugin,
    modelPlugin,
    warpPlugin,
    colorPlugin,
    shaderPlugin,
    canvasPlugin,
  ]
}
