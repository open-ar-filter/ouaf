/**
 * Loading a filter (validation, compatibility, plugins, assets, layer instances) and the public `FilterHandle`.
 */
import { formatIssues, validateManifest, type SpecRegistry, type Stage, type TManifest } from '@ouaf/spec'
import { satisfies } from './semver.ts'
import { Emitter } from './emitter.ts'
import { IncompatibleEngineError, InvalidManifestError, MissingPluginError, OuafError, withParamErrors } from './errors.ts'
import { preloadAssets, type AssetLoader, type FilterSource, type LoaderKind, type PreloadedAssets } from './assets.ts'
import type { LayerContext, LayerDecl, LayerInstance, LayerTypeImpl, ObjectsView } from './layer-type.ts'
import type { BindingDataSource, ParamsReader } from '../bindings/index.ts'
import { ExpressionEventDetector, type EventSide, type ExpressionEventName } from '../expressions/index.ts'
import { ParamStore, type ParamChange, type ParamValue, type SelectOptions, type SetParamOptions } from '../params/index.ts'
import { parsePluginRequirement } from './plugin.ts'
import type { WebGLRenderer } from 'three'
import { deriveSeed, SeededRandom } from '../random.ts'
import { ScriptOverrides } from '../script/overrides.ts'
import type { ScriptHost } from '../script/host.ts'
import { scriptImageRefs } from '../layers/canvas/script-images.ts'

/** Events of a filter handle. */
export interface FilterEvents extends Record<string, unknown> {
  /** A parameter changed (applied at the start of a frame, spec §9). */
  paramChange: ParamChange
  /**
   * A derived face event delivered to the filter (spec §13: `blink`, `wink`, `smile`, `mouthOpen`, `nod`,
   * `faceEnter`…), with the filter's own `events` tuning. Scripts receive the same events (#26); hosts may observe
   * them, e.g. to react in their own UI.
   */
  expression: ExpressionEventPayload
  /** `f.emit(name, data)` from the filter's script (spec §12.4): `on('filter:<name>', (data) => …)`. */
  [event: `filter:${string}`]: unknown
}

export interface ExpressionEventPayload {
  name: ExpressionEventName
  /** Stable id of the face (spec §5.4). */
  faceId: number
  /** `wink` only: the person's side of the closed eye. */
  side: EventSide | null
}

export interface FilterHandle {
  /** Unique per instance (the same filter can be added twice). */
  readonly key: number
  /** The manifest's `id`. */
  readonly id: string
  readonly manifest: Readonly<TManifest>
  /** Validation warnings (reserved features, unused assets…). */
  readonly warnings: readonly string[]
  /** Disabled filters stay loaded but are neither drawn nor tracked for. */
  enabled: boolean
  /** Position in the stack (0 = drawn first within each stage). */
  readonly index: number
  /** Committed parameter values (the targets of running transitions), as a fresh object. */
  readonly params: Readonly<Record<string, ParamValue>>
  /** Names of the manifest's presets. */
  readonly presets: readonly string[]
  /**
   * Validates and queues a change, applied at the start of the next frame (spec §9). Numbers, colors and vectors
   * animate over the parameter's `transition` (ms), or `options.transition`; `apply: "reload"` parameters preload the
   * filter again and swap it in without an empty frame. Throws `InvalidParamError`; nothing is applied then.
   */
  setParam(name: string, value: unknown, options?: SetParamOptions): void
  /** Like `setParam` for several values, all or nothing. */
  setParams(values: Readonly<Record<string, unknown>>, options?: SetParamOptions): void
  /** Applies a named preset (only the parameters it lists). Throws `InvalidParamError` for an unknown preset. */
  applyPreset(name: string, options?: SetParamOptions): void
  /** Supplies the options of a `select` parameter declared with `options: { from: "host" }`. */
  setOptions(name: string, options: Readonly<Record<string, string | Readonly<Record<string, string>>>> | readonly string[]): void
  /** Current options of a `select` parameter. */
  optionsOf(name: string): SelectOptions | undefined
  /**
   * Sends a message to this filter's script, received as the `message:<name>` event (spec §13). `data` must be
   * structured-cloneable; it is copied now. Ignored when the filter has no script, its script does not handle the
   * event or was stopped, or the filter was removed. Throws `OuafError('invalid-message')` (see `Engine.send`).
   */
  send(name: string, data?: unknown): void
  /** Moves the filter to `index` in the stack (clamped). */
  moveTo(index: number): void
  /** Removes the filter from the stack and frees it. */
  remove(): void
  readonly removed: boolean
  on<K extends keyof FilterEvents & string>(event: K, listener: (payload: FilterEvents[K]) => void): () => void
}

