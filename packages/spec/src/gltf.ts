/**
 * What can be checked of a glTF 2.0 / GLB model (spec §10.1, §10.4, §15) without parsing its scene: the container,
 * `asset.version`, the resources it loads, and its embedded textures, read from their headers. Shared by
 * `ouaf validate` and the engine's model loader, so that a model that validates is one the engine loads.
 * Pure JavaScript (no three.js, no DOM).
 */
import { IMAGE_MAX_SIDE, sniff } from './media.ts'

export type GltfProblemCode =
  /** A GLB whose container version is not 2. */
  | 'glb-version'
  /** A GLB without a valid JSON chunk. */
  | 'glb-chunk'
  /** The glTF JSON does not parse. */
  | 'gltf-json'
  /** `asset.version` is not 2.x. */
  | 'gltf-version'
  /** `buffers` or `images` is not an array. */
  | 'gltf-structure'
  /** A buffer or an image loaded from a file or a URL (`uri` other than `data:`). */
  | 'gltf-external'
  /** A `data:` URI that cannot be decoded. */
  | 'gltf-data-uri'
  /** An embedded KTX2 texture (`KHR_texture_basisu`): valid in the format, not loaded by the engine yet. */
  | 'texture-ktx2'
  /** An embedded texture that is not PNG, JPEG, WebP or AVIF. */
  | 'texture-format'
  /** An embedded texture whose dimensions cannot be read from its header. */
  | 'texture-unreadable'
  /** An embedded texture over `IMAGE_MAX_SIDE` px on a side. */
  | 'texture-too-large'

/** Why the engine does not load a model. */
export interface GltfProblem {
  code: GltfProblemCode
  /** What is wrong, without the file name and without a final period: "texture 0 is 5000×10 px: images are…". */
  message: string
  /** The element concerned: `buffers[0]`, `images[2]`. */
  where?: string
  /** `gltf-external`: the URI as written in the file. */
  uri?: string
}

const GLB_MAGIC = 0x46546c67 // 'glTF'
const JSON_CHUNK = 0x4e4f534a // 'JSON'
const BIN_CHUNK = 0x004e4942 // 'BIN\0'

/** Formats of the textures the engine decodes. */
const TEXTURE_FORMATS: readonly string[] = ['png', 'jpeg', 'webp', 'avif']

interface GltfJson {
  asset?: { version?: unknown }
  buffers?: Array<{ uri?: unknown } | null>
  bufferViews?: Array<{ buffer?: unknown; byteOffset?: unknown; byteLength?: unknown } | null>
  images?: Array<{ uri?: unknown; bufferView?: unknown; mimeType?: unknown } | null>
}

/** The bytes of the glTF JSON of a GLB or `.gltf` file and the GLB's BIN chunk, or what is wrong with the GLB. */
export function gltfChunks(bytes: Uint8Array): { json: Uint8Array; bin: Uint8Array | undefined } | GltfProblem {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 20 && view.getUint32(0, true) === GLB_MAGIC) {
    if (view.getUint32(4, true) !== 2) return { code: 'glb-version', message: 'not a glTF 2.0 / GLB file (not a glTF 2.0 binary)' }
    const length = view.getUint32(12, true)
    if (view.getUint32(16, true) !== JSON_CHUNK || 20 + length > bytes.length) {
      return { code: 'glb-chunk', message: 'not a glTF 2.0 / GLB file (the GLB has no valid JSON chunk)' }
    }
    const at = 20 + length
    const binLength = at + 8 <= bytes.length ? view.getUint32(at, true) : 0
    const bin = binLength > 0 && view.getUint32(at + 4, true) === BIN_CHUNK ? bytes.subarray(at + 8, at + 8 + binLength) : undefined
    return { json: bytes.subarray(20, at), bin }
  }
  return { json: bytes, bin: undefined }
}

/** Bytes of a `data:` URI (base64 or percent-encoded). Throws when it cannot be decoded. */
function dataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(',')
  const body = uri.slice(comma + 1)
  if (/;base64$/i.test(uri.slice(0, comma))) return Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
  return new TextEncoder().encode(decodeURIComponent(body))
}

