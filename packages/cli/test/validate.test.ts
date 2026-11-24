import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memorySource, openFolder, zipSource } from '../src/source.ts'
import { BrowserSetupError } from '../src/browser.ts'
import type { GlslCompiler } from '../src/glsl.ts'
import { validatePackage, validatePath, type PackageIssue, type PackageReport } from '../src/validate.ts'
import { formatReport } from '../src/report.ts'
import { avif, bytes, cube, glb, jpeg, ktx2, mp4, png, webm, zip } from './helpers.ts'

const fixtures = join(import.meta.dirname, 'fixtures')

const base = { ouaf: '1', id: 'test', name: 'Test', version: '1.0.0', license: 'CC0-1.0', requires: { face: true } }

const where = (i: PackageIssue) => `${i.code}@${i.file}${i.line !== undefined ? `:${i.line}` : ''}${i.path ? `#${i.path}` : ''}`
const codes = (issues: PackageIssue[]) => issues.map(where)

/** A package with one sticker per asset (so that every asset is used). */
function pkg(assets: Record<string, unknown>, files: Record<string, Uint8Array | string>, extra: Record<string, unknown> = {}) {
  const layers = Object.keys(assets).map((name) => ({ type: 'sticker', src: name, anchor: 'forehead' }))
  return memorySource({ 'manifest.json': JSON.stringify({ ...base, assets, layers, ...extra }, null, 2), ...files })
}

const run = (source: ReturnType<typeof memorySource>) => validatePackage(source)

describe('fixture folders', () => {
  it('valid: no errors, no warnings; GLSL compilation reported as skipped', async () => {
    const r = await validatePath(join(fixtures, 'valid'))
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.skipped).toEqual([expect.objectContaining({ check: 'glsl-compile', files: ['assets/glitch.frag'] })])
    expect(r.stats.files).toBe(5)
  })

  it('broken: every problem located by file, line and JSON pointer', async () => {
    const r = await validatePath(join(fixtures, 'broken'))
    expect(r.ok).toBe(false)
    expect(codes(r.errors)).toEqual([
      'unknown-anchor@manifest.json:15#/layers/0/anchor',
      'missing-file@manifest.json:9#/assets/hat',
      'format-mismatch@assets/photo.png#/assets/photo',
      'lut-syntax@assets/grade.cube:2#/assets/grade',
      'shader-version@assets/fx.frag:1#/assets/fx',
      'shader-main@assets/fx.frag:5#/assets/fx',
      'shader-no-effect@assets/fx.frag#/assets/fx',
    ])
    expect(codes(r.warnings)).toEqual(['outside-layout@README.md', 'unreferenced-file@assets/Hat.png'])
    // Case-only mismatch: the hint says so.
    expect(r.errors[1]!.message).toContain('Did you mean "assets/Hat.png"?')
    expect(r.errors[1]!.hint).toContain('case-sensitive')
    expect(r.errors[2]!.hint).toContain('assets/photo.jpg')
    // Every error carries a hint.
    expect(r.errors.every((e) => e.hint)).toBe(true)
  })

  it('human output: clickable file:line:column, pointer, code, hint', async () => {
    const r = await validatePath(join(fixtures, 'broken'))
    const text = formatReport({ ...r, input: 'broken' })
    expect(text).toContain('broken/manifest.json:15:40 /layers/0/anchor — error [unknown-anchor] Unknown anchor "nose". Did you mean "noseTip"?')
    expect(text).toContain('broken/assets/fx.frag:1 /assets/fx — error [shader-version]')
    expect(text).toContain('    → Remove the #version line.')
    expect(text.split('\n').pop()).toBe('broken: 7 errors, 2 warnings.')
  })
})

