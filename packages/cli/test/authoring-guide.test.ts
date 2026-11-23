/**
 * Keeps AUTHORING.md correct (#35): every JSON, TypeScript, JavaScript and GLSL block of the guide is checked.
 *
 * Each such block carries an `ouaf=` tag in its info string (```json ouaf=layer), invisible on GitHub:
 *
 * - `ouaf=layer`: one layer, validated inside a minimal manifest (`requires.face` set);
 * - `ouaf=part`: manifest fields (`params`, `assets`, `layers`…) merged into a minimal manifest;
 * - `ouaf=<example>/<path>`: a file of a complete example folder, e.g. `spotlight/manifest.json`,
 *   `spotlight/assets/spotlight.frag`, `smile-total/filter.ts`. A folder with `manifest.json` must pass
 *   `ouaf validate` without errors or warnings; a folder with `filter.ts` must pass `ouaf pack` the same way, type-check
 *   against `@ouaf/spec`, and its packed script must run its functions in the script runtime without warnings.
 *
 * llms.txt is checked too: every link points to a file of the repository.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRegistry, findEvent, validateManifest } from '@ouaf/spec'
import { afterAll, describe, expect, it } from 'vitest'
import { scriptRuntime, type WireDone } from '../../core/src/script/runtime.ts'
import { packFolder } from '../src/pack.ts'
import { validatePath } from '../src/validate.ts'
import { readZipEntries, readZipEntry } from '../src/zip.ts'

const root = join(import.meta.dirname, '../../..')
const guide = readFileSync(join(root, 'AUTHORING.md'), 'utf8')
const CHECKED = new Set(['json', 'ts', 'js', 'glsl'])

interface Block {
  lang: string
  tag: string | undefined
  body: string
  line: number
}

/** Fenced code blocks of a Markdown document, with the `ouaf=` tag of their info string. */
function blocks(markdown: string): Block[] {
  const out: Block[] = []
  const lines = markdown.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,}|~{3,})(\S*)(.*)$/.exec(lines[i]!)
    if (!open) continue
    const fence = open[1]!
    const start = i
    const body: string[] = []
    for (i++; i < lines.length && !lines[i]!.startsWith(fence); i++) body.push(lines[i]!)
    const tag = /(?:^|\s)ouaf=(\S+)/.exec(open[3]!)?.[1]
    out.push({ lang: open[2]!, tag, body: `${body.join('\n')}\n`, line: start + 1 })
  }
  return out
}

const all = blocks(guide)
const checked = all.filter((b) => CHECKED.has(b.lang))
const where = (b: Block) => `AUTHORING.md:${b.line} (${b.lang} ${b.tag ?? 'untagged'})`

const base = { ouaf: '1', id: 'snippet', name: 'Snippet', version: '1.0.0', license: 'CC0-1.0', requires: { face: true }, layers: [] }

/** Example folders: `<example>/<path>` tags grouped by example. */
const examples = new Map<string, Map<string, Block>>()
for (const b of checked) {
  const m = b.tag && /^([a-z0-9-]+)\/(.+)$/.exec(b.tag)
  if (!m) continue
  const files = examples.get(m[1]!) ?? new Map<string, Block>()
  examples.set(m[1]!, files)
  files.set(m[2]!, b)
}

const temps: string[] = []
async function writeExample(parent: string, name: string): Promise<string> {
  const dir = join(parent, name)
  for (const [path, b] of examples.get(name)!) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), b.body)
  }
  return dir
}
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ouaf-authoring-'))
  temps.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const issues = (list: Array<{ code: string; path: string; message: string; file?: string }>) =>
  list.map((i) => `${i.file ?? ''}${i.path} [${i.code}] ${i.message}`)

describe('AUTHORING.md code blocks', () => {
  it('tags every JSON, TypeScript, JavaScript and GLSL block, so none goes unchecked', () => {
    expect(checked.length).toBeGreaterThan(10)
    expect(checked.filter((b) => b.tag === undefined).map(where)).toEqual([])
    const known = (t: string) => t === 'layer' || t === 'part' || /^[a-z0-9-]+\/.+$/.test(t)
    expect(checked.filter((b) => b.tag !== undefined && !known(b.tag)).map(where)).toEqual([])
  })

  it('has examples from a manifest folder to scripted filters', () => {
    const kinds = [...examples.values()].map((files) => (files.has('filter.ts') ? 'filter.ts' : 'manifest.json'))
    expect(kinds).toContain('manifest.json')
    expect(kinds).toContain('filter.ts')
    for (const [name, files] of examples) expect([name, files.has('filter.ts') || files.has('manifest.json')]).toEqual([name, true])
  })

  for (const b of checked.filter((x) => x.tag === 'layer' || x.tag === 'part')) {
    it(`${where(b)} is valid in a manifest`, () => {
      const snippet = JSON.parse(b.body) as Record<string, unknown>
      const manifest = b.tag === 'layer' ? { ...base, layers: [snippet] } : { ...base, ...snippet }
      expect(issues(validateManifest(manifest).errors)).toEqual([])
    })
  }

  for (const [name, files] of examples) {
    if (files.has('filter.ts')) continue
    it(`example "${name}" passes ouaf validate without warnings`, async () => {
      const manifest = JSON.parse(files.get('manifest.json')!.body) as { id: string }
      expect(manifest.id).toBe(name)
      const report = await validatePath(await writeExample(await temp(), name))
      expect(issues(report.errors)).toEqual([])
      expect(issues(report.warnings)).toEqual([])
    })
  }
})

