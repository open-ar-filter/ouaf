/**
 * Built-in plugin of the `shader` layer type (spec §11, #24). Its vocabulary is in the core registry
 * (`createRegistry()`), like every v1 type; shader sources are loaded by the core's `shader` asset loader.
 */
import type { OuafPlugin } from '../../engine/plugin.ts'
import { createShaderLayer, shaderAssets } from './layer.ts'

export { checkProgram, type CompileContext } from './compile.ts'
export { ShaderFaceInputs, projectToUv, projectedUnit } from './inputs.ts'
export { createShaderLayer, shaderAssets } from './layer.ts'
export { ShaderUniforms, UniformTypeError, resolveUniformType } from './uniforms.ts'

export const shaderPlugin: OuafPlugin = {
  name: 'shader',
  version: '1.0.0',
  official: true,
  setup(api) {
    api.registerLayerType({ type: 'shader', assets: shaderAssets, create: createShaderLayer })
  },
}
