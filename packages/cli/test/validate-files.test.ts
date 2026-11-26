/**
 * `ouaf validate`: the per-file checks and error paths not covered by validate.test.ts (unreadable files and
 * manifests, encodings, header details, glTF resources, format mismatch hints), on in-memory packages.
 */
import { describe, expect, it } from 'vitest'
import { SourceError, memorySource, type PackageSource } from '../src/source.ts'
import type { ProgramLog } from '../src/glsl.ts'
import { validatePackage, type PackageIssue } from '../src/validate.ts'
import { bytes, concat, cube, glb, mp4, png, webm } from './helpers.ts'

const base = { ouaf: '1', id: 'test', name: 'Test', version: '1.0.0', license: 'CC0-1.0', requires: { face: true } }
const where = (i: PackageIssue) => `${i.code}@${i.file}${i.line !== undefined ? `:${i.line}` : ''}${i.path ? `#${i.path}` : ''}`
const codes = (issues: PackageIssue[]) => issues.map(where)

/** A package with one sticker per asset (so that every asset is used). */
function pkg(assets: Record<string, unknown>, files: Record<string, Uint8Array | string>, extra: Record<string, unknown> = {}) {
  const layers = Object.keys(assets).map((name) => ({ type: 'sticker', src: name, anchor: 'forehead' }))
  return memorySource({ 'manifest.json': JSON.stringify({ ...base, assets, layers, ...extra }), ...files })
}
/** A package whose script may use any asset (no layer references them). */
function scripted(assets: Record<string, unknown>, files: Record<string, Uint8Array | string>) {
  return memorySource({
    'manifest.json': JSON.stringify({ ...base, requires: {}, assets, layers: [], script: { entry: 'script.js', uses: [] } }),
    'script.js': '',
    ...files,
  })
}
const invalidUtf8 = Uint8Array.from([0x7b, 0xc3, 0x28, 0x7d])
/** Text that is UTF-8 in the first 4 KB sniffed (spec §10.4) but not further: only the full decoding finds it. */
const lateLatin1 = (head: string, tail = '') => concat(bytes(head), bytes(' '.repeat(5000)), [0xe9], bytes(tail))

/** `source` whose `read` fails for `path` with `error`. */
function failing(source: PackageSource, path: string, error: Error): PackageSource {
  return { ...source, read: async (p) => (p === path ? Promise.reject(error) : source.read(p)) }
}

describe('unreadable files', () => {
  it('a manifest that cannot be read is reported, with the code of the read error', async () => {
    const source = failing(memorySource({ 'manifest.json': '{}' }), 'manifest.json', new SourceError('zip-invalid', 'manifest.json: corrupt zip entry.'))
    const r = await validatePackage(source)
    expect(r.ok).toBe(false)
    expect(r.errors).toEqual([expect.objectContaining({ code: 'zip-invalid', file: 'manifest.json', path: '', message: 'manifest.json: corrupt zip entry.', hint: 'Rebuild the archive.' })])
  })

  it('an asset that cannot be read is reported at its manifest pointer', async () => {
    const source = failing(pkg({ a: 'assets/a.png' }, { 'assets/a.png': png(2, 2) }), 'assets/a.png', new SourceError('zip-unsupported', 'assets/a.png: encrypted.'))
    const r = await validatePackage(source)
    expect(codes(r.errors)).toEqual(['zip-unsupported@assets/a.png#/assets/a'])
  })

  it('other read errors are not validation problems: they propagate', async () => {
    const source = failing(memorySource({ 'manifest.json': '{}' }), 'manifest.json', new Error('EIO'))
    await expect(validatePackage(source)).rejects.toThrow('EIO')
  })

  it('a shader that cannot be read is reported once, by the file checks', async () => {
    const files = {
      'manifest.json': JSON.stringify({ ...base, requires: {}, assets: { fx: 'assets/fx.frag' }, layers: [{ type: 'shader', src: 'fx' }] }),
      'assets/fx.frag': 'vec4 effect(vec2 uv) { return ouaf_sample(uv); }',
    }
    const r = await validatePackage(failing(memorySource(files), 'assets/fx.frag', new SourceError('zip-invalid', 'assets/fx.frag: truncated zip entry.')))
    expect(codes(r.errors)).toEqual(['zip-invalid@assets/fx.frag#/assets/fx'])
  })
})

