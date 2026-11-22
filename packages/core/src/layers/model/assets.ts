/**
 * The `model` asset loader (spec §10.2): glTF 2.0 / GLB, with Draco (`KHR_draco_mesh_compression`) and meshopt
 * (`EXT_meshopt_compression`) compression.
 *
 * Nothing is fetched from outside the engine (docs/privacy.md):
 * - the meshopt decoder is a JavaScript module that embeds its wasm (`three/addons/libs/meshopt_decoder.module.js`),
 *   bundled with the engine;
 * - the Draco decoder (`draco_wasm_wrapper.js` + `draco_decoder.wasm`, from `three/examples/jsm/libs/draco/gltf/`) is
 *   fetched from `<assetsBaseUrl>draco/` the first time a Draco-compressed model is loaded, where the host serves it
 *   like the MediaPipe wasm. It decodes in a worker created from a `blob:` URL.
 * - a `.gltf` file may only embed its buffers and images (`data:` URIs); external files and remote URLs are refused,
 *   so a model never loads anything past the package. A GLB embeds everything.
 * - textures are checked from their headers before decoding (spec §10.4: at most 4096 px per side); KTX2 textures
 *   (`KHR_texture_basisu`) are not supported yet (they need the Basis transcoder, #116).
 *
 * The parsed scene is the asset's template: layers clone it per face (`cloneModel`), sharing geometries, textures and
 * (for opacity, per face) cloned materials. `dispose` frees the GPU resources of the template.
 */
import { Box3, LoadingManager, Mesh, type AnimationClip, type BufferGeometry, type Material, type Object3D, type Texture } from 'three'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { sniff } from '@ouaf/spec'
import { AssetError } from '../../engine/errors.ts'
import type { AssetLoader, AssetRequest } from '../../engine/assets.ts'

/** Largest model file accepted (bytes), checked before parsing. PROVISIONAL until the limits of Appendix C. */
export const MAX_MODEL_BYTES = 32 * 1024 * 1024
/** Folder of the Draco decoder files under `assetsBaseUrl`. */
export const DRACO_DIR = 'draco/'

const MODEL_ASSET = Symbol('ouaf.model')

/** A loaded model: the template scene, its animations and its bounding box at rest. */
export interface ModelAsset {
  readonly [MODEL_ASSET]: true
  /** Template scene, in glTF units (1 unit = 1 face unit, spec §5.1). Never added to a scene itself. */
  readonly scene: Object3D
  readonly animations: readonly AnimationClip[]
  /** Bounding box of the scene at rest, in its own frame (for `fit`). */
  readonly bounds: Box3
  /** Has skinned meshes (cloned with their skeletons). */
  readonly skinned: boolean
}

export function isModelAsset(value: unknown): value is ModelAsset {
  return typeof value === 'object' && value !== null && MODEL_ASSET in value
}

/** Wraps a scene (a parsed glTF, or a procedural shape) as a model asset. */
export function createModelAsset(scene: Object3D, animations: readonly AnimationClip[] = []): ModelAsset {
  scene.updateMatrixWorld(true)
  const bounds = new Box3().setFromObject(scene, true)
  let skinned = false
  scene.traverse((o) => {
    if ((o as { isSkinnedMesh?: boolean }).isSkinnedMesh) skinned = true
  })
  return { [MODEL_ASSET]: true, scene, animations, bounds, skinned }
}

/**
 * A copy of the model to show for one face: its own node hierarchy (animated independently), skeletons rebound for
 * skinned meshes, geometries and textures shared with the template, materials cloned (opacity is per face).
 */
export function cloneModel(asset: ModelAsset): { root: Object3D; materials: Material[] } {
  const root = asset.skinned ? cloneSkinned(asset.scene) : asset.scene.clone(true)
  const materials: Material[] = []
  const copies = new Map<Material, Material>()
  const copy = (m: Material) => {
    let c = copies.get(m)
    if (!c) {
      c = m.clone()
      copies.set(m, c)
      materials.push(c)
    }
    return c
  }
  root.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) return
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(copy) : copy(mesh.material)
    // Skinned and morphed meshes move past their rest bounds.
    if ((mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh || mesh.morphTargetInfluences) mesh.frustumCulled = false
  })
  return { root, materials }
}

