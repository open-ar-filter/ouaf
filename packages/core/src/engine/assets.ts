/**
 * Where a filter's files come from, and how its assets are resolved and preloaded (spec §10).
 *
 * - A `FilterSource` reads `manifest.json` and the package files: a folder served over HTTP (`urlSource`), files in
 *   memory (`memorySource`), or a `.ouaf` package (`packageSource`, `fetchPackage` in `package.ts`).
 * - Asset references (`src`, `font`, `lut`, `textures`…) are resolved to a name of the `assets` table, an `assets/…`
 *   path, or a `builtin:…` resource; anything else (remote URLs, `data:`…) is refused (spec §10.1, §15.4), even though
 *   the validator already rejects it.
 * - Loaders are registered per asset kind by plugins (the sticker plugin brings images and videos, the model plugin
 *   glTF…). Every referenced asset is loaded before the filter is activated (spec §10.4).
 */
import type { TAssetEntry, TAssetKind, TAssets } from '@ouaf/spec'
import { kindFromPath } from '@ouaf/spec'
import type { WebGLRenderer } from 'three'
import { AssetError, OuafError } from './errors.ts'

export interface FilterSource {
  /** URL or label, for messages. */
  readonly label: string
  /** The parsed `manifest.json` (not validated yet). */
  manifest(): Promise<unknown>
  /** A package file by its path (`assets/hat.glb`). */
  file(path: string, signal?: AbortSignal): Promise<Blob>
}

/** A filter folder served over HTTP: `<base>/manifest.json`, `<base>/assets/…`. `url` is the folder or its manifest. */
export function urlSource(url: string | URL, fetchImpl: typeof fetch = fetch): FilterSource {
  // Relative URLs resolve against the page.
  const absolute = new URL(String(url), globalThis.location?.href)
  if (!absolute.pathname.endsWith('.json') && !absolute.pathname.endsWith('/')) absolute.pathname += '/'
  const manifestUrl = absolute.pathname.endsWith('.json') ? absolute : new URL('manifest.json', absolute)
  const base = new URL('.', manifestUrl)
  const get = async (target: URL, signal?: AbortSignal): Promise<Response> => {
    let res: Response
    try {
      res = await fetchImpl(target, signal ? { signal } : undefined)
    } catch (cause) {
      throw new OuafError('filter-load', `Could not fetch ${target.href}.`, { cause })
    }
    if (!res.ok) throw new OuafError('filter-load', `Could not fetch ${target.href}: HTTP ${res.status}.`)
    // Dev servers with an SPA fallback answer a missing file with the index page.
    if (res.headers.get('content-type')?.includes('text/html')) {
      throw new OuafError('filter-load', `Could not fetch ${target.href}: the server returned an HTML page (missing file, or a server that does not serve this folder?).`)
    }
    return res
  }
  return {
    label: manifestUrl.href,
    async manifest() {
      const res = await get(manifestUrl)
      const text = await res.text()
      try {
        return JSON.parse(text) as unknown
      } catch (cause) {
        throw new OuafError('filter-load', `${manifestUrl.href} is not valid JSON.`, { cause })
      }
    },
    async file(path, signal) {
      return (await get(new URL(path, base), signal)).blob()
    },
  }
}

export interface MemorySourceInit {
  manifest: unknown
  /** Package files by path (`assets/hat.png`). */
  files?: Readonly<Record<string, Blob | string | ArrayBuffer | Uint8Array<ArrayBuffer>>>
  label?: string
}

/** A filter held in memory (tests, editors). A `.ouaf` package is read by `packageSource`. */
export function memorySource(init: MemorySourceInit): FilterSource {
  const files = init.files ?? {}
  return {
    label: init.label ?? 'memory',
    manifest: () => Promise.resolve(structuredClone(init.manifest)),
    file(path) {
      const data = Object.hasOwn(files, path) ? files[path] : undefined
      if (data === undefined) return Promise.reject(new OuafError('filter-load', `${init.label ?? 'memory'}: no file "${path}" in the package.`))
      return Promise.resolve(data instanceof Blob ? data : new Blob([data]))
    },
  }
}

