import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRegistry } from '@ouaf/spec'
import { describe, expect, it } from 'vitest'
import { BUILTIN_ASSETS, findBuiltin, isBuiltinRef, resolveBuiltin } from '../src/index.ts'

const assets = new URL('../assets/', import.meta.url)
const file = (path: string) => fileURLToPath(new URL(path, assets))

describe('built-in resources', () => {
  const registry = createRegistry().builtins

  it('every builtin: name of the spec registry resolves to a bundled asset', () => {
    expect(registry.size).toBeGreaterThan(0)
    for (const [name, def] of registry) {
      const asset = findBuiltin(`builtin:${name}`)
      expect(asset, name).toBeDefined()
      // font/emoji is registered as a font; it is an image set here.
      expect(asset!.kind === 'emoji' ? 'font' : asset!.kind, name).toBe(def.kind)
      expect(existsSync(file(asset!.path)), asset!.path).toBe(true)
      const url = resolveBuiltin(`builtin:${name}`, 'https://example.com/ouaf/')
      expect(url.href).toBe(`https://example.com/ouaf/${asset!.path}`)
    }
  })

  it('has no resource the spec registry does not know', () => {
    expect(Object.keys(BUILTIN_ASSETS).sort()).toEqual([...registry.keys()].sort())
  })

  it('fonts are small WOFF2 files', () => {
    for (const asset of Object.values(BUILTIN_ASSETS)) {
      if (asset.kind !== 'font') continue
      expect(readFileSync(file(asset.path)).subarray(0, 4).toString('latin1'), asset.path).toBe('wOF2')
      expect(statSync(file(asset.path)).size, asset.path).toBeLessThan(128 * 1024)
    }
  })

  it('ships the licence of every font and the credits', () => {
    const credits = readFileSync(file('CREDITS.md'), 'utf8')
    for (const name of ['inter', 'nunito', 'notoserif', 'jetbrainsmono', 'caveat', 'noto-emoji']) {
      const licence = readFileSync(file(`licenses/OFL-${name}.txt`), 'utf8')
      expect(licence, name).toContain('SIL Open Font License, Version 1.1')
      expect(credits, name).toContain(`licenses/OFL-${name}.txt`)
    }
  })

  it('resolves against a base URL with or without a trailing slash', () => {
    expect(resolveBuiltin('builtin:lut/noir', 'https://example.com/ouaf').href).toBe(
      'https://example.com/ouaf/luts/noir.cube',
    )
    expect(resolveBuiltin('lut/noir', new URL('https://example.com/a/b/')).href).toBe(
      'https://example.com/a/b/luts/noir.cube',
    )
  })

  it('rejects unknown names', () => {
    expect(isBuiltinRef('builtin:font/sans')).toBe(true)
    expect(isBuiltinRef('assets/font.woff2')).toBe(false)
    expect(findBuiltin('builtin:font/comic')).toBeUndefined()
    expect(findBuiltin('builtin:toString')).toBeUndefined()
    expect(() => resolveBuiltin('builtin:lut/sepia', 'https://example.com/')).toThrow(/Unknown built-in/)
  })
})
