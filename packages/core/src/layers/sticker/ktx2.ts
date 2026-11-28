/**
 * KTX2 images and spritesheets of the sticker plugin (spec §10.2), with three's KTX2Loader.
 *
 * - What is loaded: the rules of `ktx2Problem` (`@ouaf/spec`, which `ouaf validate` applies too), checked on the
 *   header before anything is decoded: 2D sRGB textures in Basis Universal (ETC1S, UASTC) or uncompressed RGBA8, at
 *   most 4096 px per side (spec §10.4).
 * - Basis Universal files are transcoded, in a worker created from a `blob:` URL, to a compressed format the renderer
 *   supports (ASTC, BC7, ETC2, S3TC, PVRTC), or to RGBA8 when it supports none. The transcoder
 *   (`basis_transcoder.js` + `basis_transcoder.wasm`, from `three/examples/jsm/libs/basis/`) is fetched from
 *   `<assetsBaseUrl>basis/` the first time a Basis file is loaded, where the host serves it like the Draco decoder:
 *   nothing comes from a CDN (docs/privacy.md). Uncompressed files need no transcoder; they are not supercompressed
 *   (three's own Zstandard decoder fetches its wasm from a `data:` URL, which a page's CSP may block).
 * - The texture keeps the sticker conventions (`StickerAsset`): sRGB-encoded values sampled as they are (the texture
 *   is in `NoColorSpace`, so the GPU does not decode sRGB), v = 0 on the top row (the KTX2 default). Alpha: RGBA8 is
 *   premultiplied at upload; a transcoded texture cannot be, so it keeps straight alpha (`straightAlpha`) and the
 *   sticker shader premultiplies it. Mip levels come from the file (an RGBA8 image with one level gets them generated);
 *   a spritesheet keeps its first level only.
 */
import { IMAGE_MAX_SIDE, ktx2Info, ktx2Problem } from '@ouaf/spec'
import {
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  LoadingManager,
  NoColorSpace,
  type DataTexture,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import type { AssetRequest } from '../../engine/assets.ts'
import { AssetError } from '../../engine/errors.ts'

/** Folder of the Basis transcoder files under `assetsBaseUrl`. */
export const BASIS_DIR = 'basis/'
export const BASIS_FILES = ['basis_transcoder.js', 'basis_transcoder.wasm'] as const

/** A loaded KTX2 texture and what the sticker asset needs to know about it. */
export interface Ktx2Texture {
  readonly texture: Texture
  readonly width: number
  readonly height: number
  /** Color not premultiplied by alpha (transcoded textures): the shader premultiplies. */
  readonly straightAlpha: boolean
}

/**
 * One loader per transcoder folder and set of formats the GPU supports, shared by every engine on the page (its
 * worker is reused; three warns about several active loaders).
 */
const loaders = new Map<string, KTX2Loader>()

function ktx2Loader(renderer: WebGLRenderer, assetsBaseUrl: string | undefined): KTX2Loader {
  const probe = new KTX2Loader().detectSupport(renderer)
  const dir = assetsBaseUrl === undefined ? undefined : new URL(BASIS_DIR, assetsBaseUrl).href
  const key = `${dir ?? ''} ${JSON.stringify(probe.workerConfig)}`
  const shared = loaders.get(key)
  if (shared) return shared
  // Defence in depth: the loader only ever fetches the transcoder.
  const manager = new LoadingManager()
  manager.setURLModifier((url) => {
    if (dir !== undefined && BASIS_FILES.some((f) => url === `${dir}${f}`)) return url
    throw new Error(`the KTX2 loader may not load "${url}"`)
  })
  const loader = new KTX2Loader(manager).detectSupport(renderer)
  if (dir !== undefined) loader.setTranscoderPath(dir)
  loader.setWorkerLimit(1)
  loaders.set(key, loader)
  return loader
}

/** Forgets a loader whose transcoder could not be fetched (it would never retry), so the next load fetches it again. */
async function dropIfBroken(loader: KTX2Loader): Promise<void> {
  const ok = await (loader.transcoderPending ?? Promise.resolve()).then(() => true, () => false)
  if (ok) return
  for (const [key, shared] of loaders) {
    if (shared !== loader) continue
    loaders.delete(key)
    loader.dispose() // no worker was started
  }
}

/** Loads a KTX2 image (`spritesheet`: a single mip level). Throws `AssetError`. */
export async function loadKtx2(r: AssetRequest, blob: Blob, spritesheet: boolean): Promise<Ktx2Texture> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const problem = ktx2Problem(bytes, r.path)
  if (problem) throw new AssetError(r.ref, problem)
  const info = ktx2Info(bytes)!
  const { width, height } = info
  if (!width || !height) throw new AssetError(r.ref, `"${r.path}" is a KTX2 texture of ${width}×${height} px.`)
  if (width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) {
    throw new AssetError(r.ref, `"${r.path}" is ${width}×${height} px: images are limited to ${IMAGE_MAX_SIDE} px per side (spec §10.4).`)
  }
  if (!r.renderer) throw new AssetError(r.ref, `"${r.path}" is a KTX2 texture, which is prepared for a renderer: load it in an engine.`)
  const basis = info.encoding !== 'rgba8'
  if (basis && r.assetsBaseUrl === undefined) {
    throw new AssetError(r.ref, `"${r.path}" is a Basis Universal texture, whose transcoder is served under the engine's assetsBaseUrl (${BASIS_DIR}): load it in an engine.`)
  }
  const loader = ktx2Loader(r.renderer, r.assetsBaseUrl)
  let texture: Texture
  try {
    // The buffer is transferred to the transcoder's worker.
    texture = await new Promise<Texture>((resolve, reject) => loader.parse(buffer, resolve, reject))
  } catch (cause) {
    if (basis) await dropIfBroken(loader)
    const why = cause instanceof Error ? cause.message : String(cause)
    throw new AssetError(r.ref, `Could not load KTX2 texture "${r.path}"${basis ? ` (Basis transcoder from <assetsBaseUrl>${BASIS_DIR})` : ''}: ${why}`, { cause })
  }
  if (r.signal.aborted) {
    texture.dispose()
    throw r.signal.reason ?? new Error('aborted')
  }

  texture.colorSpace = NoColorSpace
  texture.flipY = false
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.magFilter = LinearFilter
  const data = (texture as DataTexture).isDataTexture === true
  if (spritesheet) {
    // No mipmaps: minified levels would blend neighbouring frames.
    texture.mipmaps = data ? [] : texture.mipmaps.slice(0, 1)
    texture.generateMipmaps = false
    texture.minFilter = LinearFilter
  } else if (data && texture.mipmaps.length <= 1) {
    texture.mipmaps = [] // uploads `image`, then generates the levels
    texture.generateMipmaps = true
    texture.minFilter = LinearMipmapLinearFilter
  } else {
    texture.minFilter = texture.mipmaps.length > 1 ? LinearMipmapLinearFilter : LinearFilter
  }
  // WebGL premultiplies uncompressed data at upload; compressed blocks are uploaded as they are.
  texture.premultiplyAlpha = data && !info.premultiplied
  texture.needsUpdate = true
  return { texture, width, height, straightAlpha: !data && !info.premultiplied }
}
