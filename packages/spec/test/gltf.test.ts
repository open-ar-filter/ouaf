/**
 * Checks of a glTF / GLB model shared by `ouaf validate` and the engine's model loader: the container, the version,
 * the resources it loads and its embedded textures, on synthetic files.
 */
import { describe, expect, it } from 'vitest'
import { gltfChunks, gltfProblems, IMAGE_MAX_SIDE, type GltfProblem } from '../src/index.ts'

const enc = new TextEncoder()
const u32le = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
function concat(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)))
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0))
  let o = 0
  for (const a of arrays) (out.set(a, o), (o += a.length))
  return out
}

const gltf = (json: unknown) => enc.encode(JSON.stringify(json))
function glb(json: unknown, bin?: Uint8Array, version = 2): Uint8Array {
  let text = JSON.stringify(json)
  while (text.length % 4) text += ' '
  const data = enc.encode(text)
  const chunk = bin ? concat(u32le(bin.length), enc.encode('BIN\0'), bin) : new Uint8Array()
  return concat(enc.encode('glTF'), u32le(version), u32le(20 + data.length + chunk.length), u32le(data.length), enc.encode('JSON'), data, chunk)
}
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(36)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return b
}
const ktx2 = (width: number, height: number) =>
  concat([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a], u32le(0), u32le(1), u32le(width), u32le(height), new Uint8Array(8))
const uri = (bytes: Uint8Array, type = 'image/png') => `data:${type};base64,${btoa(String.fromCharCode(...bytes))}`
const v2 = { asset: { version: '2.0' } }
const withImages = (...images: Uint8Array[]) => gltf({ ...v2, images: images.map((i) => ({ uri: uri(i) })) })
const codes = (problems: GltfProblem[]) => problems.map((p) => (p.where ? `${p.code}@${p.where}` : p.code))

describe('gltfChunks', () => {
  it('a .gltf file is its JSON; a GLB gives its JSON chunk and its BIN chunk', () => {
    const text = gltf(v2)
    expect(gltfChunks(text)).toEqual({ json: text, bin: undefined })
    const bin = Uint8Array.from([1, 2, 3, 4])
    const chunks = gltfChunks(glb(v2, bin))
    if ('code' in chunks) throw new Error(chunks.message)
    expect(JSON.parse(new TextDecoder().decode(chunks.json))).toEqual(v2)
    expect(chunks.bin).toEqual(bin)
    expect(gltfChunks(glb(v2))).toMatchObject({ bin: undefined })
    // A second chunk that is not BIN, or an empty one, is no buffer.
    const other = glb(v2, bin)
    other.set(enc.encode('XXXX'), other.length - 8)
    expect(gltfChunks(other)).toMatchObject({ bin: undefined })
    expect(gltfChunks(glb(v2, new Uint8Array()))).toMatchObject({ bin: undefined })
  })

  it('refuses a GLB of another version, or without a JSON chunk within the file', () => {
    expect(gltfChunks(glb(v2, undefined, 1))).toEqual({ code: 'glb-version', message: 'not a glTF 2.0 / GLB file (not a glTF 2.0 binary)' })
    const binFirst = glb(v2)
    binFirst.set(enc.encode('BIN\0'), 16)
    expect(gltfChunks(binFirst)).toEqual({ code: 'glb-chunk', message: 'not a glTF 2.0 / GLB file (the GLB has no valid JSON chunk)' })
    const long = glb(v2)
    new DataView(long.buffer).setUint32(12, 10_000, true)
    expect(gltfChunks(long)).toMatchObject({ code: 'glb-chunk' })
  })

  it('reads a file that is a view into a larger buffer', () => {
    const file = glb(v2)
    const padded = concat([9, 9, 9, 9], file, [9])
    expect(gltfProblems(padded.subarray(4, 4 + file.length))).toEqual([])
  })
})

