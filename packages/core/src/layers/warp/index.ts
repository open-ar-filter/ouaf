/**
 * Built-in plugin of the `warp` layer type (spec §6.3, #22). Its vocabulary is in the core registry
 * (`createRegistry()`), like every v1 type.
 */
import type { OuafPlugin } from '../../engine/plugin.ts'
import { createWarpLayer } from './layer.ts'

export const warpPlugin: OuafPlugin = {
  name: 'warp',
  version: '1.0.0',
  official: true,
  setup(api) {
    api.registerLayerType({ type: 'warp', create: createWarpLayer })
  },
}
