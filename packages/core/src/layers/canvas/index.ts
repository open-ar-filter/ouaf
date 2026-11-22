/** Built-in plugin of the `canvas` layer type (spec §6.3, §12.6): Canvas 2D drawing by the filter's script. */
import type { OuafPlugin } from '../../engine/plugin.ts'
import { canvasLayerType } from './layer.ts'

export const canvasPlugin: OuafPlugin = {
  name: 'canvas',
  version: '1.0.0',
  official: true,
  setup(api) {
    api.registerLayerType(canvasLayerType)
  },
}

export { createCanvasLayer, type CanvasLayerInstance } from './layer.ts'
export { scriptImages, scriptImageRefs } from './script-images.ts'
