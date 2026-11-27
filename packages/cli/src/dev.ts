/**
 * Serving filter folders to a dev page with hot reload (#36): the playground's Vite server uses it, and a future
 * `ouaf dev` can. A folder written as `filter.ts` / `filter.js` is packed in memory, as `ouaf pack` does, and its
 * package files (`manifest.json`, `script.js`, `assets/…`) are served at the folder's URL, so the engine loads it like
 * any filter folder. A folder with a `manifest.json` is left to static serving. Every folder gets a validation report,
 * for the page to show when a filter fails to load.
 *
 * Packing runs the author's `filter.ts` in `node:vm` (see `pack.ts`): serve only folders you trust.
 */
import { existsSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { packFolder, PackSourceError, type FilterPackResult } from './pack.ts'
import { formatReport } from './report.ts'
import { readZipEntries, readZipEntry } from './zip.ts'

/** Entry files of a source folder (spec §3.1). */
const ENTRIES = ['filter.ts', 'filter.js']

/** What a filter folder's validation says, for the dev page. */
export interface DevReport {
  ok: boolean
  /** `ouaf validate` / `ouaf pack` text output. */
  text: string
}

/** A file to send. */
export interface DevFile {
  body: Uint8Array
  /** HTTP status: 200, or 422 for the `manifest.json` of a folder that does not pack (its body is then the report). */
  status: 200 | 422
}

const isFile = (path: string) => existsSync(path) && statSync(path).isFile()

export class DevFilters {
  /** The folder served (`filters/`), absolute. */
  readonly root: string
  /** Packs in progress or done, by folder (relative to `root`, "/"-separated); dropped when a file changes. */
  readonly #packs = new Map<string, Promise<FilterPackResult | Error>>()

  constructor(root: string) {
    this.root = resolve(root)
  }

  /**
   * The filter that a file under `root` belongs to, relative to `root` ("/"-separated): a `.ouaf` package itself, or
   * the nearest folder holding `manifest.json`, `filter.ts` or `filter.js`. `undefined` outside `root` or any filter.
   */
  filterOf(file: string): string | undefined {
    const rel = relative(this.root, resolve(this.root, file))
    if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) return undefined
    if (rel.endsWith('.ouaf')) return rel.split(sep).join('/')
    let dir = isFile(join(this.root, rel)) || !existsSync(join(this.root, rel)) ? dirname(rel) : rel
    while (dir !== '.' && dir !== '') {
      if (['manifest.json', ...ENTRIES].some((name) => isFile(join(this.root, dir, name)))) return dir.split(sep).join('/')
      dir = dirname(dir)
    }
    return undefined
  }

  /** A file of `filter` (`filterOf`) changed: its next request packs it again. */
  invalidate(filter: string): void {
    this.#packs.delete(filter)
  }

  /** Is `folder` (relative to `root`) a source folder: `filter.ts` or `filter.js`, no `manifest.json`? */
  isSource(folder: string): boolean {
    const dir = join(this.root, folder)
    return !isFile(join(dir, 'manifest.json')) && ENTRIES.some((name) => isFile(join(dir, name)))
  }

  /**
   * The file at `path` (relative to `root`, "/"-separated) when it belongs to a source folder: from the package
   * packed in memory. `undefined` when static serving answers it (not a source folder, or a file the package does
   * not have).
   */
  async file(path: string): Promise<DevFile | undefined> {
    const folder = this.filterOf(path)
    if (folder === undefined || folder.endsWith('.ouaf') || !this.isSource(folder)) return undefined
    const name = path.slice(folder.length + 1)
    const packed = await this.#pack(folder)
    if (packed instanceof Error || !packed.zip) {
      return name === 'manifest.json' ? { status: 422, body: new TextEncoder().encode(this.#text(folder, packed)) } : undefined
    }
    const entry = readZipEntries(packed.zip).find((e) => e.name === name)
    return entry ? { status: 200, body: readZipEntry(packed.zip, entry) } : undefined
  }

  /** The validation report of a filter folder (relative to `root`), packed as `ouaf pack` does; a `.ouaf` is not checked. */
  async report(folder: string): Promise<DevReport> {
    if (folder.endsWith('.ouaf') || !existsSync(join(this.root, folder))) return { ok: false, text: `${folder}: no such filter folder.` }
    const packed = await this.#pack(folder)
    return { ok: !(packed instanceof Error) && packed.report.ok, text: this.#text(folder, packed) }
  }

  #text(folder: string, packed: FilterPackResult | Error): string {
    return packed instanceof Error ? `${folder}: ${packed.message}` : formatReport({ ...packed.report, input: folder })
  }

  #pack(folder: string): Promise<FilterPackResult | Error> {
    let p = this.#packs.get(folder)
    if (!p) {
      p = packFolder(join(this.root, folder), { label: folder }).catch((e: unknown) => {
        if (e instanceof PackSourceError) return e
        throw e
      })
      this.#packs.set(folder, p)
      // A pack that throws is not kept: the next request tries again.
      p.catch(() => this.#packs.delete(folder))
    }
    return p
  }
}
