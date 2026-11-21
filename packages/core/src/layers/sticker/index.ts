/**
 * Built-in plugin of the `sticker` layer type (spec §6.3) and of the image, spritesheet, video and emoji asset
 * loaders (spec §10.2), which other layer types reading such assets share.
 */
import type { OuafPlugin } from '../../engine/plugin.ts'
import { STICKER_LOADERS } from './assets.ts'
import { stickerLayerType } from './layer.ts'

export const stickerPlugin: OuafPlugin = {
  name: 'sticker',
  version: '1.0.0',
  official: true,
  setup(api) {
    for (const loader of STICKER_LOADERS) api.registerAssetLoader(loader)
    api.registerLayerType(stickerLayerType)
  },
}

export { createStickerAsset, isStickerAsset, type SpriteGrid, type StickerAsset } from './assets.ts'
