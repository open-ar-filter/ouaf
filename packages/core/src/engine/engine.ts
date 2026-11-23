/**
 * The public engine API (#11): `createEngine`, sources, the filter stack, events, plugins.
 *
 * ```ts
 * const engine = createEngine({ canvas, assetsBaseUrl: '/ouaf/' })
 * await engine.setSource(await CameraSource.start({ facingMode: 'user' }))
 * const crown = await engine.addFilter('/filters/crown/', { size: 1.2 })
 * crown.setParam('style', 'flowers')
 * engine.on('stats', (s) => console.log(s.fps, s.trackingHz))
 * ```
 *
 * One frame (spec §7, §9): new camera frame → submit it to tracking (eager, shared by the stack) → apply the queued
 * param changes of every filter → update every layer with the latest tracking result → render the stages.
 *
 * Sources (#32) come in two regimes (spec §12.1, §12.5):
 * - **live**: a camera, a playing `<video>` (`VideoFileSource`), a canvas the host draws into. Frames are rendered as
 *   they come, with the latest tracking result; random choices are seeded randomly.
 * - **file**: a still image, an `OfflineVideoSource`, frames given with `pushFrame`. Every frame waits for its own
 *   tracking result, time is the media time, and the seed is fixed: every run gives the same images.
 */
import { resolveBuiltin } from '@ouaf/builtins'
import { DEFAULT_SCRIPT_USES, createRegistry, extendRegistry, type ScriptUse, type SpecRegistry, type Stage } from '@ouaf/spec'
import { BLENDSHAPES_STRIDE, createFaceFrame, type FaceFrame } from '../face.ts'
import { FrameScheduler, type VideoFrameInfo } from '../scheduler.ts'
import type { VideoSource } from '../video-source.ts'
import { OfflineVideoSource } from '../offline-video.ts'
import { assertReadable, describeImage, isCanvas, isFrameImage, isSecurityError, taintedError, type FrameImage } from '../frame-image.ts'
import { checkSeed, deriveSeed, FILE_SOURCE_SEED, randomSeed, SeededRandom } from '../random.ts'
import type { FitMode } from '../viewport.ts'
import { FaceIdentityTracker, FaceSmoother } from '../anchoring/index.ts'
import { GeometrySignals, blendshapeSignals, createSignals, maxEyeSignals, readExpressionSignals } from '../expressions/index.ts'
import { DeviceGovernor, type Capability, type GovernorMeasures, type GovernorTuning, type PerformanceState } from './governor.ts'
import { BACKEND_STORE_PREFIX, localBackendStore } from './backend-choice.ts'
import { FaceAnchors } from './anchor-provider.ts'
import { CORE_LOADERS, memorySource, urlSource, type AssetLoader, type FilterSource, type LoaderKind, type PreloadedAssets } from './assets.ts'
import { fetchPackage, isPackageUrl, packageSource } from './package.ts'
import { builtinPlugins } from './builtin.ts'
import { Compositor, type StagePasses } from './compositor.ts'
import { Emitter } from './emitter.ts'
import { messagePayload } from './messages.ts'
import { Outputs, type OutputStreamOptions, type RecordOptions, type Recording, type SnapshotOptions } from './outputs.ts'
import { GpuContextLostError, IncompatibleSourceError, OuafError, disposedError } from './errors.ts'
import { FilterInstance, bindingParams, createHandle, loadFilter, scriptSeed, type FilterHandle, type FilterLoadEnv } from './filter.ts'
import type { FrameContext, LayerContext, LayerInstance, LayerTypeImpl, ObjectLayer, PassLayer } from './layer-type.ts'
import { FaceBindingData } from '../bindings/index.ts'
import { ParamStore } from '../params/index.ts'
import type {
  EventSourceImpl,
  FaceTrackerImpl,
  LandmarkModifier,
  OuafPlugin,
  PluginApi,
  RenderPassImpl,
  SourceImpl,
} from './plugin.ts'
import { TrackingHub } from './tracking.ts'
import { FrameDataBuilder, type FrameDataSource } from '../script/frame-data.ts'
import { ScriptHost } from '../script/host.ts'
import { openSandbox } from '../script/sandbox.ts'
import { scriptFonts } from '../layers/canvas/script-fonts.ts'
import { scriptImages } from '../layers/canvas/script-images.ts'

/**
 * Version used for compatibility checks (spec §17): the format level this engine implements. Filters declare a
 * range on it (`"engine": "^1"`, the default). Distinct from the package version.
 */
export const ENGINE_VERSION = '1.0.0'

/**
 * When the GPU context is lost, filters whose author shader was drawn within this delay (ms) are disabled (spec §11).
 * A GPU hang is detected by the browser's watchdog seconds after the draw that caused it.
 */
export const CONTEXT_LOSS_WINDOW_MS = 5000

export interface EngineOptions {
  /** Canvas the engine renders into (it creates a WebGL2 context on it). Size it with CSS. */
  canvas: HTMLCanvasElement | OffscreenCanvas
  /**
   * Base URL of the engine's self-hosted files: tracking models and wasm, built-in fonts and LUTs. Nothing is fetched
   * from anywhere else (docs/privacy.md). Relative URLs resolve against the page. Built-in resources (`builtin:…`) are
   * the `assets/` folder of `@ouaf/builtins`, served under `<assetsBaseUrl>builtins/` (`builtins/fonts/sans.woff2`).
   * The Draco decoder of the model layer is `<assetsBaseUrl>draco/draco_wasm_wrapper.js` and `draco_decoder.wasm`
   * (from `three/examples/jsm/libs/draco/gltf/`), fetched only when a filter has a Draco-compressed model.
   */
  assetsBaseUrl: string
  /** Maximum number of tracked faces (spec §5.4). Default: 1. */
  maxFaces?: number
  /** Extra plugins, installed after the built-in ones. */
  plugins?: readonly OuafPlugin[]
  /** Install the built-in plugins (face tracker, v1 layer types). Default: true. */
  builtins?: boolean
  /** How the source is fitted into the canvas. Default: `cover`. */
  fit?: FitMode
  /** Internal resolution relative to the source frame size. Default: 1. */
  scale?: number
  /** Fixed internal resolution (set both or neither). */
  width?: number
  height?: number
  /** `fetch` used for filters and assets (tests, custom caching). Default: the global `fetch`. */
  fetch?: typeof fetch
  /**
   * Seed of every random choice (spec §12.5: `f.random()`, `{ pick, by: "random" }`), an integer from 0 to 2³² − 1,
   * e.g. to reproduce a bug seen on a live source. Default: a fixed seed for file sources (image, offline video,
   * `pushFrame`), a random one at each activation for live sources.
   */
  seed?: number
  /** Opens the sandbox of a filter's script (tests). Default: a sandboxed iframe running a Worker (spec §15.1). */
  openSandbox?: (label: string) => ReturnType<typeof openSandbox>
  /**
   * Device adaptation (spec §16): with live sources, drop optional capabilities when face tracking is too slow, and
   * hide the face filters below the 12 Hz floor (`on('performance')`). Default: true. `false` keeps everything on
   * whatever the rate (tests, benchmarks); an object tunes the governor (`DEFAULT_GOVERNOR_TUNING`).
   */
  adaptation?: boolean | Partial<GovernorTuning>
  /**
   * Inference backend of the face tracker (built-in tracker, case-insensitive: `litert` for our LiteRT.js pipeline in
   * a worker, `GPU` or `CPU` for MediaPipe's delegates on the main thread). Default: chosen by measuring them on the
   * first frames of a live source, then cached on the device per engine version (`localStorage`, never transmitted;
   * spec §16.4). Until then LiteRT.js is tried first (MediaPipe GPU with `maxFaces` > 1).
   */
  trackerBackend?: string
}

/** Analysis resolution while the governor has dropped it (spec §16.2), relative to the frame. */
export const REDUCED_ANALYSIS_SCALE = 0.5
/** A pause between frames longer than this (ms) restarts the measure of the tracking rate (background tab…). */
const GOVERNOR_PAUSE_MS = 1500
/**
 * The first results of a tracker are slow (model warm-up: a worker tracker gave 7.4 Hz for its first results on the
 * Redmi Note 11S): when the governor starts, the results of this first period (ms) are not counted (spec §16.3).
 */
const TRACKER_WARMUP_MS = 1000
/** The governor is consulted at most this often (ms). */
const GOVERNOR_PERIOD_MS = 100
/**
 * Heavy stack (#34): the engine's main-thread time per frame above this share of the frame interval, for
 * `HEAVY_STACK_WINDOWS` stats windows in a row, gives one warning per stack change.
 */
const HEAVY_STACK_LOAD = 0.5
const HEAVY_STACK_WINDOWS = 3

/** How the engine runs a source (spec §12.1): see `Engine.regime`. */
export type SourceRegime = 'live' | 'file'

export interface SourceOptions {
  /** Mirror the image (canvas, still image). Default: false. `VideoSource` and `OfflineVideoSource` carry their own. */
  mirror?: boolean
}

