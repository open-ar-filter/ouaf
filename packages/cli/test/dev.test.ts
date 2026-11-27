/** Serving filter folders to the playground with hot reload (#36): `DevFilters`. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DevFilters } from '../src/dev.ts'

const dec = new TextDecoder()
const data = (id: string) => `id: '${id}', name: 'X', version: '1.0.0', license: 'CC0-1.0', requires: {}, layers: []`

let root: string
let dev: DevFilters
const write = async (path: string, content: string) => {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), content)
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ouaf-dev-'))
  await write('src/filter.ts', `export default { ${data('src')}, setup() { return 1 } }\n`)
  await write('plain/manifest.json', JSON.stringify({ ouaf: '1', ...{ id: 'plain', name: 'X', version: '1.0.0', license: 'CC0-1.0', requires: {}, layers: [] } }))
  await write('bad/filter.js', `export default { ${data('Bad Id')} }\n`)
  await write('both/filter.js', `export default { ${data('both')} }\n`)
  await write('both/manifest.json', '{}')
  await write('group/deep/manifest.json', '{}')
  await write('group/deep/assets/a.png', 'png')
  await write('group/readme.md', '# not a filter')
  await write('pack.ouaf', 'zip')
  dev = new DevFilters(root)
})
afterAll(() => rm(root, { recursive: true, force: true }))

describe('filterOf', () => {
  it('the nearest filter folder of a file, a folder, a deleted file; a .ouaf itself', () => {
    expect(dev.filterOf('src/filter.ts')).toBe('src')
    expect(dev.filterOf(join(root, 'src', 'filter.ts'))).toBe('src')
    expect(dev.filterOf('src')).toBe('src')
    expect(dev.filterOf('group/deep/assets/a.png')).toBe('group/deep')
    expect(dev.filterOf('group/deep/assets/gone.png')).toBe('group/deep')
    expect(dev.filterOf('pack.ouaf')).toBe('pack.ouaf')
  })

  it('nothing outside a filter or outside the root', () => {
    expect(dev.filterOf('group/readme.md')).toBeUndefined()
    expect(dev.filterOf('group')).toBeUndefined()
    expect(dev.filterOf('../elsewhere/filter.ts')).toBeUndefined()
    expect(dev.filterOf(root)).toBeUndefined()
  })
})

describe('file', () => {
  it('a source folder is served from its package', async () => {
    const manifest = await dev.file('src/manifest.json')
    expect(manifest?.status).toBe(200)
    expect(JSON.parse(dec.decode(manifest!.body))).toMatchObject({ ouaf: '1', id: 'src', script: { entry: 'script.js', setup: true } })
    expect(dec.decode((await dev.file('src/script.js'))!.body)).toContain('setup')
    expect(await dev.file('src/assets/missing.png')).toBeUndefined()
    expect(dev.isSource('src')).toBe(true)
  })

  it('a folder with a manifest, a .ouaf, a path outside any filter: left to static serving', async () => {
    expect(await dev.file('plain/manifest.json')).toBeUndefined()
    expect(await dev.file('both/manifest.json')).toBeUndefined()
    expect(await dev.file('pack.ouaf')).toBeUndefined()
    expect(await dev.file('group/readme.md')).toBeUndefined()
    expect(dev.isSource('both')).toBe(false)
  })

  it('a source folder that does not pack: its manifest.json answers 422 with the report', async () => {
    const r = await dev.file('bad/manifest.json')
    expect(r?.status).toBe(422)
    expect(dec.decode(r!.body)).toMatch(/^bad\/filter\.js \/id — error \[format\] Invalid format: "Bad Id"\./)
    expect(await dev.file('bad/script.js')).toBeUndefined()
  })

  it('packed once, again after invalidate', async () => {
    await write('cached/filter.ts', `export default { ${data('one')} }\n`)
    const id = async () => JSON.parse(dec.decode((await dev.file('cached/manifest.json'))!.body)).id
    expect(await id()).toBe('one')
    await write('cached/filter.ts', `export default { ${data('two')} }\n`)
    expect(await id()).toBe('one')
    dev.invalidate('cached')
    expect(await id()).toBe('two')
  })
})

describe('report', () => {
  it('the validation report of any filter folder', async () => {
    expect(await dev.report('src')).toEqual({ ok: true, text: 'src: valid.' })
    expect(await dev.report('plain')).toEqual({ ok: true, text: 'plain: valid.' })
    expect(await dev.report('bad')).toMatchObject({ ok: false, text: expect.stringContaining('bad: 1 error.') })
  })

  it('a folder that cannot be packed, a missing folder, a .ouaf', async () => {
    expect(await dev.report('both')).toMatchObject({ ok: false, text: expect.stringMatching(/^both: .*filter\.js.*manifest\.json/) })
    expect(await dev.report('nope')).toEqual({ ok: false, text: 'nope: no such filter folder.' })
    expect(await dev.report('pack.ouaf')).toEqual({ ok: false, text: 'pack.ouaf: no such filter folder.' })
  })
})
