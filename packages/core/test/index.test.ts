import { describe, expect, it } from 'vitest'
import { VERSION, validateManifest } from '../src/index.ts'

describe('@ouaf/core', () => {
  it('exposes its version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('validates manifests through @ouaf/spec', () => {
    const r = validateManifest({
      ouaf: '1',
      id: 'empty',
      name: 'Empty',
      version: '1.0.0',
      license: 'CC0-1.0',
      requires: { face: true },
      layers: [],
    })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })
})
