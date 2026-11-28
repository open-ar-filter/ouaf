/**
 * A small KTX2 writer for tests and fixtures (`filters/fixtures/make-ktx2-assets.ts`): uncompressed
 * `VK_FORMAT_R8G8B8A8_SRGB` textures, and headers of other encodings or with Zstandard supercompression (refused by
 * engines). Layout: KTX 2.0 specification, sections 3–4.
 */
import { zstdCompressSync } from 'node:zlib'

export interface Ktx2Init {
  width: number
  height: number
  /** Texel data of each mip level, the largest first. RGBA8 for `vkFormat` 43. */
  levels: Uint8Array[]
  /** Default 43 (R8G8B8A8_SRGB); 0 for Basis Universal. */
  vkFormat?: number
  /** 0 none (default), 1 BasisLZ, 2 Zstandard (applied here to each level). */
  supercompression?: number
  /** Default 1 (RGBSDA); 163 ETC1S, 166 UASTC. */
  colorModel?: number
  /** Default 2 (sRGB). */
  transfer?: number
  premultiplied?: boolean
  faces?: number
}

const u32 = (view: DataView, at: number, v: number) => view.setUint32(at, v, true)
const u64 = (view: DataView, at: number, v: number) => view.setBigUint64(at, BigInt(v), true)

export function writeKtx2(init: Ktx2Init): Uint8Array<ArrayBuffer> {
  const vkFormat = init.vkFormat ?? 43
  const supercompression = init.supercompression ?? 0
  const rgba = vkFormat === 43
  // Basic data format descriptor: 4 samples (R, G, B, and A, whose values are linear) for RGBA8, none otherwise.
  const samples = rgba ? 4 : 0
  const blockSize = 24 + 16 * samples
  const dfd = new Uint8Array(4 + blockSize)
  const d = new DataView(dfd.buffer)
  u32(d, 0, dfd.length)
  u32(d, 4, 0) // vendor Khronos, basic descriptor
  d.setUint16(8, 2, true)
  d.setUint16(10, blockSize, true)
  dfd.set([init.colorModel ?? 1, 1, init.transfer ?? 2, init.premultiplied ? 1 : 0], 12)
  if (rgba) dfd[20] = 4 // bytesPlane0
  for (let i = 0; i < samples; i++) {
    const at = 28 + i * 16
    d.setUint16(at, i * 8, true)
    dfd[at + 2] = 7
    dfd[at + 3] = i === 3 ? 0x1f : i
    u32(d, at + 12, 255)
  }

  const levels = init.levels.map((l) => (supercompression === 2 ? new Uint8Array(zstdCompressSync(l)) : l))
  const faces = init.faces ?? 1
  const header = 80 + 24 * levels.length
  const dfdOffset = header
  let offset = Math.ceil((dfdOffset + dfd.length) / 8) * 8
  const placed = levels.map((l) => {
    const at = offset
    offset = Math.ceil((offset + l.length) / 8) * 8
    return at
  })
  const out = new Uint8Array(offset)
  const v = new DataView(out.buffer)
  out.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a])
  u32(v, 12, vkFormat)
  u32(v, 16, 1) // typeSize
  u32(v, 20, init.width)
  u32(v, 24, init.height)
  u32(v, 28, 0)
  u32(v, 32, 0)
  u32(v, 36, faces)
  u32(v, 40, levels.length)
  u32(v, 44, supercompression)
  u32(v, 48, dfdOffset)
  u32(v, 52, dfd.length)
  levels.forEach((l, i) => {
    u64(v, 80 + i * 24, placed[i]!)
    u64(v, 80 + i * 24 + 8, l.length)
    u64(v, 80 + i * 24 + 16, init.levels[i]!.length)
    out.set(l, placed[i]!)
  })
  out.set(dfd, dfdOffset)
  return out
}

/** RGBA8 texels of a `width` × `height` image, from a function of the pixel (top row first). */
export function rgba(width: number, height: number, color: (x: number, y: number) => readonly [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 4)
  return data
}
