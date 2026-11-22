import { createRegistry, extendRegistry } from '@ouaf/spec'
import { describe, expect, it } from 'vitest'
import { CORE_LOADERS, memorySource, type AssetLoader, type LoaderKind } from '../src/engine/assets.ts'
import { IncompatibleEngineError, InvalidManifestError, MissingPluginError, OuafError } from '../src/engine/errors.ts'
import { loadFilter, type FilterLoadEnv } from '../src/engine/filter.ts'
import type { LayerDecl, LayerInstance, LayerTypeImpl } from '../src/engine/layer-type.ts'
import { Type } from 'typebox'

function fakeLayer(type: string, stage: LayerInstance['stage'] = 'objects', assets: (l: LayerDecl) => string[] = () => []) {
  const created: LayerDecl[] = []
  const disposed: LayerDecl[] = []
  const impl: LayerTypeImpl = {
    type,
    assets,
    create(decl) {
      created.push(decl)
      return {
        kind: 'pass',
        stage,
        active: true,
        update() {},
        render() {},
        dispose: () => void disposed.push(decl),
      }
    },
  }
  return { impl, created, disposed }
}

function env(overrides: Partial<FilterLoadEnv> = {}, layerTypes: LayerTypeImpl[] = []): FilterLoadEnv {
  const loaders = new Map<LoaderKind, AssetLoader>()
  for (const l of CORE_LOADERS) for (const k of l.kinds) loaders.set(k, l)
  return {
    engineVersion: '1.0.0',
    registry: createRegistry(),
    layerTypes: new Map(layerTypes.map((l) => [l.type, l])),
    loaders,
    builtinUrl: (name) => `https://engine.test/builtin/${name}`,
    fetchImpl: () => Promise.reject(new Error('no network in tests')),
    renderer: {} as FilterLoadEnv['renderer'],
    view: {} as FilterLoadEnv['view'],
    maxFaces: 2,
    bindingData: { resolve: () => undefined },
    seed: () => 1,
    warn: () => {},
    ...overrides,
  }
}

const base = { ouaf: '1', id: 'demo', name: 'Demo', version: '1.0.0', license: 'CC0-1.0', requires: {} }

