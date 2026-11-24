/**
 * Error paths of the manifest validator not covered by validate.test.ts: the message of each structural keyword,
 * the semantic checks of params, presets, layers, events, script and requires, and formatIssues.
 */
import { describe, expect, it } from 'vitest'
import { Type } from 'typebox'
import { Bindable, createRegistry, extendRegistry, formatIssues, validateManifest, type Issue } from '../src/index.ts'

const base = {
  ouaf: '1',
  id: 'test',
  name: 'Test',
  version: '1.0.0',
  license: 'CC0-1.0',
  requires: { face: true },
  layers: [] as unknown[],
}
const withLayers = (...layers: unknown[]) => ({ ...base, layers })

const codes = (issues: Issue[]) => issues.map((i) => `${i.code}@${i.path}`)
const find = (issues: Issue[], path: string) => issues.find((i) => i.path === path)

describe('structural errors: one actionable message per keyword', () => {
  it('names the expected type of a value', () => {
    const r = validateManifest({
      ...base,
      requires: 5,
      tags: 'party',
      params: 5,
      credits: [{ what: 'hat', author: 'me', license: 'MIT', source: 5 }],
      events: { smile: { threshold: 'high' } },
      layers: {},
    })
    expect(r.ok).toBe(false)
    expect(find(r.errors, '/requires')?.message).toBe('Invalid value: expected an object { … }.')
    expect(find(r.errors, '/params')?.message).toBe('Invalid value: expected an object { … }.')
    expect(find(r.errors, '/tags')?.message).toBe('Invalid value: expected a list [ … ].')
    expect(find(r.errors, '/layers')?.message).toBe('Invalid value: expected a list [ … ].')
    expect(find(r.errors, '/credits/0/source')?.message).toBe('Invalid value: expected a string.')
    expect(find(r.errors, '/events/smile/threshold')?.message).toBe('Invalid value: expected a number.')
    // The hint is the schema's description.
    expect(find(r.errors, '/credits/0/source')?.hint).toBe('Origin (informational only, never loaded).')
  })

  it('integers, booleans, tuples', () => {
    const r = validateManifest({
      ...base,
      layers: [
        { type: 'canvas', id: 'c', width: 'big', height: 100.5, overlay: 'yes' },
        { type: 'text', text: 'x', shadow: { color: '#000000', offset: 'down' } },
      ],
    })
    expect(find(r.errors, '/layers/0/width')?.message).toBe('Invalid value: expected an integer.')
    expect(find(r.errors, '/layers/0/height')?.message).toBe('Invalid value: expected an integer.')
    expect(find(r.errors, '/layers/0/overlay')?.message).toBe('Invalid value: expected true or false.')
    expect(find(r.errors, '/layers/1/shadow/offset')?.message).toBe('Invalid value: expected a list of 2 numbers.')
  })

  it('a schema without a type: "a different value"', () => {
    const reg = createRegistry()
    extendRegistry(reg, {
      plugin: 'odd',
      version: '1.0.0',
      layers: [{
        type: 'odd:layer',
        schema: Type.Object({ type: Type.Literal('odd:layer'), nothing: Type.Optional(Type.Null()) }, { additionalProperties: false }),
        stage: 'objects',
        since: '1.0',
        anchored: false,
      }],
    })
    const r = validateManifest({ ...base, requires: { plugins: ['odd@^1'] }, layers: [{ type: 'odd:layer', nothing: 1 }] }, reg)
    expect(codes(r.errors)).toEqual(['type@/layers/0/nothing'])
    expect(r.errors[0]!.message).toBe('Invalid value: expected a different value.')
  })

  it('ranges: minimum, maximum and exclusive minimum, with the limits of the schema', () => {
    const r = validateManifest(withLayers(
      { type: 'text', text: 'x', lineHeight: 0.1, maxWidth: 0, outline: { width: 0.6, color: '#000000' } },
      { type: 'canvas', id: 'c', width: 8, height: 64, fps: 61 },
    ))
    expect(find(r.errors, '/layers/0/lineHeight')).toMatchObject({ code: 'range', message: 'Value 0.1 is too small: minimum is 0.5.' })
    expect(find(r.errors, '/layers/0/maxWidth')).toMatchObject({ code: 'range', message: 'Value 0 is too small: must be greater than 0.' })
    expect(find(r.errors, '/layers/0/outline/width')).toMatchObject({ code: 'range', message: 'Value 0.6 is too large: maximum is 0.5.' })
    expect(find(r.errors, '/layers/1/width')).toMatchObject({ code: 'range', message: 'Value 8 is too small: minimum is 16.' })
    expect(find(r.errors, '/layers/1/fps')).toMatchObject({ code: 'range', message: 'Value 61 is too large: maximum is 60.' })
  })

  it('a bindable property out of range is reported as a form not accepted, with the binding hint', () => {
    const r = validateManifest(withLayers({ type: 'text', text: 'x', opacity: 2 }))
    expect(find(r.errors, '/layers/0/opacity')).toMatchObject({
      code: 'type',
      message: 'This form of value is not accepted.',
      hint: 'Fixed value, { "param": "name" } or { "bind": "face.…" }.',
    })
  })

  it('strings: pattern, maximum and minimum length', () => {
    expect(find(validateManifest({ ...base, id: 'Not An Id' }).errors, '/id')).toMatchObject({ code: 'format', message: 'Invalid format: "Not An Id".' })
    expect(find(validateManifest({ ...base, author: 'x'.repeat(201) }).errors, '/author'))
      .toMatchObject({ code: 'too-long', message: 'Text too long (maximum 200 characters).' })
    const r = validateManifest(withLayers({ type: 'text', text: 'x', anchor: 'Bad Anchor' }))
    expect(find(r.errors, '/layers/0/anchor')?.code).toBe('format')
    const credits = validateManifest({ ...base, credits: [{ what: '', author: 'me', license: 'MIT' }] })
    expect(find(credits.errors, '/credits/0/what')).toMatchObject({ code: 'too-short', message: 'Text too short or empty.' })
  })

  it('lists and records: too many, too few, duplicates, too many entries', () => {
    const layers = validateManifest({ ...base, requires: {}, layers: Array.from({ length: 65 }, () => ({ type: 'color' })) })
    expect(codes(layers.errors)).toEqual(['too-many@/layers'])
    expect(layers.errors[0]!.message).toBe('Too many items (maximum 64).')
    expect(find(validateManifest({ ...base, tags: ['a', 'a'] }).errors, '/tags')).toMatchObject({ code: 'duplicate', message: 'The list contains duplicates.' })
    const r = validateManifest(withLayers(
      { type: 'shader', src: 'assets/a.frag', anchors: [] },
      { type: 'shader', src: 'assets/a.frag', textures: { a: 'assets/a.png', b: 'assets/a.png', c: 'assets/a.png', d: 'assets/a.png', e: 'assets/a.png' } },
    ))
    expect(find(r.errors, '/layers/0/anchors')).toMatchObject({ code: 'too-few', message: 'Not enough items (minimum 1).' })
    expect(find(r.errors, '/layers/1/textures')).toMatchObject({ code: 'too-many', message: 'Too many entries (maximum 4).' })
  })

  it('literals and enums, for string and non-string values', () => {
    expect(find(validateManifest({ ...base, script: { entry: 'main.js' } }).errors, '/script/entry'))
      .toMatchObject({ code: 'literal', message: 'Expected value: "script.js".' })
    expect(find(validateManifest({ ...base, ouaf: '2' }).errors, '/ouaf')).toMatchObject({ code: 'literal', message: 'Expected value: "1".' })
    const r = validateManifest(withLayers(
      { type: 'sticker', src: 'assets/a.png', blend: 'scren' },
      { type: 'sticker', src: 'assets/a.png', blend: 5 },
      { type: 'text', text: 'x', orient: 5 },
    ))
    expect(find(r.errors, '/layers/0/blend')).toMatchObject({
      code: 'enum',
      message: 'Unrecognized value "scren". Did you mean "screen"?',
      hint: 'Possible values: "normal", "add", "multiply", "screen".',
    })
    expect(find(r.errors, '/layers/1/blend')).toMatchObject({ code: 'enum', message: 'Unrecognized value.' })
    expect(find(r.errors, '/layers/2/orient')).toMatchObject({ code: 'enum', message: 'Unrecognized value.', hint: 'Possible values: "face", "screen".' })
  })

  it('stops at the envelope: layers are only checked once it is valid', () => {
    const r = validateManifest({ ...base, id: '', layers: [{ type: 'nope' }] })
    expect(codes(r.errors)).toEqual(['format@/id'])
    expect(r.warnings).toEqual([])
  })
})

