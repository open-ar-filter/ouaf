/**
 * Reader of `.ouaf` packages (spec §3) in the browser: a zip archive turned into a `FilterSource`, without dependency
 * (`DecompressionStream('deflate-raw')` inflates).
 *
 * - The archive structure is checked when the package is opened, with the rules `ouaf validate` applies
 *   (`@ouaf/spec`: `readZipEntries`, `checkPackageEntries`, `checkPackageSize`): no links or special entries, no
 *   absolute path or `..`, no duplicate entry, at most `PACKAGE_MAX_ENTRIES` entries, at most `PACKAGE_MAX_BYTES`
 *   for the archive and for its files unpacked (declared sizes), only stored and deflated entries, and a
 *   `manifest.json` at the root. Regular files outside the layout (`manifest.json`, `script.js`, `assets/`) are
 *   ignored (spec §3). Any of these fails with a `PackageError`.
 * - Entries are inflated lazily, when the engine reads them (`file(path)`): the archive (≤ 50 MB) stays in memory
 *   while the filter loads, and only the files the filter uses are inflated, one at a time, instead of the whole
 *   package next to the archive. The engine preloads every asset before activating a filter (spec §10.4), so a
 *   corrupt entry still fails `addFilter`. The source is dropped once the filter is loaded.
 * - Zip bombs: the declared sizes are bounded at open time, and inflating an entry stops as soon as it goes past its
 *   declared size. Each entry's size and CRC-32 are checked.
 */
import {
  checkPackageEntries, checkPackageSize, formatBytes, missingManifestHint, PACKAGE_MAX_BYTES, readZipEntries, ZIP_STORED,
  zipEntryData, zipEntryType, ZipError, type ZipEntry,
} from '@ouaf/spec'
import type { FilterSource } from './assets.ts'
import { OuafError, PackageError } from './errors.ts'

/** A `.ouaf` package in memory: a `Blob` (a `File` from a file picker or a drop) or its bytes. */
export type PackageInput = Blob | ArrayBuffer | Uint8Array

/** Bytes over an `ArrayBuffer` (not shared), as streams and `Blob` take them. */
type Bytes = Uint8Array<ArrayBuffer>

export interface PackageSourceOptions {
  /** For messages: defaults to the file name of a `File`, else "package.ouaf". */
  label?: string
}

/** True for a URL whose path ends with `.ouaf`: `addFilter` loads it as a package, not as a folder. */
export function isPackageUrl(url: string | URL): boolean {
  const absolute = new URL(String(url), globalThis.location?.href)
  return absolute.pathname.toLowerCase().endsWith('.ouaf')
}

/**
 * Opens a `.ouaf` package. Rejects with `PackageError` (code `invalid-package`) when the archive breaks a package
 * rule; entries are inflated later, when read.
 */
export async function packageSource(input: PackageInput, options: PackageSourceOptions = {}): Promise<FilterSource> {
  const label = options.label ?? (typeof File !== 'undefined' && input instanceof File ? input.name : 'package.ouaf')
  let zip: Bytes
  if (input instanceof Blob) {
    checkArchiveSize(label, input.size)
    zip = new Uint8Array<ArrayBuffer>(await input.arrayBuffer())
  } else {
    checkArchiveSize(label, input.byteLength)
    // A copy: the host may reuse or transfer its buffer while the filter loads.
    zip = input instanceof ArrayBuffer ? new Uint8Array<ArrayBuffer>(input.slice(0)) : input.slice()
  }
  return openPackage(zip, label)
}

/** Downloads a package (the only request a package source makes), refusing it past `PACKAGE_MAX_BYTES`. */
export async function fetchPackage(url: string | URL, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<FilterSource> {
  const target = new URL(String(url), globalThis.location?.href)
  const label = target.href
  let res: Response
  try {
    res = await fetchImpl(target, signal ? { signal } : undefined)
  } catch (cause) {
    throw new OuafError('filter-load', `Could not fetch ${label}.`, { cause })
  }
  if (!res.ok) throw new OuafError('filter-load', `Could not fetch ${label}: HTTP ${res.status}.`)
  if (res.headers.get('content-type')?.includes('text/html')) {
    throw new OuafError('filter-load', `Could not fetch ${label}: the server returned an HTML page (missing file, or a server that does not serve .ouaf files?).`)
  }
  const length = Number(res.headers.get('content-length'))
  if (length > 0) checkArchiveSize(label, length)
  let zip: Bytes
  try {
    zip = await readBody(res, label)
  } catch (cause) {
    if (cause instanceof OuafError) throw cause
    throw new OuafError('filter-load', `Could not fetch ${label}.`, { cause })
  }
  return openPackage(zip, label)
}

/** The response body, stopping as soon as it goes past the package limit (a missing or false `Content-Length`). */
async function readBody(res: Response, label: string): Promise<Bytes> {
  if (!res.body) {
    const bytes = new Uint8Array<ArrayBuffer>(await res.arrayBuffer())
    checkArchiveSize(label, bytes.length)
    return bytes
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > PACKAGE_MAX_BYTES) {
      void reader.cancel()
      checkArchiveSize(label, total)
    }
    chunks.push(value)
  }
  return concat(chunks, total)
}

function checkArchiveSize(label: string, bytes: number): void {
  const [problem] = checkPackageSize({ entries: 0, bytes: 0, archiveBytes: bytes })
  if (problem) throw new PackageError(label, problem.code, '', `${problem.message} ${problem.hint}`)
}