describe('loadFilter', () => {
  it('validates, preloads layer assets and creates instances in layer order', async () => {
    const text = fakeLayer('text')
    const shader = fakeLayer('shader', 'color', (l) => [l.src as string])
    const source = memorySource({
      manifest: {
        ...base,
        requires: { face: true },
        params: { size: { type: 'number', default: 1 } },
        assets: { fx: 'assets/fx.frag' },
        layers: [
          { type: 'text', text: 'Hi', anchor: 'forehead', size: { param: 'size' } },
          { type: 'shader', src: 'fx' },
        ],
      },
      files: { 'assets/fx.frag': 'vec4 effect(vec2 uv) { return vec4(1.0); }' },
    })
    const filter = await loadFilter(1, source, { size: 1.5 }, env({}, [text.impl, shader.impl]))
    expect(text.created).toHaveLength(1)
    expect(shader.created).toHaveLength(1)
    expect(filter.layers.map((l) => l.decl.type)).toEqual(['text', 'shader'])
    expect(filter.assets.get('fx')).toContain('effect')
    expect(filter.params.get('size')).toBe(1.5)
    expect(filter.needsFace).toBe(true)
    expect(filter.needsBlendshapes).toBe(false)
    filter.dispose()
    expect(text.disposed).toHaveLength(1)
    expect(shader.disposed).toHaveLength(1)
  })

  it('detects blendshape bindings', async () => {
    const text = fakeLayer('text')
    const source = memorySource({
      manifest: { ...base, requires: { face: true }, layers: [{ type: 'text', text: 'Hi', opacity: { bind: 'face.blendshapes.jawOpen' } }] },
    })
    const filter = await loadFilter(1, source, undefined, env({}, [text.impl]))
    expect(filter.needsBlendshapes).toBe(true)
  })

  it('reports an invalid manifest with the validator issues', async () => {
    const source = memorySource({ manifest: { ...base, layers: [{ type: 'text', text: 'Hi', anchor: 'nose' }] }, label: 'demo/manifest.json' })
    const error = await loadFilter(1, source, undefined, env()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InvalidManifestError)
    const e = error as InvalidManifestError
    expect(e.code).toBe('invalid-manifest')
    expect(e.issues.some((i) => i.path === '/layers/0/anchor')).toBe(true)
    expect(e.message).toContain('demo/manifest.json/layers/0/anchor')
  })

  it('refuses a filter whose engine range excludes this engine', async () => {
    const source = memorySource({ manifest: { ...base, engine: '^1.2', layers: [] } })
    await expect(loadFilter(1, source, undefined, env())).rejects.toBeInstanceOf(IncompatibleEngineError)
  })

  it('refuses a filter that needs a missing plugin, or an out-of-range one', async () => {
    const source = memorySource({ manifest: { ...base, requires: { plugins: ['mood@^2'] }, layers: [] } })
    const missing = await loadFilter(1, source, undefined, env()).catch((e: unknown) => e)
    expect(missing).toBeInstanceOf(MissingPluginError)
    expect((missing as MissingPluginError).message).toMatch(/plugin "mood@\^2", which is not installed/)

    const registry = createRegistry()
    extendRegistry(registry, { plugin: 'mood', version: '1.3.0' }, { official: true })
    const old = await loadFilter(1, source, undefined, env({ registry })).catch((e: unknown) => e)
    expect((old as MissingPluginError).installed).toBe('1.3.0')
  })

  it('accepts plugin layer types once their vocabulary is registered', async () => {
    const registry = createRegistry()
    const schema = Type.Object({ type: Type.Literal('acme:glow'), radius: Type.Number() }, { additionalProperties: false })
    extendRegistry(registry, {
      plugin: 'acme',
      version: '1.0.0',
      layers: [{ type: 'acme:glow', schema, stage: 'color', since: '1.0', anchored: false }],
    })
    const glow = fakeLayer('acme:glow', 'color')
    const source = memorySource({ manifest: { ...base, requires: { plugins: ['acme@^1'] }, layers: [{ type: 'acme:glow', radius: 2 }] } })
    const filter = await loadFilter(1, source, undefined, env({ registry }, [glow.impl]))
    expect(filter.layers[0]?.instance.stage).toBe('color')
  })

  it('fails clearly when a declared layer type has no implementation', async () => {
    const source = memorySource({ manifest: { ...base, layers: [{ type: 'text', text: 'Hi', anchor: 'screen' }] } })
    const error = await loadFilter(1, source, undefined, env()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OuafError)
    expect((error as OuafError).code).toBe('unknown-layer-type')
  })

  it('releases the layers already created when a later one fails', async () => {
    const ok = fakeLayer('text')
    const failing: LayerTypeImpl = { type: 'sticker', create: () => Promise.reject(new Error('decode failed')) }
    const stickerAsset: AssetLoader = { kinds: ['image'], load: async () => 'img' }
    const e = env({}, [ok.impl, failing])
    ;(e.loaders as Map<LoaderKind, AssetLoader>).set('image', stickerAsset)
    const source = memorySource({
      manifest: { ...base, layers: [{ type: 'text', text: 'Hi', anchor: 'screen' }, { type: 'sticker', src: 'assets/a.png', anchor: 'screen' }] },
      files: { 'assets/a.png': new Uint8Array([1]) },
    })
    await expect(loadFilter(1, source, undefined, e)).rejects.toThrow('decode failed')
    expect(ok.disposed).toHaveLength(1)
  })

  it('warns about scripts, which are not run yet', async () => {
    const source = memorySource({ manifest: { ...base, script: { entry: 'script.js', on: ['blink'] }, requires: { face: true }, layers: [] } })
    const filter = await loadFilter(1, source, undefined, env())
    expect(filter.warnings.some((w) => w.includes('scripts are not supported'))).toBe(true)
  })
})