export interface FilterLoadEnv {
  engineVersion: string
  registry: SpecRegistry
  layerTypes: ReadonlyMap<string, LayerTypeImpl>
  loaders: ReadonlyMap<LoaderKind, AssetLoader>
  builtinUrl(name: string): string
  /** The engine's `assetsBaseUrl`, given to asset loaders (decoders). */
  assetsBaseUrl?: string
  fetchImpl: typeof fetch
  renderer: WebGLRenderer
  view: ObjectsView
  maxFaces: number
  /** Tracking data for bindings, updated by the engine every frame. */
  bindingData: BindingDataSource
  /** Seed of a filter activation (spec §12.5); `FilterInstance.reseed` derives the layer sequences from it. */
  seed(filterId: string): number
  warn(message: string): void
}

export interface LoadedLayer {
  readonly decl: LayerDecl
  readonly instance: LayerInstance
}

/** A filter's script (spec §12): its source, the values it gives the layers, the image assets of `f.asset()`. */
export interface FilterScript {
  readonly code: string
  readonly overrides: ScriptOverrides
  /** Names of the preloaded image assets given to the script (canvas layers, spec §12.6). */
  readonly images: readonly string[]
}

/** What the engine keeps for each filter of the stack. */
export class FilterInstance {
  readonly key: number
  readonly manifest: TManifest
  readonly source: string
  readonly params: ParamStore
  readonly layers: readonly LoadedLayer[]
  readonly assets: PreloadedAssets
  readonly warnings: readonly string[]
  /** Needs face tracking / blendshapes (spec §4.1, §16.2). */
  readonly needsFace: boolean
  readonly needsBlendshapes: boolean
  readonly events: Emitter<FilterEvents>
  /** Expression detectors with the filter's tuning (spec §13); only for face filters. */
  readonly expressions: ExpressionEventDetector | undefined
  /** A layer runs GPU code written by the filter's author (`LayerInstance.authorShader`). */
  readonly authorShader: boolean
  /** When that code was last drawn (`performance.now()`), or added to the stack: context loss suspects (spec §11). */
  lastAuthorDraw = -Infinity
  /** Seeded generators (spec §12.5): the filter's own (the script's `f.random()`, #26) and one per layer. */
  readonly random: SeededRandom
  readonly layerRandom: readonly SeededRandom[]
  #seed = 0
  /** The script (spec §12): its source and the values it gives the layers. Its host is started by the engine. */
  readonly script: FilterScript | undefined
  /** Set by the engine while the script runs. */
  host: ScriptHost | undefined
  enabled = true
  disposed = false

  constructor(init: {
    key: number
    manifest: TManifest
    source: string
    params: ParamStore
    layers: LoadedLayer[]
    assets: PreloadedAssets
    warnings: string[]
    onListenerError: (error: unknown) => void
    maxFaces: number
    seed: number
    random: SeededRandom
    layerRandom: readonly SeededRandom[]
    script?: FilterScript
  }) {
    this.key = init.key
    this.manifest = init.manifest
    this.source = init.source
    this.params = init.params
    this.layers = init.layers
    this.assets = init.assets
    this.warnings = init.warnings
    this.needsFace = !!init.manifest.requires.face
    this.needsBlendshapes = this.needsFace && (!!init.manifest.requires.blendshapes || usesBlendshapes(init.manifest))
    this.authorShader = init.layers.some((l) => l.instance.authorShader === true)
    this.events = new Emitter(init.onListenerError)
    this.expressions = this.needsFace ? new ExpressionEventDetector({ maxFaces: init.maxFaces, events: init.manifest.events }) : undefined
    this.random = init.random
    this.layerRandom = init.layerRandom
    this.reseed(init.seed)
    this.script = init.script
    // Changes are committed by `params.beginFrame`, at the start of a frame (spec §9).
    this.params.onChange((change) => this.events.emit('paramChange', change))
  }

  /** Seed of the current activation. */
  get seed(): number {
    return this.#seed
  }

  /** Restarts every generator of the filter from `seed` (a new activation, or a new source run). */
  reseed(seed: number): void {
    this.#seed = seed >>> 0
    this.random.reseed(deriveSeed(seed, 'filter'))
    this.layerRandom.forEach((r, i) => r.reseed(deriveSeed(seed, 'layer', i)))
    // The script's `f.random()` runs in its sandbox: it gets the new seed with the next frame it receives.
    this.host?.reseed(scriptSeed(seed))
  }

