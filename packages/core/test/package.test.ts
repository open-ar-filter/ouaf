import { crc32, deflateRawSync } from 'node:zlib'
import { PACKAGE_MAX_BYTES, PACKAGE_MAX_ENTRIES } from '@ouaf/spec'
import { describe, expect, it } from 'vitest'
import { OuafError, PackageError } from '../src/engine/errors.ts'
import { fetchPackage, isPackageUrl, packageSource } from '../src/engine/package.ts'

// The `.ouaf` reader of the engine (#135), on archives built here entry by entry so that each rule can be broken.

const enc = new TextEncoder()
const bytes = (s: string) => enc.encode(s)

interface Entry {
  name: string
  data?: Uint8Array | string
  /** 0 stored, 8 deflated (default: deflated when it helps), anything else to test unsupported methods. */
  method?: number
  /** Unix file type and mode (default: regular file, 0o100644). */
  mode?: number
  /** Declared uncompressed size (default: the real one). */
  size?: number
  crc?: number
  /** Compressed bytes as stored (default: from `data` and `method`). */
  raw?: Uint8Array
  flags?: number
}

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff]
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]

/** A zip archive of `entries`, in order, with Unix modes (as `ouaf pack` writes them). */
function zip(entries: Entry[]): Uint8Array<ArrayBuffer> {
  const parts: number[][] = []
  const central: number[][] = []
  let offset = 0
  for (const e of entries) {
    const data = typeof e.data === 'string' ? bytes(e.data) : (e.data ?? new Uint8Array())
    const deflated = deflateRawSync(data)
    const method = e.method ?? (deflated.length < data.length ? 8 : 0)
    const raw = e.raw ?? (method === 8 ? deflated : data)
    const name = bytes(e.name)
    const common = [...u16(method), ...u16(0), ...u16(33), ...u32(e.crc ?? crc32(data)), ...u32(raw.length), ...u32(e.size ?? data.length), ...u16(name.length), ...u16(0)]
    const flags = e.flags ?? 0x800
    const local = [...u32(0x04034b50), ...u16(20), ...u16(flags), ...common, ...name, ...raw]
    central.push([...u32(0x02014b50), ...u16((3 << 8) | 20), ...u16(20), ...u16(flags), ...common, ...u16(0), ...u16(0), ...u16(0),
      ...u32(((e.mode ?? 0o100644) << 16) >>> 0), ...u32(offset), ...name])
    parts.push(local)
    offset += local.length
  }
  const cd = central.flat()
  const eocd = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(cd.length), ...u32(offset), ...u16(0)]
  return new Uint8Array([...parts.flat(), ...cd, ...eocd])
}

const manifest = { ouaf: '1', id: 'pkg', name: 'Package', version: '1.0.0', license: 'CC0-1.0', layers: [] }
const MANIFEST: Entry = { name: 'manifest.json', data: JSON.stringify(manifest), method: 0 }
/** Compresses well: deflated by default. */
const SHADER = 'vec4 effect(vec2 uv) { return vec4(uv, 0.0, 1.0); }\n'.repeat(20)

async function refused(archive: Uint8Array | Blob): Promise<PackageError> {
  const error = await packageSource(archive).then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(PackageError)
  expect((error as PackageError).code).toBe('invalid-package')
  return error as PackageError
}

