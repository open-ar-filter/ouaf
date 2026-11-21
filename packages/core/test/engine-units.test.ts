import { describe, expect, it, vi } from 'vitest'
import { Emitter } from '../src/engine/emitter.ts'
import { satisfies } from '../src/engine/semver.ts'
import { memorySource, preloadAssets, resolveAssetRef, type AssetLoader, type LoaderKind } from '../src/engine/assets.ts'
import { AssetError } from '../src/engine/errors.ts'

describe('satisfies', () => {
  it.each([
    ['1.0.0', '^1', true],
    ['1.4.2', '^1.2.0', true],
    ['2.0.0', '^1.2.0', false],
    ['1.1.0', '^1.2.0', false],
    ['0.3.4', '^0.3.1', true],
    ['0.4.0', '^0.3.1', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.2.5', '1.2', true],
    ['1.3.0', '1.2', false],
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['1.0.0-beta', '^1', false],
    ['1.0.0', 'nonsense', false],
  ])('%s satisfies %s: %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected)
  })
})

describe('Emitter', () => {
  it('calls listeners in order and unsubscribes', () => {
    const e = new Emitter<{ x: number }>()
    const calls: string[] = []
    const off = e.on('x', (n) => calls.push(`a${n}`))
    e.on('x', (n) => calls.push(`b${n}`))
    e.emit('x', 1)
    off()
    e.emit('x', 2)
    expect(calls).toEqual(['a1', 'b1', 'b2'])
  })

  it('isolates a throwing listener and tolerates unsubscribing during an emit', () => {
    const onError = vi.fn()
    const e = new Emitter<{ x: number }>(onError)
    const calls: string[] = []
    const offB = e.on('x', () => {
      throw new Error('boom')
    })
    e.on('x', () => {
      calls.push('c')
      offB()
    })
    e.on('x', () => calls.push('d'))
    e.emit('x', 0)
    e.emit('x', 0)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['c', 'd', 'c', 'd'])
  })
})

describe('resolveAssetRef', () => {
  const assets = {
    hat: 'assets/hat.glb',
    fire: { src: 'assets/fire.mp4', alpha: 'packed' as const },
    walk: { src: 'assets/walk.png', frames: { cols: 4, rows: 2, fps: 12 } },
    star: { svg: "<svg xmlns='http://www.w3.org/2000/svg'></svg>" },
    cool: { emoji: '😎' },
  }

  it('resolves names, paths, inline assets and built-ins', () => {
    expect(resolveAssetRef('hat', assets)).toMatchObject({ kind: 'model', path: 'assets/hat.glb', builtin: false })
    expect(resolveAssetRef('fire', assets)).toMatchObject({ kind: 'video', path: 'assets/fire.mp4' })
    expect(resolveAssetRef('walk', assets)).toMatchObject({ kind: 'spritesheet' })
    expect(resolveAssetRef('star', assets)).toMatchObject({ kind: 'image', inline: expect.stringContaining('<svg') })
    expect(resolveAssetRef('cool', assets)).toMatchObject({ kind: 'emoji', inline: '😎' })
    expect(resolveAssetRef('assets/x.cube', assets)).toMatchObject({ kind: 'lut' })
    expect(resolveAssetRef('builtin:lut/noir', assets)).toMatchObject({ kind: 'lut', path: 'lut/noir', builtin: true })
  })

  it('refuses remote and unknown references', () => {
    expect(() => resolveAssetRef('https://evil.example/x.png', assets)).toThrow(AssetError)
    expect(() => resolveAssetRef('data:image/png;base64,AAAA', assets)).toThrow(/not local/)
    expect(() => resolveAssetRef('//evil.example/x.png', assets)).toThrow(AssetError)
    expect(() => resolveAssetRef('assets/../secret.png', assets)).toThrow(/\.\./)
    expect(() => resolveAssetRef('nope', assets)).toThrow(/Unknown asset "nope"/)
    expect(() => resolveAssetRef('builtin:sound/x', assets)).toThrow(/built-in/)
  })
})

describe('preloadAssets', () => {
  const textLoader: AssetLoader<string> = { kinds: ['data', 'shader'], load: async (r) => (await r.read()).text() }
  const loaders = new Map<LoaderKind, AssetLoader>([
    ['data', textLoader],
    ['shader', textLoader],
  ])

  it('loads each reference once and serves it by reference', async () => {
    const file = vi.fn(async (path: string) => new Blob([`content of ${path}`]))
    const source = { ...memorySource({ manifest: {} }), file }
    const loaded = await preloadAssets({
      source,
      assets: { fx: 'assets/fx.frag' },
      refs: ['fx', 'fx', 'assets/d.json'],
      loaders,
      builtinUrl: (n) => n,
    })
    expect(loaded.get('fx')).toBe('content of assets/fx.frag')
    expect(loaded.get('assets/d.json')).toBe('content of assets/d.json')
    expect(file).toHaveBeenCalledTimes(2)
    expect(() => loaded.get('other')).toThrow(/not preloaded/)
  })

  it('fails with an explicit error when no loader handles a kind, and releases what was loaded', async () => {
    const dispose = vi.fn()
    const source = memorySource({ manifest: {}, files: { 'assets/a.json': '{}' } })
    await expect(
      preloadAssets({
        source,
        assets: {},
        refs: ['assets/a.json', 'assets/hat.glb'],
        loaders: new Map([['data', { ...textLoader, dispose }]]),
        builtinUrl: (n) => n,
      }),
    ).rejects.toThrow(/No loader for model assets/)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('reports a missing package file', async () => {
    const source = memorySource({ manifest: {}, label: 'pkg' })
    await expect(preloadAssets({ source, assets: {}, refs: ['assets/a.json'], loaders, builtinUrl: (n) => n })).rejects.toThrow(
      /no file "assets\/a\.json"/,
    )
  })
})

describe('urlSource', () => {
  it('reports an HTML page served instead of a filter file (SPA fallback)', async () => {
    const { urlSource } = await import('../src/engine/assets.ts')
    const fetchImpl = (async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch
    await expect(urlSource('https://host.test/filters/x/', fetchImpl).manifest()).rejects.toThrow(/HTML page/)
  })

  it('resolves the manifest and assets against the folder', async () => {
    const { urlSource } = await import('../src/engine/assets.ts')
    const seen: string[] = []
    const fetchImpl = (async (url: URL) => {
      seen.push(String(url))
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const folder = urlSource('https://host.test/filters/x', fetchImpl)
    await folder.manifest()
    await folder.file('assets/a.png')
    await urlSource('https://host.test/filters/y/manifest.json', fetchImpl).manifest()
    expect(seen).toEqual([
      'https://host.test/filters/x/manifest.json',
      'https://host.test/filters/x/assets/a.png',
      'https://host.test/filters/y/manifest.json',
    ])
  })
})
