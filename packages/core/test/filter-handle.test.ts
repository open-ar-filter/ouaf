import { createRegistry, extendRegistry } from '@ouaf/spec'
import { describe, expect, it, vi } from 'vitest'
import { CORE_LOADERS, memorySource, type AssetLoader, type LoaderKind } from '../src/engine/assets.ts'
import { AssetError, InvalidManifestError, InvalidParamError, MissingPluginError, OuafError } from '../src/engine/errors.ts'
import { bindingParams, createHandle, loadFilter, scriptSeed, type FilterInstance, type FilterLoadEnv } from '../src/engine/filter.ts'
import type { LayerDecl, LayerInstance, LayerTypeImpl } from '../src/engine/layer-type.ts'
import type { ScriptHost } from '../src/script/host.ts'
import { deriveSeed } from '../src/random.ts'
import { ParamStore } from '../src/params/index.ts'

/** A layer type whose instances record their disposal; `throwOnDispose` makes `dispose` throw. */
function fakeLayer(type: string, stage: LayerInstance['stage'] = 'objects', options: { throwOnDispose?: boolean } = {}) {
  const disposed: LayerDecl[] = []
  const randoms: number[] = []
  const impl: LayerTypeImpl = {
    type,
    create(decl, ctx) {
      randoms.push(ctx.random())
      return {
        kind: 'pass',
        stage,
        active: true,
        update() {},
        render() {},
        dispose: () => {
          disposed.push(decl)
          if (options.throwOnDispose) throw new Error('dispose failed')
        },
      }
    },
  }
  return { impl, disposed, randoms }
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
const text = (extra: Record<string, unknown> = {}) => ({ type: 'text', text: 'Hi', anchor: 'screen', ...extra })

const params = {
  size: { type: 'number', default: 1, min: 0, max: 4, transition: 100 },
  on: { type: 'boolean', default: true },
  tint: { type: 'color', default: '#ff0000' },
  look: { type: 'select', default: 'a', options: { a: 'A', b: 'B' } },
  hat: { type: 'select', default: '', options: { from: 'host' } },
}
const presets = { big: { size: 3 }, red: { tint: '#ff0000' } }

/** A fake stack of the engine, recording what the handle asks of it. */
function stack() {
  const calls: string[] = []
  return {
    calls,
    indexOf: () => 3,
    move: (_f: FilterInstance, index: number) => void calls.push(`move ${index}`),
    remove: (f: FilterInstance) => {
      calls.push('remove')
      f.dispose()
    },
    changed: () => void calls.push('changed'),
    send: (_f: FilterInstance, name: string, data: unknown) => void calls.push(`send ${name} ${JSON.stringify(data)}`),
  }
}

async function load(manifest: Record<string, unknown>, e: FilterLoadEnv = env({}, [fakeLayer('text').impl]), files?: Record<string, string>) {
  return loadFilter(7, memorySource({ manifest, ...(files ? { files } : {}), label: 'demo/' }), undefined, e)
}

describe('createHandle (FilterHandle)', () => {
  it('exposes the filter and forwards the stack operations', async () => {
    const filter = await load({ ...base, params, presets, layers: [text()] })
    const s = stack()
    const handle = createHandle(filter, s)
    expect(handle.key).toBe(7)
    expect(handle.id).toBe('demo')
    expect(handle.manifest).toBe(filter.manifest)
    expect(handle.warnings).toBe(filter.warnings)
    expect(handle.index).toBe(3)
    expect(handle.suspended).toBe(false)
    filter.suspended = true
    expect(handle.suspended).toBe(true)
    expect(handle.presets).toEqual(['big', 'red'])

    handle.send('go', { n: 1 })
    handle.moveTo(0)
    expect(handle.removed).toBe(false)
    handle.remove()
    expect(handle.removed).toBe(true)
    expect(s.calls).toEqual(['send go {"n":1}', 'move 0', 'remove'])
  })

  it('tells the stack only when enabled actually changes', async () => {
    const filter = await load({ ...base, layers: [text()] })
    const s = stack()
    const handle = createHandle(filter, s)
    expect(handle.enabled).toBe(true)
    handle.enabled = true
    expect(s.calls).toEqual([])
    handle.enabled = false
    expect(filter.enabled).toBe(false)
    expect(filter.active).toBe(false)
    handle.enabled = false
    expect(s.calls).toEqual(['changed'])
  })

  it('queues values for the next frame, then emits paramChange', async () => {
    const filter = await load({ ...base, params, presets, layers: [text()] })
    const handle = createHandle(filter, stack())
    const changes: string[] = []
    const off = handle.on('paramChange', (c) => changes.push(`${c.name}: ${String(c.previous)} -> ${String(c.value)}`))
    handle.setParam('on', false)
    expect(handle.params.on).toBe(true) // not before the frame starts
    filter.params.beginFrame(0)
    expect(handle.params.on).toBe(false)
    handle.setParams({ look: 'b', on: true })
    handle.applyPreset('big', { transition: 0 })
    filter.params.beginFrame(16)
    expect(handle.params).toMatchObject({ look: 'b', on: true, size: 3 })
    expect(changes).toEqual(['on: true -> false', 'look: a -> b', 'on: false -> true', 'size: 1 -> 3'])
    off()
    handle.setParam('on', false)
    filter.params.beginFrame(32)
    expect(changes).toHaveLength(4)
    // A fresh object each time.
    expect(handle.params).not.toBe(handle.params)
  })

  it('rejects invalid values as InvalidParamError naming the filter, and applies nothing', async () => {
    const filter = await load({ ...base, params, presets, layers: [text()] })
    const handle = createHandle(filter, stack())
    const range = (() => {
      try {
        handle.setParam('size', 9)
      } catch (e) {
        return e
      }
    })() as InvalidParamError
    expect(range).toBeInstanceOf(InvalidParamError)
    expect(range).toMatchObject({ param: 'size', reason: 'range' })
    expect(range.message).toMatch(/^Filter "demo": /)
    expect(() => handle.setParam('nope', 1)).toThrow(expect.objectContaining({ reason: 'unknown-param' }))
    // All or nothing: the valid value is not applied either.
    expect(() => handle.setParams({ on: false, size: -1 })).toThrow(InvalidParamError)
    expect(() => handle.applyPreset('tiny')).toThrow(expect.objectContaining({ reason: 'unknown-preset', preset: 'tiny' }))
    expect(() => handle.setOptions('look', ['x'])).toThrow(expect.objectContaining({ reason: 'not-host-options' }))
    filter.params.beginFrame(0)
    expect(handle.params).toMatchObject({ on: true, size: 1 })
  })

  it('takes the options of a host select, and reads the options of any select', async () => {
    const filter = await load({ ...base, params, layers: [text()] })
    const handle = createHandle(filter, stack())
    expect(handle.optionsOf('look')).toBeDefined()
    expect(handle.optionsOf('size')).toBeUndefined()
    expect(handle.optionsOf('hat')).toBeUndefined() // not supplied yet
    expect(() => handle.setParam('hat', 'beret')).toThrow(expect.objectContaining({ reason: 'enum' }))
    handle.setOptions('hat', ['cap', 'beret'])
    expect([...handle.optionsOf('hat')!.keys()]).toEqual(['cap', 'beret'])
    expect(() => handle.setOptions('hat', [''])).toThrow(expect.objectContaining({ reason: 'invalid-options', param: 'hat' }))
    handle.setParam('hat', 'beret')
    filter.params.beginFrame(0)
    expect(handle.params.hat).toBe('beret')
  })

  it('listens to the filter events (expression, script events)', async () => {
    const filter = await load({ ...base, layers: [text()] })
    const handle = createHandle(filter, stack())
    const got: unknown[] = []
    handle.on('filter:score', (d) => got.push(d))
    filter.events.emit('filter:score', 12)
    expect(got).toEqual([12])
  })
})

describe('bindingParams', () => {
  it('gives types and values; number bindings follow a running transition', async () => {
    const store = new ParamStore(params as never)
    const reader = bindingParams(store)
    expect(reader.type('size')).toBe('number')
    expect(reader.type('tint')).toBe('color')
    expect(reader.type('missing')).toBeUndefined()
    expect(reader.get('missing')).toBeUndefined()
    expect(reader.get('on')).toBe(true)
    expect(reader.get('look')).toBe('a')

    store.set('size', 3) // over the parameter's 100 ms transition
    store.beginFrame(0)
    store.beginFrame(50)
    expect(store.get('size')).toBe(3) // committed: the target
    const mid = reader.get('size') as number
    expect(mid).toBeGreaterThan(1)
    expect(mid).toBeLessThan(3)
    const out = new Float32Array(3)
    expect(reader.writeNumber!('size', out, 2)).toBe(true)
    expect(out[2]).toBeCloseTo(mid)
    store.beginFrame(200)
    expect(reader.get('size')).toBe(3)
  })

  it('color and vector bindings follow a running transition too, then give the committed value', () => {
    const store = new ParamStore({
      tint: { type: 'color', default: '#000000', transition: 100 },
      at: { type: 'vec2', default: [0, 0], transition: 100 },
      to: { type: 'vec3', default: [0, 0, 0] },
    } as never)
    const reader = bindingParams(store)
    store.setMany({ tint: '#ff8000', at: [2, -4], to: [1, 2, 3] })
    store.beginFrame(0)
    expect(reader.get('tint')).toBe('#000000ff')
    store.beginFrame(50)
    expect(reader.get('tint')).toBe('#804000ff')
    expect(reader.get('at')).toEqual([1, -2])
    expect(reader.get('to')).toEqual([1, 2, 3]) // no transition: at once
    store.beginFrame(100)
    expect(reader.get('tint')).toBe('#ff8000')
    expect(reader.get('at')).toBe(store.get('at'))
  })

  it('writes only number parameters', () => {
    const reader = bindingParams(new ParamStore(params as never))
    const out = new Float64Array(1)
    expect(reader.writeNumber!('on', out, 0)).toBe(false)
    expect(reader.writeNumber!('tint', out, 0)).toBe(false)
    expect(reader.writeNumber!('missing', out, 0)).toBe(false)
    expect(out[0]).toBe(0)
  })
})

describe('FilterInstance', () => {
  it('reseeds the filter and layer generators, and the script with its own seed (spec §12.5)', async () => {
    const layer = fakeLayer('text')
    const filter = await load({ ...base, layers: [text(), text()] }, env({ seed: () => 42 }, [layer.impl]))
    expect(filter.seed).toBe(42)
    const first = [filter.random.next(), filter.layerRandom[0]!.next(), filter.layerRandom[1]!.next()]
    // Layers drew their first value in `create`, from the same sequences.
    expect(layer.randoms).toHaveLength(2)
    const reseeds: number[] = []
    filter.host = { reseed: (s: number) => void reseeds.push(s), dispose: () => {} } as unknown as ScriptHost
    filter.reseed(42)
    expect([filter.random.next(), filter.layerRandom[0]!.next()]).toEqual([first[0], layer.randoms[0]])
    expect(reseeds).toEqual([scriptSeed(42)])
    expect(scriptSeed(42)).toBe(deriveSeed(42, 'script'))
    filter.reseed(-1)
    expect(filter.seed).toBe(0xffffffff) // unsigned
    expect(filter.random.next()).not.toBe(first[0])
  })

  it('lists the layers of a stage in layer order', async () => {
    const a = fakeLayer('text', 'objects')
    const b = fakeLayer('shader', 'color')
    const e = env({}, [a.impl, b.impl])
    const filter = await loadFilter(
      1,
      memorySource({
        manifest: { ...base, assets: { fx: 'assets/fx.frag' }, layers: [text(), { type: 'shader', src: 'fx' }, text({ text: 'Bye' })] },
        files: { 'assets/fx.frag': 'vec4 effect(vec2 uv) { return vec4(1.0); }' },
      }),
      undefined,
      e,
    )
    expect([...filter.layersOf('objects')]).toEqual([filter.layers[0]!.instance, filter.layers[2]!.instance])
    expect([...filter.layersOf('color')]).toEqual([filter.layers[1]!.instance])
    expect([...filter.layersOf('face')]).toEqual([])
  })

  it('disposes once, releasing every layer even when one throws, and stops its script', async () => {
    const layer = fakeLayer('text', 'objects', { throwOnDispose: true })
    const filter = await load({ ...base, layers: [text(), text()] }, env({}, [layer.impl]))
    const host = { reseed: vi.fn(), dispose: vi.fn() }
    filter.host = host as unknown as ScriptHost
    const listener = vi.fn()
    filter.events.on('paramChange', listener)
    filter.dispose()
    expect(layer.disposed).toHaveLength(2)
    expect(host.dispose).toHaveBeenCalledOnce()
    expect(filter.host).toBeUndefined()
    expect(filter.disposed).toBe(true)
    expect(filter.events.has('paramChange')).toBe(false)
    filter.dispose()
    expect(layer.disposed).toHaveLength(2)
  })

  it('reports a throwing event listener as a warning', async () => {
    const warnings: string[] = []
    const filter = await load({ ...base, layers: [text()] }, env({ warn: (m) => void warnings.push(m) }, [fakeLayer('text').impl]))
    filter.events.on('filter:x', () => {
      throw new Error('listener failed')
    })
    filter.events.emit('filter:x', 1)
    expect(warnings).toEqual(['Error: listener failed'])
  })
})

describe('loadFilter: needs, plugins, warnings and failures', () => {
  it('a script that reads blendshapes, or may read anything, needs them (spec §16.2)', async () => {
    const files = { 'script.js': 'export default {}' }
    const face = { ...base, requires: { face: true }, layers: [text()] }
    const all = await load({ ...face, script: { entry: 'script.js', on: ['blink'] } }, undefined, files)
    expect(all.needsBlendshapes).toBe(true)
    expect(all.requiresBlendshapes).toBe(false)
    const narrow = await load({ ...face, script: { entry: 'script.js', on: ['blink'], uses: ['face.landmarks'] } }, undefined, files)
    expect(narrow.needsBlendshapes).toBe(false)
    const reads = await load({ ...face, script: { entry: 'script.js', on: ['blink'], uses: ['face.blendshapes'] } }, undefined, files)
    expect(reads.needsBlendshapes).toBe(true)
    // Without the face, nothing to track: no blendshapes and no expression events.
    const noFace = await load({ ...base, script: { entry: 'script.js', on: ['message:go'] }, layers: [text()] }, undefined, files)
    expect(noFace.needsFace).toBe(false)
    expect(noFace.needsBlendshapes).toBe(false)
    expect(noFace.expressions).toBeUndefined()
    expect(all.expressions).toBeDefined()
  })

  it('requires.blendshapes: required, not only used', async () => {
    const filter = await load({ ...base, requires: { face: true, blendshapes: true }, layers: [text()] })
    expect(filter.requiresBlendshapes).toBe(true)
    expect(filter.needsBlendshapes).toBe(true)
  })

  it('names the filter as "unknown" when its id is unusable, and skips non-string plugin entries', async () => {
    const missing = await load({ requires: { plugins: ['mood'] } }).catch((e: unknown) => e)
    expect(missing).toBeInstanceOf(MissingPluginError)
    expect((missing as Error).message).toBe('Filter "unknown" requires plugin "mood", which is not installed. The host must call engine.use() with it.')
    // A non-string entry is left to the validator.
    const invalid = await load({ ...base, requires: { plugins: [42] }, layers: [text()] }).catch((e: unknown) => e)
    expect(invalid).toBeInstanceOf(InvalidManifestError)
    // A null manifest is invalid, not a crash.
    await expect(loadFilter(1, memorySource({ manifest: null }), undefined, env())).rejects.toBeInstanceOf(InvalidManifestError)
  })

  it('accepts an installed plugin required without a range', async () => {
    const registry = createRegistry()
    extendRegistry(registry, { plugin: 'mood', version: '0.1.0' }, { official: true })
    const filter = await load({ ...base, requires: { plugins: ['mood'] }, layers: [text()] }, env({ registry }, [fakeLayer('text').impl]))
    expect(filter.manifest.requires.plugins).toEqual(['mood'])
  })

  it('prefixes validation warnings with the source and their path', async () => {
    const svg = { svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/>" }
    const filter = await load({ ...base, assets: { unused: svg }, layers: [text()] })
    expect(filter.warnings.length).toBeGreaterThan(0)
    for (const w of filter.warnings) expect(w).toMatch(/^demo\/\/\S*: /)
  })

  it('refuses invalid initial params before creating any layer', async () => {
    const layer = fakeLayer('text')
    const source = memorySource({ manifest: { ...base, params, layers: [text()] } })
    const error = await loadFilter(1, source, { size: 'big' }, env({}, [layer.impl])).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InvalidParamError)
    expect(error).toMatchObject({ param: 'size', reason: 'type' })
    expect(layer.randoms).toEqual([])
    // Valid initial values apply at once, without their transition.
    const ok = await loadFilter(1, source, { size: 2 }, env({}, [layer.impl]))
    expect(bindingParams(ok.params).get('size')).toBe(2)
  })

  it('rejects a filter whose asset is missing, without creating layers', async () => {
    const layer = fakeLayer('shader', 'color')
    const impl: LayerTypeImpl = { ...layer.impl, assets: (decl) => [decl.src as string] }
    const error = await load({ ...base, assets: { fx: 'assets/fx.frag' }, layers: [{ type: 'shader', src: 'fx' }] }, env({}, [impl])).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AssetError)
    expect(layer.randoms).toEqual([])
  })

  it('says when script.js cannot be read, with the cause', async () => {
    const error = await load({ ...base, script: { entry: 'script.js', on: ['message:go'] }, layers: [text()] }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OuafError)
    expect((error as OuafError).message).toBe('Filter "demo": the manifest declares a script but script.js could not be read.')
    expect((error as OuafError).cause).toBeDefined()
  })

  it('reports a later refused host file as a warning when the engine has no error channel', async () => {
    const warnings: string[] = []
    const sticker: LayerTypeImpl = {
      type: 'sticker',
      create: () => ({ kind: 'object', stage: 'objects', object: {} as never, update() {}, dispose() {} }),
    }
    const image: AssetLoader = {
      kinds: ['image'],
      load: async (r) => {
        throw new AssetError(r.ref, `"${r.path}" is broken.`)
      },
    }
    const e = env({ warn: (m) => void warnings.push(m) }, [sticker])
    ;(e.loaders as Map<LoaderKind, AssetLoader>).set('image', image)
    const manifest = {
      ...base,
      params: { logo: { type: 'asset', accept: ['image/png'], optional: true } },
      layers: [{ type: 'sticker', src: { param: 'logo' }, anchor: 'screen' }],
    }
    const filter = await loadFilter(1, memorySource({ manifest }), undefined, e)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 8, 0, 0, 0, 8, 8, 6, 0, 0, 0])
    filter.params.set('logo', new Blob([png], { type: 'image/png' }))
    filter.params.beginFrame(0)
    await filter.params.assetsSettled()
    filter.params.beginFrame(16)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^Filter "demo": InvalidParamError: .*is broken\./)
  })
})
