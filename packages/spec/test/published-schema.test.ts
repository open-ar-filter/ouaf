import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Ajv } from 'ajv'
import { buildManifestSchema, buildPublishedSchema, createRegistry, formatJson, hoistDefinitions } from '../src/index.ts'
import type { Json } from '../src/index.ts'

// The published JSON Schema must work with a standard validator (editors, third-party tools).
const schemaPath = resolve(import.meta.dirname, '../../../docs/spec/ouaf-v1.schema.json')
const text = readFileSync(schemaPath, 'utf8')
const schema = JSON.parse(text)
const check = new Ajv({ strict: false, allErrors: true }).compile(schema)

// The same schema with every shared definition inlined, as TypeBox produces it (what was published before #40).
const draft07 = 'http://json-schema.org/draft-07/schema#'
const inlined = JSON.parse(JSON.stringify({ $schema: draft07, ...buildManifestSchema(createRegistry()) }))
const checkInlined = new Ajv({ strict: false, allErrors: true }).compile(inlined)

/** Size budget of the published schema, in characters (48 kB in November 2026). */
const SCHEMA_BUDGET = 64 * 1024

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

  it('is up to date with the TypeBox schemas', () => {
    expect(text).toBe(formatJson(buildPublishedSchema(createRegistry())) + '\n')
  })

  // A fixed budget rather than a ratio to the inlined schema (#40, #116): adding a default or a description should not
  // fail the test, but a change that inlines shared definitions again (about 250 kB) should.
  it('stays within its size budget (#40)', () => {
    expect(text.length).toBeLessThanOrEqual(SCHEMA_BUDGET)
  })

  it('accepts and rejects exactly what the inlined schema does', () => {
    const bindings = [
      { param: 'size' },
      { bind: 'face.blendshapes.jawOpen', range: [0, 1], to: [0.1, 0.6] },
      { bind: 'Bad' },
      { param: 1 },
    ]
    const manifests: unknown[] = [
      { ...base, name: { en: 'Demo', fr: 'Démo' }, description: { EN: 'x' }, layers: [] },
      { ...base, engine: '^1.2', credits: [{ what: 'x', author: 'y', license: 'MIT' }], tags: ['fun', 'Fun'], layers: [] },
      {
        ...base,
        params: {
          size: { type: 'number', default: 1, min: 0, label: { en: 'Size' }, visibleIf: { on: true } },
          tint: { type: 'color', default: '#ff00cc' },
          pick: { type: 'select', default: 'a', options: { a: 'A' } },
          host: { type: 'select', default: 'a', options: { from: 'host' } },
          bad: { type: 'vec2', default: [1, 2, 3] },
        },
        presets: { party: { size: 1.5 } },
        layers: [],
      },
      {
        ...base,
        assets: { hat: 'assets/hat.glb', star: { emoji: '⭐' }, sheet: { src: 'assets/s.png', frames: { cols: 2, fps: 0 } } },
        layers: [],
      },
      ...bindings.flatMap((b) => [
        { ...base, layers: [{ type: 'text', text: b, color: b, offset: b, visible: b, size: b }] },
        { ...base, layers: [{ type: 'color', tint: b, brightness: b, region: 'face' }] },
        { ...base, layers: [{ type: 'shader', src: 'fx', uniforms: { u: b, v: [1, 2] } }] },
      ]),
      { ...base, layers: [{ type: 'sticker', src: { pick: ['a', 'b'], by: 'random' }, anchor: 'noseTip', faces: 2 }] },
      { ...base, layers: [{ type: 'sticker', src: { pick: [] }, blend: 'darken', faces: 0 }] },
      { ...base, layers: [{ type: 'model', src: { shape: 'torus', color: '#f0c' }, scale: [1, 2, 3], follow: 'rigid' }] },
      { ...base, layers: [{ type: 'model', src: { shape: 'cube' }, occlusion: 'head', orient: 'side' }] },
      { ...base, layers: [{ type: 'canvas', id: 'c', width: 256, height: 8 }] },
      { ...base, layers: [{ type: 'warp', kind: 'swirl', anchor: [], direction: [1, 0] }] },
      { ...base, events: { blink: { threshold: 2 } }, layers: [] },
      { ...base, script: { entry: 'script.js', uses: ['face.pose'], draw: ['c'] }, layers: [] },
    ]
    for (const m of manifests) expect(check(m), JSON.stringify(m)).toBe(checkInlined(m))
    // The cases above exercise both outcomes.
    expect(new Set(manifests.map((m) => check(m)))).toEqual(new Set([true, false]))
  })
})

describe('hoistDefinitions', () => {
  const Str = { type: 'string', description: 'A' }
  const P = { type: 'object', properties: { p: Str } }
  const D = { type: 'object', properties: { d: Str } }

  it('replaces exact copies by $refs and keeps variants inline', () => {
    const out = hoistDefinitions({ properties: { a: Str, b: { ...Str, default: 'x' }, c: { items: Str } } }, [['Str', Str]])
    expect(out).toEqual({
      properties: { a: { $ref: '#/$defs/Str' }, b: { ...Str, default: 'x' }, c: { items: { $ref: '#/$defs/Str' } } },
      $defs: { Str },
    })
  })

  it('groups the alternatives of a pure named union inside a larger anyOf', () => {
    const Binding = { anyOf: [P, D] }
    const bindable = { anyOf: [{ type: 'number' }, P, D], 'x-bindable': true }
    const named: Array<[string, Json]> = [['P', P], ['D', D], ['Binding', Binding]]
    const out = hoistDefinitions({ properties: { x: bindable, y: { anyOf: [P, { type: 'number' }] } } }, named)
    expect(out).toEqual({
      properties: {
        x: { anyOf: [{ type: 'number' }, { $ref: '#/$defs/Binding' }], 'x-bindable': true },
        y: { anyOf: [{ $ref: '#/$defs/P' }, { type: 'number' }] },
      },
      $defs: {
        Binding: { anyOf: [{ $ref: '#/$defs/P' }, { $ref: '#/$defs/D' }] },
        D: { type: 'object', properties: { d: Str } },
        P: { type: 'object', properties: { p: Str } },
      },
    })
  })
})

describe('formatJson', () => {
  it('keeps short nodes on one line and fills long scalar arrays', () => {
    const value = { short: { a: 1, b: [1, 2] }, long: ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd'] }
    const lines = ['{', '  "short": { "a": 1, "b": [1, 2] },', '  "long": [', '    "aaaaaaaa", "bbbbbbbb", "cccccccc",']
    expect(formatJson(value, 40)).toBe([...lines, '    "dddddddd"', '  ]', '}'].join('\n'))
    expect(JSON.parse(formatJson(value, 40))).toEqual(value)
  })
})