/** Kinds a loader can handle: the format's asset kinds, plus `emoji` assets (`{ "emoji": "😎" }`). */
export type LoaderKind = TAssetKind | 'emoji'

/** What a loader gets for one asset. */
export interface AssetRequest {
  /** The reference as written (`hat`, `assets/hat.glb`, `builtin:lut/noir`). */
  readonly ref: string
  readonly kind: LoaderKind
  /** The `assets` table entry, when the reference is a name (`frames`, `alpha`… live there). */
  readonly entry: TAssetEntry | undefined
  /** Path inside the package or built-in name; the emoji itself for `emoji`. */
  readonly path: string
  readonly builtin: boolean
  /**
   * The engine's `assetsBaseUrl`, where the host serves the engine's own files (decoders: `draco/`, `basis/`).
   * Undefined when assets are loaded outside an engine (tests, tools).
   */
  readonly assetsBaseUrl?: string
  /**
   * The engine's renderer, for loaders that prepare GPU data for it (KTX2 textures are transcoded to a format it
   * supports). Undefined when assets are loaded outside an engine.
   */
  readonly renderer?: WebGLRenderer
  /** Reads the file (package file, built-in resource, or the inline SVG as an `image/svg+xml` blob). */
  read(): Promise<Blob>
  readonly signal: AbortSignal
}

export interface AssetLoader<T = unknown> {
  readonly kinds: readonly LoaderKind[]
  load(request: AssetRequest): Promise<T>
  /** Releases a loaded value (GPU textures…) when its filter is removed. */
  dispose?(value: T): void
}

/** The preloaded assets of a filter, by reference. */
export interface LoadedAssets {
  /** The loaded value of a reference given to `LayerTypeImpl.assets`; throws `AssetError` for any other. */
  get<T = unknown>(ref: string): T
  has(ref: string): boolean
}

export interface ResolvedAsset {
  kind: LoaderKind
  entry: TAssetEntry | undefined
  path: string
  builtin: boolean
  /** Inline content: SVG markup or the emoji. */
  inline?: string
}

const BUILTIN_KINDS: Readonly<Record<string, TAssetKind>> = { font: 'font', lut: 'lut' }

/** Resolves a reference against the manifest's `assets` table (spec §10.1). Throws `AssetError`. */
export function resolveAssetRef(ref: string, assets: Readonly<TAssets> | undefined): ResolvedAsset {
  if (ref.startsWith('builtin:')) {
    const name = ref.slice('builtin:'.length)
    const kind = BUILTIN_KINDS[name.split('/')[0] ?? '']
    if (!kind) throw new AssetError(ref, `Unknown built-in resource "${ref}".`)
    return { kind, entry: undefined, path: name, builtin: true }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) {
    throw new AssetError(ref, `Asset reference "${ref}" is not local: remote and inline URLs are forbidden (spec §10.1).`)
  }
  if (ref.startsWith('assets/')) {
    if (ref.includes('..')) throw new AssetError(ref, `Asset path "${ref}" must not contain "..".`)
    const kind = kindFromPath(ref)
    if (!kind) throw new AssetError(ref, `Cannot tell the kind of asset "${ref}" from its extension; declare it in "assets" with a "kind".`)
    return { kind, entry: undefined, path: ref, builtin: false }
  }
  const entry = assets && Object.hasOwn(assets, ref) ? assets[ref] : undefined
  if (entry === undefined) throw new AssetError(ref, `Unknown asset "${ref}": declare it in "assets" or use an "assets/…" path.`)
  if (typeof entry === 'string') return { ...resolveAssetRef(entry, undefined), entry }
  if ('svg' in entry) return { kind: 'image', entry, path: `${ref}.svg`, builtin: false, inline: entry.svg }
  if ('emoji' in entry) return { kind: 'emoji', entry, path: entry.emoji, builtin: false, inline: entry.emoji }
  const kind = entry.kind ?? (entry.frames ? 'spritesheet' : kindFromPath(entry.src))
  if (!kind) throw new AssetError(ref, `Cannot tell the kind of asset "${ref}" from "${entry.src}"; add a "kind".`)
  return { kind, entry, path: entry.src, builtin: false }
}

