/**
 * Built-in plugin of the `text` layer type (spec §6.3, #19): the layer and the loader of `font` assets.
 */
import type { OuafPlugin } from '../../engine/plugin.ts'
import { fontLoader } from './font-loader.ts'
import { createTextLayer, textFontRef } from './text-layer.ts'

export const textPlugin: OuafPlugin = {
  name: 'text',
  version: '1.0.0',
  official: true,
  setup(api) {
    api.registerAssetLoader(fontLoader)
    api.registerLayerType({
      type: 'text',
      assets: (decl) => [textFontRef(decl)],
      create: (decl, ctx) => createTextLayer(decl, ctx),
    })
  },
}

export { fontLoader, type LoadedFont } from './font-loader.ts'
export { createTextLayer, type TextLayerOptions } from './text-layer.ts'
export { TextRaster, type TextStyle, type TextSurface } from './raster.ts'
export { layoutBox, wrapText, type TextBox, type TextLines } from './layout.ts'
