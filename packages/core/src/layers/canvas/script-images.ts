/**
 * The image assets a script draws in its canvas layers with `f.asset(name)` (spec §12.4, §12.6).
 *
 * Every image, spritesheet, SVG and emoji asset declared in the manifest's `assets` table is given to a script that
 * draws canvas layers, by name: the engine cannot tell which ones the script uses, and spec §10.4 preloads every asset
 * anyway. A spritesheet gives its first frame; KTX2 images are left out (GPU textures: no image to copy). The script
 * gets copies (`ImageBitmap`s transferred to its sandbox), made afresh at each activation; the layers keep their own.
 */
import type { TManifest } from '@ouaf/spec'
import { resolveAssetRef, type LoadedAssets } from '../../engine/assets.ts'
import { isStickerAsset } from '../sticker/assets.ts'

const IMAGE_KINDS: ReadonlySet<string> = new Set(['image', 'spritesheet', 'emoji'])

/**
 * Names of the image assets of `manifest` given to its script: none unless the script draws a canvas layer.
 * `canLoad`: whether a loader for the asset kind is installed (the image loaders come with the sticker plugin).
 */
export function scriptImageRefs(manifest: Pick<TManifest, 'assets' | 'script'>, canLoad: (kind: string) => boolean = () => true): string[] {
  if (!manifest.script?.draw?.length || !manifest.assets) return []
  const out: string[] = []
  for (const name of Object.keys(manifest.assets)) {
    let kind: string
    try {
      kind = resolveAssetRef(name, manifest.assets).kind
    } catch {
      continue // reported when a layer uses it; a script cannot use it either way
    }
    if (IMAGE_KINDS.has(kind) && canLoad(kind)) out.push(name)
  }
  return out
}

/** Copies of the preloaded image assets `refs`, by name, for `f.asset()`. */
export async function scriptImages(assets: LoadedAssets, refs: readonly string[]): Promise<Record<string, ImageBitmap>> {
  const entries = await Promise.all(
    refs.map(async (ref): Promise<[string, ImageBitmap] | undefined> => {
      if (!assets.has(ref)) return undefined
      const value = assets.get(ref)
      // A KTX2 texture is GPU data only: there is no image to give.
      if (!isStickerAsset(value) || value.kind === 'video' || value.ktx2) return undefined
      const source = value.texture.image as ImageBitmap | undefined
      if (!source) return undefined
      // A spritesheet's first frame is its top-left cell; an image is copied whole.
      return [ref, await createImageBitmap(source, 0, 0, value.width, value.height)]
    }),
  )
  return Object.fromEntries(entries.filter((e) => e !== undefined))
}
