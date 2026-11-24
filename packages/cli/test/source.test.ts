/** Package sources: a folder, a .ouaf zip, files in memory; what each lists and the errors of each. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { memorySource, openFolder, openPackage, openZip, SourceError, zipSource } from '../src/source.ts'
import { zip } from './helpers.ts'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ouaf-source-'))
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const sourceError = async (p: Promise<unknown> | (() => unknown)): Promise<SourceError> => {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (e) {
    expect(e).toBeInstanceOf(SourceError)
    return e as SourceError
  }
  throw new Error('no SourceError thrown')
}

describe('folder', () => {
  it('lists files with their sizes in path order, links and special files by type, nested folders by path', async () => {
    const f = join(dir, 'folder')
    await mkdir(join(f, 'assets', 'sub'), { recursive: true })
    await writeFile(join(f, 'manifest.json'), '{}')
    await writeFile(join(f, 'assets', 'b.png'), 'bbb')
    await writeFile(join(f, 'assets', 'sub', 'a.png'), 'a')
    await symlink(join(f, 'manifest.json'), join(f, 'assets', 'link.json'))
    let fifo = false
    try {
      execFileSync('mkfifo', [join(f, 'assets', 'pipe')])
      fifo = true
    } catch {}
    const source = await openFolder(f, 'my-filter')
    expect(source.kind).toBe('folder')
    expect(source.label).toBe('my-filter')
    expect(source.archiveSize).toBeUndefined()
    expect(source.entries).toEqual([
      { path: 'assets/b.png', type: 'file', size: 3 },
      { path: 'assets/link.json', type: 'symlink', size: 0 },
      ...(fifo ? [{ path: 'assets/pipe', type: 'other', size: 0 }] : []),
      { path: 'assets/sub/a.png', type: 'file', size: 1 },
      { path: 'manifest.json', type: 'file', size: 2 },
    ])
    expect(new TextDecoder().decode(await source.read('assets/sub/a.png'))).toBe('a')
  })
})

describe('zip', () => {
  it('skips directory entries, keeps the first of duplicate names, reads entries', async () => {
    const archive = zip({ 'assets/': { data: '', mode: 0o040755 }, 'manifest.json': '{"a":1}', 'assets/x.png': 'x' })
    const source = zipSource(archive, 'pkg.ouaf')
    expect(source).toMatchObject({ kind: 'zip', label: 'pkg.ouaf', archiveSize: archive.length })
    expect(source.entries).toEqual([
      { path: 'manifest.json', type: 'file', size: 7 },
      { path: 'assets/x.png', type: 'file', size: 1 },
    ])
    expect(new TextDecoder().decode(await source.read('manifest.json'))).toBe('{"a":1}')
  })

  it('lists duplicate names twice (for the layout checks) and reads the first', async () => {
    const a = zip({ 'manifest.json': 'first' })
    const b = zip({ 'manifest.json': 'second' })
    // Two archives of one entry each, merged by hand: two central directory entries with the same name.
    const merged = mergeZips(a, b)
    const source = zipSource(merged, 'dup.ouaf')
    expect(source.entries.map((e) => e.path)).toEqual(['manifest.json', 'manifest.json'])
    expect(new TextDecoder().decode(await source.read('manifest.json'))).toBe('first')
  })

  it('a path that is not in the archive', async () => {
    const source = zipSource(zip({ 'manifest.json': '{}' }), 'pkg.ouaf')
    const e = await sourceError(source.read('assets/nope.png'))
    expect(e.code).toBe('not-found')
    expect(e.message).toBe('assets/nope.png: not in the archive.')
  })

  it('an archive that cannot be read: the zip error code, prefixed by the label', async () => {
    const e = await sourceError(() => zipSource(new Uint8Array(30), 'bad.ouaf'))
    expect(e.code).toBe('zip-invalid')
    expect(e.message).toBe('bad.ouaf: Not a zip archive (no end of central directory record).')
    await writeFile(join(dir, 'bad.ouaf'), 'nope')
    expect((await sourceError(openZip(join(dir, 'bad.ouaf')))).message).toBe(`${join(dir, 'bad.ouaf')}: Not a zip archive (no end of central directory record).`)
  })
})

describe('memory', () => {
  it('encodes strings, sorts by path, reports a missing path', async () => {
    const source = memorySource({ 'b.txt': 'é', 'a.bin': Uint8Array.from([1, 2]) })
    expect(source).toMatchObject({ kind: 'memory', label: '<memory>' })
    expect(source.entries).toEqual([{ path: 'a.bin', type: 'file', size: 2 }, { path: 'b.txt', type: 'file', size: 2 }])
    expect([...await source.read('b.txt')]).toEqual([0xc3, 0xa9])
    const e = await sourceError(source.read('c.txt'))
    expect(e).toMatchObject({ code: 'not-found', message: 'c.txt: not in the package.' })
  })
})

describe('openPackage', () => {
  it('follows a link given on the command line: to a folder or to a zip', async () => {
    const f = join(dir, 'real')
    await mkdir(f, { recursive: true })
    await writeFile(join(f, 'manifest.json'), '{}')
    await symlink(f, join(dir, 'linked-folder'))
    expect((await openPackage(join(dir, 'linked-folder'))).kind).toBe('folder')
    await writeFile(join(dir, 'real.ouaf'), zip({ 'manifest.json': '{}' }))
    await symlink(join(dir, 'real.ouaf'), join(dir, 'linked.ouaf'))
    expect((await openPackage(join(dir, 'linked.ouaf'))).kind).toBe('zip')
  })

  it('a missing path, or one that is neither a folder nor a file', async () => {
    const missing = await sourceError(openPackage(join(dir, 'nope')))
    expect(missing).toMatchObject({ code: 'not-found', message: `${join(dir, 'nope')}: no such file or folder.` })
    const device = await sourceError(openPackage('/dev/null'))
    expect(device).toMatchObject({ code: 'not-found', message: '/dev/null: not a folder or a .ouaf file.' })
  })
})

/** Concatenates the entries of two single-entry archives written by `zip` into one archive. */
function mergeZips(a: Uint8Array, b: Uint8Array): Uint8Array {
  const parts = (z: Uint8Array) => {
    const v = new DataView(z.buffer, z.byteOffset, z.byteLength)
    const eocd = z.length - 22
    const cdSize = v.getUint32(eocd + 12, true)
    const cdOffset = v.getUint32(eocd + 16, true)
    return { local: z.subarray(0, cdOffset), central: z.slice(cdOffset, cdOffset + cdSize) }
  }
  const pa = parts(a)
  const pb = parts(b)
  // The second central entry points after the first local entry.
  new DataView(pb.central.buffer).setUint32(42, pa.local.length, true)
  const cd = new Uint8Array([...pa.central, ...pb.central])
  const end = new Uint8Array(22)
  const v = new DataView(end.buffer)
  v.setUint32(0, 0x06054b50, true)
  v.setUint16(8, 2, true)
  v.setUint16(10, 2, true)
  v.setUint32(12, cd.length, true)
  v.setUint32(16, pa.local.length + pb.local.length, true)
  return new Uint8Array([...pa.local, ...pb.local, ...cd, ...end])
}
