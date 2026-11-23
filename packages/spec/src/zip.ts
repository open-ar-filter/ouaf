/**
 * Reader of the zip container of `.ouaf` packages (spec §3): the central directory and where each entry's data
 * lies. Pure JavaScript (no Node or DOM API), shared by the tools (`ouaf validate`, `ouaf pack`, which inflate with
 * `node:zlib`) and the engine (which inflates with `DecompressionStream`), so both read archives the same way.
 *
 * Supports what a filter package needs: stored and deflated entries, UTF-8 names, Unix modes (to detect symbolic
 * links). Not supported (reported as errors): ZIP64, encryption, multi-disk archives, other compression methods.
 * Packages are small (≤ 5 MB recommended, an engine MAY refuse above 50 MB), so the archive is read in memory.
 */

export interface ZipEntry {
  /** Entry name as stored (directories end with "/"). */
  name: string
  method: number
  crc: number
  compressedSize: number
  /** Uncompressed size, as declared by the central directory. */
  size: number
  /** Unix file type bits when the archive was made on Unix, else undefined. */
  unixMode?: number
  encrypted: boolean
  localOffset: number
}

export type ZipErrorCode = 'zip-invalid' | 'zip-unsupported'

/** The archive cannot be read: corrupt (`zip-invalid`) or using a zip feature packages do not need (`zip-unsupported`). */
export class ZipError extends Error {
  override name = 'ZipError'
  code: ZipErrorCode
  constructor(code: ZipErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/** Compression methods of the entries a package may contain. */
export const ZIP_STORED = 0
export const ZIP_DEFLATED = 8

const utf8 = new TextDecoder('utf-8')
/** CP437 is the zip default without the UTF-8 flag; plain ASCII names (the norm for packages) decode the same. */
const latin = new TextDecoder('latin1')

const viewOf = (zip: Uint8Array) => new DataView(zip.buffer, zip.byteOffset, zip.byteLength)

/** Reads the central directory of a zip archive. Throws `ZipError`. */
export function readZipEntries(zip: Uint8Array): ZipEntry[] {
  const view = viewOf(zip)
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError('zip-invalid', 'Not a zip archive (no end of central directory record).')
  const disk = view.getUint16(eocd + 4, true)
  const count = view.getUint16(eocd + 10, true)
  const cdSize = view.getUint32(eocd + 12, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  if (disk !== 0) throw new ZipError('zip-unsupported', 'Multi-disk zip archives are not supported.')
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new ZipError('zip-unsupported', 'ZIP64 archives are not supported (a filter package is far below 4 GB).')
  }
  if (cdOffset + cdSize > eocd) throw new ZipError('zip-invalid', 'Corrupt zip archive (central directory out of bounds).')

  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || view.getUint32(p, true) !== CENTRAL) {
      throw new ZipError('zip-invalid', 'Corrupt zip archive (bad central directory entry).')
    }
    const madeBy = view.getUint16(p + 4, true)
    const flags = view.getUint16(p + 8, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const external = view.getUint32(p + 38, true)
    const nameBytes = zip.subarray(p + 46, p + 46 + nameLen)
    entries.push({
      name: (flags & 0x800 ? utf8 : latin).decode(nameBytes),
      method: view.getUint16(p + 10, true),
      crc: view.getUint32(p + 16, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      ...(madeBy >> 8 === 3 ? { unixMode: (external >>> 16) & 0o170000 } : {}),
      encrypted: (flags & 1) !== 0,
      localOffset: view.getUint32(p + 42, true),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/**
 * What an entry is: a directory entry (a name ending with "/", no content), a symbolic link or another special file
 * (from its Unix mode), or a regular file. Archives made elsewhere than on Unix carry no mode: their entries are files.
 */
export function zipEntryType(entry: ZipEntry): 'file' | 'directory' | 'symlink' | 'other' {
  if (entry.name.endsWith('/') && entry.size === 0) return 'directory'
  if (entry.unixMode === 0o120000) return 'symlink'
  return entry.unixMode === undefined || entry.unixMode === 0o100000 || entry.unixMode === 0 ? 'file' : 'other'
}

/**
 * The stored or deflated bytes of an entry (a view into `zip`, nothing is copied), after checking its local header,
 * its bounds, its method and, for a stored entry, that its sizes agree. Inflating and checking the CRC is left to the
 * caller (`node:zlib` or `DecompressionStream`). Throws `ZipError`.
 */
export function zipEntryData<T extends ArrayBufferLike>(zip: Uint8Array<T>, entry: ZipEntry): Uint8Array<T> {
  const view = viewOf(zip)
  const p = entry.localOffset
  if (entry.encrypted) throw new ZipError('zip-unsupported', `${entry.name}: encrypted entries are not supported.`)
  if (entry.method !== ZIP_STORED && entry.method !== ZIP_DEFLATED) {
    throw new ZipError('zip-unsupported', `${entry.name}: compression method ${entry.method} is not supported (use deflate or store).`)
  }
  if (p + 30 > zip.length || view.getUint32(p, true) !== LOCAL) {
    throw new ZipError('zip-invalid', `${entry.name}: corrupt zip entry (bad local header).`)
  }
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true)
  const raw = zip.subarray(start, start + entry.compressedSize)
  if (raw.length !== entry.compressedSize) throw new ZipError('zip-invalid', `${entry.name}: truncated zip entry.`)
  if (entry.method === ZIP_STORED && entry.compressedSize !== entry.size) {
    throw new ZipError('zip-invalid', `${entry.name}: corrupt zip entry (stored entry whose sizes differ).`)
  }
  return raw
}
