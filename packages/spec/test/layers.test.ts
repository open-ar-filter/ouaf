/** Built-in layer types (spec §9): render stages, anchoring, required ids, as declared in the registry. */
import { describe, expect, it } from 'vitest'
import { Value } from 'typebox/value'
import { BUILTIN_LAYERS, createRegistry, STAGES, type LayerTypeDef } from '../src/index.ts'

const def = (type: string): LayerTypeDef => {
  const d = BUILTIN_LAYERS.find((l) => l.type === type)
  if (!d) throw new Error(`no layer type ${type}`)
  return d
}
const stageOf = (type: string, layer: Record<string, unknown> = {}) => {
  const { stage } = def(type)
  return typeof stage === 'function' ? stage({ type, ...layer }) : stage
}

describe('built-in layer types', () => {
  it('are the seven types of v1, all from core 1.0, all in the registry', () => {
    expect(BUILTIN_LAYERS.map((l) => l.type)).toEqual(['text', 'sticker', 'model', 'warp', 'color', 'shader', 'canvas'])
    const reg = createRegistry()
    for (const l of BUILTIN_LAYERS) {
      expect(l).toMatchObject({ plugin: 'core', since: '1.0' })
      expect(reg.layers.get(l.type)).toBe(l)
    }
  })

  it('text, sticker and canvas draw with the objects, or in the overlay stage with "overlay"', () => {
    for (const type of ['text', 'sticker', 'canvas']) {
      expect(stageOf(type)).toBe('objects')
      expect(stageOf(type, { overlay: false })).toBe('objects')
      expect(stageOf(type, { overlay: true })).toBe('overlay')
    }
  })

  it('model, warp and color have a fixed stage', () => {
    expect(stageOf('model', { overlay: true })).toBe('objects')
    expect(stageOf('warp')).toBe('warp')
    expect(stageOf('color')).toBe('color')
  })

  it('shader: background, face, or the color stage for "post" and by default', () => {
    expect(stageOf('shader', { stage: 'background' })).toBe('background')
    expect(stageOf('shader', { stage: 'face' })).toBe('face')
    expect(stageOf('shader', { stage: 'post' })).toBe('color')
    expect(stageOf('shader')).toBe('color')
  })

  it('every stage is one of STAGES', () => {
    for (const l of BUILTIN_LAYERS) {
      for (const layer of [{}, { overlay: true }, { stage: 'background' }, { stage: 'face' }]) {
        expect(STAGES).toContain(stageOf(l.type, layer))
      }
    }
  })

  it('anchored types are those with an anchor property; only canvas requires an id', () => {
    for (const l of BUILTIN_LAYERS) {
      const hasAnchor = 'anchor' in l.schema.properties
      if (l.anchored) expect(hasAnchor).toBe(true)
      expect(l.requiresId ?? false).toBe(l.type === 'canvas')
    }
    expect(BUILTIN_LAYERS.filter((l) => l.anchored).map((l) => l.type)).toEqual(['text', 'sticker', 'model', 'canvas'])
  })

  it('schemas accept a minimal layer and refuse unknown properties', () => {
    const minimal: Record<string, Record<string, unknown>> = {
      text: { text: 'hi' },
      sticker: { src: 'star' },
      model: { src: { shape: 'torus' } },
      warp: { kind: 'bulge', anchor: 'leftEye' },
      color: {},
      shader: { src: 'assets/fx.frag' },
      canvas: { width: 256, height: 128 },
    }
    for (const l of BUILTIN_LAYERS) {
      const layer = { type: l.type, ...minimal[l.type] }
      expect(Value.Check(l.schema, layer)).toBe(true)
      expect(Value.Check(l.schema, { ...layer, colour: '#fff' })).toBe(false)
    }
  })
})