describe('AUTHORING.md filter.ts examples', () => {
  const scripted = [...examples].filter(([, files]) => files.has('filter.ts')).map(([name]) => name)

  for (const name of scripted) {
    it(`"${name}" packs without warnings, and its script runs without warnings`, async () => {
      const dir = await writeExample(await temp(), name)
      const result = await packFolder(dir)
      expect(issues(result.report.errors)).toEqual([])
      expect(issues(result.report.warnings)).toEqual([])
      const zip = result.zip!
      const read = (path: string) => new TextDecoder().decode(readZipEntry(zip, readZipEntries(zip).find((e) => e.name === path)!))
      const manifest = JSON.parse(read('manifest.json')) as Manifest
      expect(manifest.id).toBe(name)
      const out = join(await temp(), 'script.mjs')
      await writeFile(out, read('script.js'))
      const answers = await runScript(manifest, () => import(pathToFileURL(out).href) as Promise<{ default?: unknown }>)
      expect(answers.flatMap((a) => a.warnings)).toEqual([])
    })
  }

  it('type-check against @ouaf/spec (defineFilter)', async () => {
    const dir = await temp()
    for (const name of scripted) await writeExample(dir, name)
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'es2023',
        lib: ['es2023', 'dom'],
        module: 'preserve',
        moduleResolution: 'bundler',
        strict: true,
        noUncheckedIndexedAccess: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        types: [],
        paths: { '@ouaf/spec': [join(root, 'packages/spec/src/index.ts')] },
      },
      include: ['**/filter.ts'],
    }))
    const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin/tsc')
    const r = spawnSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8' })
    expect(`${r.stdout}${r.stderr}`.trim()).toBe('')
    expect(r.status).toBe(0)
  }, 60_000)
})

describe('llms.txt', () => {
  const text = readFileSync(join(root, 'llms.txt'), 'utf8')

  it('follows llmstxt.org: a title, a summary, then lists of links', () => {
    expect(text).toMatch(/^# \S/)
    expect(text).toMatch(/\n> \S/)
    expect(text).toMatch(/\n## \S/)
  })

  it('links to files of this repository', () => {
    const links = [...text.matchAll(/\]\((https:\/\/raw\.githubusercontent\.com\/open-ar-filter\/ouaf\/main\/|https:\/\/github\.com\/open-ar-filter\/ouaf\/tree\/main\/)([^)]+)\)/g)]
    expect(links.length).toBeGreaterThan(4)
    for (const [, , path] of links) expect([path, existsSync(join(root, path!))]).toEqual([path, true])
    // No other kind of link: everything an agent needs is in the repository.
    expect([...text.matchAll(/\]\(([^)]+)\)/g)].length).toBe(links.length)
  })
})

// ---------------------------------------------------------------------------------------------
// Running a packed script.js in the script runtime of @ouaf/core, as the engine's sandbox Worker does.

interface Manifest {
  id: string
  layers: Array<{ id?: string; type: string; width?: number; height?: number; fps?: number }>
  assets?: Record<string, unknown>
  script?: { on?: string[] }
}

/** A 2D context that accepts every call and property, as an `OffscreenCanvasRenderingContext2D` would. */
function anyContext(): unknown {
  const fn = () => undefined
  const getImageData = (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })
  return new Proxy({}, { get: (_t, key) => (key === 'canvas' ? undefined : key === 'getImageData' ? getImageData : fn), set: () => true })
}

/** `init`, then two frames with one face carrying every event the script handles; returns the answers. */
async function runScript(manifest: Manifest, load: () => Promise<{ default?: unknown }>): Promise<WireDone[]> {
  const listeners = new Set<(e: { data: unknown; ports?: readonly unknown[] }) => void>()
  scriptRuntime({ addEventListener: (_t, l) => void listeners.add(l), removeEventListener: (_t, l) => void listeners.delete(l) }, {
    harden: false,
    load,
    canvas: (width, height) => ({ width, height, getContext: anyContext }),
  })
  const channel = new MessageChannel()
  for (const l of [...listeners]) l({ data: { t: 'port' }, ports: [channel.port2] })
  const ask = (message: unknown) => new Promise<WireDone>((resolve) => {
    // `started` (init: the script starts) is not an answer.
    channel.port1.onmessage = (e) => void ((e.data as { t?: unknown }).t !== 'started' && resolve(e.data as WireDone))
    channel.port1.postMessage(message)
  })
  const reg = createRegistry()
  const events = (manifest.script?.on ?? []).map((name) =>
    name === 'paramChange' || name.startsWith('message:') ? { name, payload: name === 'paramChange' ? { name: 'x', value: 1, previous: 0 } : { data: null } }
      : findEvent(reg, name)?.face ? { name, face: 1 } : { name })
  const face = { id: 1, index: 0, pose: { yaw: 0, pitch: 0, roll: 0 }, size: 0.2, blendshapes: { jawOpen: 0.6 } }
  const canvases = manifest.layers.flatMap((l, layer) => (l.type === 'canvas' ? [{ layer, width: l.width, height: l.height, fps: l.fps ?? 30 }] : []))
  const assets = Object.fromEntries(Object.keys(manifest.assets ?? {}).map((name) => [name, { image: name }]))
  const layers = manifest.layers.map((l) => l.id ?? '')
  const answers = [
    await ask({ t: 'init', code: '', layers, params: {}, seed: 1, clock: 0, time: 0, assets, canvases }),
    await ask({ t: 'frame', seq: 1, time: 0.5, dt: 0.5, clock: 0.5, faces: [face], events }),
    await ask({ t: 'frame', seq: 2, time: 1.5, dt: 1, clock: 1.5, faces: [face], events: [] }),
  ]
  channel.port1.close()
  return answers
}