describe('manifest', () => {
  it('must be UTF-8', async () => {
    const r = await validatePackage(memorySource({ 'manifest.json': invalidUtf8 }))
    expect(r.errors).toEqual([expect.objectContaining({ code: 'encoding', file: 'manifest.json', message: 'manifest.json is not valid UTF-8.' })])
  })

  it('a byte-order mark is accepted', async () => {
    const r = await validatePackage(memorySource({ 'manifest.json': `﻿${JSON.stringify({ ...base, requires: {}, layers: [] })}` }))
    expect(r.errors).toEqual([])
  })

  it('a manifest that is not an object is reported by the spec checks only', async () => {
    for (const value of ['[]', 'null', '"filter"']) {
      const r = await validatePackage(memorySource({ 'manifest.json': value, 'assets/a.png': png(1, 1) }))
      expect(r.ok).toBe(false)
      expect(r.errors.map((e) => e.code)).toContain('type')
      // No file checks: assets/a.png is not reported as unreferenced.
      expect(codes(r.warnings)).toEqual([])
    }
  })

  it('ignores malformed asset entries and layers when collecting the files to check', async () => {
    const r = await validatePackage(memorySource({
      'manifest.json': JSON.stringify({ ...base, assets: { n: 5, o: { kind: 'image' } }, layers: [null, 'text', { type: 'nope' }, { type: 'text', text: 5 }] }),
    }))
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).not.toContain('missing-file')
  })
})