/** Frees the geometries, materials and textures of a template scene. */
export function disposeScene(scene: Object3D): void {
  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  scene.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) return
    geometries.add(mesh.geometry)
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(m)
  })
  for (const g of geometries) g.dispose()
  for (const m of materials) {
    for (const value of Object.values(m)) if ((value as Texture | null)?.isTexture) (value as Texture).dispose()
    m.dispose()
  }
}

/** One Draco loader per decoder folder, shared by every engine on the page (its worker is reused). */
const dracoLoaders = new Map<string, DRACOLoader>()

function dracoLoader(assetsBaseUrl: string): DRACOLoader {
  const dir = new URL(DRACO_DIR, assetsBaseUrl).href
  let loader = dracoLoaders.get(dir)
  if (!loader) {
    loader = new DRACOLoader()
    loader.setDecoderPath({ js: `${dir}draco_wasm_wrapper.js`, wasm: `${dir}draco_decoder.wasm` } as unknown as string)
    loader.setWorkerLimit(1)
    dracoLoaders.set(dir, loader)
  }
  return loader
}

const GLB_MAGIC = 0x46546c67 // 'glTF'
const BIN_CHUNK = 0x004e4942 // 'BIN\0'
/** Spec §10.4: images ≤ 4096 px per side (glTF textures included). */
export const TEXTURE_MAX_SIDE = 4096

interface GltfJson {
  asset?: { version?: unknown }
  buffers?: Array<{ uri?: unknown }>
  bufferViews?: Array<{ buffer?: unknown; byteOffset?: unknown; byteLength?: unknown }>
  images?: Array<{ uri?: unknown; bufferView?: unknown; mimeType?: unknown }>
}

/** The glTF JSON of a GLB or `.gltf` file, and the GLB's BIN chunk. */
function readGltf(bytes: Uint8Array): { json: GltfJson; bin: Uint8Array | undefined } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 20 && view.getUint32(0, true) === GLB_MAGIC) {
    if (view.getUint32(4, true) !== 2) throw new Error('not a glTF 2.0 binary')
    const length = view.getUint32(12, true)
    if (view.getUint32(16, true) !== 0x4e4f534a || 20 + length > bytes.length) throw new Error('the GLB has no valid JSON chunk')
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as GltfJson
    const at = 20 + length
    const binLength = at + 8 <= bytes.length ? view.getUint32(at, true) : 0
    const bin = binLength > 0 && view.getUint32(at + 4, true) === BIN_CHUNK ? bytes.subarray(at + 8, at + 8 + binLength) : undefined
    return { json, bin }
  }
  return { json: JSON.parse(new TextDecoder().decode(bytes)) as GltfJson, bin: undefined }
}

/** Bytes of a `data:` URI (base64 or percent-encoded). */
function dataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(',')
  const body = uri.slice(comma + 1)
  if (/;base64$/i.test(uri.slice(0, comma))) return Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
  return new TextEncoder().encode(decodeURIComponent(body))
}

/**
 * Checks a glTF before parsing it (throws an `Error` saying why): glTF 2.0; only embedded resources (spec §10.1,
 * §15); textures in PNG, JPEG, WebP or AVIF of at most 4096 px per side, read from their headers (spec §10.4).
 */