describe('.ouaf (zip) input', () => {
  let dir = ''
  const tmp = async (name: string, data: Uint8Array) => {
    dir ||= await mkdtemp(join(tmpdir(), 'ouaf-cli-'))
    const file = join(dir, name)
    await writeFile(file, data)
    return file
  }
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  const manifest = JSON.stringify({ ...base, assets: { star: 'assets/star.png' }, layers: [{ type: 'sticker', src: 'star', anchor: 'forehead' }] })

  it('validates a zipped package like the folder', async () => {
    const r = await validatePath(await tmp('ok.ouaf', zip({ 'manifest.json': manifest, 'assets/star.png': png(64, 64) })))
    expect(r.kind).toBe('zip')
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.stats.archiveBytes).toBeGreaterThan(0)
  })

  it('reports links and unsafe paths as errors, files outside the layout and case conflicts as warnings', async () => {
    const r = await validatePath(await tmp('bad.ouaf', zip({
      'manifest.json': manifest,
      'assets/star.png': { data: 'star.png', mode: 0o120777 },
      '../evil.txt': 'x',
      'notes.txt': 'x',
      'assets/a.json': '{}',
      'assets/A.json': '{}',
    })))
    expect(codes(r.errors)).toEqual(['symlink@assets/star.png', 'unsafe-path@../evil.txt'])
    expect(codes(r.warnings)).toEqual(expect.arrayContaining(['case-conflict@assets/A.json', 'outside-layout@notes.txt']))
    expect(r.warnings.find((w) => w.code === 'case-conflict')!.message).toContain('differs from "assets/a.json" only by case')
  })

  it('explains a zip of the folder instead of its content', async () => {
    const r = await validatePath(await tmp('nested.ouaf', zip({ 'pirate/manifest.json': manifest, 'pirate/assets/star.png': png(4, 4) })))
    expect(codes(r.errors)).toContain('missing-manifest@manifest.json')
    expect(r.errors.find((e) => e.code === 'missing-manifest')!.hint).toContain('zip the content of the folder')
  })

  it('reports a file that is not a zip, or a corrupt entry', async () => {
    const r = await validatePath(await tmp('not-a-zip.ouaf', bytes('hello')))
    expect(codes(r.errors)).toEqual(['zip-invalid@'])
    const archive = zip({ 'manifest.json': { data: manifest, store: true }, 'assets/star.png': png(4, 4) })
    const at = Buffer.from(archive).indexOf('"ouaf"')
    archive[at + 1] = 'x'.charCodeAt(0) // breaks the CRC of manifest.json
    const r2 = await validatePath(await tmp('corrupt.ouaf', archive))
    expect(codes(r2.errors)).toEqual(['zip-invalid@manifest.json'])
  })

  it('throws for a missing input (usage error, not an invalid filter)', async () => {
    await expect(validatePath(join(fixtures, 'does-not-exist'))).rejects.toThrow('no such file or folder')
  })
})

describe('folder input', () => {
  it('reports symbolic links inside the folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ouaf-cli-'))
    try {
      await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...base, requires: {}, layers: [] }))
      await symlink('/etc/hostname', join(dir, 'script.js'))
      const r = await validatePackage(await openFolder(dir))
      expect(codes(r.errors)).toEqual(['symlink@script.js'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('recognizes a source folder (filter.js without manifest.json)', async () => {
    const r = await run(memorySource({ 'filter.js': 'export default {}' }))
    expect(codes(r.errors)).toEqual(['missing-manifest@manifest.json'])
    expect(r.errors[0]!.hint).toContain('ouaf pack')
  })
})

