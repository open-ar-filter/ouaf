/**
 * Malicious packages (#27): `.ouaf` archives that break the package rules of spec §3 to exhaust the engine's memory
 * or to write outside the package. They are built on demand (`zipBombs()`, used by `e2e/evil.spec.ts`) rather than
 * committed: a few lines describe each one better than its bytes, and a lying header is easier to read here.
 *
 * Every one must be refused with a `PackageError` (directly, or as the cause of the `AssetError` of the asset that
 * cannot be read), before anything is inflated beyond the declared sizes.
 */
import { crc32, deflateRawSync } from 'node:zlib'

interface Entry {
  name: string
  data?: Uint8Array | string
  /** 0 stored, 8 deflated (default). */
  method?: number
  /** Unix file type and mode (default: regular file, 0o100644). */
  mode?: number
  /** Declared uncompressed size (default: the real one). */
  size?: number
  /** Compressed bytes as stored (default: from `data`). */
  raw?: Uint8Array
}

const enc = new TextEncoder()
const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff]
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]

function cat(parts: ArrayLike<number>[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A zip archive of `entries`, in order: each field as given, true or not. */
function zip(entries: Entry[]): Uint8Array {
  const parts: ArrayLike<number>[] = []
  const central: ArrayLike<number>[] = []
  let offset = 0
  for (const e of entries) {
    const data = typeof e.data === 'string' ? enc.encode(e.data) : (e.data ?? new Uint8Array())
    const method = e.method ?? 8
    const raw = e.raw ?? (method === 8 ? deflateRawSync(data) : data)
    const name = enc.encode(e.name)
    const common = [...u16(method), ...u16(0), ...u16(33), ...u32(crc32(data)), ...u32(raw.length), ...u32(e.size ?? data.length), ...u16(name.length), ...u16(0)]
    const local = cat([u32(0x04034b50), u16(20), u16(0x800), common, name, raw])
    central.push(cat([u32(0x02014b50), u16((3 << 8) | 20), u16(20), u16(0x800), common, u16(0), u16(0), u16(0),
      u32(((e.mode ?? 0o100644) << 16) >>> 0), u32(offset), name]))
    parts.push(local)
    offset += local.length
  }
  const cd = cat(central)
  const eocd = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(cd.length), ...u32(offset), ...u16(0)]
  return cat([...parts, cd, eocd])
}

const manifest = (layers: unknown[] = [], assets: Record<string, string> = {}) =>
  JSON.stringify({ ouaf: '1', id: 'evil-zip', name: 'Evil: zip bomb (malicious package)', version: '1.0.0', license: 'CC0-1.0', requires: {}, assets, layers })

/** Deflated zeros: 100 MB inflate from about 100 kB. */
function zeros(bytes: number): Uint8Array {
  return deflateRawSync(new Uint8Array(bytes), { level: 9 })
}

export interface ZipBomb {
  bytes: Uint8Array
  /** The `reason` of the `PackageError` the engine must answer. */
  reason: string
}

export function zipBombs(): Record<string, ZipBomb> {
  const shader = { assets: { burn: 'assets/burn.frag' }, layers: [{ id: 'burn', type: 'shader', src: 'burn', stage: 'post' }] }
  return {
    // The manifest says 1 kB and inflates to 100 MB: inflating stops at the 1 kB.
    'manifest-inflates': {
      bytes: zip([{ name: 'manifest.json', size: 1000, raw: zeros(100_000_000) }]),
      reason: 'zip-invalid',
    },
    // The same with an asset, read when the filter preloads it.
    'asset-inflates': {
      bytes: zip([{ name: 'manifest.json', data: manifest(shader.layers, shader.assets) }, { name: 'assets/burn.frag', size: 1000, raw: zeros(100_000_000) }]),
      reason: 'zip-invalid',
    },
    // Two files that declare 30 MB each: refused at once, before anything is inflated (50 MB at most, spec §3).
    'declared-too-large': {
      bytes: zip([
        { name: 'manifest.json', data: manifest() },
        { name: 'assets/a.bin', size: 30_000_000, raw: zeros(1000) },
        { name: 'assets/b.bin', size: 30_000_000, raw: zeros(1000) },
      ]),
      reason: 'package-too-large',
    },
    'too-many-entries': {
      bytes: zip([{ name: 'manifest.json', data: manifest() }, ...Array.from({ length: 1000 }, (_, i) => ({ name: `assets/${i}.bin`, data: '', method: 0 }))]),
      reason: 'too-many-entries',
    },
    // Paths that would write outside the package once unpacked.
    'path-traversal': {
      bytes: zip([{ name: 'manifest.json', data: manifest() }, { name: 'assets/../../escape.js', data: 'evil' }]),
      reason: 'unsafe-path',
    },
    'absolute-path': {
      bytes: zip([{ name: 'manifest.json', data: manifest() }, { name: '/etc/evil', data: 'evil' }]),
      reason: 'unsafe-path',
    },
    'symbolic-link': {
      bytes: zip([{ name: 'manifest.json', data: manifest() }, { name: 'assets/link', data: '../../../etc/passwd', method: 0, mode: 0o120777 }]),
      reason: 'symlink',
    },
    // The same name twice: which one an unzipper keeps differs.
    'duplicate-entry': {
      bytes: zip([{ name: 'manifest.json', data: manifest() }, { name: 'manifest.json', data: manifest([{ type: 'color', saturation: -1 }]) }]),
      reason: 'duplicate-entry',
    },
  }
}
