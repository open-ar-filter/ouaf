/**
 * The files a host gives a filter's `asset` parameters (spec §9), for the content properties bound to them
 * (`{ "param": "logo" }`). A host file is untrusted input, checked like a package asset (spec §15):
 *
 * 1. its declared type and size when it is set (`checkParamValue`: `accept`, `maxSize`, the package size limit);
 * 2. its **content** when it is loaded: the format sniffed from its first bytes must be one of the `accept` types the
 *    property can show (`hostFileProblem`), whatever type the file declares;
 * 3. then the asset loader of its kind, with the checks it applies to package files: image dimensions read from the
 *    header before decoding, SVG drawn as an image (no script, no external resource), glTF without external files,
 *    `.cube` syntax…
 *
 * A file that fails is refused with an `InvalidParamError` (reason `content`), and the parameter keeps its previous
 * file. A file that passes is swapped in at the start of a frame (`ParamStore` asset hooks), and the one it replaces is
 * disposed once that frame is drawn.
 */
import { CONTENT_KINDS, hostFileProblem, sniff, type ContentKind, type TParams } from '@ouaf/spec'
import type { AssetFile, AssetParamHooks } from '../params/index.ts'
import type { AssetLoader, LoaderKind } from './assets.ts'
import { AssetError, InvalidParamError } from './errors.ts'
import type { HostAssetReader } from './layer-type.ts'

/** Bytes read to identify a file (a JPEG's frame header can come after a large EXIF block). */
const HEADER_BYTES = 1 << 20

/** The loader kind that loads a host file for a content property of each kind. */
const LOADER_KIND: Readonly<Record<ContentKind, LoaderKind>> = { image: 'image', model: 'model', font: 'font', lut: 'lut' }

interface Loaded {
  readonly loader: AssetLoader
  readonly value: unknown
}

export interface HostAssetsOptions {
  filterId: string
  params: Readonly<TParams> | undefined
  /** Asset parameters bound to a content property, with the kind it shows. */
  bound: ReadonlyMap<string, ContentKind>
  loaders: ReadonlyMap<LoaderKind, AssetLoader>
  assetsBaseUrl?: string | undefined
}

export class HostAssets implements HostAssetReader, AssetParamHooks<Loaded> {
  readonly #o: HostAssetsOptions
  readonly #current = new Map<string, Loaded>()
  /** Replaced values, disposed once the frame that swapped them is drawn. */
  #retired: Loaded[] = []
  #timer: ReturnType<typeof setTimeout> | undefined
  #disposed = false

  constructor(options: HostAssetsOptions) {
    this.#o = options
  }

  get(name: string): unknown {
    return this.#current.get(name)?.value ?? null
  }

  handles(name: string): boolean {
    return this.#o.bound.has(name)
  }

  async load(name: string, file: AssetFile, signal: AbortSignal): Promise<Loaded> {
    const kind = this.#o.bound.get(name)!
    const def = this.#o.params?.[name]
    const accept = def?.type === 'asset' ? def.accept : []
    const label = typeof File !== 'undefined' && file instanceof File && file.name ? `"${file.name}"` : 'the file'
    const refuse = (why: string, cause?: unknown): never => {
      throw new InvalidParamError(`Filter "${this.#o.filterId}": Invalid value for parameter "${name}": ${why}`,
        { param: name, reason: 'content', ...(cause === undefined ? {} : { cause }) })
    }
    if (!(file instanceof Blob)) refuse('expected a File or a Blob.')
    const blob = file as Blob
    const info = sniff(new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer()))
    const problem = hostFileProblem(kind, accept, info)
    if (problem) refuse(`${label}: ${problem}`)
    const loaderKind = LOADER_KIND[kind]
    const loader = this.#o.loaders.get(loaderKind)
    if (!loader) refuse(`this engine has no loader for ${CONTENT_KINDS[kind].label} (the plugin providing it is not installed).`)
    let value: unknown
    try {
      value = await loader!.load({
        ref: name,
        kind: loaderKind,
        entry: undefined,
        // What loaders name the file in their messages: its name, or the parameter for a Blob without one.
        path: label === 'the file' ? name : label.slice(1, -1),
        builtin: false,
        assetsBaseUrl: this.#o.assetsBaseUrl,
        read: () => Promise.resolve(blob),
        signal,
      })
    } catch (cause) {
      // The loaders' messages name the file (its `path`) and the rule it breaks.
      if (cause instanceof AssetError) refuse(cause.message, cause)
      refuse(`${label} could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`, cause)
    }
    return { loader: loader!, value }
  }

  swap(name: string, loaded: Loaded | null): void {
    const old = this.#current.get(name)
    if (loaded) this.#current.set(name, loaded)
    else this.#current.delete(name)
    if (!old) return
    // Layers switch to the new value in this frame's update; the old one is released once the frame is drawn.
    this.#retired.push(old)
    this.#timer ??= setTimeout(() => this.#flush(), 0)
  }

  discard(loaded: Loaded): void {
    release(loaded)
  }

  /** Releases every loaded file. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    for (const l of [...this.#retired, ...this.#current.values()]) release(l)
    this.#retired = []
    this.#current.clear()
  }

  #flush(): void {
    this.#timer = undefined
    const retired = this.#retired
    this.#retired = []
    for (const l of retired) release(l)
  }
}

function release(l: Loaded): void {
  try {
    l.loader.dispose?.(l.value)
  } catch {
    // Keep releasing the others.
  }
}