describe('manifest', () => {
  it('reports JSON syntax errors with line and column', async () => {
    const r = await run(memorySource({ 'manifest.json': '{\n  "ouaf": "1",\n}\n' }))
    expect(r.errors).toEqual([expect.objectContaining({ code: 'json-syntax', file: 'manifest.json', line: 3, column: 1 })])
    expect(r.errors[0]!.message).not.toContain('position')
  })

  it('maps @ouaf/spec issues to manifest.json lines, including missing properties', async () => {
    const r = await run(memorySource({ 'manifest.json': '{\n  "ouaf": "1",\n  "id": "x"\n}' }))
    expect(r.errors.find((e) => e.path === '/name')).toMatchObject({ code: 'required', file: 'manifest.json', line: 1 })
  })

  it('checks script.js against the "script" section', async () => {
    const r = await run(memorySource({ 'manifest.json': JSON.stringify({ ...base, requires: {}, layers: [], script: { entry: 'script.js' } }) }))
    expect(codes(r.errors)).toEqual(['missing-file@manifest.json:1#/script/entry'])
    const r2 = await run(memorySource({ 'manifest.json': JSON.stringify({ ...base, requires: {}, layers: [] }), 'script.js': '' }))
    expect(codes(r2.warnings)).toEqual(['unused-script@script.js'])
  })

  it('checks files referenced by path from layers and the thumbnail', async () => {
    const r = await run(memorySource({
      'manifest.json': JSON.stringify({ ...base, thumbnail: 'assets/thumb.webp', layers: [{ type: 'sticker', src: 'assets/a.png', anchor: 'forehead' }] }),
      'assets/a.png': jpeg(10, 10),
    }))
    expect(codes(r.errors)).toEqual(['missing-file@manifest.json:1#/thumbnail', 'format-mismatch@assets/a.png#/layers/0/src'])
  })
})

