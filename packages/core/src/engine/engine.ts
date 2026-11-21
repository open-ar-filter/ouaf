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
 */
import { createRegistry, extendRegistry, type SpecRegistry, type Stage } from '@ouaf/spec'
import { createFaceFrame } from '../face.ts'
import { FrameScheduler, type VideoFrameInfo } from '../scheduler.ts'
import type { VideoSource } from '../video-source.ts'
import type { FitMode } from '../viewport.ts'
import { ProvisionalAnchors } from './anchor-provider.ts'
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
   * from anywhere else (docs/privacy.md). Relative URLs resolve against the page.
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
} & { [K in `filter:${string}`]: FilterEvent }

/** A filter to load: URL of its folder (or of its `manifest.json`), or a `FilterSource` (`memorySource`…). */
export type FilterInput = string | URL | FilterSource

export interface FilterSpec {
  src: FilterInput
  params?: Readonly<Record<string, unknown>>
}

/** What `setSource` accepts: a `VideoSource` (`CameraSource`, `VideoFileSource`), a playing `<video>`, or anything a source plugin accepts. */
export type SourceInput = VideoSource | HTMLVideoElement | unknown

export class Engine {
  readonly maxFaces: number
  readonly assetsBaseUrl: string
  /** Validation registry, including the vocabulary of installed plugins (for editors and the CLI). */
  readonly registry: SpecRegistry

  #events = new Emitter<EngineEvents>((error) => this.#warn(`An event listener threw: ${String(error)}`))
  #compositor: Compositor
  #anchors: ProvisionalAnchors
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
  #source: VideoSource | undefined
  #scheduler: FrameScheduler | undefined
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
    this.registry = createRegistry()
    this.#compositor = new Compositor({ canvas: options.canvas, fit: options.fit, scale: options.scale, width: options.width, height: options.height })
    this.#anchors = new ProvisionalAnchors(createFaceFrame(1), this.#compositor.camera)
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
   * Sets the image source. The engine renders and tracks every new frame of it. A source passed by the host stays
   * the host's: the engine does not dispose it. Throws `IncompatibleSourceError`.
   */
  async setSource(input: SourceInput): Promise<void> {
    this.#assertAlive()
    let source: VideoSource | undefined
    if (isVideoSource(input)) source = input
    else if (typeof HTMLVideoElement !== 'undefined' && input instanceof HTMLVideoElement) source = videoElementSource(input)
    else {
      const impl = this.#sources.find((s) => s.accepts(input))
      if (!impl) throw new IncompatibleSourceError(`Unsupported source: ${describeSource(input)}. Pass a VideoSource (CameraSource, VideoFileSource) or a <video>.`)
      source = await impl.create(input)
    }
    if (source.disposed) throw new IncompatibleSourceError('The source has been disposed.')
    this.#scheduler?.dispose()
    this.#source = source
    this.#compositor.setVideo(source.video, source.mirrored)
    this.#lastNow = -1
    this.#scheduler = new FrameScheduler(source.video, (frame) => this.#onFrame(frame), { onError: (e) => this.#error(e) })
    this.#scheduler.start()
  }

  /** Stops rendering the current source (the canvas keeps its last image). */
  clearSource(): void {
    this.#scheduler?.dispose()
    this.#scheduler = undefined
    this.#source = undefined
    this.#compositor.setVideo(undefined, false)
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
    this.#scheduler?.dispose()
    for (const f of this.#stack) this.#disposeFilter(f)
    this.#stack = []
    for (const p of this.#renderPasses) p.dispose()
    this.#tracking.dispose()
    this.#compositor.dispose()
    this.#events.clear()
  }

  // ---------------------------------------------------------------------------------------------

  #onFrame(info: VideoFrameInfo): void {
    if (this.#disposed || !this.#source) return
    const start = performance.now()
    const compositor = this.#compositor
    compositor.beginFrame()
    this.#tracking.submit(this.#source.video, info.now, info.mediaTime)

    for (let i = 0; i < this.#stack.length; i++) {
      const filter = this.#stack[i]!
      // Media time drives transitions: deterministic with file sources (spec §12.5); a loop counts as no time.
      filter.params.beginFrame(info.mediaTime * 1000)
    }

    const faces = this.#tracking.faces
    this.#anchors.setFrame(faces, compositor.mirrored)
    const data = this.#bindingData
    data.faces = faces
    data.time = info.mediaTime
    data.mirrored = compositor.mirrored
    data.videoToClip = compositor.videoToClip
    const frame = this.#frame
    frame.dt = this.#lastNow < 0 ? 0 : info.now - this.#lastNow
    frame.now = info.now
    frame.time = info.mediaTime
    frame.faces = faces
    frame.width = compositor.width
    frame.height = compositor.height
    frame.mirrored = compositor.mirrored
    this.#lastNow = info.now

    for (let i = 0; i < this.#stack.length; i++) {
      const filter = this.#stack[i]!
      if (!filter.enabled) continue
      const layers = filter.layers
      for (let l = 0; l < layers.length; l++) layers[l]!.instance.update(frame)
    }
    for (let i = 0; i < this.#renderPasses.length; i++) this.#renderPasses[i]!.update(frame)

    compositor.render(this.#passes as StagePasses)
    this.#recordStats(info.now, performance.now() - start, faces.count)
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
      builtinUrl: (name) => new URL(`builtin/${name}`, this.assetsBaseUrl).href,
      fetchImpl: this.#fetch,
      renderer: this.#compositor.renderer,
      view: this.#compositor,
      maxFaces: this.maxFaces,
      bindingData: this.#bindingData,
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
    const ctx: LayerContext = {
      filterId: `pass:${impl.id}`,
      renderer: this.#compositor.renderer,
      view: this.#compositor,
      assets: empty,
      params,
      bindings: { data: this.#bindingData, params: bindingParams(params) },
      maxFaces: this.maxFaces,
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
