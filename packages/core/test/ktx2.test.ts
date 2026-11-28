/**
 * KTX2 images of the sticker plugin (#177): checks before decoding, the texture conventions of sticker assets, and
 * the transcoder location. Uncompressed RGBA8 files load in Node (no transcoder); Basis Universal files need the
 * transcoder's worker, tested in the browser (e2e/sticker.spec.ts).
 */
import { CompressedTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, type WebGLRenderer } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssetRequest } from '../src/engine/assets.ts'
import { AssetError } from '../src/engine/errors.ts'
import { imageLoader, spritesheetLoader, type StickerAsset } from '../src/layers/sticker/assets.ts'
import { BASIS_DIR, loadKtx2 } from '../src/layers/sticker/ktx2.ts'
import { StickerMaterial } from '../src/layers/sticker/material.ts'
import { rgba, writeKtx2 } from './ktx2-helpers.ts'

/** A renderer with no compressed texture format: what `KTX2Loader.detectSupport` reads. */
const renderer = { extensions: { has: () => false, get: () => null } } as unknown as WebGLRenderer

function request(bytes: Uint8Array<ArrayBuffer>, o: Partial<AssetRequest> = {}): AssetRequest {
  return {
    ref: 'x',
    kind: 'image',
    entry: undefined,
    path: 'assets/x.ktx2',
    builtin: false,
    renderer,
    read: () => Promise.resolve(new Blob([bytes])),
    signal: new AbortController().signal,
    ...o,
  }
}

const red = (w: number, h: number, a = 255) => rgba(w, h, () => [255, 0, 0, a])

afterEach(() => vi.unstubAllGlobals())

