/**
 * Content properties (spec §8, §9, §12.4): `sticker.src`, `model.src`, `text.font`, `color.lut`, whose value is an
 * asset. Each is compiled once when the layer is created and evaluated per face every frame, like a binding:
 *
 * | Value                                | Shows                                                                   |
 * |--------------------------------------|-------------------------------------------------------------------------|
 * | an asset reference, `{ pick }`…      | the manifest's asset: the layer resolves it (`evaluate` → `undefined`) |
 * | `{ param }` of an `asset` parameter  | the host's file, loaded and checked (`hostAssets`); `null` without one |
 * | `{ param, map }` of a `select`…      | the preloaded asset `map` gives for the value; `null` when unmapped     |
 *
 * In a filter with a script, `.set({ src: "<asset name>" })` replaces any of them, per face or for every instance,
 * until the script sets `null` (spec §12.4). The names a script may set are those of the declared assets the property
 * shows: the engine preloads them (`contentRefs`). Evaluating allocates nothing.
 */
import { CONTENT_KINDS, assetKind, contentProperties, isAssetBinding, type ContentKind, type SpecRegistry, type TAssets } from '@ouaf/spec'
import type { ContentOverride } from '../bindings/types.ts'
import { OuafError } from './errors.ts'
import type { LayerContext, LayerDecl } from './layer-type.ts'

/** A content property of a layer, as the layer compiles it. */
export interface ContentProperty<T> {
  /** Property name, as a script sets it (`src`). */
  readonly name: string
  /** Location in the manifest, for messages (`layer "logo".src`). */
  readonly path: string
  /** Whether a loaded asset is one the property shows (the loader's value of its kinds). */
  accepts(value: unknown): value is T
  /** What the property shows, in messages: "an image, spritesheet or video". */
  readonly what: string
}

/** A compiled content property. */
export interface ContentBinding<T> {
  /** Bound to a parameter: the manifest value is not an asset of its own. */
  readonly bound: boolean
  /**
   * What face slot `face` (or `NO_FACE`) shows: a loaded asset, `null` for none (an asset parameter without a file, a
   * value `map` does not list), or `undefined` for the manifest's own asset (a fixed reference or a `{ pick }`, which
   * the layer resolves).
   */
  evaluate(face: number): T | null | undefined
}

/** An asset name a script can set (spec §12.4): a name of the `assets` table, not a path or `builtin:`. */
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export function compileContent<T>(value: unknown, property: ContentProperty<T>, ctx: LayerContext): ContentBinding<T> {
  const { assets } = ctx
  const override: ContentOverride | undefined = ctx.bindings.overrides?.content?.(property.name, (name) =>
    NAME.test(name) && assets.has(name) && property.accepts(assets.get(name))
      ? undefined
      : `no asset named "${name}" is declared in "assets" as ${property.what}`,
  )
  const base = compileBase(value, property, ctx)
  return {
    bound: base !== undefined,
    evaluate(face) {
      const name = override?.get(face)
      if (name !== undefined) return assets.get<T>(name)
      return base === undefined ? undefined : base()
    },
  }
}

function compileBase<T>(value: unknown, property: ContentProperty<T>, ctx: LayerContext): (() => T | null) | undefined {
  if (!isAssetBinding(value)) return undefined
  const fail = (why: string): never => {
    throw new OuafError('asset', `Filter "${ctx.filterId}", ${property.path}: ${why}`)
  }
  const name = value.param
  const params = ctx.params
  const index = params.indexOf(name)
  if (index < 0) fail(`unknown parameter "${name}".`)
  const type = params.defAt(index).type
  if (type === 'asset') {
    const host = ctx.hostAssets
    return () => {
      const v = host?.get(name)
      return v !== null && v !== undefined && property.accepts(v) ? v : null
    }
  }
  if ((type !== 'select' && type !== 'string') || value.map === undefined) {
    fail(`parameter "${name}" (${type}) cannot choose an asset: bind an "asset" parameter, or a "select" or "string" parameter with "map".`)
  }
  const table = new Map<string, T>()
  for (const [key, ref] of Object.entries(value.map!)) {
    const asset = ctx.assets.get(ref)
    if (!property.accepts(asset)) fail(`"map" gives "${ref}" for "${key}", which is not ${property.what}.`)
    table.set(key, asset as T)
  }
  return () => {
    const v = params.valueAt(index)
    return typeof v === 'string' ? (table.get(v) ?? null) : null
  }
}

/** The content properties of a layer declaration: property, kind and value (`registry` gives the type's schema). */
export function layerContent(decl: LayerDecl, registry: SpecRegistry): Array<{ name: string; kind: ContentKind; value: unknown }> {
  const def = registry.layers.get(decl.type)
  if (!def) return []
  return contentProperties(def.schema).map(([name, kind]) => ({ name, kind, value: decl[name] }))
}

/**
 * The assets the content properties of `decls` need preloaded besides their fixed references: every `map` value and,
 * with a script, every declared asset of a kind a content property of the filter shows (a script may set any of them,
 * spec §12.4). `loadable` tells whether the engine has a loader for a declared asset.
 */
export function contentRefs(
  decls: readonly LayerDecl[],
  registry: SpecRegistry,
  assets: Readonly<TAssets> | undefined,
  scripted: boolean,
  loadable: (name: string) => boolean,
): string[] {
  const refs: string[] = []
  const kinds = new Set<string>()
  for (const decl of decls) {
    for (const p of layerContent(decl, registry)) {
      for (const k of CONTENT_KINDS[p.kind].kinds) kinds.add(k)
      if (isAssetBinding(p.value) && p.value.map) refs.push(...Object.values(p.value.map))
    }
  }
  if (scripted) {
    for (const [name, entry] of Object.entries(assets ?? {})) {
      const kind = assetKind(entry)
      if (kind !== undefined && kinds.has(kind) && loadable(name)) refs.push(name)
    }
  }
  return refs
}

/** The `asset` parameters content properties are bound to, with the kind each shows (the first binding decides). */
export function boundAssetParams(decls: readonly LayerDecl[], registry: SpecRegistry, params: Readonly<Record<string, { type: string }>> | undefined): Map<string, ContentKind> {
  const bound = new Map<string, ContentKind>()
  for (const decl of decls) {
    for (const p of layerContent(decl, registry)) {
      if (!isAssetBinding(p.value) || p.value.map !== undefined) continue
      const def = params?.[p.value.param]
      if (def?.type === 'asset' && !bound.has(p.value.param)) bound.set(p.value.param, p.kind)
    }
  }
  return bound
}
