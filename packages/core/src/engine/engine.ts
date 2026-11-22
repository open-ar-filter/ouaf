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
import { createRegistry, extendRegistry, type SpecRegistry, type Stage } from '@ouaf/spec'
import { createFaceFrame, type FaceFrame } from '../face.ts'
import { FrameScheduler, type VideoFrameInfo } from '../scheduler.ts'
import type { VideoSource } from '../video-source.ts'
import { OfflineVideoSource } from '../offline-video.ts'
import { assertReadable, describeImage, isCanvas, isFrameImage, isSecurityError, taintedError, type FrameImage } from '../frame-image.ts'
import { checkSeed, deriveSeed, FILE_SOURCE_SEED, randomSeed, SeededRandom } from '../random.ts'
import type { FitMode } from '../viewport.ts'
import { FaceIdentityTracker, FaceSmoother } from '../anchoring/index.ts'
import { createSignals, readExpressionSignals } from '../expressions/index.ts'
import { FaceAnchors } from './anchor-provider.ts'
import { CORE_LOADERS, memorySource, urlSource, type AssetLoader, type FilterSource, type LoaderKind, type PreloadedAssets } from './assets.ts'
import { builtinPlugins } from './builtin.ts'
import { Compositor, type StagePasses } from './compositor.ts'
import { Emitter } from './emitter.ts'
import { IncompatibleSourceError, OuafError, disposedError } from './errors.ts'
import { FilterInstance, bindingParams, createHandle, loadFilter, type FilterHandle, type FilterLoadEnv } from './filter.ts'
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

/**
 * Version used for compatibility checks (spec §17): the format level this engine implements. Filters declare a
 * range on it (`"engine": "^1"`, the default). Distinct from the package version.
 */
export const ENGINE_VERSION = '1.0.0'

export interface EngineOptions {
  /** Canvas the engine renders into (it creates a WebGL2 context on it). Size it with CSS. */
  canvas: HTMLCanvasElement | OffscreenCanvas
  /**
   * Base URL of the engine's self-hosted files: tracking models and wasm, built-in fonts and LUTs. Nothing is fetched
   * from anywhere else (docs/privacy.md). Relative URLs resolve against the page. Built-in resources (`builtin:…`) are
   * the `assets/` folder of `@ouaf/builtins`, served under `<assetsBaseUrl>builtins/` (`builtins/fonts/sans.woff2`).
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
}

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

export interface EngineStats {
  /** Rendered frames per second over the last second. */
  fps: number
  /** Completed tracking results per second (spec §16.1), 0 without face tracking. */
  trackingHz: number
  /** Faces in the latest tracking result. */
  faces: number
  /** Mean time spent in the engine per frame (ms): params, layer updates and render submission. */
  frameMs: number
  /** Tracker backend in use, when tracking runs. */
  tracker: string | undefined
  width: number
  height: number
}

/** `engine.on('performance')` (spec §16.3); emitted by the device governor (#90). */
export interface PerformanceEvent {
  state: 'ok' | 'degraded' | 'unsupported'
  /** Optional capabilities dropped, in drop order. */
  dropped: readonly string[]
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

export type EngineEvents = {
  stats: EngineStats
  warning: EngineWarning
  /** Asynchronous failures (tracking, a frame that threw). Synchronous API errors are thrown instead. */
  error: Error
  performance: PerformanceEvent
  sourceEnd: SourceEndEvent
} & { [K in `filter:${string}`]: FilterEvent }

/** A filter to load: URL of its folder (or of its `manifest.json`), or a `FilterSource` (`memorySource`…). */
export type FilterInput = string | URL | FilterSource

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
  | { readonly kind: 'video'; readonly source: VideoSource; readonly scheduler: FrameScheduler }
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

  #events = new Emitter<EngineEvents>((error) => this.#warn(`An event listener threw: ${String(error)}`))
  #compositor: Compositor
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
  #lastNow = -1
  #statsStart = 0
  #statsFrames = 0
  #statsMs = 0
  #disposed = false