export interface PreloadOptions {
  source: FilterSource
  assets: Readonly<TAssets> | undefined
  refs: Iterable<string>
  loaders: ReadonlyMap<LoaderKind, AssetLoader>
  /** URL of a built-in resource (`font/sans`, `lut/noir`). */
  builtinUrl: (name: string) => string
  /** Given to loaders (`AssetRequest.assetsBaseUrl`). */
  assetsBaseUrl?: string
  /** Given to loaders (`AssetRequest.renderer`). */
  renderer?: WebGLRenderer
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export interface PreloadedAssets extends LoadedAssets {
  dispose(): void
}

/** Loads every reference (each once), in parallel. Rejects with the first `AssetError`; nothing is kept then. */
export async function preloadAssets(options: PreloadOptions): Promise<PreloadedAssets> {
  const { source, loaders } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const signal = options.signal ?? new AbortController().signal
  const refs = [...new Set(options.refs)]
  const loaded = new Map<string, { value: unknown; loader: AssetLoader }>()

  const results = await Promise.allSettled(
    refs.map(async (ref) => {
      const r = resolveAssetRef(ref, options.assets)
      const loader = loaders.get(r.kind)
      if (!loader) throw new AssetError(ref, `No loader for ${r.kind} assets ("${ref}"): the plugin providing them is not installed.`)
      const read = async (): Promise<Blob> => {
        if (r.inline !== undefined) return new Blob([r.inline], { type: r.kind === 'image' ? 'image/svg+xml' : 'text/plain' })
        if (r.builtin) {
          const url = options.builtinUrl(r.path)
          const res = await fetchImpl(url, { signal })
          if (!res.ok) throw new AssetError(ref, `Could not load built-in resource "${ref}" from ${url}: HTTP ${res.status}.`)
          return res.blob()
        }
        return source.file(r.path, signal)
      }
      try {
        const { assetsBaseUrl, renderer } = options
        const { kind, entry, path, builtin } = r
        const value = await loader.load({ ref, kind, entry, path, builtin, assetsBaseUrl, renderer, read, signal })
        loaded.set(ref, { value, loader })
      } catch (cause) {
        if (cause instanceof AssetError) throw cause
        throw new AssetError(ref, `Could not load asset "${ref}" (${r.path}): ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
      }
    }),
  )
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  const disposeAll = () => {
    for (const { value, loader } of loaded.values()) loader.dispose?.(value)
    loaded.clear()
  }
  if (failure) {
    disposeAll()
    throw failure.reason
  }
  return {
    get<T>(ref: string): T {
      const hit = loaded.get(ref)
      if (!hit) throw new AssetError(ref, `Asset "${ref}" was not preloaded: list it in the layer type's assets().`)
      return hit.value as T
    },
    has: (ref) => loaded.has(ref),
    dispose: disposeAll,
  }
}

/** Loaders the core provides itself: JSON data and shader sources. */
export const CORE_LOADERS: readonly AssetLoader[] = [
  {
    kinds: ['data'],
    async load(r) {
      const text = await (await r.read()).text()
      try {
        return JSON.parse(text) as unknown
      } catch (cause) {
        throw new AssetError(r.ref, `Asset "${r.ref}" (${r.path}) is not valid JSON.`, { cause })
      }
    },
  },
  {
    kinds: ['shader'],
    async load(r) {
      return (await r.read()).text()
    },
  },
]