describe('semantic checks', () => {
  it('number params: min above max, default outside the range; visibleIf on an unknown param', () => {
    const r = validateManifest({
      ...base,
      requires: {},
      params: {
        n: { type: 'number', default: 5, min: 10, max: 1 },
        m: { type: 'number', default: 50, max: 10 },
        v: { type: 'boolean', default: true, visibleIf: { ghost: true } },
      },
    })
    expect(codes(r.errors)).toEqual(['range@/params/n', 'range@/params/n/default', 'range@/params/m/default', 'unknown-param@/params/v/visibleIf/ghost'])
    expect(r.errors[0]!.message).toBe('"min" (10) is greater than "max" (1).')
    expect(r.errors[2]!.message).toBe('Default value 50 is outside [undefined, 10].')
    expect(r.errors[3]!.message).toBe('visibleIf refers to an unknown parameter "ghost".')
  })

  it('presets: values of the wrong type, outside the range, unknown params with a suggestion', () => {
    const r = validateManifest({
      ...base,
      requires: {},
      params: { size: { type: 'number', default: 1, min: 0, max: 2 }, on: { type: 'boolean', default: true } },
      presets: { p: { size: 'big', on: 3 }, q: { size: 3 }, r: { sise: 1 } },
    })
    expect(codes(r.errors)).toEqual(['preset-invalid@/presets/p/size', 'preset-invalid@/presets/p/on', 'range@/presets/q/size', 'unknown-param@/presets/r/sise'])
    expect(r.errors[0]!.message).toBe('Invalid value for "size" (type number).')
    expect(r.errors[2]!.message).toBe('Value 3 is outside [0, 2].')
    expect(r.errors[3]!.message).toBe('Preset "r" sets an unknown parameter "sise". Did you mean "size"?')
  })

  it('duplicate layer ids, and excludeFromCapture without overlay', () => {
    const r = validateManifest(withLayers({ type: 'color', id: 'a' }, { type: 'color', id: 'a' }, { type: 'text', text: 'x', excludeFromCapture: true }))
    expect(codes(r.errors)).toEqual(['duplicate-id@/layers/1/id'])
    expect(r.errors[0]!.message).toBe('Duplicate layer id "a" (already used by /layers/0).')
    expect(codes(r.warnings)).toEqual(['ignored@/layers/2/excludeFromCapture'])
  })

  it('layer types of a declared plugin are not checked; others are unknown', () => {
    const r = validateManifest({ ...base, requires: { plugins: ['mood@^1'] }, layers: [{ type: 'mood:aura', any: 1 }, { type: 'other:x' }] })
    expect(codes(r.errors)).toEqual(['unknown-layer-type@/layers/1/type'])
    expect(codes(r.warnings)).toEqual(['unverified-layer@/layers/0/type'])
    expect(r.warnings[0]!.message).toBe('Unknown layer type "mood:aura". Provided by a plugin that is not loaded: not checked.')
  })

  it('script: draw for a layer that is not a canvas, unknown script data, pairs uses the face', () => {
    const r = validateManifest({ ...base, requires: {}, layers: [{ type: 'color', id: 'a' }], script: { entry: 'script.js', draw: ['a'], uses: ['pairs', 'nope'] } })
    expect(codes(r.errors)).toEqual(['not-canvas@/script/draw/0', 'unknown-data@/script/uses/1', 'requires-face@/requires'])
    expect(r.errors[0]!.message).toBe('draw.a: layer "a" has type "color", not "canvas".')
    expect(r.errors[1]!.hint).toMatch(/^Possible values: "face.pose", /)
  })

  it('a script with an unknown layer type still checks its assets', () => {
    const r = validateManifest({ ...base, requires: {}, layers: [{ type: 'nope' }], assets: { blob: { src: 'assets/blob.json', kind: 'data' } }, script: { entry: 'script.js', uses: [] } })
    expect(codes(r.errors)).toEqual(['unknown-layer-type@/layers/0/type'])
    expect(codes(r.warnings)).toEqual(['unused-asset@/assets/blob'])
  })

  it('reserved requirements are warnings (spec: phase 2 and later)', () => {
    const r = validateManifest({ ...base, requires: { hands: true, segmentation: true, pose: true, audio: true }, layers: [{ type: 'color' }] })
    expect(r.ok).toBe(true)
    expect(codes(r.warnings)).toEqual(['reserved@/requires/hands', 'reserved@/requires/segmentation', 'reserved@/requires/pose', 'reserved@/requires/audio'])
  })

  it('only tunable events take a threshold', () => {
    const r = validateManifest({ ...base, events: { faceEnter: { threshold: 0.5 }, smile: { threshold: 0.2 } } })
    expect(codes(r.errors)).toEqual(['not-tunable@/events/faceEnter/threshold'])
    expect(r.errors[0]!.message).toBe('The threshold of "faceEnter" cannot be tuned.')
  })

  it('assets of unknown kind, and the hint for unused data assets', () => {
    const r = validateManifest({
      ...base,
      layers: [{ type: 'sticker', src: 'a' }],
      assets: { a: 'assets/a.png', b: 'assets/b.xyz', c: { src: 'assets/c.json', kind: 'data' } },
    })
    expect(codes(r.warnings)).toEqual(['unused-asset@/assets/b', 'unknown-kind@/assets/b', 'unused-asset@/assets/c'])
    expect(find(r.warnings, '/assets/b')!.hint).toBeUndefined()
    expect(r.warnings[1]!.hint).toBe('Set "kind", e.g. { "src": "…", "kind": "lottie" }.')
    expect(r.warnings[2]!.hint).toMatch(/A script does not read data assets/)
  })
})