describe('formats', () => {
  it('a file without extension, and an asset whose kind cannot be told', async () => {
    const r = await validatePackage(scripted({ a: { src: 'assets/noext', kind: 'image' }, b: 'assets/b.xyz' }, { 'assets/noext': png(1, 1), 'assets/b.xyz': 'x' }))
    expect(codes(r.errors)).toEqual(['unsupported-format@manifest.json:1#/assets/a'])
    expect(r.errors[0]!.message).toBe('"assets/noext": a file without extension is not a supported image format.')
    expect(codes(r.warnings)).toEqual(['unknown-kind@manifest.json:1#/assets/b'])
  })

  it('a mismatch suggests a rename when the real format is one the kind supports', async () => {
    const r = await validatePackage(pkg({ a: 'assets/a.png' }, { 'assets/a.png': webm('V_VP9', 2, 2) }))
    expect(r.errors[0]!.message).toBe('"assets/a.png" is not a PNG file (its content is WebM).')
    expect(r.errors[0]!.hint).toBe('Export it again as PNG. Supported image formats: PNG, WebP, JPEG, AVIF, SVG, KTX2.')
    const renamed = await validatePackage(pkg({ a: 'assets/a.png' }, { 'assets/a.png': concat([0xff, 0xd8, 0xff, 0xd9]) }))
    expect(renamed.errors[0]!.message).toBe('"assets/a.png" is not a PNG file (its content is JPEG).')
    expect(renamed.errors[0]!.hint).toBe('Rename it to "assets/a.jpg" and update the manifest, or export it again as PNG.')
  })

  it('text where a binary format is expected, and binary where text is expected', async () => {
    const text = await validatePackage(pkg({ a: 'assets/a.png' }, { 'assets/a.png': 'just text' }))
    expect(text.errors[0]!.message).toBe('"assets/a.png" is not a PNG file.')
    const lut = await validatePackage(memorySource({
      'manifest.json': JSON.stringify({ ...base, requires: {}, assets: { g: 'assets/g.cube' }, layers: [{ type: 'color', lut: 'g' }] }),
      'assets/g.cube': Uint8Array.from([0, 1, 2, 0xff]),
    }))
    expect(lut.errors[0]!.message).toBe('"assets/g.cube" is not a text file (unrecognized content).')
    expect(lut.errors[0]!.hint).toBe('Export it again as UTF-8 text. Supported lut formats: .cube.')
  })

  it('an image whose header has no dimensions', async () => {
    const noIhdr = concat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 0], bytes('IEND'), [0, 0, 0, 0])
    const r = await validatePackage(pkg({ a: 'assets/a.png' }, { 'assets/a.png': noIhdr }))
    expect(codes(r.warnings)).toEqual(['unreadable-header@assets/a.png#/assets/a'])
  })

  it('an SVG has no pixel size to check; a spritesheet that divides into its grid is fine', async () => {
    const r = await validatePackage(pkg(
      { s: 'assets/s.svg', walk: { src: 'assets/walk.png', frames: { cols: 4, rows: 2, fps: 12 } } },
      { 'assets/s.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'assets/walk.png': png(64, 32) },
    ))
    expect([r.errors, r.warnings]).toEqual([[], []])
  })

  it('videos: unreadable codec, VP9 required in WebM, packed alpha in the size message', async () => {
    const r = await validatePackage(pkg(
      { a: 'assets/a.mp4', b: 'assets/b.webm', c: { src: 'assets/c.mp4', alpha: 'packed' } },
      {
        'assets/a.mp4': concat(mp4('avc1', 2, 2).subarray(0, 24), new Uint8Array(8)),
        'assets/b.webm': webm('V_AV1', 640, 360),
        'assets/c.mp4': mp4('avc1', 1440, 720),
      },
    ))
    expect(codes(r.errors)).toEqual(['unsupported-codec@assets/b.webm#/assets/b'])
    expect(r.errors[0]!.message).toBe('"assets/b.webm" uses the AV1 codec: WebM videos must be VP9 (spec §10.2).')
    expect(r.errors[0]!.hint).toBe('Re-encode it, e.g. ffmpeg -i in -c:v libvpx-vp9 -an "b.webm".')
    expect(codes(r.warnings)).toEqual(['unreadable-header@assets/a.mp4#/assets/a', 'video-large@assets/c.mp4#/assets/c'])
    expect(r.warnings[0]!.hint).toBe('MP4 videos must be H.264 (spec §10.2).')
    expect(r.warnings[1]!.message).toBe('"assets/c.mp4" is 1440×720 px (alpha packed side by side included): 720p or less is recommended (spec §10.4).')
  })

  it('audio: an .opus file must hold Opus, an .ogg file may hold anything Ogg', async () => {
    const opus = bytes('OggS\0\x02' + '\0'.repeat(22) + 'OpusHead')
    const vorbis = bytes('OggS\0\x02' + '\0'.repeat(22) + 'Vorbis\0\0')
    const r = await validatePackage(scripted({ a: 'assets/a.opus', b: 'assets/b.ogg' }, { 'assets/a.opus': opus, 'assets/b.ogg': vorbis }))
    expect([r.errors, r.warnings]).toEqual([[], []])
  })

  it('JSON data must be UTF-8: in the sniffed header, and after it', async () => {
    const r = await validatePackage(scripted({ d: 'assets/d.json' }, { 'assets/d.json': concat(bytes('{"a": "'), [0xe9], bytes('"}')) }))
    expect(codes(r.errors)).toEqual(['format-mismatch@assets/d.json#/assets/d'])
    const late = await validatePackage(scripted({ d: 'assets/d.json' }, { 'assets/d.json': lateLatin1('{"a": "', '"}') }))
    expect(late.errors).toEqual([expect.objectContaining({ code: 'encoding', file: 'assets/d.json', message: '"assets/d.json" is not valid UTF-8.' })])
    const ok = await validatePackage(scripted({ d: { src: 'assets/d.json', kind: 'data' } }, { 'assets/d.json': '{"a": [1, 2]}' }))
    expect(ok.errors).toEqual([])
  })

  it('fonts are checked by their magic bytes only', async () => {
    const r = await validatePackage(memorySource({
      'manifest.json': JSON.stringify({ ...base, assets: { f: 'assets/f.ttf' }, layers: [{ type: 'text', text: 'x', font: 'f' }] }),
      'assets/f.ttf': Uint8Array.from([0, 1, 0, 0, 0, 0x10, 0, 0]),
    }))
    expect([r.errors, r.warnings]).toEqual([[], []])
  })
})

