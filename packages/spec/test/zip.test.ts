/**
 * Zip reader of .ouaf packages (spec §3): the archives it reads, and the corrupt or unsupported ones it refuses with
 * a `ZipError` code. Archives are built by hand, byte by byte.
 */
import { describe, expect, it } from 'vitest'
import { readZipEntries, ZIP_DEFLATED, ZIP_STORED, zipEntryData, zipEntryType, ZipError, type ZipEntry } from '../src/index.ts'

const enc = new TextEncoder()
function concat(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)))
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0))
  let o = 0
  for (const a of arrays) (out.set(a, o), (o += a.length))
  return out
}
const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff]
const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]

interface Spec {
  name: string | Uint8Array
  data?: Uint8Array
  method?: number
  flags?: number
  madeBy?: number
  mode?: number
  size?: number
  extra?: number
  comment?: number
}

/** A stored archive; every field of the central directory can be set. */
function zip(files: Spec[], eocd: { disk?: number; count?: number; cdSize?: number; cdOffset?: number; comment?: number } = {}): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const f of files) {
    const name = typeof f.name === 'string' ? enc.encode(f.name) : f.name
    const data = f.data ?? new Uint8Array()
    const flags = f.flags ?? 0x800
    const common = [...u16(f.method ?? ZIP_STORED), ...u16(0), ...u16(0), ...u32(0), ...u32(data.length), ...u32(f.size ?? data.length)]
    const local = concat(u32(0x04034b50), u16(20), u16(flags), common, u16(name.length), u16(0), name, data)
    centrals.push(concat(
      u32(0x02014b50), u16(f.madeBy ?? (3 << 8) | 20), u16(20), u16(flags), common,
      u16(name.length), u16(f.extra ?? 0), u16(f.comment ?? 0), u16(0), u16(0), u32(((f.mode ?? 0o100644) << 16) >>> 0), u32(offset),
      name, new Uint8Array((f.extra ?? 0) + (f.comment ?? 0)),
    ))
    locals.push(local)
    offset += local.length
  }
  const cd = concat(...centrals)
  const count = eocd.count ?? files.length
  return concat(
    ...locals, cd,
    u32(0x06054b50), u16(eocd.disk ?? 0), u16(0), u16(count), u16(count), u32(eocd.cdSize ?? cd.length), u32(eocd.cdOffset ?? offset),
    u16(eocd.comment ?? 0), new Uint8Array(eocd.comment ?? 0),
  )
}

const zipError = (f: () => unknown): ZipError => {
  try {
    f()
  } catch (e) {
    expect(e).toBeInstanceOf(ZipError)
    return e as ZipError
  }
  throw new Error('no ZipError thrown')
}

describe('readZipEntries', () => {
  it('reads names, sizes, Unix modes, extra fields and comments, and an archive comment', () => {
    const archive = zip([
      { name: 'manifest.json', data: enc.encode('{}'), extra: 4, comment: 3 },
      { name: 'assets/', mode: 0o040755 },
      { name: 'dos.txt', data: enc.encode('hi'), madeBy: 20 },
    ], { comment: 10 })
    const entries = readZipEntries(archive)
    expect(entries.map((e) => [e.name, e.size, e.unixMode])).toEqual([
      ['manifest.json', 2, 0o100000],
      ['assets/', 0, 0o040000],
      ['dos.txt', 2, undefined],
    ])
    expect(entries[0]).toMatchObject({ method: ZIP_STORED, encrypted: false, compressedSize: 2, localOffset: 0 })
  })

  it('decodes names as UTF-8 with the flag, as Latin-1 without it', () => {
    const name = Uint8Array.from([0x63, 0x61, 0x66, 0xc3, 0xa9]) // "café" in UTF-8
    expect(readZipEntries(zip([{ name }]))[0]!.name).toBe('café')
    expect(readZipEntries(zip([{ name, flags: 0 }]))[0]!.name).toBe('cafÃ©')
  })

  it('an empty archive has no entries', () => {
    expect(readZipEntries(zip([]))).toEqual([])
  })

  it('refuses what is not a zip archive', () => {
    expect(zipError(() => readZipEntries(new Uint8Array(100))).code).toBe('zip-invalid')
    expect(zipError(() => readZipEntries(new Uint8Array(10))).message).toBe('Not a zip archive (no end of central directory record).')
  })

  it('refuses multi-disk and ZIP64 archives as unsupported', () => {
    const files = [{ name: 'a', data: enc.encode('a') }]
    expect(zipError(() => readZipEntries(zip(files, { disk: 1 })))).toMatchObject({ code: 'zip-unsupported', message: 'Multi-disk zip archives are not supported.' })
    for (const e of [{ count: 0xffff }, { cdOffset: 0xffffffff }, { cdSize: 0xffffffff }]) {
      expect(zipError(() => readZipEntries(zip(files, e))).code).toBe('zip-unsupported')
    }
  })

  it('refuses a central directory out of bounds or with a bad entry', () => {
    const files = [{ name: 'a', data: enc.encode('a') }]
    expect(zipError(() => readZipEntries(zip(files, { cdSize: 1000 })))).toMatchObject({ code: 'zip-invalid', message: 'Corrupt zip archive (central directory out of bounds).' })
    expect(zipError(() => readZipEntries(zip(files, { cdOffset: 0 })))).toMatchObject({ code: 'zip-invalid', message: 'Corrupt zip archive (bad central directory entry).' })
    expect(zipError(() => readZipEntries(zip(files, { count: 2 }))).message).toBe('Corrupt zip archive (bad central directory entry).')
  })
})

