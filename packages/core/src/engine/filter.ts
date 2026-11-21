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
import { ParamStore, type ParamChange, type ParamValue, type SelectOptions, type SetParamOptions } from '../params/index.ts'
import { parsePluginRequirement } from './plugin.ts'
import type { WebGLRenderer } from 'three'

/** Events of a filter handle. */
export interface FilterEvents extends Record<string, unknown> {
  /** A parameter changed (applied at the start of a frame, spec §9). */
  paramChange: ParamChange
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
  fetchImpl: typeof fetch
  renderer: WebGLRenderer
  view: ObjectsView
  maxFaces: number
  /** Tracking data for bindings, updated by the engine every frame. */
  bindingData: BindingDataSource
  warn(message: string): void
}

export interface LoadedLayer {
  readonly decl: LayerDecl
  readonly instance: LayerInstance
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
    this.events = new Emitter(init.onListenerError)
    // Changes are committed by `params.beginFrame`, at the start of a frame (spec §9).
    this.params.onChange((change) => this.events.emit('paramChange', change))
  }

  /** Layers of a stage, in layer order. */
  *layersOf(stage: Stage): Iterable<LayerInstance> {
    for (const l of this.layers) if (l.instance.stage === stage) yield l.instance
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
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
  if (manifest.script) {
    warnings.push(`${source.label}/script: scripts are not supported by this engine version yet (#26); the script is ignored.`)
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
  const refs: string[] = []
  impls.forEach((impl, i) => {
    for (const ref of impl.assets?.(decls[i]!) ?? []) refs.push(ref)
  })
  const assets = await preloadAssets({
    source,
    assets: manifest.assets,
    refs,
    loaders: env.loaders,
    builtinUrl: env.builtinUrl,
    fetchImpl: env.fetchImpl,
  })

  const ctx: LayerContext = {
    filterId: manifest.id,
    renderer: env.renderer,
    view: env.view,
    assets,
    params,
    bindings: { data: env.bindingData, params: bindingParams(params) },
    maxFaces: env.maxFaces,
    warn: (message) => env.warn(`Filter "${manifest.id}": ${message}`),
  }
  const layers: LoadedLayer[] = []
  try {
    for (let i = 0; i < decls.length; i++) {
      const instance = await impls[i]!.create(decls[i]!, ctx)
      layers.push({ decl: decls[i]!, instance })
    }
  } catch (error) {
    for (const l of layers) l.instance.dispose()
    assets.dispose()
    params.dispose()
    throw error
  }
  return new FilterInstance({ key, manifest, source: source.label, params, layers, assets, warnings, onListenerError: (e) => env.warn(String(e)) })
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

/** A `face.blendshapes.*` binding anywhere in the layers, or a script reading them (spec §16.2). */
function usesBlendshapes(manifest: TManifest): boolean {
  const script = manifest.script
  if (script && (script.uses === undefined || script.uses.includes('face.blendshapes'))) return true
  return JSON.stringify(manifest.layers).includes('"face.blendshapes.')
}

/** Implements the public handle over a `FilterInstance`; stack operations go through the engine. */
export function createHandle(
  filter: FilterInstance,
  stack: { indexOf(f: FilterInstance): number; move(f: FilterInstance, index: number): void; remove(f: FilterInstance): void; changed(): void },
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
