/**
 * Loading a filter (validation, compatibility, plugins, assets, layer instances) and the public `FilterHandle`.
 */
import { formatIssues, validateManifest, type SpecRegistry, type Stage, type TManifest } from '@ouaf/spec'
import { satisfies } from './semver.ts'
import { Emitter } from './emitter.ts'
import { IncompatibleEngineError, InvalidManifestError, MissingPluginError, OuafError } from './errors.ts'
import { preloadAssets, type AssetLoader, type FilterSource, type LoaderKind, type PreloadedAssets } from './assets.ts'
import type { LayerContext, LayerDecl, LayerInstance, LayerTypeImpl, ObjectsView } from './layer-type.ts'
import { SimpleParams, type FilterParams, type ParamChange, type ParamValue } from './params.ts'
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
  /** Current parameter values. */
  readonly params: Readonly<Record<string, ParamValue>>
  /** Validates and queues a change, applied at the start of the next frame. Throws `InvalidParamError`. */
  setParam(name: string, value: unknown): void
  /** Like `setParam` for several values, all or nothing. */
  setParams(values: Readonly<Record<string, unknown>>): void
  /** Applies a named preset (spec §9). Throws `InvalidParamError` for an unknown preset. */
  applyPreset(name: string): void
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
  readonly params: FilterParams
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
    params: FilterParams
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

  const params = new SimpleParams(manifest.id, manifest.params ?? {}, manifest.presets ?? {}, initialParams ?? {})

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
    throw error
  }
  return new FilterInstance({ key, manifest, source: source.label, params, layers, assets, warnings, onListenerError: (e) => env.warn(String(e)) })
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
      return filter.params.snapshot()
    },
    setParam(name, value) {
      filter.params.set({ [name]: value })
    },
    setParams(values) {
      filter.params.set(values)
    },
    applyPreset(name) {
      filter.params.applyPreset(name)
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
