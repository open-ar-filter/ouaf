import { Texture } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoadedAssets } from '../src/engine/assets.ts'
import { scriptImageRefs, scriptImages } from '../src/layers/canvas/script-images.ts'
import { createStickerAsset, type StickerAsset } from '../src/layers/sticker/assets.ts'

/** A decoded image (stands for an `ImageBitmap`). */
const bitmap = (name: string, width: number, height: number) => ({ name, width, height }) as unknown as ImageBitmap

function sticker(kind: StickerAsset['kind'], image: ImageBitmap | undefined, width: number, height: number): StickerAsset {
  return createStickerAsset({
    kind,
    texture: new Texture(image),
    textureWidth: image?.width ?? 0,
    textureHeight: image?.height ?? 0,
    width,
    height,
    frames: kind === 'spritesheet' ? { cols: 4, rows: 2, count: 8, fps: 12 } : undefined,
    packed: false,
    video: undefined,
    owner: undefined,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('script images (spec §12.4, §12.6)', () => {
  it('copies each preloaded image whole, and the first frame of a spritesheet', async () => {
    const copies: unknown[][] = []
    vi.stubGlobal('createImageBitmap', async (...args: unknown[]) => (copies.push(args), { copyOf: (args[0] as { name: string }).name }))
    const logo = bitmap('logo', 64, 32)
    const sheet = bitmap('sheet', 400, 200)
    const loaded: Record<string, unknown> = {
      logo: sticker('image', logo, 64, 32),
      walk: sticker('spritesheet', sheet, 100, 100),
      clip: sticker('video', undefined, 1280, 720),
      empty: sticker('image', undefined, 1, 1),
      grade: { size: 17 }, // not an image asset (a LUT)
    }
    const assets: LoadedAssets = { get: <T>(ref: string) => loaded[ref] as T, has: (ref) => ref in loaded }
    const images = await scriptImages(assets, ['logo', 'walk', 'clip', 'empty', 'grade', 'missing'])
    expect(images).toEqual({ logo: { copyOf: 'logo' }, walk: { copyOf: 'sheet' } })
    // Copies (the originals stay with the layers): the whole image, the top-left cell of the sheet.
    expect(copies).toEqual([
      [logo, 0, 0, 64, 32],
      [sheet, 0, 0, 100, 100],
    ])
    expect(await scriptImages(assets, [])).toEqual({})
  })

  it('leaves out the assets whose reference cannot be resolved', () => {
    const assets = { remote: 'https://example.com/a.png', odd: 'assets/a.xyz', star: { svg: '<svg/>' } }
    expect(scriptImageRefs({ assets, script: { entry: 'script.js', draw: ['c'] } })).toEqual(['star'])
    expect(scriptImageRefs({ assets, script: { entry: 'script.js', draw: [] } })).toEqual([])
  })
})
