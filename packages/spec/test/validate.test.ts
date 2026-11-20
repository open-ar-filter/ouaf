import { describe, expect, it } from 'vitest'
import { Type } from '@sinclair/typebox'
import { closest, createRegistry, extendRegistry, formatIssues, validateManifest, type Issue } from '../src/index.ts'

const base = {
  ouaf: '1',
  id: 'test',
  name: 'Test',
  version: '1.0.0',
  license: 'CC0-1.0',
  requires: { face: true },
}

function codes(issues: Issue[]) {
  return issues.map((i) => `${i.code}@${i.path}`)
}

describe('valid manifests', () => {
  it('text-bubble: text bound to parameters, no script', () => {
    const r = validateManifest({
      ...base,
      id: 'text-bubble',
      params: {
        message: { type: 'string', default: 'Hi 👋', label: { en: 'Text', fr: 'Texte' } },
        color: { type: 'color', default: '#ffffff' },
      },
      layers: [
        {
          id: 'label',
          type: 'text',
          text: { param: 'message' },
          color: { param: 'color' },
          anchor: 'forehead',
          offset: [0, 0.9, 0],
          size: 0.35,
          outline: { width: 0.08, color: '#000000' },
          orient: 'screen',
          faces: 'all',
        },
      ],
    })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('glasses + big eyes + vintage: assets, shapes, blendshape-driven warp, presets', () => {
    const r = validateManifest({
      ...base,
      id: 'combo',
      params: {
        size: { type: 'number', default: 1, min: 0.5, max: 2, step: 0.1 },
        style: { type: 'select', default: 'gold', options: { gold: 'Gold', flowers: 'Flowers' } },
        confetti: { type: 'boolean', default: true },
        density: { type: 'number', default: 20, min: 0, max: 100, visibleIf: { confetti: true } },
      },
      presets: { party: { size: 1.5, density: 80 } },
      assets: {
        glasses: 'assets/glasses.glb',
        star: { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' },
        cool: { emoji: '😎' },
        lut: 'assets/vintage.cube',
        grain: 'assets/grain.frag',
      },
      layers: [
        { type: 'model', src: 'glasses', anchor: 'eyes', fit: { width: 2.2 }, occlusion: 'head', scale: { param: 'size' } },
        { type: 'model', src: { shape: 'torus', color: '#ff00cc', thickness: 0.1 }, anchor: 'leftEye' },
        { type: 'sticker', src: { pick: ['star', 'cool'], by: 'face' }, anchor: 'forehead', size: 0.5 },
        { type: 'warp', kind: 'bulge', anchor: ['leftEye', 'rightEye'], strength: { bind: 'face.blendshapes.jawOpen', range: [0, 1], to: [0.1, 0.6] } },
        { type: 'color', lut: 'lut', intensity: 0.8, vignette: 0.3 },
        { type: 'shader', src: 'grain', uniforms: { amount: 0.4 } },
      ],
    })
    expect(r.errors).toEqual([])
  })

  it('smile-counter: script, events, drawn canvas', () => {
    const r = validateManifest({
      ...base,
      id: 'smile-counter',
      layers: [
        { id: 'label', type: 'text', text: '😐', anchor: 'forehead', offset: [0, 0.9, 0] },
        { id: 'bubble', type: 'canvas', width: 512, height: 256, anchor: 'forehead', fps: 0 },
      ],
      events: { smile: { threshold: 0.6 } },
      script: { entry: 'script.js', on: ['smile', 'faceLeave', 'message:startGame'], update: true, draw: ['bubble'], uses: ['face.pose'] },
    })
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('screen layer without a face: unused requires.face is only a warning', () => {
    const r = validateManifest({
      ...base,
      layers: [{ type: 'text', text: 'Hello', anchor: 'screen', overlay: true, excludeFromCapture: true }],
    })
    expect(r.ok).toBe(true)
    expect(codes(r.warnings)).toContain('unused-requirement@/requires/face')
  })
})

describe('actionable errors', () => {
  it('missing required property', () => {
    const { license: _omit, ...withoutLicense } = base
    const r = validateManifest({ ...withoutLicense, layers: [] })
    expect(codes(r.errors)).toContain('required@/license')
  })

  it('unknown anchor, with a synonym suggestion', () => {
    const r = validateManifest({ ...base, assets: { star: { emoji: '⭐' } }, layers: [{ type: 'sticker', src: 'star', anchor: 'nose' }] })
    expect(r.errors[0]).toMatchObject({ code: 'unknown-anchor', path: '/layers/0/anchor' })
    expect(r.errors[0]!.message).toContain('"noseTip"')
  })

  it('typo in a property name', () => {
    const r = validateManifest({ ...base, layers: [{ type: 'text', text: 'x', colour: '#fff' }] })
    expect(r.errors[0]).toMatchObject({ code: 'unknown-property', path: '/layers/0/colour' })
    expect(r.errors[0]!.message).toContain('"color"')
  })

  it('unknown layer type', () => {
    const r = validateManifest({ ...base, layers: [{ type: 'stiker', src: 'a' }] })
    expect(r.errors[0]).toMatchObject({ code: 'unknown-layer-type' })
    expect(r.errors[0]!.message).toContain('"sticker"')
  })

  it('value outside the allowed list, with a suggestion', () => {
    const r = validateManifest({ ...base, layers: [{ type: 'warp', kind: 'bulg', anchor: 'leftEye' }] })
    expect(r.errors[0]).toMatchObject({ code: 'enum', path: '/layers/0/kind' })
    expect(r.errors[0]!.message).toContain('"bulge"')
  })

  it('undeclared asset, and remote URL rejected', () => {
    const r1 = validateManifest({ ...base, layers: [{ type: 'sticker', src: 'hat' }] })
    expect(r1.errors[0]).toMatchObject({ code: 'unknown-asset', path: '/layers/0/src' })
    const r2 = validateManifest({ ...base, assets: { hat: 'https://example.org/hat.png' }, layers: [] })
    expect(r2.ok).toBe(false)
  })

  it('binding to a missing parameter or a parameter of the wrong type', () => {
    const r = validateManifest({
      ...base,
      params: { message: { type: 'string', default: 'x' } },
      layers: [
        { type: 'text', text: { param: 'mesage' } },
        { type: 'text', text: 'x', size: { param: 'message' } },
      ],
    })
    expect(codes(r.errors)).toEqual(['unknown-param@/layers/0/text/param', 'param-type-mismatch@/layers/1/size/param'])
    expect(r.errors[0]!.message).toContain('"message"')
  })

  it('unknown tracking data path', () => {
    const r = validateManifest({ ...base, layers: [{ type: 'text', text: 'x', size: { bind: 'face.blendshapes.jawOpn' } }] })
    expect(r.errors[0]).toMatchObject({ code: 'unknown-data-path' })
    expect(r.errors[0]!.message).toContain('jawOpen')
  })

  it('face used without requires.face', () => {
    const r = validateManifest({ ...base, requires: {}, layers: [{ type: 'text', text: 'x', anchor: 'chin' }] })
    expect(codes(r.errors)).toContain('requires-face@/requires')
  })

  it('canvas without id, draw for a missing layer, unknown event', () => {
    const r = validateManifest({
      ...base,
      layers: [{ type: 'canvas', width: 64, height: 64 }],
      script: { entry: 'script.js', on: ['smiel'], draw: ['bubble'] },
    })
    expect(codes(r.errors)).toEqual(['missing-id@/layers/0', 'unknown-layer@/script/draw/0', 'unknown-event@/script/on/0'])
    expect(r.errors[2]!.message).toContain('"smile"')
  })

  it('inconsistent presets and defaults', () => {
    const r = validateManifest({
      ...base,
      params: {
        size: { type: 'number', default: 5, min: 0, max: 2 },
        style: { type: 'select', default: 'silver', options: { gold: 'Gold' } },
      },
      presets: { party: { size: 3, colour: '#fff' } },
      layers: [],
    })
    expect(codes(r.errors)).toEqual([
      'range@/params/size/default',
      'enum@/params/style/default',
      'range@/presets/party/size',
      'unknown-param@/presets/party/colour',
    ])
  })

  it('unknown built-in resource', () => {
    const r = validateManifest({ ...base, layers: [{ type: 'text', text: 'x', font: 'builtin:font/rounded' }] })
    expect(r.errors[0]).toMatchObject({ code: 'unknown-builtin', path: '/layers/0/font' })
    expect(r.errors[0]!.message).toContain('"builtin:font/')
  })

  it('reserved event is a warning', () => {
    const r = validateManifest({ ...base, layers: [], script: { entry: 'script.js', on: ['tap'] } })
    expect(r.ok).toBe(true)
    expect(codes(r.warnings)).toContain('reserved@/script/on/0')
  })

  it('formatIssues produces readable text', () => {
    const r = validateManifest({ ...base, assets: { star: { emoji: '⭐' } }, layers: [{ type: 'sticker', src: 'star', anchor: 'nose' }] })
    const text = formatIssues(r, 'filters/test')
    expect(text).toContain('filters/test/layers/0/anchor — error [unknown-anchor]')
    expect(text).toContain('→ Available anchors')
  })
})

describe('registry and plugins', () => {
  it('a third-party plugin must prefix its vocabulary', () => {
    const reg = createRegistry()
    expect(() => extendRegistry(reg, { plugin: 'sparkles', version: '1.0.0', anchors: [{ name: 'halo', subject: 'face', description: '', status: 'stable' }] }))
      .toThrow(/sparkles:halo/)
  })

  it('a layer provided by a plugin requires requires.plugins', () => {
    const reg = createRegistry()
    extendRegistry(reg, {
      plugin: 'sparkles',
      version: '1.2.0',
      layers: [{
        type: 'sparkles:burst',
        schema: Type.Object({ type: Type.Literal('sparkles:burst'), count: Type.Integer() }, { additionalProperties: false }),
        stage: 'objects',
        since: '1.0',
        anchored: false,
      }],
    })
    const m = { ...base, requires: {}, layers: [{ type: 'sparkles:burst', count: 10 }] }
    expect(codes(validateManifest(m, reg).errors)).toEqual(['missing-plugin@/layers/0/type'])
    expect(validateManifest({ ...m, requires: { plugins: ['sparkles@^1'] } }, reg).ok).toBe(true)
  })

  it('closest: synonyms (English and French), case, distance', () => {
    expect(closest('lips', ['mouth', 'chin'])).toBe('mouth')
    expect(closest('bouche', ['mouth', 'chin'])).toBe('mouth')
    expect(closest('NOSETIP', ['noseTip'])).toBe('noseTip')
    expect(closest('xyz', ['mouth', 'chin'])).toBeUndefined()
  })
})