describe('zipEntryType', () => {
  const entry = (name: string, unixMode?: number, size = 0): ZipEntry => ({
    name, method: 0, crc: 0, compressedSize: size, size, encrypted: false, localOffset: 0, ...(unixMode === undefined ? {} : { unixMode }),
  })

  it('directories, symbolic links, regular and special files', () => {
    expect(zipEntryType(entry('assets/'))).toBe('directory')
    expect(zipEntryType(entry('assets/', 0o040000))).toBe('directory')
    expect(zipEntryType(entry('weird/', 0o100000, 3))).toBe('file') // a name ending with "/" but with content
    expect(zipEntryType(entry('link', 0o120000))).toBe('symlink')
    expect(zipEntryType(entry('a.png'))).toBe('file')
    expect(zipEntryType(entry('a.png', 0))).toBe('file')
    expect(zipEntryType(entry('a.png', 0o100000))).toBe('file')
    expect(zipEntryType(entry('fifo', 0o010000))).toBe('other')
  })
})

describe('zipEntryData', () => {
  it('returns a view of the stored bytes', () => {
    const archive = zip([{ name: 'a.txt', data: enc.encode('hello') }, { name: 'b.txt', data: enc.encode('world!') }])
    const [a, b] = readZipEntries(archive)
    expect(new TextDecoder().decode(zipEntryData(archive, a!))).toBe('hello')
    const data = zipEntryData(archive, b!)
    expect(new TextDecoder().decode(data)).toBe('world!')
    expect(data.buffer).toBe(archive.buffer)
  })

  it('returns the raw bytes of a deflated entry, to be inflated by the caller', () => {
    const archive = zip([{ name: 'a.bin', data: Uint8Array.from([1, 2, 3]), method: ZIP_DEFLATED, size: 10 }])
    expect([...zipEntryData(archive, readZipEntries(archive)[0]!)]).toEqual([1, 2, 3])
  })

  it('refuses encrypted entries and other compression methods', () => {
    const encrypted = zip([{ name: 'secret', data: enc.encode('x'), flags: 0x801 }])
    const e = readZipEntries(encrypted)[0]!
    expect(e.encrypted).toBe(true)
    expect(zipError(() => zipEntryData(encrypted, e))).toMatchObject({ code: 'zip-unsupported', message: 'secret: encrypted entries are not supported.' })
    const bzip = zip([{ name: 'b', data: enc.encode('x'), method: 12 }])
    expect(zipError(() => zipEntryData(bzip, readZipEntries(bzip)[0]!))).toMatchObject({
      code: 'zip-unsupported',
      message: 'b: compression method 12 is not supported (use deflate or store).',
    })
  })

  it('refuses a bad local header, a truncated entry, a stored entry whose sizes differ', () => {
    const archive = zip([{ name: 'a', data: enc.encode('abc') }])
    const entry = readZipEntries(archive)[0]!
    expect(zipError(() => zipEntryData(archive, { ...entry, localOffset: 5 }))).toMatchObject({ code: 'zip-invalid', message: 'a: corrupt zip entry (bad local header).' })
    expect(zipError(() => zipEntryData(archive, { ...entry, localOffset: archive.length - 10 })).code).toBe('zip-invalid')
    expect(zipError(() => zipEntryData(archive, { ...entry, compressedSize: 10_000 })).message).toBe('a: truncated zip entry.')
    const mismatch = zip([{ name: 'm', data: enc.encode('abc'), size: 4 }])
    expect(zipError(() => zipEntryData(mismatch, readZipEntries(mismatch)[0]!)).message).toBe('m: corrupt zip entry (stored entry whose sizes differ).')
  })
})
