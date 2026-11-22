/**
 * Built-in plugin of the `model` layer type (spec §6.3) and of the glTF / GLB asset loader (spec §10.2).
 *
 * Files served by the host under `assetsBaseUrl` (docs/privacy.md): `draco/draco_wasm_wrapper.js` and
 * `draco/draco_decoder.wasm` (from `three/examples/jsm/libs/draco/gltf/`), fetched the first time a Draco-compressed
 * model is loaded. Meshopt needs no file (its decoder is bundled with the engine).
 */
import type { OuafPlugin } from '../../engine/plugin.ts'
import { modelLoader } from './assets.ts'
import { modelLayerType } from './layer.ts'

export const modelPlugin: OuafPlugin = {
  name: 'model',
  version: '1.0.0',
  official: true,
  setup(api) {
    api.registerAssetLoader(modelLoader)
    api.registerLayerType(modelLayerType)
  },
}

export { cloneModel, createModelAsset, isModelAsset, DRACO_DIR, type ModelAsset } from './assets.ts'
export { createModel, fitScale, type ModelLayerInstance } from './layer.ts'
