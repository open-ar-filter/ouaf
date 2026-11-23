import { createRegistry, extendRegistry } from '@ouaf/spec'
import { describe, expect, it } from 'vitest'
import { CORE_LOADERS, memorySource, type AssetLoader, type LoaderKind } from '../src/engine/assets.ts'
import { AssetError, IncompatibleEngineError, InvalidManifestError, InvalidParamError, MissingPluginError, OuafError } from '../src/engine/errors.ts'
import { loadFilter, type FilterLoadEnv } from '../src/engine/filter.ts'
import type { LayerContext, LayerDecl, LayerInstance, LayerTypeImpl } from '../src/engine/layer-type.ts'
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

  it('reads script.js and gives each layer a registry of the properties a script can set', async () => {
    const manifest = { ...base, script: { entry: 'script.js', on: ['blink'] }, requires: { face: true }, layers: [] }
    const filter = await loadFilter(1, memorySource({ manifest, files: { 'script.js': 'export default {}' } }), undefined, env())
    expect(filter.script?.code).toBe('export default {}')
    expect(filter.host).toBeUndefined() // started by the engine on activation
    const missing = await loadFilter(2, memorySource({ manifest }), undefined, env()).catch((e: unknown) => e)
    expect(missing).toBeInstanceOf(OuafError)
    expect((missing as OuafError).code).toBe('filter-load')
  })
})