describe('glTF models', () => {
  const model = (files: Record<string, Uint8Array | string>, src = 'assets/m.gltf') => validatePackage(memorySource({
    'manifest.json': JSON.stringify({ ...base, assets: { m: src }, layers: [{ type: 'model', src: 'm' }] }),
    ...files,
  }))

  it('a GLB without a valid JSON chunk, or whose JSON is not UTF-8 or not JSON', async () => {
    const notJson = Uint8Array.from(glb({ asset: { version: '2.0' } }))
    new DataView(notJson.buffer).setUint32(16, 0x4e4f4942, true) // "BIN\0" chunk first
    expect(codes((await model({ 'assets/m.glb': notJson }, 'assets/m.glb')).errors)).toEqual(['gltf-invalid@assets/m.glb#/assets/m'])
    const short = Uint8Array.from(glb({ asset: { version: '2.0' } }))
    new DataView(short.buffer).setUint32(12, 10_000, true) // chunk longer than the file
    expect(codes((await model({ 'assets/m.glb': short }, 'assets/m.glb')).errors)).toEqual(['gltf-invalid@assets/m.glb#/assets/m'])
    const latin = glb({ asset: { version: '2.0' } })
    latin[latin.length - 1] = 0xff
    expect(codes((await model({ 'assets/m.glb': latin }, 'assets/m.glb')).errors)).toEqual(['encoding@assets/m.glb#/assets/m'])
    const broken = concat(bytes('glTF'), [2, 0, 0, 0, 24, 0, 0, 0, 4, 0, 0, 0], bytes('JSON'), bytes('{ x '))
    expect(codes((await model({ 'assets/m.glb': broken }, 'assets/m.glb')).errors)).toEqual(['json-syntax@assets/m.glb:1#/assets/m'])
  })

  it('a .gltf whose JSON is not UTF-8, or without asset.version', async () => {
    expect(codes((await model({ 'assets/m.gltf': concat(bytes('{"asset": "'), [0xff], bytes('"}')) })).errors))
      .toEqual(['format-mismatch@assets/m.gltf#/assets/m'])
    const late = await model({ 'assets/m.gltf': lateLatin1('{"asset": "', '"}') })
    expect(late.errors).toEqual([expect.objectContaining({ code: 'encoding', message: '"assets/m.gltf": the glTF JSON is not valid UTF-8.' })])
    const r = await model({ 'assets/m.gltf': JSON.stringify({ asset: {} }) })
    expect(codes(r.errors)).toEqual(['gltf-version@assets/m.gltf#/assets/m'])
    expect(r.errors[0]!.message).toBe('"assets/m.gltf" is not glTF 2.0 (asset.version is undefined).')
  })

  it('resolves external files relative to the model, decoding URIs; ignores data URIs and malformed entries', async () => {
    const gltf = {
      asset: { version: '2.0' },
      buffers: [{ uri: 'sub%20dir/m.bin' }, { uri: 'data:application/octet-stream;base64,AAAA' }, null, {}],
      images: [{ uri: './tex/./a.png' }, { uri: '../assets/tex/a.png' }, { uri: 'bad%zz.png' }],
    }
    const r = await model({
      'assets/m.gltf': JSON.stringify(gltf),
      'assets/sub dir/m.bin': new Uint8Array(4),
      'assets/tex/a.png': png(1, 1),
    })
    expect(codes(r.errors)).toEqual(['missing-file@assets/m.gltf#/assets/m'])
    expect(r.errors[0]!.message).toBe('File "assets/bad%zz.png" not found in the package.')
    expect(r.warnings).toEqual([])
  })

  it('a missing file that differs only by case says so', async () => {
    const r = await model({ 'assets/m.gltf': JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'M.BIN' }] }), 'assets/m.bin': new Uint8Array(4) })
    expect(r.errors[0]!.message).toBe('File "assets/M.BIN" not found in the package. Did you mean "assets/m.bin"?')
    expect(r.errors[0]!.hint).toBe('Paths are case-sensitive: fix the case of the path or of the file name.')
  })
})