function zipError(label: string, error: unknown, path = ''): never {
  if (error instanceof ZipError) throw new PackageError(label, error.code, path, `${error.message} Rebuild it with \`ouaf pack\`.`)
  throw error
}

/** Checks the structure of the archive and returns the source over its layout files. */
function openPackage(zip: Bytes, label: string): FilterSource {
  let raw: ZipEntry[]
  try {
    raw = readZipEntries(zip)
  } catch (error) {
    zipError(label, error)
  }
  const entries = raw.flatMap((z) => {
    const type = zipEntryType(z)
    return type === 'directory' ? [] : [{ path: z.name, type, size: z.size, zip: z }]
  })
  const layout = checkPackageEntries(entries)
  const problems = [...layout.problems, ...checkPackageSize({ entries: entries.length, bytes: layout.files.reduce((n, e) => n + e.size, 0), archiveBytes: zip.length })]
  const [first] = problems
  if (first) {
    const more = problems.length > 1 ? ` (and ${problems.length - 1} other problem${problems.length > 2 ? 's' : ''}: run \`ouaf validate\` on it)` : ''
    throw new PackageError(label, first.code, first.path, `${first.message} ${first.hint}${more}`)
  }
  const files = new Map<string, ZipEntry>()
  for (const e of layout.files) {
    // Local header, bounds and method of every file now, so a malformed archive fails before anything is loaded.
    try {
      zipEntryData(zip, e.zip)
    } catch (error) {
      zipError(label, error, e.path)
    }
    files.set(e.path, e.zip)
  }
  if (!files.has('manifest.json')) {
    throw new PackageError(label, 'missing-manifest', 'manifest.json', `The package has no manifest.json at its root. ${missingManifestHint(entries.map((e) => e.path))}`)
  }

  const read = async (path: string, signal?: AbortSignal): Promise<Blob> => {
    const entry = files.get(path)
    if (!entry) throw new OuafError('filter-load', `${label}: no file "${path}" in the package.`)
    return new Blob(await inflate(zip, entry, label, signal), { type: mediaType(path) })
  }
  return {
    label,
    async manifest() {
      const bytes = await (await read('manifest.json')).arrayBuffer()
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) // drops a leading BOM
      } catch (cause) {
        throw new OuafError('filter-load', `${label}: manifest.json is not valid UTF-8.`, { cause })
      }
      try {
        return JSON.parse(text) as unknown
      } catch (cause) {
        throw new OuafError('filter-load', `${label}: manifest.json is not valid JSON.`, { cause })
      }
    },
    file: read,
  }
}

/** The content of an entry, in chunks: inflated, bounded by its declared size, its CRC-32 checked. */
async function inflate(zip: Bytes, entry: ZipEntry, label: string, signal?: AbortSignal): Promise<Bytes[]> {
  let data: Bytes
  try {
    data = zipEntryData(zip, entry)
  } catch (error) {
    zipError(label, error, entry.name)
  }
  const corrupt = (what: string, cause?: unknown) =>
    new PackageError(label, 'zip-invalid', entry.name, `${entry.name}: corrupt zip entry (${what}). Rebuild the package with \`ouaf pack\`.`, cause === undefined ? undefined : { cause })
  if (entry.method === ZIP_STORED) {
    if (crc32(data) !== entry.crc) throw corrupt('CRC mismatch')
    return [data]
  }
  const input = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    },
  })
  const reader = input.pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  const chunks: Bytes[] = []
  let total = 0
  let crc = CRC_INIT
  try {
    for (;;) {
      signal?.throwIfAborted()
      let step: ReadableStreamReadResult<Bytes>
      try {
        step = await reader.read()
      } catch (cause) {
        throw corrupt('invalid compressed data', cause)
      }
      if (step.done) break
      total += step.value.length
      // Stops a zip bomb at once: nothing past the declared size is kept or inflated.
      if (total > entry.size) throw corrupt(`inflates beyond its declared ${formatBytes(entry.size)}`)
      crc = crc32Update(crc, step.value)
      chunks.push(step.value)
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  }
  if (total !== entry.size) throw corrupt(`${formatBytes(total)} instead of the declared ${formatBytes(entry.size)}`)
  if (crcFinal(crc) !== entry.crc) throw corrupt('CRC mismatch')
  return chunks
}

function concat(chunks: readonly Uint8Array[], total: number): Bytes {
  const out = new Uint8Array(total)
  let p = 0
  for (const c of chunks) {
    out.set(c, p)
    p += c.length
  }
  return out
}

// CRC-32 (IEEE 802.3, the zip checksum), table-driven.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
const CRC_INIT = 0xffffffff

function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = crc
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return c
}

const crcFinal = (crc: number) => (crc ^ 0xffffffff) >>> 0

function crc32(bytes: Uint8Array): number {
  return crcFinal(crc32Update(CRC_INIT, bytes))
}

/** Media type of a package file, as a server would send it: some browsers need it to play a video from a blob URL. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  json: 'application/json', js: 'text/javascript',
  png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', avif: 'image/avif', svg: 'image/svg+xml', ktx2: 'image/ktx2',
  mp4: 'video/mp4', webm: 'video/webm',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json',
  ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  cube: 'text/plain', frag: 'text/plain', glsl: 'text/plain',
}

function mediaType(path: string): string {
  const dot = path.lastIndexOf('.')
  return (dot > path.lastIndexOf('/') ? MEDIA_TYPES[path.slice(dot + 1).toLowerCase()] : undefined) ?? ''
}