describe('formats and limits (spec §10)', () => {
  it('rejects extensions outside the formats of the kind', async () => {
    const r = await run(pkg({ anim: { src: 'assets/anim.gif', kind: 'image' } }, { 'assets/anim.gif': bytes('GIF89a\x01\0\x01\0') }))
    expect(codes(r.errors)).toEqual(['unsupported-format@manifest.json:11#/assets/anim'])
    expect(r.errors[0]!.hint).toContain('PNG, WebP, JPEG, AVIF, SVG, KTX2')
  })

  it('limits images to 4096 px per side, read from the header of each format', async () => {
    const r = await run(pkg(
      { a: 'assets/a.png', b: 'assets/b.jpg', c: 'assets/c.ktx2', d: 'assets/d.avif', ok: 'assets/ok.png' },
      { 'assets/a.png': png(4097, 1), 'assets/b.jpg': jpeg(10, 5000), 'assets/c.ktx2': ktx2(8192, 8192), 'assets/d.avif': avif(5000, 100), 'assets/ok.png': png(4096, 4096) },
    ))
    expect(codes(r.errors)).toEqual(['image-too-large@assets/a.png#/assets/a', 'image-too-large@assets/b.jpg#/assets/b', 'image-too-large@assets/c.ktx2#/assets/c', 'image-too-large@assets/d.avif#/assets/d'])
    expect(r.errors[0]!.message).toContain('4097×1 px')
  })

  it('warns when a spritesheet does not divide into its grid', async () => {
    const r = await run(pkg({ walk: { src: 'assets/walk.png', frames: { cols: 3, rows: 2, fps: 12 } } }, { 'assets/walk.png': png(100, 64) }))
    expect(codes(r.warnings)).toEqual(['spritesheet-grid@assets/walk.png#/assets/walk'])
  })

  it('checks video codecs and resolution', async () => {
    const r = await run(pkg(
      { a: 'assets/a.mp4', b: 'assets/b.mp4', c: 'assets/c.webm', d: 'assets/d.webm', e: 'assets/e.mp4', f: { src: 'assets/f.mp4', alpha: 'packed' } },
      {
        'assets/a.mp4': mp4('avc1', 1280, 720),
        'assets/b.mp4': mp4('hvc1', 1280, 720),
        'assets/c.webm': webm('V_VP9', 720, 1280),
        'assets/d.webm': webm('V_VP8', 640, 360),
        'assets/e.mp4': mp4('avc1', 1920, 1080),
        'assets/f.mp4': mp4('avc1', 2560, 720),
      },
    ))
    expect(codes(r.errors)).toEqual(['unsupported-codec@assets/b.mp4#/assets/b', 'unsupported-codec@assets/d.webm#/assets/d', 'video-too-large@assets/f.mp4#/assets/f'])
    expect(codes(r.warnings)).toEqual(['video-large@assets/e.mp4#/assets/e'])
    expect(r.errors[0]!.hint).toContain('libx264')
  })

  it('checks glTF models: version, external files, remote URLs', async () => {
    const gltf = {
      asset: { version: '2.0' },
      buffers: [{ uri: 'hat.bin' }, { uri: 'data:application/octet-stream;base64,AAAA' }],
      images: [{ uri: 'https://example.com/t.png' }, { uri: 'tex/missing.png' }, { uri: '../../x.png' }],
    }
    const r = await run(pkg({ hat: 'assets/hat.gltf', old: 'assets/old.glb' }, {
      'assets/hat.gltf': JSON.stringify(gltf),
      'assets/hat.bin': new Uint8Array(4),
      'assets/old.glb': glb({ asset: { version: '1.0' } }, 1),
    }))
    expect(codes(r.errors)).toEqual([
      'remote-resource@assets/hat.gltf#/assets/hat',
      'missing-file@assets/hat.gltf#/assets/hat',
      'unsafe-path@assets/hat.gltf#/assets/hat',
      'gltf-version@assets/old.glb#/assets/old',
    ])
    // hat.bin is used by the model, so it is not reported as unreferenced.
    expect(r.warnings).toEqual([])
  })

  it('accepts a GLB with an embedded JSON chunk', async () => {
    const r = await run(pkg({ hat: 'assets/hat.glb' }, { 'assets/hat.glb': glb({ asset: { version: '2.0' } }) }))
    expect(r.errors).toEqual([])
  })

  it('checks .cube LUTs line by line', async () => {
    const lut = (text: string) => run(memorySource({
      'manifest.json': JSON.stringify({ ...base, requires: {}, assets: { g: 'assets/g.cube' }, layers: [{ type: 'color', lut: 'g' }] }),
      'assets/g.cube': text,
    }))
    expect((await lut(cube(3))).errors).toEqual([])
    expect(codes((await lut('LUT_3D_SIZE 2\n0 0 0\n0 0 oops\n')).errors)).toEqual(['lut-syntax@assets/g.cube:3#/assets/g'])
    expect(codes((await lut('0 0 0\n')).errors)).toEqual(['lut-syntax@assets/g.cube:1#/assets/g'])
    expect(codes((await lut('# empty\n')).errors)).toEqual(['lut-syntax@assets/g.cube#/assets/g'])
    expect(codes((await lut('LUT_3D_SIZE 1\n')).errors)).toEqual(['lut-syntax@assets/g.cube:1#/assets/g'])
  })

  it('parses JSON data assets with located errors', async () => {
    const r = await run(memorySource({
      'manifest.json': JSON.stringify({ ...base, requires: {}, assets: { words: 'assets/words.json' }, layers: [], script: { entry: 'script.js', uses: [] } }),
      'script.js': 'export default {}',
      'assets/words.json': '{\n  "a": [1, 2,]\n}',
    }))
    expect(r.errors).toEqual([expect.objectContaining({ code: 'json-syntax', file: 'assets/words.json', line: 2, path: '/assets/words' })])
  })

  it('checks fonts and audio by their magic bytes', async () => {
    const r = await run(memorySource({
      'manifest.json': JSON.stringify({
        ...base,
        assets: { f: 'assets/f.woff2', o: 'assets/o.opus' },
        layers: [{ type: 'text', text: 'x', anchor: 'chin', font: 'f' }],
        script: { entry: 'script.js', uses: [] },
      }),
      'script.js': '',
      'assets/f.woff2': bytes('wOFF\0\x01\0\0'),
      'assets/o.opus': bytes('OggS\0\x02' + '\0'.repeat(22) + 'Vorbis'),
    }))
    expect(codes(r.errors)).toEqual(['format-mismatch@assets/f.woff2#/assets/f', 'format-mismatch@assets/o.opus#/assets/o'])
  })

  it('reports empty files and files that are not media at all', async () => {
    const r = await run(pkg({ a: 'assets/a.png', b: 'assets/b.webp' }, { 'assets/a.png': new Uint8Array(), 'assets/b.webp': bytes('hello') }))
    expect(codes(r.errors)).toEqual(['empty-file@assets/a.png#/assets/a', 'format-mismatch@assets/b.webp#/assets/b'])
  })
})