describe('LUTs and shaders', () => {
  const lut = (text: string | Uint8Array) => validatePackage(memorySource({
    'manifest.json': JSON.stringify({ ...base, requires: {}, assets: { g: 'assets/g.cube' }, layers: [{ type: 'color', lut: 'g' }] }),
    'assets/g.cube': text,
  }))

  it('1D LUTs, metadata lines, CRLF line ends; the row count of the declared size', async () => {
    expect((await lut('TITLE "x"\r\nDOMAIN_MIN 0 0 0\r\nLUT_1D_SIZE 2\r\n0 0 0\r\n1 1 1\r\n')).errors).toEqual([])
    const short = await lut('LUT_3D_SIZE 2\n0 0 0\n')
    expect(codes(short.errors)).toEqual(['lut-syntax@assets/g.cube:1#/assets/g'])
    expect(short.errors[0]!.message).toBe('LUT_3D_SIZE 2 needs 8 data rows, the file has 1.')
    expect((await lut(cube(2, 9))).errors[0]!.message).toBe('LUT_3D_SIZE 2 needs 8 data rows, the file has 9.')
    expect((await lut('LUT_1D_SIZE 70000\n')).errors[0]!.message).toBe('LUT_1D_SIZE must be an integer from 2 to 65536.')
  })

  it('a LUT or a shader whose text is not UTF-8', async () => {
    const latin = concat(bytes('LUT_3D_SIZE 2\n# '), [0xe9], bytes('\n'))
    expect((await lut(latin)).errors.map((e) => e.code)).toEqual(['format-mismatch'])
    expect((await lut(lateLatin1('# ', '\n'))).errors).toEqual([expect.objectContaining({ code: 'encoding', message: '"assets/g.cube" is not valid UTF-8 text.' })])
    const r = await validatePackage(memorySource({
      'manifest.json': JSON.stringify({ ...base, requires: {}, assets: { fx: 'assets/fx.frag' }, layers: [{ type: 'shader', src: 'fx' }] }),
      'assets/fx.frag': concat(bytes('vec4 effect(vec2 uv) { return vec4(1); } // '), [0xe9]),
    }))
    expect(r.errors.map((e) => e.code)).toEqual(['format-mismatch'])
    const late = await validatePackage(memorySource({
      'manifest.json': JSON.stringify({ ...base, requires: {}, assets: { fx: 'assets/fx.frag' }, layers: [{ type: 'shader', src: 'fx' }] }),
      'assets/fx.frag': lateLatin1('vec4 effect(vec2 uv) { return vec4(1); } // '),
    }))
    expect(late.errors).toEqual([expect.objectContaining({ code: 'encoding', message: '"assets/fx.frag" is not valid UTF-8 text.' })])
  })

  it('compiler logs: author lines, warnings stay warnings, the wrapper\'s lines and the engine\'s steps without a line', async () => {
    const compile = (log: ProgramLog) => validatePackage(memorySource({
      'manifest.json': JSON.stringify({ ...base, requires: {}, assets: { fx: 'assets/fx.frag' }, layers: [{ type: 'shader', src: 'fx' }] }),
      'assets/fx.frag': 'vec4 effect(vec2 uv) { return ouaf_sample(uv); }\n',
    }), { compileShaders: async (programs) => programs.map(() => log) })
    const r = await compile({
      fragment: "WARNING: 0:1: 'for' : slow loop\nERROR: 0:1: 'x' : bad\nERROR: 0:40: 'effect' : no matching overload\nERROR: 2 compilation errors.  No code generated.",
    })
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'glsl', file: 'assets/fx.frag', path: '/layers/0/src', line: 1, message: "'for' : slow loop" })])
    expect(r.errors.map((e) => [e.line, e.message])).toEqual([
      [1, "'x' : bad"],
      [undefined, "'effect' : no matching overload (in the engine's main(), which calls vec4 effect(vec2 uv))"],
    ])
    expect(r.errors[0]).not.toHaveProperty('column')
    const silent = await compile({ fragment: '' })
    expect(silent.errors.map((e) => e.message)).toEqual(['The shader does not compile.'])
    const engine = await compile({ vertex: 'bad vertex', link: 'bad link' })
    expect(engine.errors.map((e) => e.message)).toEqual([
      "The engine's vertex shader does not compile here: bad vertex",
      'The program does not link: bad link',
    ])
  })
})