/**
 * The problems of a glTF / GLB file, in the order the engine meets them: it refuses a model with any of them, and
 * reports the first. Empty for a model that passes: glTF 2.0; only embedded resources (spec §10.1, §15); textures
 * in PNG, JPEG, WebP or AVIF of at most 4096 px per side, read from their headers (spec §10.4).
 *
 * After a problem of the container, the JSON, the version or the structure nothing else is checked. A tool may be
 * more lenient than the engine on `gltf-external` and `texture-ktx2`, which the format allows.
 */
export function gltfProblems(bytes: Uint8Array): GltfProblem[] {
  const chunks = gltfChunks(bytes)
  if ('code' in chunks) return [chunks]
  let gltf: GltfJson | null
  try {
    gltf = JSON.parse(new TextDecoder().decode(chunks.json)) as GltfJson | null
  } catch (cause) {
    return [{ code: 'gltf-json', message: `not a glTF 2.0 / GLB file (${cause instanceof Error ? cause.message : String(cause)})` }]
  }
  const version = gltf?.asset?.version
  if (gltf === null || typeof version !== 'string' || !version.startsWith('2.')) {
    return [{ code: 'gltf-version', message: `not glTF 2.0 (asset.version is ${JSON.stringify(version)})` }]
  }
  for (const key of ['buffers', 'images'] as const) {
    if (gltf[key] !== undefined && gltf[key] !== null && !Array.isArray(gltf[key])) {
      return [{ code: 'gltf-structure', message: `not a valid glTF file ("${key}" is not an array)`, where: key }]
    }
  }
  const buffers = gltf.buffers ?? []
  const images = gltf.images ?? []
  const bufferViews = gltf.bufferViews
  const problems: GltfProblem[] = []

  for (const [list, name] of [[buffers, 'buffers'], [images, 'images']] as const) {
    list.forEach((r, i) => {
      const uri = r?.uri
      if (typeof uri !== 'string' || uri.startsWith('data:')) return
      problems.push({
        code: 'gltf-external', where: `${name}[${i}]`, uri,
        message: `it loads "${uri}": a model must embed its buffers and images (export it as GLB)`,
      })
    })
  }

  const decode = (uri: string, where: string): Uint8Array | undefined => {
    if (!uri.startsWith('data:')) return undefined // external: reported above
    try {
      return dataUri(uri)
    } catch {
      problems.push({ code: 'gltf-data-uri', where, message: `the data: URI of ${where} cannot be decoded` })
      return undefined
    }
  }
  // Bytes of each buffer: the GLB's BIN chunk (buffer 0 without uri) or a data: URI.
  const data = buffers.map((b, i) => (typeof b?.uri === 'string' ? decode(b.uri, `buffers[${i}]`) : i === 0 ? chunks.bin : undefined))
  images.forEach((image, i) => {
    const where = `images[${i}]`
    let content: Uint8Array | undefined
    if (typeof image?.uri === 'string') content = decode(image.uri, where)
    else if (typeof image?.bufferView === 'number') {
      const view = bufferViews?.[image.bufferView]
      const buffer = typeof view?.buffer === 'number' ? data[view.buffer] : undefined
      const offset = typeof view?.byteOffset === 'number' ? view.byteOffset : 0
      if (buffer && typeof view?.byteLength === 'number') content = buffer.subarray(offset, offset + view.byteLength)
    }
    if (!content) return
    const info = sniff(content)
    const tooLarge = (width: number, height: number) => {
      if (width <= IMAGE_MAX_SIDE && height <= IMAGE_MAX_SIDE) return
      problems.push({
        code: 'texture-too-large', where,
        message: `texture ${i} is ${width}×${height} px: images are limited to ${IMAGE_MAX_SIDE} px per side (spec §10.4)`,
      })
    }
    if (info?.format === 'ktx2') {
      problems.push({ code: 'texture-ktx2', where, message: `texture ${i} is KTX2, which models do not support yet` })
      tooLarge(info.width ?? 0, info.height ?? 0)
    } else if (!info || !TEXTURE_FORMATS.includes(info.format)) {
      problems.push({
        code: 'texture-format', where,
        message: `texture ${i} is not a PNG, JPEG, WebP or AVIF image${info ? ` (its content is ${info.format})` : ''}`,
      })
    } else if (info.width === undefined || info.height === undefined) {
      problems.push({ code: 'texture-unreadable', where, message: `could not read the dimensions of texture ${i}` })
    } else tooLarge(info.width, info.height)
  })
  return problems
}