  /** Layers of a stage, in layer order. */
  *layersOf(stage: Stage): Iterable<LayerInstance> {
    for (const l of this.layers) if (l.instance.stage === stage) yield l.instance
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.host?.dispose()
    this.host = undefined
    for (const l of this.layers) {
      try {
        l.instance.dispose()
      } catch {
        // Keep releasing the others.
      }
    }
    this.assets.dispose()
    this.params.dispose()
    this.events.clear()
  }
}

/**
 * Loads, validates and instantiates a filter. Throws `InvalidManifestError`, `IncompatibleEngineError`,
 * `MissingPluginError`, `AssetError`, `InvalidParamError` (initial params) or `OuafError('unknown-layer-type')`.
 * Nothing is left allocated when it throws.
 */
export async function loadFilter(
  key: number,
  source: FilterSource,
  initialParams: Readonly<Record<string, unknown>> | undefined,
  env: FilterLoadEnv,
): Promise<FilterInstance> {
  const raw = await source.manifest()
  checkPlugins(raw, env.registry)

  const result = validateManifest(raw, env.registry)
  if (!result.ok) {
    throw new InvalidManifestError(source.label, result.errors, `Invalid filter manifest:\n${formatIssues(result, source.label)}`)
  }
  const manifest = raw as TManifest
  const warnings = result.warnings.map((w) => `${source.label}${w.path || '/'}: ${w.message}`)

  const range = manifest.engine ?? '^1'
  if (!satisfies(env.engineVersion, range)) throw new IncompatibleEngineError(manifest.id, range, env.engineVersion)
  let script: FilterScript | undefined
  if (manifest.script) {
    let code: string
    try {
      code = await (await source.file('script.js')).text()
    } catch (cause) {
      throw new OuafError('filter-load', `Filter "${manifest.id}": the manifest declares a script but script.js could not be read.`, { cause })
    }
    // The image assets `f.asset()` gives to the canvas layers' `draw` functions (spec §12.6).
    const images = env.layerTypes.has('canvas') ? scriptImageRefs(manifest, (kind) => env.loaders.has(kind as LoaderKind)) : []
    script = { code, overrides: new ScriptOverrides(), images }
  }

  // `apply: "reload"` parameters are applied at the next frame like live ones until the engine preloads and swaps
  // whole filters (ReloadHooks).
  const params = new ParamStore(manifest.params, { presets: manifest.presets, onError: (e) => env.warn(`Filter "${manifest.id}": ${String(e)}`) })
  if (initialParams) {
    // Initial values apply at once, without transitions.
    withParamErrors(manifest.id, () => params.setMany(initialParams, { transition: 0 }))
    params.beginFrame(0)
  }

  const decls = manifest.layers as unknown as LayerDecl[]
  const impls = decls.map((decl, i) => {
    const impl = env.layerTypes.get(decl.type)
    if (!impl) {
      throw new OuafError(
        'unknown-layer-type',
        `Filter "${manifest.id}", layer ${i}: no implementation of layer type "${decl.type}" is installed on this engine.`,
      )
    }
    return impl
  })
  const refs: string[] = [...(script?.images ?? [])]
  impls.forEach((impl, i) => {
    for (const ref of impl.assets?.(decls[i]!) ?? []) refs.push(ref)
  })
  const assets = await preloadAssets({
    source,
    assets: manifest.assets,
    refs,
    loaders: env.loaders,
    builtinUrl: env.builtinUrl,
    assetsBaseUrl: env.assetsBaseUrl,
    fetchImpl: env.fetchImpl,
  })

  // Seeded before the layers are created: a layer may draw in `create`.
  const seed = env.seed(manifest.id)
  const random = new SeededRandom(deriveSeed(seed, 'filter'))
  const layerRandom = decls.map((_, i) => new SeededRandom(deriveSeed(seed, 'layer', i)))
  const reader = bindingParams(params)
  // With a script, each layer gets its own registry of the properties the script can set (spec §12.4).
  const ctxOf = (i: number): LayerContext => ({
    random: layerRandom[i]!.next,
    filterId: manifest.id,
    renderer: env.renderer,
    view: env.view,
    assets,
    params,
    bindings: script ? { data: env.bindingData, params: reader, overrides: script.overrides.forLayer(i) } : { data: env.bindingData, params: reader },
    maxFaces: env.maxFaces,
    requiresFace: !!manifest.requires.face,
    warn: (message) => env.warn(`Filter "${manifest.id}": ${message}`),
  })
  const layers: LoadedLayer[] = []
  try {
    for (let i = 0; i < decls.length; i++) {
      const instance = await impls[i]!.create(decls[i]!, ctxOf(i))
      layers.push({ decl: decls[i]!, instance })
    }
  } catch (error) {
    for (const l of layers) l.instance.dispose()
    assets.dispose()
    params.dispose()
    throw error
  }
  return new FilterInstance({
    key,
    manifest,
    source: source.label,
    params,
    layers,
    assets,
    warnings,
    maxFaces: env.maxFaces,
    onListenerError: (e) => env.warn(String(e)),
    seed,
    random,
    layerRandom,
    ...(script ? { script } : {}),
  })
}

