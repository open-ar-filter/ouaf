/**
 * Zip reader and writer for .ouaf packages (spec §3), on top of node:zlib: no dependency.
 *
 * The central directory and the local headers are read by `@ouaf/spec` (`readZipEntries`, `zipEntryData`), shared
 * with the engine, which inflates in the browser; this module inflates and checks entries with node:zlib, and writes
 * archives. Packages are small (≤ 5 MB recommended, an engine MAY refuse above 50 MB), so they are read in memory.
 */
import { constants, crc32, deflateRawSync, inflateRawSync } from 'node:zlib'
import { readZipEntries, ZIP_STORED, zipEntryData, ZipError, type ZipEntry } from '@ouaf/spec'

export { readZipEntries, ZipError, type ZipEntry }

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/** Extracts one entry, checking its size and CRC. */
export function readZipEntry(zip: Uint8Array, entry: ZipEntry): Uint8Array {
  const raw = zipEntryData(zip, entry)
  let data: Uint8Array
  if (entry.method === ZIP_STORED) data = raw
  else {
    try {
      // maxOutputLength guards against an entry that inflates beyond its declared size (zip bomb).
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) })
    } catch {
      throw new ZipError('zip-invalid', `${entry.name}: corrupt compressed data.`)
    }
  }
  if (data.length !== entry.size || crc32(data) !== entry.crc) {
    throw new ZipError('zip-invalid', `${entry.name}: corrupt zip entry (size or CRC mismatch).`)
  }
  return data
}

export interface ZipInput {
  /** Path inside the archive, "/"-separated, without a leading "/". */
  path: string
  data: Uint8Array
}

/** 1980-01-01 00:00:00, the earliest DOS date: entries carry no real time, so the same files give the same archive. */
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1
/** "Made by" Unix (3), zip spec 2.0: readers then take the file type from the external attributes. */
const MADE_BY = (3 << 8) | 20
/** Regular file, rw-r--r--, in the high 16 bits of the external attributes. */
const FILE_ATTRS = (0o100644 << 16) >>> 0

/**
 * Writes a zip archive of regular files, in the order given. The output depends only on the paths and contents:
 * fixed timestamps and permissions, no extra fields, no directory entries. Each file is deflated (level 9), or
 * stored when deflating does not make it smaller (PNG, MP4…).
 */
export function writeZip(files: readonly ZipInput[]): Uint8Array {
  if (files.length > 0xfffe) throw new ZipError('zip-unsupported', 'Too many files for a zip archive without ZIP64.')
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const f of files) {
    const name = enc.encode(f.path)
    const deflated = deflateRawSync(f.data, { level: 9, strategy: constants.Z_DEFAULT_STRATEGY })
    const stored = deflated.length >= f.data.length
    const body = stored ? f.data : new Uint8Array(deflated.buffer, deflated.byteOffset, deflated.length)
    const crc = crc32(f.data)
    // UTF-8 names (bit 11) only when needed: plain ASCII names stay readable by the oldest tools.
    const flags = /^[\x20-\x7e]*$/.test(f.path) ? 0 : 0x800
    const method = stored ? 0 : 8
    if (offset + 30 + name.length + body.length > 0xffffffff) throw new ZipError('zip-unsupported', 'The archive would need ZIP64 (over 4 GB).')

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, LOCAL, true)
    lv.setUint16(4, 20, true) // version needed: 2.0 (deflate)
    lv.setUint16(6, flags, true)
    lv.setUint16(8, method, true)
    lv.setUint16(10, DOS_TIME, true)
    lv.setUint16(12, DOS_DATE, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, f.data.length, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    local.set(name, 30)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, CENTRAL, true)
    cv.setUint16(4, MADE_BY, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, flags, true)
    cv.setUint16(10, method, true)
    cv.setUint16(12, DOS_TIME, true)
    cv.setUint16(14, DOS_DATE, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, f.data.length, true)
    cv.setUint16(28, name.length, true)
    // Extra field, comment, disk number and internal attributes stay 0.
    cv.setUint32(38, FILE_ATTRS, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)

    locals.push(local, body)
    centrals.push(central)
    offset += local.length + body.length
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, EOCD, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)

  const out = new Uint8Array(offset + cdSize + eocd.length)
  let p = 0
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p)
    p += part.length
  }
  return out
}
