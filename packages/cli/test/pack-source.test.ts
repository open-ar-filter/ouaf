/**
 * `ouaf pack`: what the export of filter.js may hold (spec §3.1, §12.2, §12.3) and the folder layouts it refuses,
 * beyond pack.test.ts.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { packFolder, PackSourceError } from '../src/pack.ts'
import { readZipEntries, readZipEntry } from '../src/zip.ts'

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function folder(files: Record<string, string | Uint8Array>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ouaf-pack-src-'))
  temps.push(root)
  const dir = join(root, 'filter')
  await mkdir(dir, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

const data = `id: 'x', name: 'X', version: '1.0.0', license: 'CC0-1.0', requires: {}`
const filterJs = (rest = `layers: []`) => `export default { ${data}, ${rest} }\n`
const pack = async (js: string) => (await packFolder(await folder({ 'filter.js': js }))).report
const errors = async (js: string) => (await pack(js)).errors.map((e) => [e.code, e.path])
const manifestOf = (zip: Uint8Array) => {
  const entry = readZipEntries(zip).find((e) => e.name === 'manifest.json')!
  return JSON.parse(new TextDecoder().decode(readZipEntry(zip, entry))) as Record<string, unknown>
}

describe('the default export', () => {
  it('must be a plain object', async () => {
    expect(await errors(`export default 5\n`)).toEqual([['not-an-object', '']])
    expect(await errors(`export default [1]\n`)).toEqual([['not-an-object', '']])
    expect(await errors(`class F {}\nexport default new F()\n`)).toEqual([['not-an-object', '']])
    const r = await pack(`export default Object.assign(Object.create(null), { ${data}, layers: [] })\n`)
    expect(r.errors).toEqual([])
  })

  it('reports what threw at the top level, whatever was thrown', async () => {
    const thrown = await pack(`throw 'plain string'\n${filterJs()}`)
    expect(thrown.errors[0]).toMatchObject({ code: 'run-error', message: 'filter.js threw when run to read its export: plain string' })
    const named = await pack(`throw new TypeError('bad')\n${filterJs()}`)
    expect(named.errors[0]!.message).toBe('filter.js threw when run to read its export: TypeError: bad')
    const anonymous = await pack(`throw { message: 'no name' }\n${filterJs()}`)
    expect(anonymous.errors[0]!.message).toBe('filter.js threw when run to read its export: no name')
  })

  it('values JSON cannot hold: bigints, symbols, cycles, class instances, undefined in lists', async () => {
    const r = await errors(`const loop = { a: 1 }
      loop.self = loop
      class Point { constructor() { this.x = 1 } }
      const orphan = Object.create(Object.create(null))
      ${filterJs(`layers: [], big: 10n, sym: Symbol('s'), loop, point: new Point(), orphan, list: [1, undefined, Infinity]`)}`)
    expect(r).toEqual([
      ['not-json', '/big'],
      ['not-json', '/sym'],
      ['cycle', '/loop/self'],
      ['not-json', '/point'],
      ['not-json', '/orphan'],
      ['not-json', '/list'],
      ['not-json', '/list/2'],
    ])
    const report = await pack(filterJs(`layers: [], point: new (class Point {})(), orphan: Object.create(Object.create(null))`))
    expect(report.errors.map((e) => e.message)).toEqual([
      'A Point cannot be written to manifest.json: data is made of objects, lists, strings, numbers, booleans and null.',
      'A object cannot be written to manifest.json: data is made of objects, lists, strings, numbers, booleans and null.',
    ])
  })

  it('keeps null and drops undefined properties', async () => {
    const result = await packFolder(await folder({ 'filter.js': filterJs(`layers: [], description: undefined, author: null`) }))
    // null is written (the validator then refuses it as an author), undefined is left out.
    expect(result.report.errors.map((e) => [e.code, e.path])).toEqual([['type', '/author']])
  })

  it('a data-only filter keeps its state out of the manifest', async () => {
    const result = await packFolder(await folder({ 'filter.js': filterJs(`layers: [], state: { n: 1 }, on: {}, draw: { c: undefined }`) }))
    expect(result.report.errors).toEqual([])
    const manifest = manifestOf(result.zip!)
    expect(manifest).not.toHaveProperty('state')
    expect(manifest).not.toHaveProperty('script')
    expect(manifest).not.toHaveProperty('on')
  })
})

describe('script functions and the script section', () => {
  it('"state" is data; "on" and "draw" are objects of functions; accessors in them are refused', async () => {
    expect(await errors(filterJs(`layers: [], state() { return {} }`))).toEqual([['not-plain-data', '/state']])
    expect(await errors(filterJs(`layers: [], on: [], draw: 'canvas'`))).toEqual([['not-an-object', '/on'], ['not-an-object', '/draw']])
    expect(await errors(filterJs(`layers: [], setup() {}, draw: { get c() { return () => {} } }`))).toEqual([['accessor-in-data', '/draw/c']])
    expect(await errors(filterJs(`layers: [], on: { get smile() { return () => {} } }`))).toEqual([['accessor-in-data', '/on/smile']])
  })

  it('"script" must be an object with "uses" only; its uses are ignored without functions', async () => {
    expect(await errors(filterJs(`layers: [], script: ['face.pose']`))).toEqual([['script-section', '/script']])
    expect(await errors(filterJs(`layers: [], update() {}, script: { uses: [NaN] }`))).toEqual([['not-json', '/script/uses/0']])
    const unused = await pack(filterJs(`layers: [], script: { uses: ['face.pose'] }`))
    expect(unused.errors).toEqual([])
    expect(unused.warnings.map((w) => [w.code, w.path])).toEqual([['unused-script-uses', '/script/uses']])
  })

  it('writes the functions found into "script", with "uses"', async () => {
    const result = await packFolder(await folder({
      'filter.js': filterJs(`requires: { face: true }, layers: [{ id: 'c', type: 'canvas', width: 64, height: 64, anchor: 'screen' }],
        setup() {}, on: { smile() {} }, draw: { c() {} }, script: { uses: ['face.pose'] }`).replace(`requires: {}, `, ''),
    }))
    expect(result.report.errors).toEqual([])
    expect(manifestOf(result.zip!).script).toEqual({ entry: 'script.js', setup: true, on: ['smile'], draw: ['c'], uses: ['face.pose'] })
  })
})

describe('build logs', () => {
  it('reports bundler warnings as warnings, located in the file', async () => {
    const result = await packFolder(await folder({ 'filter.js': `import * as m from './m.js'\nm.nope\n${filterJs()}`, 'm.js': 'export const a = 1\n' }))
    expect(result.report.errors).toEqual([])
    expect(result.report.warnings.length).toBeGreaterThan(0)
    for (const w of result.report.warnings) expect(w.code).toBe('build-warning')
  })
})

describe('folder layout', () => {
  it('takes the files of nested asset folders, in code-unit order', async () => {
    const dir = await folder({
      'manifest.json': JSON.stringify({ ouaf: '1', id: 'x', name: 'X', version: '1.0.0', license: 'CC0-1.0', requires: {}, layers: [] }),
      'assets/b/z.txt': 'z',
      'assets/b/a.txt': 'a',
      'assets/B.txt': 'B',
      'assets/a.txt': 'a',
    })
    const result = await packFolder(dir)
    expect(result.files).toEqual(['manifest.json', 'assets/B.txt', 'assets/a.txt', 'assets/b/a.txt', 'assets/b/z.txt'])
  })

  it('"assets" must be a folder, manifest.json a file', async () => {
    const asFile = await folder({ 'filter.js': filterJs(), assets: 'not a folder' })
    expect((await packFolder(asFile)).report.errors.map((e) => [e.code, e.file])).toEqual([['not-a-file', 'assets']])
    const asDir = await folder({ 'manifest.json/x': '{}' })
    const r = await packFolder(asDir)
    expect(r.report.errors.map((e) => [e.code, e.file, e.message])).toEqual([['not-a-file', 'manifest.json', '"manifest.json" is not a regular file.']])
  })

  it('refuses special files in assets/', async () => {
    const dir = await folder({ 'filter.js': filterJs() })
    await mkdir(join(dir, 'assets'))
    try {
      execFileSync('mkfifo', [join(dir, 'assets', 'pipe')])
    } catch {
      return // no mkfifo on this system
    }
    const result = await packFolder(dir)
    expect(result.report.errors.map((e) => [e.code, e.file])).toEqual([['not-a-file', 'assets/pipe']])
  })

  it('a file given instead of a folder is not something to pack', async () => {
    const dir = await folder({ 'filter.js': filterJs() })
    await expect(packFolder(join(dir, 'filter.js'))).rejects.toThrow(PackSourceError)
    await expect(packFolder(join(dir, 'filter.js'))).rejects.toThrow(/not a folder \(ouaf pack takes the filter folder/)
  })
})