/** `engine.on('sourceEnd')`: an `OfflineVideoSource` without `loop` rendered its last frame. */
export interface SourceEndEvent {
  /** Frames rendered in this run. */
  frames: number
  /** Media time of the last frame (s). */
  time: number
}

/** `engine.on('stats')`: emitted about once per second while frames are rendered (none while no source plays). */
export interface EngineStats {
  /** Rendered frames per second over the last second. */
  fps: number
  /** Completed tracking results per second (spec §16.1), 0 without face tracking. */
  trackingHz: number
  /** Faces in the latest tracking result. */
  faces: number
  /**
   * Mean time spent in the engine per frame on the main thread (ms): params, layer updates and render submission
   * (GPU time not included). Compare with the frame interval, `1000 / fps`: the frame budget (#34).
   */
  frameMs: number
  /** Longest `frameMs` of a frame over the last second. */
  frameMsMax: number
  /** Mean time per frame spent by a tracker that runs on the main thread (ms; 0 for a tracker in a worker). */
  trackMs: number
  /**
   * Mean time from a frame's submission to its tracking result (ms, `NaN` before the first): what one result costs.
   * The tracking rate is at most `1000 / pipelineMs`; below it, the gap is time spent waiting for frames.
   */
  pipelineMs: number
  /** The tracker's own steps, mean ms per result (`FrameTracker.timings`), when it reports them. */
  trackerTimings: Readonly<Record<string, number>> | undefined
  /** Tracker backend in use, when tracking runs. */
  tracker: string | undefined
  /** Internal resolution (px) the engine renders at. */
  width: number
  height: number
}

/**
 * `engine.on('performance')` (spec §16.3), emitted by the device governor at each change of `state` or `dropped`;
 * `engine.performance` gives the current one.
 */
export interface PerformanceEvent {
  /** `ok`; `degraded`: optional capabilities dropped; `unsupported`: the face filters are hidden (raw camera). */
  state: PerformanceState
  /** Optional capabilities dropped (spec §16.2), in drop order: `blendshapes`, `extraFaces`, `resolution`. */
  dropped: readonly Capability[]
  /** Tracking rate measured (Hz) when the state changed. */
  trackingHz: number
}

export interface EngineWarning {
  message: string
  /** Filter concerned, when there is one. */
  filter?: string
}

/** `engine.on('filter:<name>')`: an event emitted by a filter's script (`f.emit`, #26). */
export interface FilterEvent {
  filter: FilterHandle
  data: unknown
}

/**
 * Events of `engine.on(name, listener)`. Listeners are called synchronously, in subscription order; a throwing listener
 * does not stop the others (its error is reported as a `warning`, or with `console.error` for a `warning` listener).
 * `dispose()` removes every listener.
 */
export type EngineEvents = {
  /** Rendering and tracking rates, about once per second while frames are rendered. */
  stats: EngineStats
  /** Something the engine worked around (a filter's script was slow, a resource fell back…). */
  warning: EngineWarning
  /** Asynchronous failures (tracking, a frame that threw). Synchronous API errors are thrown instead. */
  error: Error
  performance: PerformanceEvent
  sourceEnd: SourceEndEvent
} & {
  /**
   * `f.emit(name, data)` from the script of any filter of the stack (spec §12.4), with the filter's handle. The same
   * message reaches `handle.on('filter:<name>', (data) => …)` of that filter.
   */
  [K in `filter:${string}`]: FilterEvent
}

/**
 * A filter to load:
 * - a URL (`string` or `URL`, relative to the page): of a `.ouaf` package when its path ends with `.ouaf`
 *   (`/filters/crown.ouaf`), else of a filter folder or of its `manifest.json` (development, spec §3);
 * - a `.ouaf` package in memory: a `Blob` or `File` (file picker, drop), an `ArrayBuffer` or a `Uint8Array`;
 * - a `FilterSource` (`memorySource`, `urlSource`, `packageSource`, or the host's own).
 *
 * A package served from a URL without the `.ouaf` extension is loaded by fetching it as a `Blob` first, or with
 * `fetchPackage(url)`.
 */
export type FilterInput = string | URL | Blob | ArrayBuffer | Uint8Array | FilterSource

export interface FilterSpec {
  src: FilterInput
  params?: Readonly<Record<string, unknown>>
}

/**
 * What `setSource` accepts: a `VideoSource` (`CameraSource`, `VideoFileSource`) or a playing `<video>` (live), a
 * canvas (`HTMLCanvasElement`, `OffscreenCanvas`, read on every animation frame: live), a still image
 * (`HTMLImageElement`, `ImageBitmap`, `VideoFrame`: file), an `OfflineVideoSource` (file), or anything a source plugin
 * accepts.
 */
export type SourceInput = VideoSource | HTMLVideoElement | FrameImage | OfflineVideoSource | unknown

/** What drives the frames of the current source. Async loops stop when `Engine.#feed` is no longer theirs. */
type Feed =
  /** `owned`: the engine created the source (a source plugin) and disposes it when it stops. */
  | { readonly kind: 'video'; readonly source: VideoSource; readonly scheduler: FrameScheduler; readonly owned: boolean }
  | { readonly kind: 'canvas'; readonly canvas: HTMLCanvasElement | OffscreenCanvas; raf: number }
  | { readonly kind: 'still'; readonly image: FrameImage; raf: number }
  | { readonly kind: 'offline'; readonly source: OfflineVideoSource }
  | { readonly kind: 'push' }

/** Frames between two checks that a live canvas is still readable (it can become tainted at any time). */
const CANVAS_CHECK_FRAMES = 60

export class Engine {
  readonly maxFaces: number
  readonly assetsBaseUrl: string
  /** Validation registry, including the vocabulary of installed plugins (for editors and the CLI). */
  readonly registry: SpecRegistry