describe('packageSource: valid packages', () => {
  it('reads stored and deflated entries, as a FilterSource', async () => {
    const archive = zip([MANIFEST, { name: 'script.js', data: 'export default {}\n', method: 0 }, { name: 'assets/fx.frag', data: SHADER }])
    const source = await packageSource(archive)
    expect(source.label).toBe('package.ouaf')
    expect(await source.manifest()).toEqual(manifest)
    expect(await (await source.file('script.js')).text()).toBe('export default {}\n')
    const shader = await source.file('assets/fx.frag')
    expect(await shader.text()).toBe(SHADER)
    expect(shader.type).toBe('text/plain')
  })

  it('takes a Blob, a File (labelled by its name), an ArrayBuffer or a Uint8Array', async () => {
    const archive = zip([MANIFEST, { name: 'assets/a.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }])
    for (const input of [new Blob([archive]), new File([archive], 'mine.ouaf'), archive.buffer, archive]) {
      const source = await packageSource(input)
      expect(await source.manifest()).toEqual(manifest)
      const png = await source.file('assets/a.png')
      expect(png.type).toBe('image/png')
      expect([...new Uint8Array(await png.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47])
    }
    expect((await packageSource(new File([archive], 'mine.ouaf'))).label).toBe('mine.ouaf')
    expect((await packageSource(archive, { label: 'crown.ouaf' })).label).toBe('crown.ouaf')
  })

  it('copies bytes given by the host, which may reuse its buffer', async () => {
    const archive = zip([MANIFEST])
    const source = await packageSource(archive)
    archive.fill(0)
    expect(await source.manifest()).toEqual(manifest)
  })

  it('skips directory entries and ignores the files outside the layout (spec §3)', async () => {
    const source = await packageSource(zip([
      { name: 'assets/', mode: 0o040755 },
      MANIFEST,
      { name: 'README.md', data: 'notes' },
      { name: '__MACOSX/assets/._a.png', data: 'resource fork' },
    ]))
    expect(await source.manifest()).toEqual(manifest)
    await expect(source.file('README.md')).rejects.toThrow('no file "README.md" in the package')
    await expect(source.file('assets/missing.png')).rejects.toMatchObject({ code: 'filter-load' })
  })

  it('reports a manifest that is not JSON when it is read', async () => {
    const source = await packageSource(zip([{ name: 'manifest.json', data: '{ "ouaf": "1", }' }]))
    await expect(source.manifest()).rejects.toThrow('package.ouaf: manifest.json is not valid JSON.')
  })
})

describe('packageSource: refused packages', () => {
  it('a path escaping the package', async () => {
    const e = await refused(zip([MANIFEST, { name: 'assets/../../evil.js', data: 'x' }]))
    expect(e).toMatchObject({ reason: 'unsafe-path', path: 'assets/../../evil.js' })
    expect(e.message).toContain('contain no ".."')
  })

  it('an absolute or Windows path', async () => {
    expect(await refused(zip([MANIFEST, { name: '/etc/passwd', data: 'x' }]))).toMatchObject({ reason: 'unsafe-path', path: '/etc/passwd' })
    expect(await refused(zip([MANIFEST, { name: 'C:/x.txt', data: 'x' }]))).toMatchObject({ reason: 'unsafe-path' })
    expect(await refused(zip([MANIFEST, { name: 'assets\\a.png', data: 'x' }]))).toMatchObject({ reason: 'unsafe-path' })
  })

  it('a symbolic link, or another special entry', async () => {
    const link = await refused(zip([MANIFEST, { name: 'assets/a.png', data: '/etc/passwd', mode: 0o120777 }]))
    expect(link).toMatchObject({ reason: 'symlink', path: 'assets/a.png' })
    expect(link.message).toContain('is a symbolic link')
    expect(await refused(zip([MANIFEST, { name: 'assets/pipe', mode: 0o010644 }]))).toMatchObject({ reason: 'not-a-file', path: 'assets/pipe' })
  })

  it('a duplicate entry', async () => {
    const other = { ...MANIFEST, data: JSON.stringify({ ...manifest, id: 'other' }) }
    expect(await refused(zip([MANIFEST, other]))).toMatchObject({ reason: 'duplicate-entry', path: 'manifest.json' })
  })

  it('too many entries', async () => {
    const files = Array.from({ length: PACKAGE_MAX_ENTRIES }, (_, i) => ({ name: `assets/${i}.txt`, data: '' }))
    const e = await refused(zip([MANIFEST, ...files]))
    expect(e).toMatchObject({ reason: 'too-many-entries', path: '' })
    expect(e.message).toContain(`more than ${PACKAGE_MAX_ENTRIES}`)
    // At the limit, the package opens.
    await expect(packageSource(zip([MANIFEST, ...files.slice(1)]))).resolves.toBeDefined()
  })

  it('a declared size above the limit, before inflating anything', async () => {
    const e = await refused(zip([MANIFEST, { name: 'assets/big.frag', data: SHADER, size: PACKAGE_MAX_BYTES }]))
    expect(e).toMatchObject({ reason: 'package-too-large' })
    expect(e.message).toContain('unpacked')
  })

  it('an archive above the limit, before reading it', async () => {
    const big = new Blob([new Uint8Array(PACKAGE_MAX_BYTES + 1)])
    const e = await refused(big)
    expect(e).toMatchObject({ reason: 'package-too-large' })
    expect(e.message).toContain('50.0 MB')
  })

  it('an entry that inflates beyond its declared size (zip bomb), stopping early', async () => {
    const bomb = new Uint8Array(20_000_000) // 20 MB of zeros deflate to about 20 kB
    const source = await packageSource(zip([MANIFEST, { name: 'assets/bomb.frag', data: bomb, size: 1000, crc: 0 }]))
    const error = await source.file('assets/bomb.frag').then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(PackageError)
    expect(error).toMatchObject({ reason: 'zip-invalid', path: 'assets/bomb.frag' })
    expect((error as Error).message).toContain('inflates beyond its declared 1 kB')
  })

  it('an entry shorter than declared, or with a wrong CRC', async () => {
    const short = await packageSource(zip([MANIFEST, { name: 'assets/a.frag', data: SHADER, size: SHADER.length + 10 }]))
    await expect(short.file('assets/a.frag')).rejects.toMatchObject({ reason: 'zip-invalid', message: expect.stringContaining('instead of the declared') })
    const crc = await packageSource(zip([MANIFEST, { name: 'assets/a.frag', data: SHADER, crc: 1 }]))
    await expect(crc.file('assets/a.frag')).rejects.toMatchObject({ reason: 'zip-invalid', message: expect.stringContaining('CRC mismatch') })
    const stored = await packageSource(zip([{ ...MANIFEST, crc: 1 }]))
    await expect(stored.manifest()).rejects.toMatchObject({ reason: 'zip-invalid', path: 'manifest.json' })
  })

  it('corrupt compressed data', async () => {
    const source = await packageSource(zip([MANIFEST, { name: 'assets/a.frag', data: SHADER, method: 8, raw: new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00, 0x13]) }]))
    await expect(source.file('assets/a.frag')).rejects.toMatchObject({ reason: 'zip-invalid', message: expect.stringContaining('invalid compressed data') })
  })

  it('a file that is not a zip, or a truncated one', async () => {
    expect(await refused(bytes('not a zip at all'))).toMatchObject({ reason: 'zip-invalid', path: '' })
    const archive = zip([MANIFEST, { name: 'assets/a.frag', data: SHADER }])
    // Central directory kept, data cut: the local header of the second entry is gone.
    const cut = new Uint8Array([...archive.subarray(0, 60), ...archive.subarray(archive.length - 200)])
    expect(await refused(cut)).toMatchObject({ reason: 'zip-invalid' })
  })

  it('unsupported compression methods and encrypted entries', async () => {
    expect(await refused(zip([MANIFEST, { name: 'assets/a.frag', data: SHADER, method: 12 }]))).toMatchObject({ reason: 'zip-unsupported', path: 'assets/a.frag' })
    expect(await refused(zip([MANIFEST, { name: 'assets/a.frag', data: SHADER, flags: 0x801 }]))).toMatchObject({ reason: 'zip-unsupported' })
  })

  it('no manifest.json, with a hint', async () => {
    const nested = await refused(zip([{ ...MANIFEST, name: 'crown/manifest.json' }]))
    expect(nested).toMatchObject({ reason: 'missing-manifest', path: 'manifest.json' })
    expect(nested.message).toContain('zip the content of the folder')
    expect((await refused(zip([{ ...MANIFEST, name: 'Manifest.json' }]))).message).toContain('the name is case-sensitive')
  })
})

describe('fetchPackage', () => {
  const respond = (body: BodyInit | null, init: ResponseInit = {}) => (() => Promise.resolve(new Response(body, init))) as typeof fetch

  it('downloads and opens a package', async () => {
    const archive = zip([MANIFEST])
    const source = await fetchPackage('https://host.test/filters/crown.ouaf', respond(archive, { headers: { 'content-type': 'application/zip' } }))
    expect(source.label).toBe('https://host.test/filters/crown.ouaf')
    expect(await source.manifest()).toEqual(manifest)
  })

  it('refuses a package above the limit from its Content-Length, or while it downloads', async () => {
    const declared = respond('x', { headers: { 'content-length': String(PACKAGE_MAX_BYTES + 1) } })
    await expect(fetchPackage('https://host.test/a.ouaf', declared)).rejects.toMatchObject({ reason: 'package-too-large' })
    let sent = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1_000_000
        controller.enqueue(new Uint8Array(1_000_000))
      },
    })
    await expect(fetchPackage('https://host.test/a.ouaf', respond(endless))).rejects.toMatchObject({ reason: 'package-too-large' })
    // The download stops just past the limit (the stream reads a few chunks ahead).
    expect(sent).toBeLessThan(PACKAGE_MAX_BYTES + 5_000_000)
  })

  it('reports HTTP errors and HTML fallbacks as filter-load errors', async () => {
    await expect(fetchPackage('https://host.test/a.ouaf', respond('nope', { status: 404 }))).rejects.toThrow('HTTP 404')
    const html = respond('<!doctype html>', { headers: { 'content-type': 'text/html' } })
    await expect(fetchPackage('https://host.test/a.ouaf', html)).rejects.toMatchObject({ code: 'filter-load' })
    const offline = (() => Promise.reject(new TypeError('offline'))) as typeof fetch
    const error = await fetchPackage('https://host.test/a.ouaf', offline).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OuafError)
    expect(error).toMatchObject({ code: 'filter-load' })
  })
})

describe('isPackageUrl', () => {
  it('is true for a path ending with .ouaf, query and hash aside', () => {
    expect(isPackageUrl('https://host.test/filters/crown.ouaf')).toBe(true)
    expect(isPackageUrl(new URL('https://host.test/CROWN.OUAF?v=2#x'))).toBe(true)
    expect(isPackageUrl('https://host.test/filters/crown/')).toBe(false)
    expect(isPackageUrl('https://host.test/filters/crown/manifest.json')).toBe(false)
    expect(isPackageUrl('https://host.test/get?file=crown.ouaf')).toBe(false)
  })
})
