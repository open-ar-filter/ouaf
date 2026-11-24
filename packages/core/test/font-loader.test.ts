import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssetRequest } from '../src/engine/assets.ts'
import { fontLoader, isLoadedFont } from '../src/layers/text/font-loader.ts'

/** A `FontFace` of the CSS Font Loading API: `load()` fails for an empty file. */
class FakeFontFace {
  static created: FakeFontFace[] = []
  readonly family: string
  readonly bytes: number
  readonly descriptors: unknown
  loaded = false
  constructor(family: string, source: ArrayBuffer, descriptors: unknown) {
    this.family = family
    this.bytes = source.byteLength
    this.descriptors = descriptors
    FakeFontFace.created.push(this)
  }
  async load(): Promise<this> {
    if (this.bytes === 0) throw new Error('not a font')
    this.loaded = true
    return this
  }
}

/** A `FontFaceSet`: the faces it holds. */
function fakeFontSet() {
  const faces = new Set<unknown>()
  return { faces, add: (f: unknown) => void faces.add(f), delete: (f: unknown) => faces.delete(f) }
}

function request(path: string, options: { builtin?: boolean; bytes?: number; ref?: string } = {}): AssetRequest & { reads: number } {
  const r = {
    ref: options.ref ?? path,
    kind: 'font' as const,
    entry: undefined,
    path,
    builtin: options.builtin ?? false,
    reads: 0,
    read: () => {
      r.reads++
      return Promise.resolve(new Blob([new Uint8Array(options.bytes ?? 16)]))
    },
    signal: new AbortController().signal,
  }
  return r
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeFontFace.created = []
})

describe('font loader (spec §10.2)', () => {
  it('registers a package font, loaded from its bytes, under a family of its own', async () => {
    const set = fakeFontSet()
    vi.stubGlobal('FontFace', FakeFontFace)
    vi.stubGlobal('document', { fonts: set })
    const a = await fontLoader.load(request('assets/title.woff2', { bytes: 12 }))
    const b = await fontLoader.load(request('assets/body.ttf'))
    expect(a.family).toMatch(/^Ouaf Filter Font \d+$/)
    expect(b.family).not.toBe(a.family) // two package fonts never share a family
    expect([a.weight, a.style]).toEqual(['normal', 'normal'])
    expect(a.data.byteLength).toBe(12) // kept for the script's canvases (spec §12.6)
    const face = a.face as unknown as FakeFontFace
    expect([face.family, face.loaded, face.descriptors]).toEqual([a.family, true, { weight: 'normal', style: 'normal' }])
    expect(set.faces).toEqual(new Set([a.face, b.face]))
    expect(isLoadedFont(a)).toBe(true)

    fontLoader.dispose!(a)
    expect(set.faces).toEqual(new Set([b.face]))
  })

  it('keeps the family and weight of a built-in font', async () => {
    vi.stubGlobal('FontFace', FakeFontFace)
    vi.stubGlobal('document', { fonts: fakeFontSet() })
    const bold = await fontLoader.load(request('font/sans-bold', { builtin: true, ref: 'builtin:font/sans-bold' }))
    const regular = await fontLoader.load(request('font/sans', { builtin: true, ref: 'builtin:font/sans' }))
    expect([bold.family, bold.weight, regular.family, regular.weight]).toEqual(['Ouaf Sans', '700', 'Ouaf Sans', '400'])
    expect((bold.face as unknown as FakeFontFace).descriptors).toEqual({ weight: '700', style: 'normal' })
  })

  it('refuses a built-in reference that is not a font, before reading anything', async () => {
    vi.stubGlobal('FontFace', FakeFontFace)
    vi.stubGlobal('document', { fonts: fakeFontSet() })
    for (const path of ['lut/noir', 'font/nope']) {
      const r = request(path, { builtin: true, ref: `builtin:${path}` })
      await expect(fontLoader.load(r)).rejects.toThrow(`"builtin:${path}" is not a built-in font.`)
      expect(r.reads).toBe(0)
    }
  })

  it('uses the worker font set when there is no document', async () => {
    const set = fakeFontSet()
    vi.stubGlobal('FontFace', FakeFontFace)
    vi.stubGlobal('document', undefined)
    vi.stubGlobal('fonts', set)
    const font = await fontLoader.load(request('assets/a.otf'))
    expect(set.faces.has(font.face)).toBe(true)
    fontLoader.dispose!(font)
    expect(set.faces.size).toBe(0)
  })

  it('rejects a file the browser cannot load, without registering it', async () => {
    const set = fakeFontSet()
    vi.stubGlobal('FontFace', FakeFontFace)
    vi.stubGlobal('document', { fonts: set })
    await expect(fontLoader.load(request('assets/broken.woff', { bytes: 0 }))).rejects.toThrow('not a font')
    expect(set.faces.size).toBe(0)
  })

  it('fails clearly without the CSS Font Loading API or a font set', async () => {
    vi.stubGlobal('FontFace', undefined)
    await expect(fontLoader.load(request('assets/a.woff2'))).rejects.toThrow('this environment has no CSS Font Loading API (FontFace).')
    vi.stubGlobal('FontFace', FakeFontFace)
    vi.stubGlobal('document', {})
    vi.stubGlobal('fonts', undefined)
    await expect(fontLoader.load(request('assets/a.woff2'))).rejects.toThrow('this environment has no font set (document.fonts).')
    // Disposing without a font set is a no-op.
    expect(() => fontLoader.dispose!({ family: 'x', weight: 'normal', style: 'normal', face: {} as FontFace, data: new ArrayBuffer(0) })).not.toThrow()
  })
})

describe('isLoadedFont', () => {
  it('recognizes the loaded value of a font asset', () => {
    expect(isLoadedFont({ family: 'a', weight: '400', style: 'normal', face: {} })).toBe(true)
    for (const value of [null, undefined, 'Ouaf Sans', { family: 'a', weight: 400, style: 'normal', face: {} }, { family: 'a', weight: '400', style: 'normal' }]) {
      expect(isLoadedFont(value), JSON.stringify(value)).toBe(false)
    }
  })
})