  // A throwing listener becomes a `warning`, except a throwing `warning` listener: reporting it as a warning would
  // call it again, without end.
  #events = new Emitter<EngineEvents>((error, event) => {
    if (event === 'warning') console.error('[ouaf] A warning listener threw:', error)
    else this.#warn(`An event listener threw: ${String(error)}`)
  })
  #compositor: Compositor
  #outputs = new Outputs()
  #anchors: FaceAnchors
  /** Stable face ids (spec §5.4), smoothing and prediction of the tracking results (#13). */
  #identity: FaceIdentityTracker
  #smoother: FaceSmoother
  /** Smoothed latest result, and the same predicted to the displayed frame (what layers and bindings read). */
  #smoothed: FaceFrame
  #drawn: FaceFrame
  #seenResults = 0
  /** Expression signals of the latest result, shared by every filter's detector (spec §13). */
  #signals: Float32Array
  /** Expression signals from the landmark geometry while blendshapes are dropped (spec §13, §16.2). */
  #geometry: GeometrySignals
  #geometrySignals: Float32Array
  #bindingData = new FaceBindingData(createFaceFrame(1))
  #tracking: TrackingHub
  #fetch: typeof fetch
  #plugins = new Map<string, OuafPlugin>()
  #layerTypes = new Map<string, LayerTypeImpl>()
  #loaders = new Map<LoaderKind, AssetLoader>()
  #trackers: FaceTrackerImpl[] = []
  #sources: SourceImpl[] = []
  #modifiers: LandmarkModifier[] = []
  #eventSources: EventSourceImpl[] = []
  #renderPasses: LayerInstance[] = []
  #stack: FilterInstance[] = []
  #handles = new Map<FilterInstance, FilterHandle>()
  #nextKey = 1
  #feed: Feed | undefined
  /** Regime of the current (or last) source; seeds follow it. */
  #regime: SourceRegime = 'live'
  #seedOption: number | undefined
  /** A video source is a camera: frames are timed with the clock, not the media time. */
  #live = false
  /** `pushFrame` calls run one after the other. */
  #pushChain: Promise<void> = Promise.resolve()
  /** Media time of the last frame of a file source (NaN: none yet), to detect a new run (loop, seek back). */
  #lastTime = Number.NaN
  #scratch: OffscreenCanvasRenderingContext2D | null | undefined
  #passes: { [S in 'background' | 'face' | 'warp' | 'color']: PassLayer[] } = { background: [], face: [], warp: [], color: [] }
  #objects: ObjectLayer[] = []
  #frame: { -readonly [K in keyof FrameContext]: FrameContext[K] }
  /** What scripts read their `frame.faces` from (spec §12.4). */
  #scriptData: FrameDataSource
  /** Overrides how a script's sandbox is opened (tests). */
  #openSandbox: typeof openSandbox
  #lastNow = -1
  #statsStart = 0
  #statsFrames = 0
  #statsMs = 0
  #statsMaxMs = 0
  #statsTrackMs = 0
  /** Main-thread time of the tracker call of the frame being drawn (ms). */
  #frameTrackMs = 0
  /** Stats windows in a row over the heavy-stack load, and whether this stack was warned about (#34). */
  #heavyWindows = 0
  #heavyWarned = false
  /** Device governor (spec §16); undefined when `adaptation` is off. */
  #governor: DeviceGovernor | undefined
  #performance: PerformanceEvent = { state: 'ok', dropped: [], trackingHz: 0 }
  /** Capabilities the enabled stack may lose (recomputed on stack changes). */
  #droppable = new Set<Capability>()
  /** `#droppable` less what the tracker cannot shed (`FrameTracker.sheds`): what the governor may drop. */
  #governable = new Set<Capability>()
  /** Faces looked for while the extra faces are dropped: the faces tracked when they were. */
  #reducedFaces = 1
  #governedAt = Number.NaN
  readonly #governorMeasures: GovernorMeasures = {}
  readonly #recovery = new Float64Array(2)
  /** End of the tracker's warm-up when the governor (re)starts (NaN: none). */
  #warmupUntil = Number.NaN
  #disposed = false
  #contextLost = false
  #onContextLost = (event: Event) => this.#contextLostHandler(event)
  #onContextRestored = () => this.#contextRestoredHandler()

  constructor(options: EngineOptions) {
    const maxFaces = options.maxFaces ?? 1
    if (!Number.isInteger(maxFaces) || maxFaces < 1 || maxFaces > 16) throw new RangeError(`maxFaces must be an integer from 1 to 16, got ${maxFaces}`)
    this.maxFaces = maxFaces
    this.assetsBaseUrl = new URL(options.assetsBaseUrl.endsWith('/') ? options.assetsBaseUrl : `${options.assetsBaseUrl}/`, globalThis.location?.href).href
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.#seedOption = options.seed === undefined ? undefined : checkSeed(options.seed)
    this.registry = createRegistry()
    this.#compositor = new Compositor({ canvas: options.canvas, fit: options.fit, scale: options.scale, width: options.width, height: options.height })
    this.#compositor.capture = this.#outputs
    this.#anchors = new FaceAnchors(createFaceFrame(1), this.#compositor.camera)
    this.#identity = new FaceIdentityTracker({ maxFaces })
    this.#smoother = new FaceSmoother(this.#identity)
    this.#smoothed = createFaceFrame(maxFaces)
    this.#drawn = createFaceFrame(maxFaces)
    this.#signals = createSignals(maxFaces)
    this.#geometry = new GeometrySignals(maxFaces)
    this.#geometrySignals = createSignals(maxFaces)
    for (const loader of CORE_LOADERS) for (const kind of loader.kinds) this.#loaders.set(kind, loader)

    for (const plugin of options.builtins === false ? [] : builtinPlugins()) this.use(plugin)
    for (const plugin of options.plugins ?? []) this.use(plugin)

    const impl = this.#trackers.at(-1)
    this.#tracking = new TrackingHub({
      impl,
      env: {
        assetsBaseUrl: this.assetsBaseUrl,
        warn: (message) => this.#warn(message),
        ...(options.trackerBackend ? { backend: options.trackerBackend } : {}),
        // The measured backend choice stays on the device (spec §16.4, §15).
        store: localBackendStore(`${BACKEND_STORE_PREFIX}${ENGINE_VERSION}:${impl?.id ?? 'none'}`),
      },
      maxFaces,
      modifiers: this.#modifiers,
      onError: (error) => this.#error(error),
    })
    // GPU context loss (spec §11, §15.5). three.js listens too: it stops drawing while lost and rebuilds its GPU
    // resources on restore.
    options.canvas.addEventListener('webglcontextlost', this.#onContextLost as EventListener)
    options.canvas.addEventListener('webglcontextrestored', this.#onContextRestored)
    this.#frame = {
      time: 0,
      now: 0,
      dt: 0,
      faces: this.#tracking.faces,
      anchors: this.#anchors,
      width: this.#compositor.width,
      height: this.#compositor.height,
      mirrored: false,
    }
    const engine = this
    this.#scriptData = {
      get faces() {
        return engine.#drawnFaces
      },
      anchors: this.#anchors,
      bindingData: this.#bindingData,
      camera: this.#compositor.camera,
      get videoToClip() {
        return engine.#compositor.videoToClip
      },
      // The rendered image is what is displayed (the host keeps its aspect ratio), cover crop included.
      get aspect() {
        const c = engine.#compositor
        return c.width > 0 && c.height > 0 ? c.width / c.height : 1
      },
    }
    this.#openSandbox = options.openSandbox ?? openSandbox
    const adaptation = options.adaptation ?? true
    if (adaptation !== false) this.#governor = new DeviceGovernor(adaptation === true ? {} : adaptation)
  }

  /**
   * Device adaptation now (spec §16): `ok`, `degraded` (optional capabilities dropped) or `unsupported` (face
   * filters hidden), as last reported by `on('performance')`, with the current tracking rate.
   */
  get performance(): PerformanceEvent {
    return { ...this.#performance, trackingHz: this.#tracking.rateHz }
  }

  get disposed(): boolean {
    return this.#disposed
  }

  /** The GPU context is lost: nothing is drawn until the browser restores it. */
  get contextLost(): boolean {
    return this.#contextLost
  }

  /** The canvas rendered into. */
  get canvas(): HTMLCanvasElement | OffscreenCanvas {
    return this.#compositor.renderer.domElement
  }

  /** The filter stack, in order. */
  get filters(): readonly FilterHandle[] {
    return this.#stack.map((f) => this.#handles.get(f)!)
  }

  /** Installed plugins (name → version), built-ins included. */
  get plugins(): ReadonlyMap<string, string> {
    return new Map([...this.#plugins].map(([name, p]) => [name, p.version]))
  }

  /**
   * Subscribes to an engine event (see `EngineEvents`): `stats`, `warning`, `error`, `performance`, `sourceEnd`,
   * `filter:<name>`. Returns a function that unsubscribes. After `dispose()` it does nothing (no event fires any more).
   */
  on<K extends keyof EngineEvents & string>(event: K, listener: (payload: EngineEvents[K]) => void): () => void {
    if (this.#disposed) return () => {}
    return this.#events.on(event, listener)
  }

  /** Unsubscribes a listener given to `on`. */
  off<K extends keyof EngineEvents & string>(event: K, listener: (payload: EngineEvents[K]) => void): void {
    this.#events.off(event, listener)
  }

  /**
   * Installs a plugin (spec §14): merges its vocabulary into validation and registers its implementations. Throws
   * `OuafError('plugin-conflict')` when the plugin is already installed or redefines existing vocabulary. Install
   * plugins before adding the filters that need them; trackers must be installed at creation (`options.plugins`).
   */
  use(plugin: OuafPlugin): this {
    this.#assertAlive()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(plugin.name)) throw new OuafError('plugin-conflict', `Invalid plugin name "${plugin.name}".`)
    if (this.#plugins.has(plugin.name)) throw new OuafError('plugin-conflict', `Plugin "${plugin.name}" is already installed.`)
    try {
      extendRegistry(this.registry, { plugin: plugin.name, version: plugin.version, ...plugin.vocabulary }, { official: plugin.official ?? false })
    } catch (cause) {
      throw new OuafError('plugin-conflict', cause instanceof Error ? cause.message : String(cause), { cause })
    }
    const conflict = (what: string, name: string) => new OuafError('plugin-conflict', `Plugin "${plugin.name}" registers ${what} "${name}", which is already registered.`)
    const pendingPasses: RenderPassImpl[] = []
    const api: PluginApi = {
      engineVersion: ENGINE_VERSION,
      registerLayerType: (impl) => {
        if (this.#layerTypes.has(impl.type)) throw conflict('layer type', impl.type)
        if (!this.registry.layers.has(impl.type)) {
          throw new OuafError('plugin-conflict', `Plugin "${plugin.name}" implements layer type "${impl.type}" without declaring it in its vocabulary.`)
        }
        this.#layerTypes.set(impl.type, impl)
      },
      registerTracker: (impl) => {
        if (this.#tracking) throw new OuafError('plugin-conflict', `Plugin "${plugin.name}": trackers must be installed when the engine is created (options.plugins).`)
        this.#trackers.push(impl) // the last one installed wins: a host plugin replaces the built-in tracker
      },
      registerAssetLoader: (loader) => {
        for (const kind of loader.kinds) this.#loaders.set(kind, loader) // later plugins override (e.g. KTX2-aware images)
      },
      registerSource: (impl) => void this.#sources.unshift(impl), // newest first
      registerLandmarkModifier: (modifier) => void this.#modifiers.push(modifier),
      registerRenderPass: (impl) => void pendingPasses.push(impl),
      registerEventSource: (impl) => void this.#eventSources.push(impl),
    }
    plugin.setup?.(api)
    this.#plugins.set(plugin.name, plugin)
    for (const impl of pendingPasses) void this.#createRenderPass(impl)
    return this
  }

  /**
   * Regime of the current source (spec §12.1): `live` (camera, playing video, canvas: frames are rendered as they
   * come) or `file` (still image, offline video, `pushFrame`: each frame waits for its tracking, seeds are fixed).
   */
  get regime(): SourceRegime {
    return this.#regime
  }

  /**
   * Sets the image source (see `SourceInput`). The engine renders and tracks every new frame of it. A source passed
   * by the host stays the host's: the engine does not dispose it (not even in `dispose()`: stop a `CameraSource`
   * yourself), and a still image or canvas must stay readable while it is the source. A source that a source plugin
   * creates is the engine's: it is disposed when it stops being the source. Throws `IncompatibleSourceError`:
   * unsupported input, disposed source, the engine's own canvas, an image without pixels, a tainted (cross-origin)
   * image or canvas.
   */
  async setSource(input: SourceInput, options: SourceOptions = {}): Promise<void> {
    this.#assertAlive()
    if (input instanceof OfflineVideoSource) {
      if (input.disposed) throw new IncompatibleSourceError('The offline video source has been disposed.')
      this.#begin({ kind: 'offline', source: input }, 'file', undefined, input.mirrored)
      input.restart()
      void this.#runOffline(this.#feed!, input)
      return
    }
    if (isFrameImage(input)) {
      const image = await this.#checkImage(input, true)
      this.#assertAlive()
      if (isCanvas(image)) {
        const feed = { kind: 'canvas' as const, canvas: image, raf: 0 }
        this.#begin(feed, 'live', image, options.mirror ?? false)
        this.#runCanvas(feed)
      } else {
        const feed = { kind: 'still' as const, image, raf: 0 }
        this.#begin(feed, 'file', image, options.mirror ?? false)
        void this.#runStill(feed)
      }
      return
    }
    let source: VideoSource | undefined
    let owned = false
    if (isVideoSource(input)) source = input
    else if (typeof HTMLVideoElement !== 'undefined' && input instanceof HTMLVideoElement) source = videoElementSource(input)
    else {
      const impl = this.#sources.find((s) => s.accepts(input))
      if (!impl) {
        throw new IncompatibleSourceError(
          `Unsupported source: ${describeSource(input)}. Pass a VideoSource (CameraSource, VideoFileSource), a <video>, a canvas, an image (HTMLImageElement, ImageBitmap, VideoFrame) or an OfflineVideoSource.`,
        )
      }
      source = await impl.create(input)
      owned = true
      if (this.#disposed) {
        source.dispose()
        throw disposedError('The engine')
      }
    }
    if (source.disposed) throw new IncompatibleSourceError('The source has been disposed.')
    const scheduler = new FrameScheduler(source.video, (frame) => this.#onVideoFrame(frame), { onError: (e) => this.#error(e) })
    this.#begin({ kind: 'video', source, scheduler, owned }, 'live', source.video, source.mirrored)
    this.#live = typeof MediaStream !== 'undefined' && source.video.srcObject instanceof MediaStream
    scheduler.start()
  }

  /** Stops rendering the current source (the canvas keeps its last image). */
  clearSource(): void {
    this.#stopFeed()
    this.#compositor.setSource(undefined, false)
  }

  /**
   * Renders one frame given by the host at media time `time` (s): the file regime (spec §12.1), for frames the host
   * produces itself (its own decoder, a canvas animation rendered offline). The frame is tracked, then rendered; the
   * promise resolves once it is drawn, and the host may then close or reuse it. Calls are processed in order; a time
   * earlier than the previous one starts a new run (faces are tracked afresh). The first call replaces the current
   * source. Rejects with `IncompatibleSourceError` (the engine's own canvas, no pixels, tainted) or `RangeError`.
   */
  pushFrame(frame: FrameImage, time: number): Promise<void> {
    this.#assertAlive()
    if (!isFrameImage(frame)) return Promise.reject(new IncompatibleSourceError(`pushFrame needs a canvas, an image, an ImageBitmap or a VideoFrame, got ${describeSource(frame)}.`))
    if (!Number.isFinite(time)) return Promise.reject(new RangeError(`time must be a finite number of seconds, got ${time}`))
    const run = this.#pushChain.then(async () => {
      this.#assertAlive()
      const image = await this.#checkImage(frame, false)
      if (this.#feed?.kind !== 'push') {
        this.#begin({ kind: 'push' }, 'file', undefined, false)
      }
      await this.#fileFrame(this.#feed!, image, time)
    })
    this.#pushChain = run.catch(() => {})
    return run
  }

  /**
   * A photo of the next rendered frame (#33), as the user sees it (mirroring included) without the overlay layers
   * marked `excludeFromCapture`, at the internal render size. PNG by default. Resolves once a frame is rendered: not
   * while there is no source or a video is paused. Rejects if the engine is disposed first.
   */
  snapshot(options?: SnapshotOptions): Promise<Blob> {
    this.#assertAlive()
    return this.#outputs.snapshot(options)
  }

  /**
   * Records the output in real time with `MediaRecorder` (#33), like `snapshot` (excluded overlays left out). H.264
   * MP4 where the browser can encode it, else WebM (`RECORDING_TYPES`); `audio` adds tracks the host opened. Stop it
   * with `recording.stop()`, which resolves with the video. Throws `OuafError` (`unsupported`) without
   * `MediaRecorder` or for a type the browser cannot record.
   */
  record(options?: RecordOptions): Recording {
    this.#assertAlive()
    return this.#outputs.record(options)
  }

  /**
   * A live `MediaStream` of the output (#33), like `snapshot` (excluded overlays left out), e.g. for a video call
   * (WebRTC) or a `<video>`. Each call gives a new stream with one video track; the copy into it stops once every
   * stream's track is stopped (`track.stop()`). The tracks end when the engine is disposed.
   */
  outputStream(options?: OutputStreamOptions): MediaStream {
    this.#assertAlive()
    return this.#outputs.outputStream(options)
  }

  /**
   * Loads a filter and adds it on top of the stack. Rejects with `InvalidManifestError`, `IncompatibleEngineError`,
   * `MissingPluginError`, `AssetError`, `InvalidParamError` (initial params): the stack is then unchanged.
   */
  async addFilter(src: FilterInput, params?: Readonly<Record<string, unknown>>): Promise<FilterHandle> {
    this.#assertAlive()
    const filter = await this.#load(src, params)
    if (this.#disposed) {
      filter.dispose()
      throw disposedError('The engine')
    }
    filter.lastAuthorDraw = filter.authorShader ? performance.now() : -Infinity
    this.#stack.push(filter)
    this.#handles.set(filter, this.#handleFor(filter))
    this.#stackChanged()
    this.#startScript(filter)
    await this.#updateTracking()
    return this.#handles.get(filter)!
  }

  /**
   * Replaces the whole stack. All filters are loaded first, in parallel; the old stack keeps rendering until they all
   * are, then they swap in one frame (no empty frame). On failure the old stack is kept and the error is thrown.
   */
  async setFilters(list: ReadonlyArray<FilterInput | FilterSpec>): Promise<FilterHandle[]> {
    this.#assertAlive()
    const specs = list.map((item) => (isFilterSpec(item) ? item : { src: item }))
    const settled = await Promise.allSettled(specs.map((s) => this.#load(s.src, s.params)))
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    const loaded = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    if (failed || this.#disposed) {
      for (const f of loaded) f.dispose()
      throw failed ? failed.reason : disposedError('The engine')
    }
    const old = this.#stack
    for (const f of loaded) if (f.authorShader) f.lastAuthorDraw = performance.now()
    this.#stack = loaded
    for (const f of loaded) this.#handles.set(f, this.#handleFor(f))
    this.#stackChanged()
    for (const f of old) this.#disposeFilter(f)
    for (const f of loaded) this.#startScript(f)
    await this.#updateTracking()
    return this.filters.slice()
  }

  /**
   * Sends a message to the scripts of every filter of the stack (disabled ones included), received as the
   * `message:<name>` event (spec §13) by the scripts that list it in `script.on`; `handle.send` targets one filter.
   * `name`: a letter, then letters, digits, `_` or `-`. `data` must be structured-cloneable: it is copied now, so
   * changing it afterwards changes nothing. Delivered with the next frame sent to each script, after the events
   * queued before it. Throws `OuafError('invalid-message')` (bad name, data that cannot be cloned) or
   * `OuafError('disposed')`.
   */
  send(name: string, data?: unknown): void {
    this.#assertAlive()
    const payload = messagePayload(name, data)
    for (const filter of this.#stack) filter.host?.queue({ name: `message:${name}`, payload })
  }

  /**
   * Stops everything and frees what the engine holds: the source feed (and a source a plugin created; a source the
   * host passed stays the host's), every filter (layers, assets, GPU resources, script sandbox and Worker), the
   * render passes, the face tracker, the outputs (recordings stop, output streams end, pending snapshots reject), the
   * GPU context of the canvas (lost for good: use a new canvas for a new engine) and every listener. Pending `addFilter`, `setFilters`, `setSource` and `pushFrame` calls reject with
   * `OuafError('disposed')`, as does every later call but `dispose` itself, which is idempotent.
   */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#stopFeed()
    for (const f of this.#stack) this.#disposeFilter(f)
    this.#stack = []
    this.#handles.clear()
    for (const p of this.#renderPasses) p.dispose()
    this.#renderPasses = []
    this.#objects.length = 0
    for (const key of ['background', 'face', 'warp', 'color'] as const) this.#passes[key].length = 0
    this.#tracking.dispose()
    this.#outputs.dispose()
    this.#scratch = undefined
    const renderer = this.#compositor.renderer
    const canvas = renderer.domElement as EventTarget
    canvas.removeEventListener('webglcontextlost', this.#onContextLost as EventListener)
    canvas.removeEventListener('webglcontextrestored', this.#onContextRestored)
    this.#compositor.dispose()
    // Browsers keep a canvas's context (and its GPU memory) alive while the canvas lives, and cap live contexts.
    try {
      renderer.forceContextLoss()
    } catch {
      // Already lost, or no WEBGL_lose_context: nothing more to free.
    }
    this.#events.clear()
  }

  // ---------------------------------------------------------------------------------------------

  /** Starts `feed` as the new source: stops the previous one, forgets its faces, reseeds the filters. */
  #begin(feed: Feed, regime: SourceRegime, image: FrameImage | HTMLVideoElement | undefined, mirrored: boolean): void {
    this.#stopFeed()
    this.#feed = feed
    this.#regime = regime
    this.#live = false
    this.#lastNow = -1
    this.#lastTime = Number.NaN
    // A new stats window: the first `stats` of this source does not average in the previous one.
    this.#statsStart = 0
    this.#statsFrames = 0
    this.#statsMs = 0
    this.#statsMaxMs = 0
    this.#statsTrackMs = 0
    this.#resetFaces()
    // A new source starts with every capability on (spec §16.3: judged again over its first seconds).
    this.#resetGovernor()
    for (const f of this.#stack) f.reseed(this.#filterSeed(f.manifest.id))
    this.#compositor.setSource(image, mirrored)
  }

  #stopFeed(): void {
    const feed = this.#feed
    this.#feed = undefined
    if (!feed) return
    if (feed.kind === 'video') {
      feed.scheduler.dispose()
      if (feed.owned) feed.source.dispose()
    } else if (feed.kind === 'canvas' || feed.kind === 'still') cancelAnimationFrame(feed.raf)
    else if (feed.kind === 'offline') feed.source.restart() // frees the decoder; the next run starts from frame 0
  }

  /** Faces of the previous source are forgotten: new ids, no smoothing across sources. */
  #resetFaces(): void {
    this.#tracking.clear()
    this.#identity.reset()
    this.#geometry.reset()
  }

  /** Seed of a filter activation (spec §12.5). */
  #filterSeed(filterId: string): number {
    if (this.#seedOption !== undefined) return deriveSeed(this.#seedOption, filterId)
    if (this.#regime === 'file') return deriveSeed(FILE_SOURCE_SEED, filterId)
    return randomSeed()
  }

  /**
   * Checks an image the engine will read (spec: explicit errors): not the engine's own canvas, has pixels, not
   * tainted. An `<img>` still loading is awaited when `decode` is set.
   */
  async #checkImage(image: FrameImage, decode: boolean): Promise<FrameImage> {
    if (image === this.#compositor.renderer.domElement) {
      throw new IncompatibleSourceError('The source is the canvas the engine renders into: it cannot read its own output. Draw into another canvas.')
    }
    if (decode && typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement && !(image.complete && image.naturalWidth > 0)) {
      try {
        await image.decode()
      } catch (cause) {
        throw new IncompatibleSourceError(`The image ${image.currentSrc || image.src || ''} could not be loaded or decoded.`, { cause })
      }
    }
    assertReadable(image, () => this.#scratchContext())
    return image
  }

  #scratchContext(): OffscreenCanvasRenderingContext2D | undefined {
    if (this.#scratch === undefined) {
      this.#scratch = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })
    }
    return this.#scratch ?? undefined
  }

  /** A new frame of a video source (live regime). */
  #onVideoFrame(info: VideoFrameInfo): void {
    const feed = this.#feed
    if (this.#disposed || feed?.kind !== 'video') return
    // The frame's time (s): the media time for files (deterministic, spec §12.5); for a live source the clock, since
    // browsers do not always advance a camera's media time (Firefox reports 0 for every frame).
    const time = this.#live ? info.now / 1000 : info.mediaTime
    const start = performance.now()
    this.#tracking.submit(feed.source.video, info.now, time)
    const tracked = performance.now()
    this.#frameTrackMs = tracked - start
    this.#compositor.beginFrame()
    this.#draw(time, info.now, tracked)
  }

  /** A canvas the host draws into (live regime): read on every animation frame. */
  #runCanvas(feed: Extract<Feed, { kind: 'canvas' }>): void {
    let frames = 0
    const tick = (now: number) => {
      if (this.#feed !== feed) return
      feed.raf = requestAnimationFrame(tick)
      const start = performance.now()
      try {
        // It may have been tainted since the last check (drawn from another origin): WebGL would refuse it silently.
        if (++frames % CANVAS_CHECK_FRAMES === 0) assertReadable(feed.canvas, () => this.#scratchContext())
        this.#compositor.setFrame(feed.canvas)
        const submitted = performance.now()
        this.#tracking.submit(feed.canvas, now, now / 1000)
        const tracked = performance.now()
        this.#frameTrackMs = tracked - submitted
        this.#compositor.beginFrame()
        this.#draw(now / 1000, now, start + (tracked - submitted))
      } catch (error) {
        this.#sourceFailed(feed, error)
      }
    }
    feed.raf = requestAnimationFrame(tick)
  }

  /**
   * A still image (file regime): tracked once (IMAGE mode), again when the tracking configuration changes, and
   * rendered on every animation frame so that animations and transitions play. Time is the time since the source
   * was set.
   */
  async #runStill(feed: Extract<Feed, { kind: 'still' }>): Promise<void> {
    let tracked = -1
    let t0 = -1
    while (this.#feed === feed) {
      const now = await new Promise<number>((resolve) => (feed.raf = requestAnimationFrame(resolve)))
      if (this.#feed !== feed) return
      const tracking = this.#tracking
      const starting = tracking.starting
      if (starting) await starting.catch(() => {})
      if (tracking.active && tracking.configVersion !== tracked) {
        tracked = tracking.configVersion
        await tracking.track(feed.image, now, t0 < 0 ? 0 : (now - t0) / 1000, true)
        if (this.#feed !== feed) return
      }
      // The clock starts with the first frame shown (switching the tracker to IMAGE mode can take a while).
      if (t0 < 0) t0 = Math.max(now, performance.now())
      const time = Math.max(0, now - t0) / 1000
      const start = performance.now()
      try {
        this.#compositor.beginFrame()
        this.#draw(time, now, start)
      } catch (error) {
        this.#sourceFailed(feed, error)
      }
    }
  }

  /** Renders every frame of an offline video, paced at `source.rate` (file regime). */
  async #runOffline(feed: Feed, source: OfflineVideoSource): Promise<void> {
    let frames = 0
    let last = 0
    // Pacing reference: media time `t0` is due at wall-clock `wall0`.
    let t0 = Number.NaN
    let wall0 = 0
    let rate = source.rate
    try {
      for (;;) {
        const frame = await source.read()
        if (this.#feed !== feed) return frame?.close()
        if (!frame) {
          if (source.loop && frames > 0 && !source.disposed) {
            source.restart()
            t0 = Number.NaN
            continue
          }
          if (this.#events.has('sourceEnd')) this.#events.emit('sourceEnd', { frames, time: last })
          return
        }
        try {
          const now = performance.now()
          if (Number.isNaN(t0) || frame.time < last || source.rate !== rate) {
            t0 = frame.time
            wall0 = now
            rate = source.rate
          } else if (Number.isFinite(rate)) {
            const due = wall0 + ((frame.time - t0) * 1000) / rate
            // Late (a slow device): run slower than real time from here instead of rushing to catch up.
            if (now - due > 100) {
              t0 = frame.time
              wall0 = now
            } else if (due - now > 1) await sleep(due - now)
          } else await yieldToBrowser()
          if (this.#feed !== feed) return
          await this.#fileFrame(feed, frame.image, frame.time)
        } finally {
          frame.close()
        }
        frames++
        last = frame.time
      }
    } catch (error) {
      if (this.#feed === feed) this.#sourceFailed(feed, error)
    }
  }

  /**
   * One frame of a file source: waits for the tracker, tracks this very frame, then renders it (spec §12.1). A time
   * earlier than the previous frame's starts a new run: faces and the tracker's temporal state are reset, and seeds
   * restart, so that every run gives the same images (spec §12.5).
   */
  async #fileFrame(feed: Feed, image: FrameImage, time: number): Promise<void> {
    const tracking = this.#tracking
    const newRun = !(time >= this.#lastTime)
    this.#lastTime = time
    if (newRun) {
      if (this.#lastNow >= 0) {
        this.#resetFaces()
        for (const f of this.#stack) f.reseed(this.#filterSeed(f.manifest.id))
      }
      this.#lastNow = -1
      await tracking.resetTracker()
    } else {
      const starting = tracking.starting
      if (starting) await starting.catch(() => {})
    }
    if (this.#feed !== feed || this.#disposed) return
    const now = time * 1000
    this.#compositor.setFrame(image)
    this.#compositor.beginFrame()
    if (tracking.active) {
      await tracking.track(image, now, time)
      if (this.#feed !== feed || this.#disposed) return
    }
    try {
      this.#draw(time, now, performance.now())
    } catch (error) {
      if (isSecurityError(error)) throw taintedError(describeImage(image), error)
      throw error
    }
  }

  /** The source cannot be read any more (tainted canvas, decoding error): reported, and the source is cleared. */
  #sourceFailed(feed: Feed, error: unknown): void {
    if (this.#feed !== feed) return
    const what = feed.kind === 'canvas' ? describeImage(feed.canvas) : feed.kind === 'still' ? describeImage(feed.image) : 'source'
    this.#error(isSecurityError(error) ? taintedError(what, error) : error)
    if (error instanceof IncompatibleSourceError || isSecurityError(error) || feed.kind === 'offline') this.clearSource()
  }

  /** Params, tracking data, layer updates and rendering of one frame at media time `time`. */
  #draw(time: number, now: number, start: number): void {
    const compositor = this.#compositor
    for (let i = 0; i < this.#stack.length; i++) {
      const filter = this.#stack[i]!
      // Media time drives transitions: deterministic with file sources (spec §12.5); a loop counts as no time.
      filter.params.beginFrame(time * 1000)
    }

    const faces = this.#trackedFaces(time)
    this.#anchors.setFrame(faces, this.#identity.ids, compositor.mirrored)
    const data = this.#bindingData
    data.faces = faces
    data.time = time
    data.mirrored = compositor.mirrored
    data.videoToClip = compositor.videoToClip
    const frame = this.#frame
    frame.dt = this.#lastNow < 0 ? 0 : Math.max(0, now - this.#lastNow)
    frame.now = now
    frame.time = time
    frame.faces = faces
    frame.width = compositor.width
    frame.height = compositor.height
    frame.mirrored = compositor.mirrored
    this.#lastNow = now

    this.#drawnFaces = faces
    for (let i = 0; i < this.#stack.length; i++) {
      const filter = this.#stack[i]!
      if (!filter.script) continue
      // The script's values and animations follow the media time; its answers apply from this frame (spec §12.1).
      filter.script.overrides.clock.advance(time)
      filter.script.overrides.idOf = this.#idOf
      filter.host?.beginFrame()
    }

    for (let i = 0; i < this.#stack.length; i++) {
      const filter = this.#stack[i]!
      if (!filter.active) continue
      const layers = filter.layers
      for (let l = 0; l < layers.length; l++) layers[l]!.instance.update(frame)
    }
    for (let i = 0; i < this.#renderPasses.length; i++) this.#renderPasses[i]!.update(frame)

    if (this.#contextLost) return
    this.#markAuthorShaders(start)
    compositor.render(this.#passes as StagePasses)
    // Then the frame goes to the scripts that are not busy with a previous one (spec §12.7).
    for (let i = 0; i < this.#stack.length; i++) {
      const filter = this.#stack[i]!
      if (filter.active) filter.host?.endFrame(time, this.#scriptData)
    }
    const end = performance.now()
    this.#recordStats(end, end - start, faces.count)
    if (this.#regime === 'live') this.#govern(now)
  }

  /** Records which filters draw author shader code this frame (context loss suspects, spec §11). */
  #markAuthorShaders(now: number): void {
    for (let i = 0; i < this.#stack.length; i++) {
      const filter = this.#stack[i]!
      if (!filter.authorShader || !filter.active) continue
      const layers = filter.layers
      for (let l = 0; l < layers.length; l++) {
        const instance = layers[l]!.instance
        if (instance.authorShader && instance.kind === 'pass' && instance.active) {
          filter.lastAuthorDraw = now
          break
        }
      }
    }
  }

  /**
   * GPU context lost (spec §11, §15.5): disables the filters whose author shader was drawn within
   * `CONTEXT_LOSS_WINDOW_MS`, the likely cause, and reports each one (`error`: `GpuContextLostError`). A loss while
   * the page is hidden is the system's (mobile browsers drop background contexts): no filter is blamed then.
   */
  #contextLostHandler(event: Event): void {
    event.preventDefault() // allows the browser to restore the context
    if (this.#contextLost || this.#disposed) return
    this.#contextLost = true
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    const since = performance.now() - CONTEXT_LOSS_WINDOW_MS
    const suspects = hidden ? [] : this.#stack.filter((f) => f.active && f.authorShader && f.lastAuthorDraw >= since)
    for (const f of suspects) f.enabled = false
    if (suspects.length) {
      this.#stackChanged()
      void this.#updateTracking()
    }
    this.#warn(
      `The GPU context was lost${suspects.length ? `; disabled ${suspects.map((f) => `"${f.manifest.id}"`).join(', ')}, whose shader was drawing` : ''}. Rendering resumes when the browser restores the context.`,
    )
    for (const f of suspects) this.#error(new GpuContextLostError(f.manifest.id))
  }

  #contextRestoredHandler(): void {
    if (this.#disposed) return
    this.#contextLost = false
  }

  /**
   * The faces layers see this frame: each new tracking result goes through face identity and smoothing (on the time
   * of the analysed frame), then the smoothed faces are predicted to the displayed frame's time, which
   * hides most of the result age of an asynchronous tracker (docs/decisions/tracking-worker.md).
   */
  #trackedFaces(time: number): FaceFrame {
    const tracking = this.#tracking
    const raw = tracking.faces
    if (!tracking.active) return raw
    if (tracking.results !== this.#seenResults) {
      this.#seenResults = tracking.results
      this.#identity.update(raw, raw.mediaTime)
      this.#smoother.update(raw, raw.mediaTime, this.#smoothed)
      // Blendshapes dropped (spec §16.2), or not computed yet after a reconfiguration: bindings take their default,
      // scripts get none, and expression events come from the landmark geometry (§13).
      // A tracker may keep computing them while they are dropped (MediaPipe: no gain, see builtin.ts).
      if (raw.count > 0) this.#bindingData.blendshapes = tracking.config.blendshapes && hasBlendshapes(raw)
      this.#detectExpressions(raw, raw.mediaTime * 1000)
    }
    this.#smoother.predict(this.#smoothed, time, this.#drawn)
    return this.#drawn
  }

  /**
   * Runs every enabled face filter's expression detectors on the new result and delivers the events (spec §13).
   * `faceEnter` / `faceLeave` come from face identity, which applies the grace delay (spec §5.4).
   */
  #detectExpressions(raw: Readonly<FaceFrame>, timeMs: number): void {
    const faces = this.#smoothed
    const identity = this.#identity
    // The geometric signals, from the raw result in the same slots as the smoothed one: smoothing would blunt a blink
    // that lasts one or two results (and the mapping was calibrated on raw landmarks). Computed even with blendshapes:
    // blinks and winks read the larger of the two eye values (`maxEyeSignals`), and the eye baselines stay warm.
    this.#geometry.begin(identity.ids, timeMs)
    if (this.#bindingData.blendshapes) {
      readExpressionSignals(faces, this.#signals, blendshapeSignals)
      readExpressionSignals(raw, this.#geometrySignals, this.#geometry.source)
      maxEyeSignals(Math.min(faces.count, raw.count), this.#geometrySignals, this.#signals)
    } else readExpressionSignals(raw, this.#signals, this.#geometry.source)
    for (let i = 0; i < this.#stack.length; i++) {
      const filter = this.#stack[i]!
      const detector = filter.expressions
      if (!detector || !filter.active) continue
      const out = detector.update(timeMs, identity.count, identity.ids, this.#signals)
      const host = filter.host
      if (host) {
        for (let e = 0; e < out.count; e++) {
          const ev = out.items[e]!
          if (ev.name === 'faceEnter' || ev.name === 'faceLeave') continue
          host.queue(ev.side ? { name: ev.name, face: ev.faceId, side: ev.side } : { name: ev.name, face: ev.faceId })
        }
        for (let e = 0; e < identity.enteredCount; e++) host.queue({ name: 'faceEnter', face: identity.entered[e]! })
        for (let e = 0; e < identity.leftCount; e++) host.queue({ name: 'faceLeave', face: identity.left[e]! })
      }
      // A face that left keeps no script values (its id is never reused).
      if (filter.script) for (let e = 0; e < identity.leftCount; e++) filter.script.overrides.dropFace(identity.left[e]!)
      if (!filter.events.has('expression')) continue
      for (let e = 0; e < out.count; e++) {
        const ev = out.items[e]!
        if (ev.name === 'faceEnter' || ev.name === 'faceLeave') continue
        filter.events.emit('expression', { name: ev.name, faceId: ev.faceId, side: ev.side })
      }
      for (let e = 0; e < identity.enteredCount; e++) filter.events.emit('expression', { name: 'faceEnter', faceId: identity.entered[e]!, side: null })
      for (let e = 0; e < identity.leftCount; e++) filter.events.emit('expression', { name: 'faceLeave', faceId: identity.left[e]!, side: null })
    }
  }

  #recordStats(now: number, ms: number, faces: number): void {
    this.#statsFrames++
    this.#statsMs += ms
    if (ms > this.#statsMaxMs) this.#statsMaxMs = ms
    this.#statsTrackMs += this.#frameTrackMs
    this.#frameTrackMs = 0
    if (this.#statsStart === 0) this.#statsStart = now
    const elapsed = now - this.#statsStart
    if (elapsed < 1000) return
    const fps = (this.#statsFrames * 1000) / elapsed
    const frameMs = this.#statsMs / this.#statsFrames
    if (this.#events.has('stats')) {
      this.#events.emit('stats', {
        fps,
        trackingHz: this.#tracking.rateHz,
        faces,
        frameMs,
        frameMsMax: this.#statsMaxMs,
        trackMs: this.#statsTrackMs / this.#statsFrames,
        pipelineMs: this.#tracking.pipelineMs,
        trackerTimings: this.#tracking.timings ? { ...this.#tracking.timings } : undefined,
        tracker: this.#tracking.description,
        width: this.#compositor.width,
        height: this.#compositor.height,
      })
    }
    this.#checkHeavyStack(frameMs, fps)
    this.#statsStart = now
    this.#statsFrames = 0
    this.#statsMs = 0
    this.#statsMaxMs = 0
    this.#statsTrackMs = 0
  }

  /**
   * Frame budget (#34): warns once per stack change when the engine's own work takes more than half of the frame
   * interval for a few seconds in a row (tracking not counted: the governor handles it).
   */
  #checkHeavyStack(frameMs: number, fps: number): void {
    if (this.#heavyWarned || !(fps > 0)) return
    const budget = 1000 / fps
    this.#heavyWindows = frameMs > HEAVY_STACK_LOAD * budget ? this.#heavyWindows + 1 : 0
    if (this.#heavyWindows < HEAVY_STACK_WINDOWS) return
    this.#heavyWarned = true
    const ids = this.#stack.filter((f) => f.active).map((f) => `"${f.manifest.id}"`)
    this.#warn(
      `The filter stack${ids.length ? ` (${ids.join(', ')})` : ''} takes ${frameMs.toFixed(1)} ms per frame on the main thread, ` +
        `${Math.round((100 * frameMs) / budget)} % of the ${budget.toFixed(1)} ms between frames at ${fps.toFixed(0)} fps: it may not keep up on this device.`,
    )
  }

  async #load(src: FilterInput, params: Readonly<Record<string, unknown>> | undefined): Promise<FilterInstance> {
    return loadFilter(this.#nextKey++, await filterSource(src, this.#fetch), params, this.#loadEnv())
  }

  #loadEnv(): FilterLoadEnv {
    return {
      engineVersion: ENGINE_VERSION,
      registry: this.registry,
      layerTypes: this.#layerTypes,
      loaders: this.#loaders,
      builtinUrl: (name) => resolveBuiltin(name, new URL('builtins/', this.assetsBaseUrl)).href,
      assetsBaseUrl: this.assetsBaseUrl,
      fetchImpl: this.#fetch,
      renderer: this.#compositor.renderer,
      view: this.#compositor,
      maxFaces: this.maxFaces,
      bindingData: this.#bindingData,
      seed: (filterId) => this.#filterSeed(filterId),
      warn: (message) => this.#warn(message),
      error: (error) => this.#error(error),
    }
  }

  #handleFor(filter: FilterInstance): FilterHandle {
    return createHandle(filter, {
      indexOf: (f) => this.#stack.indexOf(f),
      move: (f, index) => {
        const from = this.#stack.indexOf(f)
        if (from < 0) return
        this.#stack.splice(from, 1)
        this.#stack.splice(Math.max(0, Math.min(this.#stack.length, Math.trunc(index))), 0, f)
        this.#stackChanged()
      },
      remove: (f) => {
        const i = this.#stack.indexOf(f)
        if (i < 0) return
        this.#stack.splice(i, 1)
        this.#stackChanged()
        this.#disposeFilter(f)
        void this.#updateTracking()
      },
      changed: () => {
        this.#stackChanged()
        void this.#updateTracking()
      },
      send: (f, name, data) => {
        // A removed filter (the engine disposed included) ignores it, like a filter without a script.
        const payload = messagePayload(name, data)
        f.host?.queue({ name: `message:${name}`, payload })
      },
    })
  }

  /** Face key of a face slot for the scripts' per-face values: its stable id, 0 for no face (screen layers). */
  readonly #idOf = (slot: number): number => (slot < 0 ? 0 : this.#anchors.id(slot))
  #drawnFaces: FaceFrame = createFaceFrame(1)

  /** Starts the script of a filter just added to the stack (spec §12): a new sandbox and a new seed. */
  #startScript(filter: FilterInstance): void {
    const script = filter.script
    const decl = filter.manifest.script
    if (!script || !decl || filter.host || filter.disposed) return
    const id = filter.manifest.id
    const uses = (decl.uses ?? DEFAULT_SCRIPT_USES) as readonly ScriptUse[]
    if (uses.includes('pairs')) this.#warn(`Filter "${id}": pair data (uses: "pairs") is not computed by this engine version yet: frame.pairs stays empty.`, id)
    const anchors = [...this.registry.anchors.values()].filter((a) => a.subject === 'face').map((a) => a.name)
    const host = new ScriptHost({
      filterId: id,
      code: script.code,
      layers: filter.manifest.layers.map((l) => l.id ?? ''),
      on: decl.on ?? [],
      uses,
      overrides: script.overrides,
      frameData: new FrameDataBuilder(uses, anchors),
      // The filter's seed (spec §12.5): fixed for file sources, random per activation when live, or the host's.
      seed: scriptSeed(filter.seed),
      connect: () => this.#openSandbox(`Filter "${id}"`),
      warn: (message) => this.#warn(message, id),
      error: (error) => this.#error(error),
      // Canvas layers drawn by the script (spec §12.6), and the image assets it draws them with.
      canvases: (decl.draw ?? []).flatMap((drawId) => {
        const layer = filter.manifest.layers.findIndex((l) => l.id === drawId && l.type === 'canvas')
        const l = filter.manifest.layers[layer] as { width?: number; height?: number; fps?: number } | undefined
        return l && typeof l.width === 'number' && typeof l.height === 'number' ? [{ layer, width: l.width, height: l.height, fps: l.fps ?? 30 }] : []
      }),
      images: () => scriptImages(filter.assets, script.images),
      fonts: () => scriptFonts(filter.assets, script.fonts),
      drawn: (layer, pixels) => {
        const instance = filter.layers[layer]?.instance as (LayerInstance & { setImage?: (pixels: Uint8ClampedArray) => void }) | undefined
        if (typeof instance?.setImage === 'function') instance.setImage(pixels)
      },
      play: (layer, face, animation) => {
        const instance = filter.layers[layer]?.instance as (LayerInstance & { play?: (name: string, faceId?: number) => boolean }) | undefined
        if (typeof instance?.play !== 'function') return 'unsupported'
        return instance.play(animation, face) ? 'played' : 'unknown'
      },
      emit: (name, data) => {
        const handle = this.#handles.get(filter)
        filter.events.emit(`filter:${name}`, data)
        if (handle) this.#events.emit(`filter:${name}`, { filter: handle, data })
      },
    })
    filter.host = host
    filter.params.onChange((change) => {
      host.paramsChanged(filter.params.values())
      host.queue({ name: 'paramChange', payload: change })
    })
    void host.start(filter.params.values(), this.#frame.time)
  }

  #disposeFilter(filter: FilterInstance): void {
    this.#handles.delete(filter)
    filter.dispose()
  }

  /** Rebuilds the per-stage lists and the scenes after any stack change (spec §7). */
  #stackChanged(): void {
    const passes = this.#passes
    for (const key of ['background', 'face', 'warp', 'color'] as const) passes[key].length = 0
    for (const o of this.#objects) o.object.removeFromParent()
    this.#objects.length = 0
    this.#heavyWindows = 0
    this.#heavyWarned = false
    // Face filters are hidden while the governor says the device tracks too slowly (spec §16.3), new ones included.
    const hidden = this.#governor?.hidden ?? false
    for (const f of this.#stack) f.suspended = hidden && f.needsFace

    // The background is exclusive: the last active filter that has one wins (spec §7).
    const enabled = this.#stack.filter((f) => f.active)
    const withBackground = enabled.filter((f) => [...f.layersOf('background')].length > 0)
    const backgroundOwner = withBackground.at(-1)
    if (withBackground.length > 1) {
      this.#warn(
        `Several filters draw a background (${withBackground.map((f) => f.manifest.id).join(', ')}): only the last one, "${backgroundOwner!.manifest.id}", is shown.`,
      )
    }
    const add = (instance: LayerInstance, filter: FilterInstance | undefined) => {
      if (instance.kind === 'pass') {
        const stage = passStage(instance.stage)
        if (stage === 'background' && filter && filter !== backgroundOwner) return
        passes[stage].push(instance)
      } else {
        const c = this.#compositor
        ;(instance.stage === 'overlay' ? (instance.excludeFromCapture ? c.excludedOverlay : c.overlay) : c.objects).add(instance.object)
        this.#objects.push(instance)
      }
    }
    for (const filter of enabled) for (const l of filter.layers) add(l.instance, filter)
    for (const p of this.#renderPasses) add(p, undefined)
    this.#compositor.drawOrder.setLayers(this.#objects)
  }

  /**
   * Starts or reconfigures tracking for the enabled filters (suspended ones included: tracking keeps measuring,
   * spec §16.3), less what the governor dropped. Blendshapes are computed for every face filter, since expression
   * events read them (spec §13), unless dropped (§16.2).
   */
  async #updateTracking(): Promise<void> {
    const enabled = this.#stack.filter((f) => f.enabled)
    const face = enabled.some((f) => f.needsFace)
    const droppable = this.#droppable
    droppable.clear()
    if (face) {
      if (!enabled.some((f) => f.requiresBlendshapes)) droppable.add('blendshapes')
      if (this.maxFaces > 1) droppable.add('extraFaces')
      droppable.add('resolution')
    }
    const dropped = (c: Capability) => droppable.has(c) && (this.#governor?.isDropped(c) ?? false)
    try {
      await this.#tracking.setNeeds({
        face,
        blendshapes: face && !dropped('blendshapes'),
        maxFaces: dropped('extraFaces') ? this.#reducedFaces : this.maxFaces,
        analysisScale: dropped('resolution') ? REDUCED_ANALYSIS_SCALE : 1,
      })
    } catch (error) {
      this.#error(error)
    }
  }

  /**
   * One step of the device governor (spec §16), live sources only: consults it with the tracking rate measured since
   * its last change, and applies its decision.
   */
  #govern(now: number): void {
    const g = this.#governor
    if (!g) return
    const tracking = this.#tracking
    if (!tracking.active || this.#droppable.size === 0) {
      // No face filter, or tracking not running yet: nothing to govern, everything back on.
      if (g.state !== 'ok' || this.#performance.state !== 'ok') this.#resetGovernor()
      this.#governedAt = Number.NaN
      return
    }
    if (tracking.measuring) {
      // The tracker compares its backends (spec §16.4): rates are mixed; the measure starts once it is done.
      this.#governedAt = Number.NaN
      return
    }
    const last = this.#governedAt
    if (now - last < GOVERNOR_PERIOD_MS) return
    this.#governedAt = now
    // The first step, or a pause of frames (hidden tab): the measure restarts from now; on the first step, once the
    // tracker's warm-up is over.
    if (Number.isNaN(last) || now - last > GOVERNOR_PAUSE_MS) {
      g.restart(now)
      tracking.restartRate(now)
      this.#warmupUntil = Number.isNaN(last) ? now + TRACKER_WARMUP_MS : Number.NaN
      return
    }
    if (!Number.isNaN(this.#warmupUntil)) {
      if (now < this.#warmupUntil) return
      this.#warmupUntil = Number.NaN
      g.restart(now)
      tracking.restartRate(now)
      return
    }
    const rate = tracking.rateHz
    const governable = this.#governable
    governable.clear()
    const sheds = tracking.sheds
    for (const c of this.#droppable) if (!sheds || sheds.includes(c)) governable.add(c)
    // Showing and restoring judge the results with the faces of the decision (none in view is no recovery).
    const reference = g.referenceFaces
    const measures = this.#governorMeasures
    measures.pipelineMs = tracking.pipelineMs
    measures.faces = tracking.faces.count
    if (reference > 0) {
      tracking.rateWithFaces(reference, this.#recovery)
      measures.recoveryHz = this.#recovery[0]!
      measures.recoveryPipelineMs = this.#recovery[1]!
    } else {
      measures.recoveryHz = rate
      measures.recoveryPipelineMs = measures.pipelineMs
    }
    const change = g.update(now, rate, governable, measures)
    if (!change) return
    if (change.kind === 'drop' && change.capability === 'extraFaces') this.#reducedFaces = Math.max(1, tracking.faces.count)
    tracking.restartRate(now)
    this.#applyGovernor(rate)
  }

  /** Applies the governor's state: suspended filters, tracker configuration, `performance` event on a change. */
  #applyGovernor(rate: number): void {
    const g = this.#governor
    const hidden = g?.hidden ?? false
    if (this.#stack.some((f) => f.needsFace && f.suspended !== hidden)) this.#stackChanged()
    void this.#updateTracking()
    const state = g?.state ?? 'ok'
    const dropped = g ? [...g.dropped] : []
    const previous = this.#performance
    if (state === previous.state && dropped.join() === previous.dropped.join()) return
    this.#performance = { state, dropped, trackingHz: rate }
    if (this.#events.has('performance')) this.#events.emit('performance', { state, dropped: [...dropped], trackingHz: rate })
  }

  /** Everything back on and shown (new source, no face filter); the governor starts over. */
  #resetGovernor(): void {
    const g = this.#governor
    if (!g) return
    const rate = this.#tracking.rateHz
    g.reset(performance.now())
    this.#governedAt = Number.NaN
    this.#applyGovernor(rate)
  }

  async #createRenderPass(impl: RenderPassImpl): Promise<void> {
    const empty: PreloadedAssets = {
      get: (ref) => {
        throw new OuafError('asset', `Render pass "${impl.id}" has no assets (asked for "${ref}").`)
      },
      has: () => false,
      dispose: () => {},
    }
    const params = new ParamStore(undefined)
    const random = new SeededRandom(this.#seedOption ?? randomSeed())
    const ctx: LayerContext = {
      filterId: `pass:${impl.id}`,
      renderer: this.#compositor.renderer,
      view: this.#compositor,
      assets: empty,
      params,
      bindings: { data: this.#bindingData, params: bindingParams(params) },
      maxFaces: this.maxFaces,
      random: random.next,
      warn: (message) => this.#warn(`Render pass "${impl.id}": ${message}`),
    }
    try {
      const instance = await impl.create(ctx)
      if (this.#disposed) return instance.dispose()
      this.#renderPasses.push(instance)
      this.#stackChanged()
    } catch (error) {
      this.#error(error)
    }
  }

  #warn(message: string, filter?: string): void {
    if (this.#events.has('warning')) this.#events.emit('warning', filter ? { message, filter } : { message })
    else console.warn(`[ouaf] ${message}`)
  }

  #error(error: unknown): void {
    const e = error instanceof Error ? error : new Error(String(error))
    if (this.#events.has('error')) this.#events.emit('error', e)
    else console.error('[ouaf]', e)
  }

  #assertAlive(): void {
    if (this.#disposed) throw disposedError('The engine')
  }
}

/** Creates an engine on `options.canvas`. Throws when WebGL2 is not available. */
export function createEngine(options: EngineOptions): Engine {
  return new Engine(options)
}

export { memorySource, urlSource }

function passStage(stage: Stage): 'background' | 'face' | 'warp' | 'color' {
  if (stage === 'background' || stage === 'face' || stage === 'warp' || stage === 'color') return stage
  throw new OuafError('unknown-layer-type', `A pass layer cannot be in stage "${stage}".`)
}

/** The tracker computed blendshapes for this result: MediaPipe leaves them at 0 when they are off. */
function hasBlendshapes(faces: Readonly<FaceFrame>): boolean {
  const b = faces.blendshapes
  for (let i = 0; i < BLENDSHAPES_STRIDE; i++) if (b[i] !== 0) return true
  return false
}

function isVideoSource(input: unknown): input is VideoSource {
  if (typeof input !== 'object' || input === null) return false
  const s = input as Partial<VideoSource>
  return typeof s.mirrored === 'boolean' && typeof s.dispose === 'function' && typeof HTMLVideoElement !== 'undefined' && s.video instanceof HTMLVideoElement
}

function videoElementSource(video: HTMLVideoElement): VideoSource {
  return {
    video,
    mirrored: false,
    get width() {
      return video.videoWidth
    },
    get height() {
      return video.videoHeight
    },
    disposed: false,
    dispose() {},
  }
}

function isFilterSpec(item: FilterInput | FilterSpec): item is FilterSpec {
  if (typeof item !== 'object' || item === null) return false
  if (item instanceof URL || item instanceof Blob || item instanceof ArrayBuffer || ArrayBuffer.isView(item)) return false
  return 'src' in item
}

/** The `FilterSource` of a `FilterInput`: a folder, a package (URL, blob, bytes) or the source itself. */
async function filterSource(src: FilterInput, fetchImpl: typeof fetch): Promise<FilterSource> {
  if (typeof src === 'string' || src instanceof URL) {
    return isPackageUrl(src) ? fetchPackage(src, fetchImpl) : urlSource(src, fetchImpl)
  }
  if (src instanceof Blob || src instanceof ArrayBuffer || src instanceof Uint8Array) return packageSource(src)
  if (typeof src === 'object' && src !== null && typeof src.manifest === 'function' && typeof src.file === 'function') {
    return src
  }
  throw new OuafError('filter-load', `Cannot load a filter from ${describeSource(src)}: expected a URL, a .ouaf ` +
    'package (Blob, File, ArrayBuffer, Uint8Array) or a FilterSource.')
}

function describeSource(input: unknown): string {
  if (input === null) return 'null'
  if (typeof input !== 'object') return typeof input
  return (input as object).constructor?.name ?? 'object'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Lets the page handle input and paint between frames rendered as fast as possible. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
