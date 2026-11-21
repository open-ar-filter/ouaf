/**
 * The small semver subset the format uses (`SemVerRange` in `@ouaf/spec`): "1", "1.2", "1.2.3", "^1.2.0", "~1.4.1",
 * with an optional prerelease. No dependency: the full semver grammar is not needed.
 */

export interface Version {
  major: number
  minor: number
  patch: number
  prerelease: string | undefined
}

const VERSION = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/

/** Parses "1", "1.2" or "1.2.3[-pre]"; missing parts are 0. Returns undefined when invalid. */
export function parseVersion(text: string): Version | undefined {
  const m = VERSION.exec(text.trim())
  if (!m) return undefined
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), prerelease: m[4] }
}

export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  // A prerelease sorts before its release.
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === undefined) return 1
  if (b.prerelease === undefined) return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

/**
 * Does `version` satisfy `range`?
 * - "^1.2.3": >= 1.2.3 and < 2.0.0 (for 0.x: < 0.(minor + 1).0, as npm);
 * - "~1.2.3": >= 1.2.3 and < 1.3.0;
 * - "1" / "1.2": any 1.x / 1.2.x; "1.2.3": exactly that version.
 * Returns false for an invalid version or range.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version)
  const r = range.trim()
  const op = r[0] === '^' || r[0] === '~' ? r[0] : ''
  const body = op ? r.slice(1) : r
  const m = VERSION.exec(body)
  const min = parseVersion(body)
  if (!v || !m || !min) return false
  const parts = m[3] !== undefined ? 3 : m[2] !== undefined ? 2 : 1

  if (op === '') {
    if (parts === 3) return compareVersions(v, min) === 0
    // "1" or "1.2": a partial version is a range; prereleases are excluded, as npm.
    if (v.prerelease !== undefined) return false
    return v.major === min.major && (parts === 1 || v.minor === min.minor)
  }
  if (compareVersions(v, min) < 0) return false
  if (op === '~') return v.major === min.major && (parts === 1 || v.minor === min.minor)
  if (min.major > 0 || parts === 1) return v.major === min.major
  if (min.minor > 0 || parts === 2) return v.major === 0 && v.minor === min.minor
  return v.major === 0 && v.minor === 0 && v.patch === min.patch
}