  constructor(options: EngineOptions) {
    const maxFaces = options.maxFaces ?? 1
    if (!Number.isInteger(maxFaces) || maxFaces < 1 || maxFaces > 16) throw new RangeError(`maxFaces must be an integer from 1 to 16, got ${maxFaces}`)
    this.maxFaces = maxFaces
    this.assetsBaseUrl = new URL(options.assetsBaseUrl.endsWith('/') ? options.assetsBaseUrl : `${options.assetsBaseUrl}/`, globalThis.location?.href).href
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.#seedOption = options.seed === undefined ? undefined : checkSeed(options.seed)
    this.registry = createRegistry()
    this.#compositor = new Compositor({ canvas: options.canvas, fit: options.fit, scale: options.scale, width: options.width, height: options.height })
    this.#anchors = new FaceAnchors(createFaceFrame(1), this.#compositor.camera)
    this.#identity = new FaceIdentityTracker({ maxFaces })
    this.#smoother = new FaceSmoother(this.#identity)
    this.#smoothed = createFaceFrame(maxFaces)
    this.#drawn = createFaceFrame(maxFaces)
    this.#signals = createSignals(maxFaces)
    for (const loader of CORE_LOADERS) for (const kind of loader.kinds) this.#loaders.set(kind, loader)

    for (const plugin of options.builtins === false ? [] : builtinPlugins()) this.use(plugin)
    for (const plugin of options.plugins ?? []) this.use(plugin)

    this.#tracking = new TrackingHub({
      impl: this.#trackers.at(-1),
      env: { assetsBaseUrl: this.assetsBaseUrl, warn: (message) => this.#warn(message) },
      maxFaces,
      modifiers: this.#modifiers,
      onError: (error) => this.#error(error),
    })
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
  }

  get disposed(): boolean {
    return this.#disposed
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

  on<K extends keyof EngineEvents & string>(event: K, listener: (payload: EngineEvents[K]) => void): () => void {
    return this.#events.on(event, listener)
  }

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
   * by the host stays the host's: the engine does not dispose it, and a still image or canvas must stay readable
   * while it is the source. Throws `IncompatibleSourceError`: unsupported input, disposed source, the engine's own
   * canvas, an image without pixels, a tainted (cross-origin) image or canvas.
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
    }
    if (source.disposed) throw new IncompatibleSourceError('The source has been disposed.')
    const scheduler = new FrameScheduler(source.video, (frame) => this.#onVideoFrame(frame), { onError: (e) => this.#error(e) })
    this.#begin({ kind: 'video', source, scheduler }, 'live', source.video, source.mirrored)
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
    this.#stack.push(filter)
    this.#handles.set(filter, this.#handleFor(filter))
    this.#stackChanged()
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
    this.#stack = loaded
    for (const f of loaded) this.#handles.set(f, this.#handleFor(f))
    this.#stackChanged()
    for (const f of old) this.#disposeFilter(f)
    await this.#updateTracking()
    return this.filters.slice()
  }

  /** Sends a message to the filters' scripts (`message:<name>`, spec §13). Delivered once scripts run (#26). */
  send(name: string, data?: unknown): void {
    this.#assertAlive()
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new OuafError('invalid-param', `Invalid message name "${name}".`)
    void data
  }

  /** Stops everything and frees the GPU context, the tracker and every filter. Idempotent. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#stopFeed()
    for (const f of this.#stack) this.#disposeFilter(f)
    this.#stack = []
    for (const p of this.#renderPasses) p.dispose()
    this.#tracking.dispose()
    this.#compositor.dispose()
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
    this.#resetFaces()
    for (const f of this.#stack) f.reseed(this.#filterSeed(f.manifest.id))
    this.#compositor.setSource(image, mirrored)
  }

  #stopFeed(): void {
    const feed = this.#feed
    this.#feed = undefined
    if (!feed) return
    if (feed.kind === 'video') feed.scheduler.dispose()
    else if (feed.kind === 'canvas' || feed.kind === 'still') cancelAnimationFrame(feed.raf)
    else if (feed.kind === 'offline') feed.source.restart() // frees the decoder; the next run starts from frame 0
  }

  /** Faces of the previous source are forgotten: new ids, no smoothing across sources. */
  #resetFaces(): void {
    this.#tracking.clear()
    this.#identity.reset()
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
    const start = performance.now()
    this.#compositor.beginFrame()
    // The frame's time (s): the media time for files (deterministic, spec §12.5); for a live source the clock, since
    // browsers do not always advance a camera's media time (Firefox reports 0 for every frame).
    const time = this.#live ? info.now / 1000 : info.mediaTime
    this.#tracking.submit(feed.source.video, info.now, time)
    this.#draw(time, info.now, start)
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
        this.#compositor.beginFrame()
        this.#tracking.submit(feed.canvas, now, now / 1000)
        this.#draw(now / 1000, now, start)
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

    for (let i = 0; i < this.#stack.length; i++) {
      const filter = this.#stack[i]!
      if (!filter.enabled) continue
      const layers = filter.layers
      for (let l = 0; l < layers.length; l++) layers[l]!.instance.update(frame)
    }
    for (let i = 0; i < this.#renderPasses.length; i++) this.#renderPasses[i]!.update(frame)

    compositor.render(this.#passes as StagePasses)
    const end = performance.now()
    this.#recordStats(end, end - start, faces.count)
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
      this.#detectExpressions(raw.mediaTime * 1000)
    }
    this.#smoother.predict(this.#smoothed, time, this.#drawn)
    return this.#drawn
  }

  /**
   * Runs every enabled face filter's expression detectors on the new result and delivers the events (spec §13).
   * `faceEnter` / `faceLeave` come from face identity, which applies the grace delay (spec §5.4).
   */
  #detectExpressions(timeMs: number): void {
    const faces = this.#smoothed
    const identity = this.#identity
    readExpressionSignals(faces, this.#signals)
    for (let i = 0; i < this.#stack.length; i++) {
      const filter = this.#stack[i]!
      const detector = filter.expressions
      if (!detector || !filter.enabled) continue
      const out = detector.update(timeMs, identity.count, identity.ids, this.#signals)
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
    if (this.#statsStart === 0) this.#statsStart = now
    const elapsed = now - this.#statsStart
    if (elapsed < 1000) return
    if (this.#events.has('stats')) {
      this.#events.emit('stats', {
        fps: (this.#statsFrames * 1000) / elapsed,
        trackingHz: this.#tracking.rateHz,
        faces,
        frameMs: this.#statsMs / this.#statsFrames,
        tracker: this.#tracking.description,
        width: this.#compositor.width,
        height: this.#compositor.height,
      })
    }
    this.#statsStart = now
    this.#statsFrames = 0
    this.#statsMs = 0
  }

  async #load(src: FilterInput, params: Readonly<Record<string, unknown>> | undefined): Promise<FilterInstance> {
    const source = typeof src === 'string' || src instanceof URL ? urlSource(src, this.#fetch) : src
    return loadFilter(this.#nextKey++, source, params, this.#loadEnv())
  }

  #loadEnv(): FilterLoadEnv {
    return {
      engineVersion: ENGINE_VERSION,
      registry: this.registry,
      layerTypes: this.#layerTypes,
      loaders: this.#loaders,
      builtinUrl: (name) => resolveBuiltin(name, new URL('builtins/', this.assetsBaseUrl)).href,
      fetchImpl: this.#fetch,
      renderer: this.#compositor.renderer,
      view: this.#compositor,
      maxFaces: this.maxFaces,
      bindingData: this.#bindingData,
      seed: (filterId) => this.#filterSeed(filterId),
      warn: (message) => this.#warn(message),
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
    })
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

    // The background is exclusive: the last enabled filter that has one wins (spec §7).
    const enabled = this.#stack.filter((f) => f.enabled)
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
        ;(instance.stage === 'overlay' ? this.#compositor.overlay : this.#compositor.objects).add(instance.object)
        this.#objects.push(instance)
      }
    }
    for (const filter of enabled) for (const l of filter.layers) add(l.instance, filter)
    for (const p of this.#renderPasses) add(p, undefined)
  }

  async #updateTracking(): Promise<void> {
    const enabled = this.#stack.filter((f) => f.enabled)
    try {
      await this.#tracking.setNeeds({ face: enabled.some((f) => f.needsFace), blendshapes: enabled.some((f) => f.needsBlendshapes) })
    } catch (error) {
      this.#error(error)
    }
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
  return typeof item === 'object' && item !== null && !(item instanceof URL) && 'src' in item
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