describe('KTX2 images (spec §10.2)', () => {
  it('an RGBA8 image: sRGB values as they are, premultiplied at upload, mipmaps generated', async () => {
    const file = writeKtx2({ width: 8, height: 4, levels: [red(8, 4, 128)] })
    const { texture, width, height, straightAlpha } = await loadKtx2(request(file), new Blob([file]), false)
    expect([width, height, straightAlpha]).toEqual([8, 4, false])
    expect(texture).toBeInstanceOf(DataTexture)
    expect(texture.colorSpace).toBe(NoColorSpace)
    expect(texture.flipY).toBe(false)
    expect(texture.premultiplyAlpha).toBe(true)
    expect(texture.generateMipmaps).toBe(true)
    expect(texture.mipmaps).toEqual([])
    expect([texture.minFilter, texture.magFilter]).toEqual([LinearMipmapLinearFilter, LinearFilter])
    const image = texture.image as { data: Uint8Array; width: number }
    expect([...image.data.subarray(0, 4)]).toEqual([255, 0, 0, 128])
  })

  it('keeps the mip levels of the file; a premultiplied file is not premultiplied again', async () => {
    const file = writeKtx2({ width: 4, height: 4, levels: [red(4, 4), red(2, 2), red(1, 1)], premultiplied: true })
    const { texture } = await loadKtx2(request(file), new Blob([file]), false)
    expect(texture.mipmaps).toHaveLength(3)
    expect(texture.generateMipmaps).toBe(false)
    expect(texture.minFilter).toBe(LinearMipmapLinearFilter)
    expect(texture.premultiplyAlpha).toBe(false)
    expect([...(texture.mipmaps[1] as { data: Uint8Array }).data.subarray(0, 4)]).toEqual([255, 0, 0, 255])
  })

  it('a spritesheet has no mipmaps (they would blend neighbouring frames)', async () => {
    const file = writeKtx2({ width: 4, height: 2, levels: [red(4, 2), red(2, 1), red(1, 1)] })
    const { texture } = await loadKtx2(request(file), new Blob([file]), true)
    expect(texture.mipmaps).toEqual([])
    expect(texture.generateMipmaps).toBe(false)
    expect(texture.minFilter).toBe(LinearFilter)
  })

  it('through the image and spritesheet loaders: a sticker asset marked as KTX2', async () => {
    const file = writeKtx2({ width: 8, height: 4, levels: [red(8, 4)] })
    const image = await imageLoader.load(request(file))
    expect(image).toMatchObject({ kind: 'image', textureWidth: 8, textureHeight: 4, width: 8, height: 4, ktx2: true, straightAlpha: false, frames: undefined })
    const sheet = await spritesheetLoader.load(request(file, { kind: 'spritesheet', entry: { src: 'assets/x.ktx2', frames: { cols: 2, rows: 1, fps: 4 } } }))
    expect(sheet).toMatchObject({ kind: 'spritesheet', textureWidth: 8, width: 4, height: 4, ktx2: true, frames: { cols: 2, rows: 1, count: 2, fps: 4 } })
    expect(sheet.texture.generateMipmaps).toBe(false)
    const dispose = vi.spyOn(image.texture, 'dispose')
    imageLoader.dispose!(image)
    expect(dispose).toHaveBeenCalled()
  })

  it('the sticker shader premultiplies a texture with straight alpha', () => {
    const material = new StickerMaterial('normal')
    const asset = (straightAlpha: boolean): StickerAsset => ({
      kind: 'image', texture: new CompressedTexture([], 4, 4), textureWidth: 4, textureHeight: 4, width: 4, height: 4,
      frames: undefined, packed: false, video: undefined, owner: undefined, straightAlpha, ktx2: true,
    })
    material.setAsset(asset(true))
    expect(material.params.z).toBe(1)
    material.setAsset(asset(false))
    expect(material.params.z).toBe(0)
    expect(material.fragmentShader).toContain('if (uParams.z > 0.0) c.rgb *= c.a;')
  })

  it('refuses before decoding: the rules of ktx2Problem, the size limit', async () => {
    const load = (bytes: Uint8Array<ArrayBuffer>) => imageLoader.load(request(bytes))
    await expect(load(writeKtx2({ width: 4, height: 4, levels: [red(4, 4)], faces: 6 }))).rejects.toThrow('"assets/x.ktx2" is a cube map: KTX2 images must be 2D textures (spec §10.2).')
    await expect(load(writeKtx2({ width: 4, height: 4, levels: [red(4, 4)], transfer: 1 }))).rejects.toThrow(/is not in sRGB/)
    await expect(load(writeKtx2({ width: 4, height: 4, levels: [new Uint8Array(16)], vkFormat: 145, colorModel: 0 }))).rejects.toThrow(/is not encoded with Basis Universal/)
    // Zstandard outside the Basis transcoder: three's decoder fetches its wasm from a data: URL (a CSP blocks it).
    await expect(load(writeKtx2({ width: 4, height: 4, levels: [red(4, 4)], supercompression: 2 }))).rejects.toThrow(/without supercompression/)
    await expect(load(writeKtx2({ width: 5000, height: 4, levels: [new Uint8Array(4)] }))).rejects.toThrow('"assets/x.ktx2" is 5000×4 px: images are limited to 4096 px per side (spec §10.4).')
    await expect(load(writeKtx2({ width: 0, height: 4, levels: [new Uint8Array(4)] }))).rejects.toThrow('is a KTX2 texture of 0×4 px.')
    const error = await load(writeKtx2({ width: 4, height: 4, levels: [red(4, 4)], faces: 6 })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AssetError)
    expect((error as AssetError).ref).toBe('x')
  })

  it('needs the renderer, and the transcoder location for Basis Universal files', async () => {
    const rgba8 = writeKtx2({ width: 4, height: 4, levels: [red(4, 4)] })
    await expect(imageLoader.load(request(rgba8, { renderer: undefined }))).rejects.toThrow('"assets/x.ktx2" is a KTX2 texture, which is prepared for a renderer: load it in an engine.')
    const uastc = writeKtx2({ width: 4, height: 4, levels: [new Uint8Array(16)], vkFormat: 0, colorModel: 166 })
    await expect(imageLoader.load(request(uastc))).rejects.toThrow(`is a Basis Universal texture, whose transcoder is served under the engine's assetsBaseUrl (${BASIS_DIR})`)
  })

  it('fetches the transcoder from <assetsBaseUrl>basis/ only, and names it when it fails', async () => {
    const fetched: string[] = []
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      fetched.push(String(input instanceof Request ? input.url : input))
      return Promise.resolve(new Response('missing', { status: 404 }))
    })
    const uastc = writeKtx2({ width: 4, height: 4, levels: [new Uint8Array(16)], vkFormat: 0, colorModel: 166 })
    const error = await imageLoader.load(request(uastc, { assetsBaseUrl: 'https://host.test/ouaf/' })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AssetError)
    expect((error as AssetError).message).toMatch(/^Could not load KTX2 texture "assets\/x.ktx2" \(Basis transcoder from <assetsBaseUrl>basis\/\): /)
    expect(fetched.sort()).toEqual(['https://host.test/ouaf/basis/basis_transcoder.js', 'https://host.test/ouaf/basis/basis_transcoder.wasm'])
    // A failed fetch is not kept: the next load tries again.
    await expect(imageLoader.load(request(uastc, { assetsBaseUrl: 'https://host.test/ouaf/' }))).rejects.toThrow(AssetError)
    expect(fetched).toHaveLength(4)
  })

  it('an asset load aborted while the texture was prepared frees it', async () => {
    const controller = new AbortController()
    const file = writeKtx2({ width: 4, height: 4, levels: [red(4, 4)] })
    const r = request(file, { signal: controller.signal })
    const pending = loadKtx2(r, new Blob([file]), false)
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toThrow('stop')
  })
})