describe('bindings', () => {
  it('to a param when no params are declared', () => {
    const r = validateManifest(withLayers({ type: 'text', text: { param: 'message' } }))
    expect(codes(r.errors)).toEqual(['unknown-param@/layers/0/text/param'])
    expect(r.errors[0]!.message).toBe('Unknown parameter "message".')
  })

  it('"range" without "to"', () => {
    const r = validateManifest(withLayers({ type: 'warp', kind: 'bulge', anchor: 'leftEye', strength: { bind: 'face.blendshapes.jawOpen', range: [0, 1] } }))
    expect(codes(r.errors)).toEqual(['binding-range@/layers/0/strength'])
  })

  it('unknown data path without a known prefix: example paths from the whole list', () => {
    const r = validateManifest(withLayers({ type: 'text', text: { bind: 'zzz.qqq' } }))
    expect(codes(r.errors)).toEqual(['unknown-data-path@/layers/0/text/bind'])
    expect(r.errors[0]!.hint).toMatch(/^Example paths: "time", "faces.count", .*\(\d+ in total\)\.$/)
  })

  it('a number into a vector needs map', () => {
    const r = validateManifest(withLayers({ type: 'text', text: 'x', offset: { bind: 'face.blendshapes.jawOpen' } }))
    expect(codes(r.errors)).toEqual(['binding-map-required@/layers/0/offset'])
    expect(r.errors[0]!.message).toBe('"face.blendshapes.jawOpen" is a number, this property expects an [x, y, z] vector: add "map" to convert it.')
  })

  it('map keys a number never matches: a canonical form when there is one', () => {
    const r = validateManifest(withLayers({ type: 'text', text: { bind: 'face.blendshapes.jawOpen', map: { ' ': 'a', '1.0': 'b', abc: 'c', '0.5': 'd' } } }))
    expect(r.ok).toBe(true)
    expect(codes(r.warnings)).toEqual(['binding-map-key@/layers/0/text/map/ ', 'binding-map-key@/layers/0/text/map/1.0', 'binding-map-key@/layers/0/text/map/abc'])
    expect(r.warnings.map((w) => w.hint)).toEqual([
      'Use number keys such as "0", "1" or "0.5", or "range"/"to" for a continuous value.',
      'Write the key "1".',
      'Use number keys such as "0", "1" or "0.5", or "range"/"to" for a continuous value.',
    ])
  })

  it('a property of a plugin whose kind has no param type accepts any param; a bind to it needs map', () => {
    const reg = createRegistry()
    extendRegistry(reg, {
      plugin: 'odd',
      version: '1.0.0',
      layers: [{
        type: 'odd:layer',
        schema: Type.Object(
          { type: Type.Literal('odd:layer'), box: Type.Optional(Bindable(Type.Object({ w: Type.Number() }))) },
          { additionalProperties: false },
        ),
        stage: 'objects',
        since: '1.0',
        anchored: false,
      }],
    })
    const m = { ...base, requires: { face: true, plugins: ['odd@^1'] }, params: { s: { type: 'string', default: 'x' } } }
    expect(validateManifest({ ...m, layers: [{ type: 'odd:layer', box: { param: 's' } }] }, reg).errors).toEqual([])
    const r = validateManifest({ ...m, layers: [{ type: 'odd:layer', box: { bind: 'face.size' } }] }, reg)
    expect(codes(r.errors)).toEqual(['binding-map-required@/layers/0/box'])
    expect(r.errors[0]!.message).toBe('"face.size" is a number, this property expects object: add "map" to convert it.')
  })

  it('content map: undeclared assets and assets of the wrong kind, keys that are not options', () => {
    const r = validateManifest({
      ...base,
      params: { s: { type: 'select', default: 'a', options: { a: 'A', b: 'B' } } },
      assets: { pic: 'assets/pic.png' },
      layers: [{ type: 'sticker', src: { param: 's', map: { a: 'builtin:font/sans', b: 'pic', c: 'nope' } } }],
    })
    expect(codes(r.errors)).toEqual(['asset-kind@/layers/0/src/map/a', 'unknown-asset@/layers/0/src/map/c'])
    expect(r.errors[0]!.message).toBe('"builtin:font/sans" is a font asset: this property shows an image, spritesheet or video asset.')
    expect(codes(r.warnings)).toEqual(['binding-map-key@/layers/0/src/map/c'])
    expect(r.warnings[0]!.hint).toBe('Did you mean "a"? Options: "a", "b".')
  })

  it('content binding to a param when no params are declared', () => {
    const r = validateManifest(withLayers({ type: 'sticker', src: { param: 'logo' } }))
    expect(codes(r.errors)).toEqual(['unknown-param@/layers/0/src/param'])
  })
})