describe('shaders (spec §11)', () => {
  const shader = (src: string, compileShaders?: GlslCompiler, requires: Record<string, unknown> = {}, ref = 'fx', layer: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    validatePackage(memorySource({
      'manifest.json': JSON.stringify({ ...base, requires, assets: { fx: 'assets/fx.frag' }, layers: [{ type: 'shader', id: 'mask', src: ref, ...layer }], ...extra }),
      'assets/fx.frag': src,
    }), compileShaders ? { compileShaders } : {})

  it('ignores #version and main() inside comments', async () => {
    const r = await shader('/* #version 300 es\nvoid main() {} */\n// void main()\nvec4 effect(vec2 uv) { return ouaf_sample(uv); }\n')
    expect(r.errors).toEqual([])
  })

  it('ouaf_faceMask uses the face: requires.face is needed, and is not reported unused (spec §11.1)', async () => {
    const masked = 'vec4 effect(vec2 uv) { return ouaf_sample(uv) * ouaf_faceMask(uv); }\n'
    const missing = await shader(masked)
    expect(codes(missing.errors)).toEqual(['requires-face@manifest.json:1#/requires'])
    expect(missing.errors[0]!.message).toContain('ouaf_faceMask in the shader of layer "mask"')
    const declared = await shader(masked, undefined, { face: true })
    expect([declared.errors, declared.warnings]).toEqual([[], []])
    // By path rather than by asset name (the asset is then unused: its own warning).
    const byPath = await shader(masked, undefined, { face: true }, 'assets/fx.frag')
    expect(codes(byPath.warnings)).not.toContain('unused-requirement@manifest.json:1#/requires/face')
    // A commented-out call is not a use.
    const commented = await shader('// ouaf_faceMask(uv)\nvec4 effect(vec2 uv) { return ouaf_sample(uv); /* ouaf_faceMask */ }\n', undefined, { face: true })
    expect(codes(commented.warnings)).toEqual(['unused-requirement@manifest.json:1#/requires/face'])
  })

  it('compiles each layer\'s program as the engine wraps it, and reports errors at lines of the author\'s file', async () => {
    const seen: Array<{ vertex: string; fragment: string }> = []
    const compiler: GlslCompiler = async (programs) => {
      seen.push(...programs)
      // The wrapper's `#line 1` makes compilers report author lines (ANGLE's format).
      return programs.map(() => ({ fragment: "ERROR: 0:2: 'nope' : undeclared identifier\nERROR: 1 compilation errors.  No code generated." }))
    }
    const r = await shader('vec4 effect(vec2 uv) {\n  return nope;\n}\n', compiler, { face: true }, 'fx', {
      stage: 'face', uniforms: { amount: { param: 'amount' }, tint: '#ff0000' }, textures: { noise: 'fx' }, anchors: ['noseTip'],
    }, { params: { amount: { type: 'number', default: 0.5 } } })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.vertex).toContain('out float ouaf_vMask') // the face mesh's vertex shader
    expect(seen[0]!.fragment).toMatch(/uniform float amount;[\s\S]*uniform vec4 tint;[\s\S]*uniform sampler2D noise;/)
    expect(seen[0]!.fragment).toContain('#define OUAF_MAX_FACES 1')
    expect(seen[0]!.fragment).toContain('uniform vec2 ouaf_anchor_noseTip[OUAF_MAX_FACES];')
    expect(r.errors).toEqual([
      expect.objectContaining({ code: 'glsl', file: 'assets/fx.frag', line: 2, path: '/layers/0/src', message: "'nope' : undeclared identifier" }),
    ])
    expect(r.skipped).toEqual([])
  })

  it('reports a uniform without a GLSL type, which the engine would reject, and compiles nothing then', async () => {
    let calls = 0
    const r = await shader('vec4 effect(vec2 uv) { return ouaf_sample(uv); }\n', async () => (calls++, []), {}, 'fx', {
      uniforms: { level: { bind: 'faces.count', map: { '0': 0, '1': '#ff0000' } } },
    })
    expect(codes(r.errors)).toEqual(['shader-uniform@manifest.json:1#/layers/0/uniforms/level'])
    expect(r.errors[0]!.message).toContain('the values of "map" must all be')
    expect(calls).toBe(0)
  })

  it('skips compilation, saying why, without a compiler or when Chromium cannot start', async () => {
    const src = 'vec4 effect(vec2 uv) { return ouaf_sample(uv); }\n'
    const none = await shader(src)
    expect(none.ok).toBe(true)
    expect(none.skipped).toEqual([expect.objectContaining({ check: 'glsl-compile', files: ['assets/fx.frag'] })])
    const missing = await shader(src, async () => {
      throw new BrowserSetupError('Playwright\'s Chromium is not installed.', 'Run: npx playwright install chromium')
    })
    expect(missing.ok).toBe(true)
    expect(missing.skipped[0]!.reason).toContain('npx playwright install chromium')
    // A source that fails the static checks is not compiled.
    let calls = 0
    const broken = await shader('void main() {}\n', async () => (calls++, []))
    expect(codes(broken.errors)).toContain('shader-main@assets/fx.frag:1#/assets/fx')
    expect([calls, broken.skipped]).toEqual([0, []])
  })
})