/**
 * Params as bindings read them (`{ "param": "name" }`): numbers and booleans from the animated components (a number
 * binding follows a running `transition`), everything else as committed.
 */
export function bindingParams(store: ParamStore): ParamsReader {
  return {
    type(name) {
      const i = store.indexOf(name)
      return i < 0 ? undefined : store.defAt(i).type
    },
    get(name) {
      const i = store.indexOf(name)
      if (i < 0) return undefined
      return store.defAt(i).type === 'number' ? store.numberAt(i) : store.valueAt(i)
    },
  }
}

/** `requires.plugins` against the installed plugins, before validation, for a precise error (spec §4.1). */
function checkPlugins(raw: unknown, registry: SpecRegistry): void {
  const m = raw as { id?: unknown; requires?: { plugins?: unknown } } | null
  const list = m?.requires?.plugins
  if (!Array.isArray(list)) return
  const id = typeof m?.id === 'string' ? m.id : 'unknown'
  for (const item of list) {
    if (typeof item !== 'string') continue
    const { name, range } = parsePluginRequirement(item)
    const installed = registry.plugins.get(name)
    if (installed === undefined || (range !== undefined && !satisfies(installed, range))) {
      throw new MissingPluginError(id, name, range, installed)
    }
  }
}

/** Seed of the script's `f.random()` for a filter activation seeded with `seed` (spec §12.5). */
export function scriptSeed(seed: number): number {
  return deriveSeed(seed, 'script')
}

/** A `face.blendshapes.*` binding anywhere in the layers, or a script reading them (spec §16.2). */
function usesBlendshapes(manifest: TManifest): boolean {
  const script = manifest.script
  if (script && (script.uses === undefined || script.uses.includes('face.blendshapes'))) return true
  return JSON.stringify(manifest.layers).includes('"face.blendshapes.')
}

/** Implements the public handle over a `FilterInstance`; stack operations go through the engine. */
export function createHandle(
  filter: FilterInstance,
  stack: {
    indexOf(f: FilterInstance): number
    move(f: FilterInstance, index: number): void
    remove(f: FilterInstance): void
    changed(): void
    send(f: FilterInstance, name: string, data: unknown): void
  },
): FilterHandle {
  return {
    key: filter.key,
    id: filter.manifest.id,
    manifest: filter.manifest,
    warnings: filter.warnings,
    get enabled() {
      return filter.enabled
    },
    set enabled(value: boolean) {
      if (filter.enabled === value) return
      filter.enabled = value
      stack.changed()
    },
    get index() {
      return stack.indexOf(filter)
    },
    get params() {
      return filter.params.values()
    },
    get presets() {
      return filter.params.presetNames
    },
    setParam(name, value, options) {
      withParamErrors(filter.manifest.id, () => filter.params.set(name, value, options))
    },
    setParams(values, options) {
      withParamErrors(filter.manifest.id, () => filter.params.setMany(values, options))
    },
    applyPreset(name, options) {
      withParamErrors(filter.manifest.id, () => filter.params.applyPreset(name, options))
    },
    setOptions(name, options) {
      withParamErrors(filter.manifest.id, () => filter.params.setOptions(name, options))
    },
    optionsOf(name) {
      return filter.params.optionsOf(name)
    },
    send(name, data) {
      stack.send(filter, name, data)
    },
    moveTo(index) {
      stack.move(filter, index)
    },
    remove() {
      stack.remove(filter)
    },
    get removed() {
      return filter.disposed
    },
    on(event, listener) {
      return filter.events.on(event, listener)
    },
  }
}
