/**
 * Rules of the `.ouaf` package (spec §3, §15.4): its layout, the paths and entries it may hold, and its limits.
 * Shared by the tools (`ouaf validate`, `ouaf pack`) and the engine's package reader, so that a package that
 * validates is one the engine loads, and the engine refuses what the validator reports. Pure JavaScript.
 */
import { closest } from './validate.ts'

/** §3: recommended package size; `ouaf validate` warns above. Decimal megabytes, the stricter reading. */
export const PACKAGE_RECOMMENDED_BYTES = 5_000_000
/**
 * §3: an engine MAY refuse packages above this size. Applied to the archive and to the total size of its files once
 * unpacked (what an engine holds in memory, and the bound that defuses zip bombs).
 */
export const PACKAGE_MAX_BYTES = 50_000_000
/** Most files a package may hold (bounds the work of reading an archive; a filter has a few dozen at most). */
export const PACKAGE_MAX_ENTRIES = 1000

/** A file of a package, from a folder or an archive. */
export interface PackageEntryInfo {
  /** Path inside the package, "/"-separated, e.g. "assets/hat.png". */
  path: string
  type: 'file' | 'symlink' | 'other'
  /** Uncompressed size in bytes (declared by the archive for a zip entry). */
  size: number
}

export type PackageProblemCode = 'duplicate-entry' | 'unsafe-path' | 'symlink' | 'not-a-file' | 'too-many-entries' | 'package-too-large'

/** A rule of the package broken by an entry (`path`), or by the package as a whole (`path` empty). */
export interface PackageProblem {
  code: PackageProblemCode
  path: string
  message: string
  hint: string
}

/** Absolute, Windows-style or with `.`, `..` or empty segments: not a path a package may hold (spec §3). */
export function isUnsafePackagePath(path: string): boolean {
  return path.startsWith('/') || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path) ||
    path.split('/').some((s) => s === '..' || s === '.' || s === '')
}

/** In the package layout (spec §3): `manifest.json`, `script.js` or a file under `assets/`. */
export function inPackageLayout(path: string): boolean {
  return path === 'manifest.json' || path === 'script.js' || path.startsWith('assets/')
}

export interface PackageLayout<E extends PackageEntryInfo> {
  /** Regular files of the layout, each once, safe to read. */
  files: E[]
  /** Regular files outside the layout: an engine ignores them (spec §3), the validator reports them. */
  outside: E[]
  /** Entries that break the rules (links, unsafe paths, duplicates, special files), in entry order. */
  problems: PackageProblem[]
}

/** Sorts the entries of a package into its layout, the files outside it, and the entries that break the rules. */
export function checkPackageEntries<E extends PackageEntryInfo>(entries: readonly E[]): PackageLayout<E> {
  const seen = new Set<string>()
  const layout: PackageLayout<E> = { files: [], outside: [], problems: [] }
  for (const e of entries) {
    const problem = (code: PackageProblemCode, message: string, hint: string) => layout.problems.push({ code, path: e.path, message, hint })
    if (seen.has(e.path)) {
      problem('duplicate-entry', `"${e.path}" appears several times in the archive.`, 'Rebuild the archive.')
      continue
    }
    seen.add(e.path)
    if (isUnsafePackagePath(e.path)) {
      problem('unsafe-path', `Unsafe path "${e.path}": package paths are relative, use "/" and contain no "..".`,
        'Rebuild the archive from the filter folder (spec §3).')
    } else if (e.type === 'symlink') {
      problem('symlink', `"${e.path}" is a symbolic link: packages MUST NOT contain links (spec §3).`,
        'Replace the link with a copy of the file.')
    } else if (e.type !== 'file') {
      problem('not-a-file', `"${e.path}" is not a regular file.`, 'Remove it from the package.')
    } else {
      ;(inPackageLayout(e.path) ? layout.files : layout.outside).push(e)
    }
  }
  return layout
}

export interface PackageSize {
  /** Entries of the package (files, links and special files; not directory entries). */
  entries: number
  /** Total size of the layout files, unpacked. */
  bytes: number
  /** Size of the archive itself, for a zip. */
  archiveBytes?: number
}

/** Formats a size in decimal units, as the limits are written: "6.0 MB", "12 kB", "300 B". */
export function formatBytes(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : n >= 1000 ? `${(n / 1000).toFixed(0)} kB` : `${n} B`
}

const SHRINK = 'Compress the assets (KTX2 textures, Draco/meshopt models, shorter or smaller videos).'

/** The limits a package exceeds (spec §3): its number of entries, its size as an archive and unpacked. */
export function checkPackageSize(size: PackageSize): PackageProblem[] {
  const problems: PackageProblem[] = []
  if (size.entries > PACKAGE_MAX_ENTRIES) {
    problems.push({ code: 'too-many-entries', path: '', message: `The package holds ${size.entries} files: an engine refuses more than ${PACKAGE_MAX_ENTRIES}.`,
      hint: 'Merge small images into a spritesheet, and remove the files the manifest does not use.' })
  }
  if (size.archiveBytes !== undefined && size.archiveBytes > PACKAGE_MAX_BYTES) {
    problems.push({ code: 'package-too-large', path: '', message: `The package is ${formatBytes(size.archiveBytes)}: an engine may refuse packages above 50 MB (spec §3).`, hint: SHRINK })
  } else if (size.bytes > PACKAGE_MAX_BYTES) {
    const unpacked = size.archiveBytes !== undefined ? ' unpacked' : ''
    problems.push({ code: 'package-too-large', path: '', message: `The package files total ${formatBytes(size.bytes)}${unpacked}: an engine may refuse packages above 50 MB (spec §3).`, hint: SHRINK })
  }
  return problems
}

/** Hint for a package without `manifest.json` at its root, from the paths it holds: a zipped folder, a source folder, a typo. */
export function missingManifestHint(paths: readonly string[]): string {
  const nested = paths.filter((p) => /^[^/]+\/manifest\.json$/.test(p))
  if (nested.length === 1) return `Found "${nested[0]}": zip the content of the folder, not the folder itself.`
  if (paths.includes('filter.js') || paths.includes('filter.ts')) return 'This is a source folder (filter.js): validate the package that `ouaf pack` builds from it.'
  const near = closest('manifest.json', paths.filter((p) => !p.includes('/')))
  if (near) return `Found "${near}": the name is case-sensitive, rename it to "manifest.json".`
  return 'Add a manifest.json describing the filter (spec §4).'
}