export function checkGltf(bytes: Uint8Array): void {
  let parsed: { json: GltfJson; bin: Uint8Array | undefined }
  try {
    parsed = readGltf(bytes)
  } catch (cause) {
    throw new Error(`not a glTF 2.0 / GLB file (${cause instanceof Error ? cause.message : String(cause)})`)
  }
  const gltf = parsed.json
  const version = gltf?.asset?.version
  if (typeof version !== 'string' || !version.startsWith('2.')) throw new Error(`not glTF 2.0 (asset.version is ${JSON.stringify(version)})`)
  const uris = [...(gltf.buffers ?? []), ...(gltf.images ?? [])].map((r) => r?.uri).filter((u): u is string => typeof u === 'string')
  const external = uris.find((u) => !u.startsWith('data:'))
  if (external !== undefined) {
    throw new Error(`it loads "${external}": a model must embed its buffers and images (export it as GLB)`)
  }

  // Bytes of each buffer: the GLB's BIN chunk (buffer 0 without uri) or a data: URI.
  const buffers = (gltf.buffers ?? []).map((b, i) =>
    typeof b?.uri === 'string' ? dataUri(b.uri) : i === 0 ? parsed.bin : undefined,
  )
  ;(gltf.images ?? []).forEach((image, i) => {
    let data: Uint8Array | undefined
    if (typeof image?.uri === 'string') data = dataUri(image.uri)
    else if (typeof image?.bufferView === 'number') {
      const view = gltf.bufferViews?.[image.bufferView]
      const buffer = typeof view?.buffer === 'number' ? buffers[view.buffer] : undefined
      const offset = typeof view?.byteOffset === 'number' ? view.byteOffset : 0
      if (buffer && typeof view?.byteLength === 'number') data = buffer.subarray(offset, offset + view.byteLength)
    }
    if (!data) return
    const info = sniff(data)
    if (info?.format === 'ktx2') throw new Error(`texture ${i} is KTX2, which models do not support yet`)
    if (!info || !['png', 'jpeg', 'webp', 'avif'].includes(info.format)) {
      throw new Error(`texture ${i} is not a PNG, JPEG, WebP or AVIF image${info ? ` (its content is ${info.format})` : ''}`)
    }
    if (info.width === undefined || info.height === undefined) throw new Error(`could not read the dimensions of texture ${i}`)
    if (info.width > TEXTURE_MAX_SIDE || info.height > TEXTURE_MAX_SIDE) {
      throw new Error(`texture ${i} is ${info.width}×${info.height} px: images are limited to ${TEXTURE_MAX_SIDE} px per side (spec §10.4)`)
    }
  })
}

/** Parses a checked glTF / GLB. Exported for tests; `assetsBaseUrl` locates the Draco decoder. */
export async function parseModel(bytes: Uint8Array, assetsBaseUrl: string | undefined): Promise<ModelAsset> {
  checkGltf(bytes)
  // Defence in depth: whatever the glTF says, nothing but embedded data is ever requested.
  const manager = new LoadingManager()
  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url
    if (assetsBaseUrl && url.startsWith(new URL(DRACO_DIR, assetsBaseUrl).href)) return url
    throw new Error(`a model may not load "${url}"`)
  })
  const loader = new GLTFLoader(manager)
  loader.setMeshoptDecoder(MeshoptDecoder)
  if (assetsBaseUrl) loader.setDRACOLoader(dracoLoader(assetsBaseUrl))
  // The bytes exactly, without copying them when they fill their buffer (`new Uint8Array(view)` copies; a Node
  // `Buffer.slice` would not).
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
  const data = (whole ? bytes.buffer : new Uint8Array(bytes).buffer) as ArrayBuffer
  const gltf = await loader.parseAsync(data, '')
  return createModelAsset(gltf.scene, gltf.animations)
}

export const modelLoader: AssetLoader<ModelAsset> = {
  kinds: ['model'],
  async load(r: AssetRequest) {
    const blob = await r.read()
    if (blob.size > MAX_MODEL_BYTES) {
      throw new AssetError(r.ref, `Model "${r.ref}" (${r.path}) is ${(blob.size / 1e6).toFixed(1)} MB: models are limited to ${MAX_MODEL_BYTES / 1024 / 1024} MB.`)
    }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    try {
      return await parseModel(bytes, r.assetsBaseUrl)
    } catch (cause) {
      if (cause instanceof AssetError) throw cause
      throw new AssetError(r.ref, `Model "${r.ref}" (${r.path}) could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}.`, { cause })
    }
  },
  dispose: (asset) => disposeScene(asset.scene),
}