describe('package budget (spec §3)', () => {
  it('warns above 5 MB and fails above 50 MB', async () => {
    const big = (n: number) => pkg({ v: 'assets/v.mp4' }, { 'assets/v.mp4': Object.assign(new Uint8Array(n), mp4('avc1', 640, 360)) })
    const warn = await run(big(6_000_000))
    expect(codes(warn.warnings)).toEqual(['package-size@'])
    expect(warn.warnings[0]!.message).toContain('6.0 MB')
    const fail = await run(big(51_000_000))
    expect(codes(fail.errors)).toEqual(['package-too-large@'])
  })

  it('counts the files unpacked, not the archive: just under 50 MB of stored files in an archive over 50 MB is valid', async () => {
    const files = Object.fromEntries(Array.from({ length: 999 }, (_, i) => [`assets/${i}.json`, { data: new Uint8Array(50_000), store: true }]))
    const archive = zip({ 'manifest.json': JSON.stringify({ ...base, requires: {}, layers: [] }), ...files })
    expect(archive.length).toBeGreaterThan(50_000_000)
    const r = await validatePackage(zipSource(archive, 'big.ouaf'))
    expect(codes(r.errors).filter((c) => c.startsWith('package-too-large') || c.startsWith('too-many'))).toEqual([])
    expect(r.warnings.find((w) => w.code === 'package-size')!.message).toMatch(/^The package files total [\d.]+ MB unpacked/)
  })

  it('fails a zip whose files total more than 50 MB unpacked, and above 1000 files (the engine refuses them)', async () => {
    const archive = zip({ 'manifest.json': JSON.stringify({ ...base, requires: {}, layers: [] }), 'assets/zeros.json': new Uint8Array(51_000_000) })
    expect(archive.length).toBeLessThan(1_000_000)
    const r = await validatePackage(zipSource(archive, 'zeros.ouaf'))
    expect(codes(r.errors)).toContain('package-too-large@')
    expect(r.errors.find((e) => e.code === 'package-too-large')!.message).toContain('51.0 MB unpacked')

    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`assets/${i}.json`, '{}']))
    const r2 = await run(memorySource({ 'manifest.json': JSON.stringify({ ...base, requires: {}, layers: [] }), ...many }))
    expect(codes(r2.errors)).toEqual(['too-many-entries@'])
  })
})

describe('report', () => {
  it('stays a plain JSON-serializable object', async () => {
    const r: PackageReport = await validatePath(join(fixtures, 'broken'))
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
  })
})