describe('shaders (spec §11)', () => {
  it('reads the source of an asset path, of a declared asset (string or object), not of a built-in', () => {
    const read: string[] = []
    const r = validateManifest(
      {
        ...base,
        assets: { fx: 'assets/fx.frag', fy: { src: 'assets/fy.frag' } },
        layers: [
          { type: 'shader', src: 'assets/direct.frag' },
          { type: 'shader', src: 'fx' },
          { type: 'shader', id: 'named', src: 'fy' },
          { type: 'shader', src: 'builtin:lut/noir' },
        ],
      },
      createRegistry(),
      { shaderSource: (p) => (read.push(p), 'vec4 effect(vec2 uv) { return vec4(ouaf_faceMask); }') },
    )
    expect(read).toEqual(['assets/direct.frag', 'assets/fx.frag', 'assets/fy.frag'])
    expect(r.errors).toEqual([])
  })

  it('names the shaders whose face inputs make requires.face necessary', () => {
    const r = validateManifest(
      { ...base, requires: {}, layers: [{ type: 'shader', id: 'glow', src: 'assets/a.frag' }, { type: 'shader', src: 'assets/b.frag' }] },
      createRegistry(),
      { shaderSource: () => 'vec4 effect(vec2 uv) { return vec4(float(ouaf_faceCount)); }' },
    )
    expect(codes(r.errors)).toEqual(['requires-face@/requires'])
    expect(r.errors[0]!.message).toBe(
      'The filter uses the face (anchors, data, events or shader inputs; ouaf_faceCount in the shader of layer "glow"; ouaf_faceCount in the shader of /layers/1) without declaring it.',
    )
  })

  it('a source that cannot be read uses nothing', () => {
    const r = validateManifest({ ...base, requires: {}, layers: [{ type: 'shader', src: 'assets/a.frag' }] }, createRegistry(), { shaderSource: () => undefined })
    expect(r.ok).toBe(true)
  })
})

describe('formatIssues', () => {
  it('prints "/" for the root, hints, and the summary line', () => {
    const text = formatIssues({ ok: false, errors: [{ severity: 'error', code: 'x', path: '', message: 'Bad.', hint: 'Fix it.' }], warnings: [] }, 'f.json')
    expect(text).toBe('f.json/ — error [x] Bad.\n    → Fix it.\nf.json: 1 error(s).')
    expect(formatIssues({ ok: true, errors: [], warnings: [] })).toBe('manifest: valid.')
    const warned = formatIssues({ ok: true, errors: [], warnings: [{ severity: 'warning', code: 'w', path: '/a', message: 'Hm.' }] })
    expect(warned).toBe('manifest/a — warning [w] Hm.\nmanifest: valid (1 warning(s)).')
  })
})