describe('gltfProblems', () => {
  it('nothing for glTF 2.x that embeds its resources, or has none', () => {
    expect(gltfProblems(gltf(v2))).toEqual([])
    expect(gltfProblems(glb({ asset: { version: '2.1' }, buffers: null, images: null }))).toEqual([])
    expect(gltfProblems(gltf({ ...v2, buffers: [{ uri: 'data:application/octet-stream;base64,AAAA', byteLength: 3 }, null, {}] }))).toEqual([])
    expect(gltfProblems(withImages(png(64, 64), png(IMAGE_MAX_SIDE, 1), png(1, IMAGE_MAX_SIDE)))).toEqual([])
  })

  it('the container, the JSON, the version and the structure: one problem, nothing else checked', () => {
    expect(codes(gltfProblems(glb(v2, undefined, 1)))).toEqual(['glb-version'])
    const text = gltfProblems(enc.encode('solid cube'))
    expect(codes(text)).toEqual(['gltf-json'])
    expect(text[0]!.message).toMatch(/^not a glTF 2\.0 \/ GLB file \(.+\)$/)
    // A file too short to be a GLB is read as JSON.
    expect(codes(gltfProblems(enc.encode('glTF')))).toEqual(['gltf-json'])
    expect(gltfProblems(gltf({ asset: { version: '1.0' }, images: [{ uri: 'a.png' }] }))).toEqual([
      { code: 'gltf-version', message: 'not glTF 2.0 (asset.version is "1.0")' },
    ])
    for (const json of [null, [], 5, 'text', {}, { asset: null }, { asset: { version: 2 } }]) {
      expect(codes(gltfProblems(gltf(json)))).toEqual(['gltf-version'])
    }
    expect(gltfProblems(gltf(null))[0]!.message).toBe('not glTF 2.0 (asset.version is undefined)')
    expect(gltfProblems(gltf({ ...v2, buffers: {}, images: [{ uri: 'a.png' }] }))).toEqual([
      { code: 'gltf-structure', message: 'not a valid glTF file ("buffers" is not an array)', where: 'buffers' },
    ])
    for (const images of ['abc', '', 0, false, { length: 0 }]) expect(codes(gltfProblems(gltf({ ...v2, images })))).toEqual(['gltf-structure@images'])
  })

  it('every buffer and image loaded from outside the file, buffers first', () => {
    const problems = gltfProblems(gltf({
      ...v2,
      buffers: [{ uri: 'cube.bin' }, { uri: 'data:application/octet-stream;base64,AAAA' }, null, { uri: 5 }],
      images: [{ uri: 'https://example.com/a.png' }, { uri: 'tex/a.png' }],
    }))
    expect(problems).toEqual([
      { code: 'gltf-external', where: 'buffers[0]', uri: 'cube.bin', message: 'it loads "cube.bin": a model must embed its buffers and images (export it as GLB)' },
      expect.objectContaining({ code: 'gltf-external', where: 'images[0]', uri: 'https://example.com/a.png' }),
      expect.objectContaining({ code: 'gltf-external', where: 'images[1]', uri: 'tex/a.png' }),
    ])
  })

  it('embedded textures: too large, another format, unreadable dimensions, KTX2', () => {
    expect(gltfProblems(withImages(png(64, 64), png(5000, 10)))).toEqual([
      { code: 'texture-too-large', where: 'images[1]', message: 'texture 1 is 5000×10 px: images are limited to 4096 px per side (spec §10.4)' },
    ])
    expect(codes(gltfProblems(withImages(png(10, 4097))))).toEqual(['texture-too-large@images[0]'])
    expect(gltfProblems(withImages(enc.encode('GIF89a\x10\x00\x10\x00')))).toEqual([
      { code: 'texture-format', where: 'images[0]', message: 'texture 0 is not a PNG, JPEG, WebP or AVIF image (its content is gif)' },
    ])
    expect(gltfProblems(withImages(Uint8Array.from([0, 1, 2, 0xff])))[0]!.message).toBe('texture 0 is not a PNG, JPEG, WebP or AVIF image')
    const noHeader = concat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], new Uint8Array(8))
    expect(gltfProblems(withImages(noHeader))).toEqual([
      { code: 'texture-unreadable', where: 'images[0]', message: 'could not read the dimensions of texture 0' },
    ])
    expect(gltfProblems(withImages(ktx2(64, 64)))).toEqual([
      { code: 'texture-ktx2', where: 'images[0]', message: 'texture 0 is KTX2, which models do not support yet' },
    ])
    // The engine stops at the first problem (KTX2); a tool that accepts KTX2 still gets its size.
    expect(codes(gltfProblems(withImages(ktx2(8192, 16), png(1, 1), png(4097, 1))))).toEqual([
      'texture-ktx2@images[0]', 'texture-too-large@images[0]', 'texture-too-large@images[2]',
    ])
  })

  it('reads textures from buffer views: the BIN chunk of a GLB, a data: buffer', () => {
    const big = png(8000, 8000)
    const views = { bufferViews: [{ buffer: 0, byteOffset: 4, byteLength: big.length }], images: [{ bufferView: 0, mimeType: 'image/png' }] }
    const bin = concat([0, 0, 0, 0], big)
    expect(codes(gltfProblems(glb({ ...v2, buffers: [{ byteLength: bin.length }], ...views }, bin)))).toEqual(['texture-too-large@images[0]'])
    expect(codes(gltfProblems(gltf({ ...v2, buffers: [{ uri: uri(bin, 'application/octet-stream') }], ...views })))).toEqual(['texture-too-large@images[0]'])
    // Without byteOffset the view starts at 0.
    const atStart = { bufferViews: [{ buffer: 0, byteLength: big.length }], images: [{ bufferView: 0 }] }
    expect(codes(gltfProblems(glb({ ...v2, buffers: [{}], ...atStart }, big)))).toEqual(['texture-too-large@images[0]'])
  })

  it('skips images it cannot locate: no source, a missing view or buffer, a buffer without bytes', () => {
    const big = png(8000, 8000)
    const images = [null, {}, { bufferView: 7 }, { bufferView: 0 }, { bufferView: 1 }, { bufferView: 2 }, { bufferView: '0' }]
    const bufferViews = [{ buffer: 1, byteLength: 4 }, { buffer: 9, byteLength: 4 }, { buffer: 0 }, null]
    expect(gltfProblems(glb({ ...v2, buffers: [{}, {}], bufferViews, images }, big))).toEqual([])
    expect(gltfProblems(gltf({ ...v2, buffers: [{}], bufferViews: [{ buffer: 0, byteLength: 4 }], images: [{ bufferView: 0 }] }))).toEqual([])
    expect(gltfProblems(gltf({ ...v2, images: [{ bufferView: 0 }] }))).toEqual([])
  })

  it('data: URIs: percent-encoded content, and the ones that cannot be decoded', () => {
    const svg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>')}`
    expect(codes(gltfProblems(gltf({ ...v2, images: [{ uri: svg }] })))).toEqual(['texture-format@images[0]'])
    const problems = gltfProblems(gltf({
      ...v2,
      buffers: [{ uri: 'data:application/octet-stream;base64,@@@' }],
      bufferViews: [{ buffer: 0, byteLength: 4 }],
      images: [{ uri: 'data:image/png,%zz' }, { bufferView: 0 }, { uri: uri(png(4097, 1)) }],
    }))
    expect(problems).toEqual([
      { code: 'gltf-data-uri', where: 'buffers[0]', message: 'the data: URI of buffers[0] cannot be decoded' },
      { code: 'gltf-data-uri', where: 'images[0]', message: 'the data: URI of images[0] cannot be decoded' },
      expect.objectContaining({ code: 'texture-too-large', where: 'images[2]' }),
    ])
  })

  it('external files come first; embedded textures are still checked', () => {
    expect(codes(gltfProblems(gltf({ ...v2, buffers: [{ uri: 'm.bin' }], images: [{ uri: uri(png(4097, 1)) }, { uri: 'a.png' }] })))).toEqual([
      'gltf-external@buffers[0]', 'gltf-external@images[1]', 'texture-too-large@images[0]',
    ])
  })
})
