/**
 * KTX2 textures of image assets (spec §10.2): what an engine loads, read from the file header (spec §10.4: checked
 * before decoding). Shared by the engine's image loader and `ouaf validate`.
 *
 * A KTX2 image is a 2D texture (one face, one layer, no depth) in sRGB (the transfer function of its data format
 * descriptor), encoded as one of:
 * - Basis Universal ETC1S (BasisLZ supercompression) or UASTC (none or Zstandard): transcoded to a GPU format the
 *   device supports;
 * - uncompressed `VK_FORMAT_R8G8B8A8_SRGB`, without supercompression (the package is a zip already, and decoding
 *   Zstandard outside the transcoder would need more WebAssembly from the engine).
 */

/** How the texels are stored. */
export type Ktx2Encoding = 'etc1s' | 'uastc' | 'rgba8' | 'other'

export interface Ktx2Info {
  readonly vkFormat: number
  readonly width: number
  readonly height: number
  readonly depth: number
  readonly layers: number
  readonly faces: number
  /** Mip levels in the file (0: to be generated at load). */
  readonly levels: number
  /** 0 none, 1 BasisLZ, 2 Zstandard, 3 zlib. */
  readonly supercompression: number
  readonly encoding: Ktx2Encoding
  /** Transfer function of the data format descriptor: 1 linear, 2 sRGB; 0 when there is no descriptor. */
  readonly transfer: number
  /** Alpha premultiplied into the color (the descriptor's flag); straight alpha otherwise. */
  readonly premultiplied: boolean
}

export const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a] as const
/** Size of the fixed header, before the level index (bytes). */
const HEADER = 80

const VK_FORMAT_UNDEFINED = 0
const VK_FORMAT_R8G8B8A8_SRGB = 43
const KHR_DF_MODEL_ETC1S = 163
const KHR_DF_MODEL_UASTC = 166
const KHR_DF_TRANSFER_LINEAR = 1
const KHR_DF_TRANSFER_SRGB = 2
const KHR_SUPERCOMPRESSION_BASISLZ = 1
const KHR_SUPERCOMPRESSION_ZSTD = 2

const le16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8)
const le32 = (b: Uint8Array, at: number) => (le16(b, at) | (le16(b, at + 2) << 16)) >>> 0

/** The header fields of a KTX2 file; undefined when `bytes` does not start with a whole KTX2 header. */
export function ktx2Info(bytes: Uint8Array): Ktx2Info | undefined {
  if (bytes.length < HEADER || !KTX2_IDENTIFIER.every((v, i) => bytes[i] === v)) return undefined
  const vkFormat = le32(bytes, 12)
  const supercompression = le32(bytes, 44)
  const dfdOffset = le32(bytes, 48)
  const dfdLength = le32(bytes, 52)
  // The basic descriptor block: color model, primaries, transfer function, flags at bytes 12–15 of the descriptor.
  const dfd = dfdLength >= 16 && dfdOffset + 16 <= bytes.length ? dfdOffset : undefined
  const colorModel = dfd === undefined ? 0 : bytes[dfd + 12]!
  const transfer = dfd === undefined ? 0 : bytes[dfd + 14]!
  const flags = dfd === undefined ? 0 : bytes[dfd + 15]!
  let encoding: Ktx2Encoding = 'other'
  if (vkFormat === VK_FORMAT_UNDEFINED && colorModel === KHR_DF_MODEL_ETC1S && supercompression === KHR_SUPERCOMPRESSION_BASISLZ) {
    encoding = 'etc1s'
  } else if (vkFormat === VK_FORMAT_UNDEFINED && colorModel === KHR_DF_MODEL_UASTC && (supercompression === 0 || supercompression === KHR_SUPERCOMPRESSION_ZSTD)) {
    encoding = 'uastc'
  } else if (vkFormat === VK_FORMAT_R8G8B8A8_SRGB && supercompression === 0) {
    encoding = 'rgba8'
  }
  return {
    vkFormat,
    width: le32(bytes, 20),
    height: le32(bytes, 24),
    depth: le32(bytes, 28),
    layers: le32(bytes, 32),
    faces: le32(bytes, 36),
    levels: le32(bytes, 40),
    supercompression,
    encoding,
    transfer,
    premultiplied: (flags & 1) === 1,
  }
}

/**
 * Why a KTX2 image cannot be loaded (a sentence naming `path`), or undefined when it can. Dimensions are not checked
 * here (§10.4 limits, as for every image).
 */
export function ktx2Problem(bytes: Uint8Array, path: string): string | undefined {
  const info = ktx2Info(bytes)
  if (!info) return `"${path}" is not a valid KTX2 file (its header is incomplete).`
  if (info.faces !== 1 || info.layers > 1 || info.depth > 0) {
    const what = info.faces === 6 ? 'a cube map' : info.depth > 0 ? 'a 3D texture' : info.layers > 1 ? 'a texture array' : `a texture with ${info.faces} faces`
    return `"${path}" is ${what}: KTX2 images must be 2D textures (spec §10.2).`
  }
  if (info.encoding === 'other') {
    return `"${path}" is not encoded with Basis Universal (ETC1S or UASTC) or as uncompressed R8G8B8A8_SRGB without supercompression, the KTX2 encodings images may use (spec §10.2).`
  }
  if (info.transfer !== KHR_DF_TRANSFER_SRGB) {
    return `"${path}" is not in sRGB (its transfer function is ${info.transfer === KHR_DF_TRANSFER_LINEAR ? 'linear' : info.transfer}): KTX2 images must be sRGB, like the other image formats (spec §10.2).`
  }
  return undefined
}
