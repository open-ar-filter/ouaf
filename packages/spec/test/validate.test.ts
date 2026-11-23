import { describe, expect, it } from 'vitest'
import { Type } from 'typebox'
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

  it('follow: accepts auto/rigid/expression, rejects other values', () => {
    const layer = (follow: string) => ({ type: 'sticker', src: 'beard', anchor: 'chin', follow })
    const assets = { beard: { emoji: '🧔' } }
    for (const f of ['auto', 'rigid', 'expression']) expect(validateManifest({ ...base, assets, layers: [layer(f)] }).errors).toEqual([])
    const r = validateManifest({ ...base, assets, layers: [layer('rigd')] })
    expect(r.errors[0]).toMatchObject({ path: '/layers/0/follow' })
    expect(r.errors[0]!.message).toContain('"rigid"')
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

  it('requires.blendshapes: needs face, warns when nothing reads them', () => {
    const jaw = { type: 'text', text: 'x', size: { bind: 'face.blendshapes.jawOpen', range: [0, 1], to: [0.1, 0.6] } }
    expect(validateManifest({ ...base, requires: { face: true, blendshapes: true }, layers: [jaw] }).warnings).toEqual([])
    const withoutFace = validateManifest({ ...base, requires: { blendshapes: true }, layers: [{ type: 'text', text: 'x', anchor: 'screen' }] })
    expect(codes(withoutFace.errors)).toContain('requires-face@/requires/blendshapes')
    const unused = validateManifest({ ...base, requires: { face: true, blendshapes: true }, layers: [{ type: 'text', text: 'x', anchor: 'chin' }] })
    expect(unused.ok).toBe(true)
    expect(codes(unused.warnings)).toContain('unused-requirement@/requires/blendshapes')
  })

  it('face used without requires.face', () => {
    const r = validateManifest({ ...base, requires: {}, layers: [{ type: 'text', text: 'x', anchor: 'chin' }] })
    expect(codes(r.errors)).toContain('requires-face@/requires')
  })

  it('color region "face" uses the face', () => {
    const face = { type: 'color', saturation: -1, region: 'face' }
    expect(codes(validateManifest({ ...base, requires: {}, layers: [face] }).errors)).toContain('requires-face@/requires')
    expect(validateManifest({ ...base, requires: { face: true }, layers: [face] }).warnings).toEqual([])
    const all = validateManifest({ ...base, requires: { face: true }, layers: [{ type: 'color', saturation: -1 }] })
    expect(codes(all.warnings)).toContain('unused-requirement@/requires/face')
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

  it('warns about map keys that can never match the data (spec §8)', () => {
    const text = (bind: string, map: Record<string, unknown>) =>
      ({ ...base, layers: [{ type: 'text', id: 't', text: { bind, map, default: '?' } }] })
    const r = validateManifest(text('face.index', { '0': 'A', '1': 'B', '1.0': 'C', '01': 'D', x: 'E', '0.5': 'F', '-1': 'G' }))
    expect(r.errors).toEqual([])
    expect(codes(r.warnings)).toEqual(['binding-map-key@/layers/0/text/map/1.0', 'binding-map-key@/layers/0/text/map/01', 'binding-map-key@/layers/0/text/map/x'])
    expect(r.warnings[0]!.message).toContain('"face.index" is a number')
    expect(r.warnings[0]!.hint).toBe('Write the key "1".')
    expect(r.warnings[2]!.hint).toContain('"range"/"to"')
    // Boolean and string data of plugins: only "true" / "false" match a boolean; any key matches a string.
    const reg = createRegistry()
    extendRegistry(reg, {
      plugin: 'mood',
      version: '1.0.0',
      data: [
        { path: 'ext.mood.happy', type: 'boolean', description: '' },
        { path: 'ext.mood.name', type: 'string', description: '' },
      ],
    })
    const plugin = { requires: { face: true, plugins: ['mood@^1'] } }
    const bool = validateManifest({ ...text('ext.mood.happy', { true: 'yes', false: 'no', 1: 'one', TRUE: 'YES' }), ...plugin }, reg)
    expect(codes(bool.warnings)).toEqual(['binding-map-key@/layers/0/text/map/1', 'binding-map-key@/layers/0/text/map/TRUE'])
    expect(bool.warnings[0]!.hint).toBe('Use the keys "true" and "false".')
    const str = validateManifest({ ...text('ext.mood.name', { '1.0': 'a', '': 'b', 'a/b': 'c' }), ...plugin }, reg)
    expect(str.warnings).toEqual([])
  })

  it('needs map when the data does not have the property\'s type, as the engine (spec §8)', () => {
    const reg = createRegistry()
    extendRegistry(reg, {
      plugin: 'mood',
      version: '1.0.0',
      data: [
        { path: 'ext.mood.name', type: 'string', description: '' },
        { path: 'ext.mood.happy', type: 'boolean', description: '' },
      ],
    })
    const check = (prop: string, bind: string, extra: Record<string, unknown> = {}) =>
      validateManifest({ ...base, requires: { face: true, plugins: ['mood@^1'] }, layers: [{ type: 'text', text: 'x', [prop]: { bind, ...extra } }] }, reg)
    // Fits as it is: numbers into a number or a text, strings into a text, booleans into a boolean.
    for (const [prop, bind] of [['size', 'face.index'], ['text', 'faces.count'], ['text', 'ext.mood.name'], ['visible', 'ext.mood.happy']] as const) {
      expect(check(prop, bind).errors, `${prop} ← ${bind}`).toEqual([])
    }
    const cases = [
      ['color', 'ext.mood.name', 'a color'],
      ['color', 'face.index', 'a color'],
      ['offset', 'face.index', 'an [x, y, z] vector'],
      ['visible', 'face.index', 'a boolean'],
      ['text', 'ext.mood.happy', 'a text'],
      ['size', 'ext.mood.happy', 'a number'],
    ] as const
    for (const [prop, bind, wants] of cases) {
      const r = check(prop, bind)
      expect(codes(r.errors), `${prop} ← ${bind}`).toEqual([`binding-map-required@/layers/0/${prop}`])
      expect(r.errors[0]!.message).toContain(`this property expects ${wants}: add "map"`)
    }
    expect(check('visible', 'face.index').errors[0]!.hint).toContain('"map": { "0": …, "1": … }')
    expect(check('visible', 'face.index', { map: { '0': true }, default: false }).errors).toEqual([])
    expect(check('color', 'ext.mood.name', { map: { happy: '#ffcc00' } }).errors).toEqual([])
  })

  it('reports data and lottie assets that no layer uses, even with a script (spec §10.2: reserved kinds)', () => {
    const r = validateManifest({
      ...base,
      requires: {},
      assets: { levels: 'assets/levels.json', anim: 'assets/anim.lottie', star: { emoji: '⭐' }, beep: 'assets/beep.ogg' },
      layers: [],
      script: { entry: 'script.js', setup: true },
    })
    expect(codes(r.warnings)).toEqual(['unused-asset@/assets/levels', 'unused-asset@/assets/anim'])
    expect(r.warnings[0]!.hint).toContain('import the JSON in filter.js')
  })

  it('accepts built-in resources in assets, under a name of the filter (spec §10.1), and checks them', () => {
    const ok = validateManifest({
      ...base,
      requires: {},
      assets: { title: 'builtin:font/rounded-bold', grade: 'builtin:lut/noir' },
      layers: [
        { type: 'text', text: 'Hi', font: 'title', anchor: 'screen' },
        { type: 'color', lut: 'grade' },
      ],
    })
    expect(ok.errors).toEqual([])
    expect(ok.warnings).toEqual([])
    const bad = validateManifest({ ...base, requires: {}, assets: { title: 'builtin:font/round' }, layers: [{ type: 'text', text: 'Hi', font: 'title', anchor: 'screen' }] })
    expect(codes(bad.errors)).toEqual(['unknown-builtin@/assets/title'])
    expect(bad.errors[0]!.message).toContain('"builtin:font/')
    // Not a remote URL, nor another scheme.
    expect(validateManifest({ ...base, requires: {}, assets: { title: 'https://example.com/f.woff2' }, layers: [] }).ok).toBe(false)
  })

  it('counts fonts as used by a script that draws canvas layers (spec §12.6), not by one that does not', () => {
    const manifest = (draw: string[] | undefined) => ({
      ...base,
      requires: {},
      assets: { title: 'builtin:font/rounded-bold', body: 'assets/body.woff2' },
      layers: [{ id: 'card', type: 'canvas', width: 64, height: 64, anchor: 'screen' }],
      script: { entry: 'script.js', ...(draw ? { draw } : { setup: true }) },
    })
    expect(validateManifest(manifest(['card'])).warnings).toEqual([])
    expect(codes(validateManifest(manifest(undefined)).warnings)).toEqual(['canvas-not-drawn@/layers/0', 'unused-asset@/assets/title', 'unused-asset@/assets/body'])
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

describe('script API and shaders (spec §11, §12, #66)', () => {
  const shader = (extra: Record<string, unknown>) => ({ type: 'shader', src: 'assets/fx.frag', ...extra })

  it('accepts scale on anchored layers, shader anchors and pair events', () => {
    const r = validateManifest({
      ...base,
      layers: [
        { id: 'label', type: 'text', text: 'Hi', scale: 1.2 },
        { type: 'sticker', src: 'assets/hat.png', scale: [1, 2, 1] },
        shader({ anchors: ['noseTip', 'leftEye'] }),
      ],
      events: { pairContact: { threshold: 0.2 } },
      script: { entry: 'script.js', on: ['pairContact', 'pairSeparate'], uses: ['pairs', 'face.anchors'] },
    })
    expect(codes(r.errors)).toEqual([])
  })

  it('refuses a screen anchor in a shader', () => {
    const r = validateManifest({ ...base, layers: [shader({ anchors: ['screen'] })] })
    expect(codes(r.errors)).toEqual(['not-face-anchor@/layers/0/anchors/0'])
  })

  it('needs requires.face for a face-stage shader, shader anchors and face script data', () => {
    const noFace = { ...base, requires: {} }
    for (const m of [
      { ...noFace, layers: [shader({ stage: 'face' })] },
      { ...noFace, layers: [shader({ anchors: ['mouth'] })] },
      { ...noFace, layers: [], script: { entry: 'script.js', update: true, uses: ['pairs'] } },
    ]) {
      expect(codes(validateManifest(m).errors)).toContain('requires-face@/requires')
    }
  })

  it('counts the face inputs of a readable shader source as a use of the face (spec §11.1)', () => {
    const sources: Record<string, string> = {
      'assets/fx.frag': 'vec4 effect(vec2 uv) { return ouaf_sample(uv) * ouaf_faceMask(uv); }',
      'assets/count.frag': 'vec4 effect(vec2 uv) { return vec4(float(ouaf_faceCount), ouaf_faceSize[0], 0.0, 1.0); }',
      'assets/plain.frag': '// ouaf_faceMask(uv)\nvec4 effect(vec2 uv) { return ouaf_sample(uv); }',
    }
    const files = { shaderSource: (path: string) => sources[path] }
    const masked = { ...base, assets: { fx: 'assets/fx.frag' }, layers: [{ type: 'shader', id: 'mask', src: 'fx' }] }
    // Without the files, nothing to go on: requires.face looks unused.
    expect(codes(validateManifest(masked).warnings)).toEqual(['unused-requirement@/requires/face'])
    expect(validateManifest(masked, undefined, files)).toMatchObject({ errors: [], warnings: [] })
    const missing = validateManifest({ ...masked, requires: {} }, undefined, files)
    expect(codes(missing.errors)).toEqual(['requires-face@/requires'])
    expect(missing.errors[0]!.message).toContain('ouaf_faceMask in the shader of layer "mask"')
    const count = validateManifest({ ...base, requires: {}, layers: [shader({ src: 'assets/count.frag' })] }, undefined, files)
    expect(count.errors[0]!.message).toContain('ouaf_faceCount, ouaf_faceSize in the shader of /layers/0')
    // A commented-out call is not a use; a built-in shader has no file to read.
    expect(codes(validateManifest({ ...base, layers: [shader({ src: 'assets/plain.frag' })] }, undefined, files).warnings))
      .toEqual(['unused-requirement@/requires/face'])
  })

  it('needs GLSL names for uniforms and textures (#24)', () => {
    const r = validateManifest({
      ...base,
      requires: {},
      layers: [
        shader({
          uniforms: { 'my-amount': 1, ouaf_x: 1, float: 1, ok: 1, both: 1 },
          textures: { gl_tex: 'assets/a.png', both: 'assets/a.png', noise: 'assets/a.png' },
        }),
      ],
    })
    expect(codes(r.errors)).toEqual([
      'shader-name@/layers/0/uniforms/my-amount',
      'shader-name@/layers/0/uniforms/ouaf_x',
      'shader-name@/layers/0/uniforms/float',
      'shader-name@/layers/0/textures/gl_tex',
      'shader-name@/layers/0/textures/both',
    ])
  })

  it('binds uniforms to number, boolean, color and vector params, not to strings (#24)', () => {
    const params = {
      n: { type: 'number', default: 1 },
      b: { type: 'boolean', default: true },
      c: { type: 'color', default: '#ff0000' },
      v2: { type: 'vec2', default: [0, 0] },
      v3: { type: 'vec3', default: [0, 0, 0] },
      s: { type: 'string', default: 'x' },
    }
    const uniforms = Object.fromEntries(Object.keys(params).map((k) => [k, { param: k }]))
    const r = validateManifest({ ...base, requires: {}, params, layers: [shader({ uniforms })] })
    expect(codes(r.errors)).toEqual(['param-type-mismatch@/layers/0/uniforms/s/param'])
    expect(r.errors[0]!.hint).toBe('Parameter types accepted here: "number", "boolean", "vec2", "vec3", "color".')
  })
})
