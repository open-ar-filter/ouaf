import { describe, expect, it } from 'vitest'
import type { AssetLoader } from '../src/engine/assets.ts'
import type { LayerContext, LayerDecl, LayerTypeImpl } from '../src/engine/layer-type.ts'
import type { OuafPlugin, PluginApi } from '../src/engine/plugin.ts'
import { canvasPlugin } from '../src/layers/canvas/index.ts'
import { canvasLayerType } from '../src/layers/canvas/layer.ts'
import { modelPlugin } from '../src/layers/model/index.ts'
import { modelLoader } from '../src/layers/model/assets.ts'
import { modelLayerType } from '../src/layers/model/layer.ts'
import { shaderPlugin } from '../src/layers/shader/index.ts'
import { stickerPlugin } from '../src/layers/sticker/index.ts'
import { STICKER_LOADERS } from '../src/layers/sticker/assets.ts'
import { stickerLayerType } from '../src/layers/sticker/layer.ts'
import { textPlugin } from '../src/layers/text/index.ts'
import { fontLoader } from '../src/layers/text/font-loader.ts'
import { warpPlugin } from '../src/layers/warp/index.ts'

/** Runs `plugin.setup` on an API that records what it registers; anything else it registers fails the test. */
function install(plugin: OuafPlugin): { layers: LayerTypeImpl[]; loaders: AssetLoader[] } {
  const layers: LayerTypeImpl[] = []
  const loaders: AssetLoader[] = []
  const unexpected = (what: string) => () => {
    throw new Error(`${plugin.name} registered a ${what}`)
  }
  const api: PluginApi = {
    engineVersion: '1.0.0',
    registerLayerType: (impl) => void layers.push(impl),
    registerAssetLoader: (loader) => void loaders.push(loader),
    registerTracker: unexpected('tracker'),
    registerSource: unexpected('source'),
    registerLandmarkModifier: unexpected('landmark modifier'),
    registerRenderPass: unexpected('render pass'),
    registerEventSource: unexpected('event source'),
  }
  plugin.setup!(api)
  return { layers, loaders }
}

describe('built-in layer plugins', () => {
  it('are official 1.0.0 plugins named after their layer type', () => {
    for (const plugin of [textPlugin, modelPlugin, stickerPlugin, canvasPlugin, shaderPlugin, warpPlugin]) {
      expect([plugin.version, plugin.official]).toEqual(['1.0.0', true])
      expect(install(plugin).layers.map((l) => l.type)).toEqual([plugin.name])
    }
  })

  it('sticker: the image, emoji, spritesheet and video loaders, and the sticker layer', () => {
    const { layers, loaders } = install(stickerPlugin)
    expect(loaders).toEqual([...STICKER_LOADERS])
    expect(loaders.flatMap((l) => l.kinds)).toEqual(['image', 'emoji', 'spritesheet', 'video'])
    expect(layers).toEqual([stickerLayerType])
  })

  it('model: the glTF loader and the model layer', () => {
    const { layers, loaders } = install(modelPlugin)
    expect(loaders).toEqual([modelLoader])
    expect(layers).toEqual([modelLayerType])
  })

  it('text: the font loader, and a layer that preloads its font', () => {
    const { layers, loaders } = install(textPlugin)
    expect(loaders).toEqual([fontLoader])
    expect(loaders[0]!.kinds).toEqual(['font'])
    const text = layers[0]!
    expect([...text.assets!({ type: 'text', text: 'hi', font: 'title' } as LayerDecl)]).toEqual(['title'])
    expect([...text.assets!({ type: 'text', text: 'hi' } as LayerDecl)]).toEqual(['builtin:font/sans-bold']) // the default
    // `create` builds the text layer, which starts by reading its preloaded font.
    const asked: string[] = []
    const ctx = {
      assets: {
        get: (ref: string) => {
          asked.push(ref)
          throw new Error('no font here')
        },
      },
    } as unknown as LayerContext
    expect(() => text.create({ type: 'text', text: 'hi', font: 'title' } as LayerDecl, ctx)).toThrow('no font here')
    expect(asked).toEqual(['title'])
  })

  it('shader: preloads its source and textures; no loader of its own', () => {
    const { layers, loaders } = install(shaderPlugin)
    expect(loaders).toEqual([])
    const decl = { type: 'shader', src: 'assets/fx.frag', textures: { u_noise: 'noise', u_logo: 'assets/logo.png' } } as unknown as LayerDecl
    expect([...layers[0]!.assets!(decl)]).toEqual(['assets/fx.frag', 'noise', 'assets/logo.png'])
    expect([...layers[0]!.assets!({ type: 'shader', src: 'fx' } as LayerDecl)]).toEqual(['fx'])
  })

  it('canvas and warp: a layer type only, with no assets to preload', () => {
    const canvas = install(canvasPlugin)
    expect([canvas.layers, canvas.loaders]).toEqual([[canvasLayerType], []])
    const warp = install(warpPlugin)
    expect(warp.loaders).toEqual([])
    expect(warp.layers[0]!.assets).toBeUndefined()
  })
})
