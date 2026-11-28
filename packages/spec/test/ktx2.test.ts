/**
 * KTX2 images (spec §10.2): header fields and the encodings an engine loads, on synthetic headers.
 */
import { describe, expect, it } from 'vitest'
import { ktx2Info, ktx2Problem, sniff } from '../src/index.ts'
import { ktx2 } from '../../cli/test/helpers.ts'

describe('ktx2Info', () => {
  it('reads the header and the data format descriptor', () => {
    expect(ktx2Info(ktx2(64, 32))).toEqual({
      vkFormat: 0, width: 64, height: 32, depth: 0, layers: 0, faces: 1, levels: 1, supercompression: 0,
      encoding: 'uastc', transfer: 2, premultiplied: false,
    })
    expect(ktx2Info(ktx2(8, 8, { colorModel: 163, supercompression: 1, premultiplied: true }))).toMatchObject({ encoding: 'etc1s', premultiplied: true })
    expect(ktx2Info(ktx2(8, 8, { supercompression: 2 }))?.encoding).toBe('uastc')
    expect(ktx2Info(ktx2(8, 8, { vkFormat: 43, colorModel: 1 }))?.encoding).toBe('rgba8')
    // Encodings an engine does not load: ETC1S without BasisLZ, UASTC with zlib, a GPU format, RGBA8 supercompressed.
    for (const o of [{ colorModel: 163 }, { supercompression: 3 }, { vkFormat: 145, colorModel: 0 }, { vkFormat: 43, supercompression: 2 }]) {
      expect(ktx2Info(ktx2(8, 8, o))?.encoding).toBe('other')
    }
    // `sniff` agrees on the size.
    expect(sniff(ktx2(64, 32))).toEqual({ format: 'ktx2', width: 64, height: 32 })
  })

  it('no header, or a truncated one; a descriptor past the bytes read', () => {
    expect(ktx2Info(new Uint8Array(100))).toBeUndefined()
    expect(ktx2Info(ktx2(8, 8).subarray(0, 79))).toBeUndefined()
    expect(ktx2Info(ktx2(8, 8).subarray(0, 104))).toMatchObject({ width: 8, transfer: 0, encoding: 'other' })
  })
})

describe('ktx2Problem', () => {
  const problem = (o: Parameters<typeof ktx2>[2]) => ktx2Problem(ktx2(8, 8, o), 'assets/a.ktx2')

  it('accepts 2D sRGB textures in ETC1S, UASTC or RGBA8', () => {
    expect(problem({})).toBeUndefined()
    expect(problem({ colorModel: 163, supercompression: 1 })).toBeUndefined()
    expect(problem({ vkFormat: 43, colorModel: 1 })).toBeUndefined()
  })

  it('refuses other shapes, encodings and transfer functions, naming the file', () => {
    expect(ktx2Problem(new Uint8Array(10), 'assets/a.ktx2')).toBe('"assets/a.ktx2" is not a valid KTX2 file (its header is incomplete).')
    expect(problem({ faces: 6 })).toBe('"assets/a.ktx2" is a cube map: KTX2 images must be 2D textures (spec §10.2).')
    expect(problem({ layers: 4 })).toMatch(/is a texture array/)
    expect(problem({ depth: 4 })).toMatch(/is a 3D texture/)
    expect(problem({ faces: 2 })).toMatch(/is a texture with 2 faces/)
    expect(problem({ vkFormat: 145, colorModel: 0 })).toMatch(/is not encoded with Basis Universal \(ETC1S or UASTC\) or as uncompressed R8G8B8A8_SRGB without supercompression/)
    expect(problem({ transfer: 1 })).toBe('"assets/a.ktx2" is not in sRGB (its transfer function is linear): KTX2 images must be sRGB, like the other image formats (spec §10.2).')
    expect(problem({ transfer: 0 })).toMatch(/its transfer function is 0/)
  })
})