describe('loadFilter: content properties bound to params (spec §8, §9, §15, #140)', () => {
  /** A PNG header of `w` × `h` px (what `sniff` reads). */
  const png = (w: number, h: number) => {
    const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0])
  }
  const svg = { svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/>" }

  /** A sticker layer type that records its context, and an image loader that refuses images over 64 px. */
  function setup(overrides: Partial<FilterLoadEnv> = {}) {
    const contexts: LayerContext[] = []
    const sticker: LayerTypeImpl = {
      type: 'sticker',
      assets: (decl) => (typeof decl.src === 'string' ? [decl.src] : []),
      create(_decl, ctx) {
        contexts.push(ctx)
        return { kind: 'object', stage: 'objects', object: {} as never, update() {}, dispose() {} }
      },
    }
    const loaded: string[] = []
    const disposed: unknown[] = []
    const image: AssetLoader<{ ref: string; size: number }> = {
      kinds: ['image', 'video'],
      async load(r) {
        const bytes = new Uint8Array(await (await r.read()).arrayBuffer())
        if (bytes[0] === 0x89 && bytes.length > 23 && (bytes[19]! > 64 || bytes[23]! > 64)) throw new AssetError(r.ref, `"${r.path}" is too large.`)
        loaded.push(r.ref)
        return { ref: r.ref, size: bytes.length }
      },
      dispose: (v) => void disposed.push(v),
    }
    const errors: Error[] = []
    const warnings: string[] = []
    const e = env({ error: (err) => void errors.push(err), warn: (m) => void warnings.push(m), ...overrides }, [sticker])
    ;(e.loaders as Map<LoaderKind, AssetLoader>).set('image', image as AssetLoader)
    ;(e.loaders as Map<LoaderKind, AssetLoader>).set('video', image as AssetLoader)
    return { e, contexts, loaded, disposed, errors, warnings }
  }

  const manifest = {
    ...base,
    params: {
      style: { type: 'select', default: 'a', options: { a: 'A', b: 'B' } },
      logo: { type: 'asset', accept: ['image/png'], optional: true },
    },
    assets: { a: svg, b: svg, c: svg, clip: 'assets/clip.mp4', grade: 'assets/grade.cube' },
    layers: [
      { type: 'sticker', src: { param: 'style', map: { a: 'a', b: 'b' } }, anchor: 'screen' },
      { type: 'sticker', src: { param: 'logo' }, anchor: 'screen' },
    ],
  }
  const files = { 'assets/clip.mp4': new Uint8Array([0]), 'assets/grade.cube': 'LUT_3D_SIZE 2' }

  it('preloads the map values; with a script, every declared asset a content property can show', async () => {
    const s = setup()
    const filter = await loadFilter(1, memorySource({ manifest, files }), undefined, s.e)
    expect(s.loaded.sort()).toEqual(['a', 'b'])
    filter.dispose()
    const scripted = setup()
    const withScript = { ...manifest, script: { entry: 'script.js', on: ['message:go'] } }
    await loadFilter(2, memorySource({ manifest: withScript, files: { ...files, 'script.js': 'export default {}' } }), undefined, scripted.e)
    // Images and videos (what a sticker shows), not the LUT: no layer shows LUTs.
    expect(scripted.loaded.sort()).toEqual(['a', 'b', 'c', 'clip'])
  })

  it('loads and checks an initial file before activation; a file that fails rejects the filter', async () => {
    const s = setup()
    const file = new Blob([png(32, 32)], { type: 'image/png' })
    const filter = await loadFilter(1, memorySource({ manifest, files }), { logo: file }, s.e)
    expect(filter.params.get('logo')).toBe(file)
    expect(s.contexts[1]!.hostAssets!.get('logo')).toEqual({ ref: 'logo', size: 29 })
    filter.dispose()
    expect(s.disposed).toContainEqual({ ref: 'logo', size: 29 })

    const huge = setup()
    const error = await loadFilter(2, memorySource({ manifest, files }), { logo: new Blob([png(500, 500)], { type: 'image/png' }) }, huge.e).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InvalidParamError)
    expect(error).toMatchObject({ param: 'logo', reason: 'content' })
    expect((error as Error).message).toBe('Filter "demo": Invalid value for parameter "logo": "logo" is too large.')
    const text = setup()
    const fake = await loadFilter(3, memorySource({ manifest, files }), { logo: new File(['hello'], 'fake.png', { type: 'image/png' }) }, text.e).catch((e: unknown) => e)
    expect((fake as Error).message).toBe('Filter "demo": Invalid value for parameter "logo": "fake.png": its content is text, not an image this parameter accepts (image/png).')
    expect(text.contexts).toEqual([]) // no layer was created
  })

  it('swaps a later file in at a frame start; a refused one is an error event and the previous file stays', async () => {
    const s = setup()
    const filter = await loadFilter(1, memorySource({ manifest, files }), undefined, s.e)
    const host = s.contexts[1]!.hostAssets!
    expect(host.get('logo')).toBe(null)
    const good = new Blob([png(8, 8)], { type: 'image/png' })
    filter.params.set('logo', good)
    filter.params.beginFrame(16)
    await filter.params.assetsSettled()
    expect(host.get('logo')).toBe(null) // until the next frame
    filter.params.beginFrame(32)
    expect(host.get('logo')).toEqual({ ref: 'logo', size: 29 })
    filter.params.set('logo', new Blob([png(100, 8)], { type: 'image/png' }))
    filter.params.beginFrame(48)
    await filter.params.assetsSettled()
    filter.params.beginFrame(64)
    expect(s.errors).toHaveLength(1)
    expect(s.errors[0]).toBeInstanceOf(InvalidParamError)
    expect(filter.params.get('logo')).toBe(good)
    expect(host.get('logo')).toEqual({ ref: 'logo', size: 29 })
    // Removing it: none at the next frame; the replaced value is released once that frame is drawn.
    filter.params.set('logo', null)
    filter.params.beginFrame(80)
    expect(host.get('logo')).toBe(null)
    expect(s.disposed).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(s.disposed).toEqual([{ ref: 'logo', size: 29 }])
  })

  it('warns when an asset param a layer shows is required and has no file', async () => {
    const s = setup()
    const required = { ...manifest, params: { ...manifest.params, logo: { type: 'asset', accept: ['image/png'] } } }
    await loadFilter(1, memorySource({ manifest: required, files }), undefined, s.e)
    expect(s.warnings).toEqual(['Filter "demo": parameter "logo" needs a file from the host; the layers showing it stay hidden until it is set.'])
  })
})
