import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Ajv } from 'ajv'

// The published JSON Schema must work with a standard validator (editors, third-party tools).
const schemaPath = resolve(import.meta.dirname, '../../../docs/spec/ouaf-v1.schema.json')
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
const ajv = new Ajv({ strict: false, allErrors: true })
const check = ajv.compile(schema)

const base = { ouaf: '1', id: 'demo', name: 'Demo', version: '1.0.0', license: 'CC0-1.0', requires: { face: true } }

describe('published JSON Schema', () => {
  it('accepts a valid manifest', () => {
    const ok = check({
      ...base,
      params: { message: { type: 'string', default: 'Hi' } },
      layers: [
        { id: 'label', type: 'text', text: { param: 'message' }, anchor: 'forehead', offset: [0, 0.9, 0] },
        { type: 'warp', kind: 'bulge', anchor: ['leftEye', 'rightEye'], strength: 0.3 },
      ],
    })
    expect(check.errors ?? []).toEqual([])
    expect(ok).toBe(true)
  })

  it('rejects an unknown property and a remote URL', () => {
    expect(check({ ...base, layers: [{ type: 'text', text: 'x', colour: '#fff' }] })).toBe(false)
    expect(check({ ...base, assets: { a: 'https://example.org/a.png' }, layers: [] })).toBe(false)
  })

  it('is up to date with the TypeBox schemas', async () => {
    const { buildManifestSchema, createRegistry } = await import('../src/index.ts')
    const fresh = buildManifestSchema(createRegistry())
    expect(Object.keys(schema.properties)).toEqual(Object.keys(fresh.properties))
  })
})
