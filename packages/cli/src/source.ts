/**
 * Package sources: the unzipped folder (development), the .ouaf zip, or files in memory (`ouaf pack` output, tests).
 * Validation only sees this interface, so every command checks packages the same way.
 */
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { readZipEntries, readZipEntry, ZipError, type ZipEntry } from './zip.ts'

export type EntryType = 'file' | 'symlink' | 'other'

export interface PackageEntry {
  /** Path inside the package, "/"-separated, e.g. "assets/hat.png". */
  path: string
  type: EntryType
  /** Uncompressed size in bytes. */
  size: number
}

export interface PackageSource {
  kind: 'folder' | 'zip' | 'memory'
  /** What the user passed (folder or file path), for messages. */
  label: string
  /** Files of the package (directories are implied by the paths). */
  entries: PackageEntry[]
  /** Size of the archive itself for a zip; undefined otherwise. */
  archiveSize?: number
  read(path: string): Promise<Uint8Array>
}

/** Cannot open the input at all (missing path, unreadable or corrupt archive). */
export class SourceError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export async function openFolder(dir: string, label = dir): Promise<PackageSource> {
  const entries: PackageEntry[] = []
  const walk = async (abs: string): Promise<void> => {
    for (const d of await readdir(abs, { withFileTypes: true })) {
      const full = join(abs, d.name)
      const path = relative(dir, full).split(sep).join('/')
      if (d.isDirectory()) await walk(full)
      else if (d.isSymbolicLink()) entries.push({ path, type: 'symlink', size: 0 })
      else if (d.isFile()) entries.push({ path, type: 'file', size: (await lstat(full)).size })
      else entries.push({ path, type: 'other', size: 0 })
    }
  }
  await walk(dir)
  entries.sort((a, b) => (a.path < b.path ? -1 : 1))
  return {
    kind: 'folder',
    label,
    entries,
    read: async (path) => new Uint8Array(await readFile(join(dir, ...path.split('/')))),
  }
}

export function zipSource(zip: Uint8Array, label: string): PackageSource {
  let raw: ZipEntry[]
  try {
    raw = readZipEntries(zip)
  } catch (e) {
    if (e instanceof ZipError) throw new SourceError(e.code, `${label}: ${e.message}`)
    throw e
  }
  const byPath = new Map<string, ZipEntry>()
  const entries: PackageEntry[] = []
  for (const z of raw) {
    if (z.name.endsWith('/') && z.size === 0) continue // directory entry
    const type: EntryType = z.unixMode === 0o120000 ? 'symlink' : z.unixMode === undefined || z.unixMode === 0o100000 || z.unixMode === 0 ? 'file' : 'other'
    entries.push({ path: z.name, type, size: z.size })
    if (!byPath.has(z.name)) byPath.set(z.name, z)
  }
  return {
    kind: 'zip',
    label,
    entries,
    archiveSize: zip.length,
    read: async (path) => {
      const z = byPath.get(path)
      if (!z) throw new SourceError('not-found', `${path}: not in the archive.`)
      return readZipEntry(zip, z)
    },
  }
}

export async function openZip(file: string, label = file): Promise<PackageSource> {
  return zipSource(new Uint8Array(await readFile(file)), label)
}

/** In-memory package, e.g. the output of `ouaf pack` before it is written, or test fixtures. */
export function memorySource(files: Record<string, Uint8Array | string>, label = '<memory>'): PackageSource {
  const enc = new TextEncoder()
  const data = new Map(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v]))
  return {
    kind: 'memory',
    label,
    entries: [...data].map(([path, bytes]) => ({ path, type: 'file' as const, size: bytes.length })).sort((a, b) => (a.path < b.path ? -1 : 1)),
    read: async (path) => {
      const bytes = data.get(path)
      if (!bytes) throw new SourceError('not-found', `${path}: not in the package.`)
      return bytes
    },
  }
}

/** Opens a folder or a .ouaf (zip) file. */
export async function openPackage(input: string): Promise<PackageSource> {
  let st
  try {
    st = await lstat(input)
  } catch {
    throw new SourceError('not-found', `${input}: no such file or folder.`)
  }
  // Following a link given on the command line is fine; links inside the package are reported.
  if (st.isSymbolicLink()) st = await stat(input)
  if (st.isDirectory()) return openFolder(input)
  if (st.isFile()) return openZip(input)
  throw new SourceError('not-found', `${input}: not a folder or a .ouaf file.`)
}
