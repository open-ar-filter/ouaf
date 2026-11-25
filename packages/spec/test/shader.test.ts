import { describe, expect, it } from 'vitest'
import {
  checkShaderSource,
  parseShaderLog,
  shaderNameProblem,
  shaderUses,
  stripGlslComments,
  uniformTypeOf,
  uniformTypeOfParam,
  wrapShader,
  ShaderDeclarationError,
} from '../src/index.ts'

const EFFECT = 'vec4 effect(vec2 uv) {\n  return ouaf_sample(uv);\n}\n'

describe('checkShaderSource (spec §11)', () => {
  it('accepts an effect() and nothing else', () => {
    expect(checkShaderSource(EFFECT)).toEqual([])
    expect(checkShaderSource('vec4 effect(in highp vec2 p) { return vec4(p, 0.0, 1.0); }')).toEqual([])
  })

  it('reports #version, main() and a missing effect(), with lines, ignoring comments', () => {
    const src = '// void main() in a comment\n#version 300 es\n/* effect */\nvoid main() {}\n'
    expect(checkShaderSource(src).map((i) => [i.code, i.line])).toEqual([
      ['shader-version', 2],
      ['shader-main', 4],
      ['shader-no-effect', undefined],
    ])
  })

  it('keeps line and column numbers when stripping comments', () => {
    const src = 'a /* b\nc */ d // e\nf'
    const out = stripGlslComments(src)
    expect(out.split('\n').map((l) => l.length)).toEqual(src.split('\n').map((l) => l.length))
    expect(out.replace(/ +/g, ' ')).toBe('a \n d \nf')
  })
})

describe('shaderNameProblem', () => {
  it('accepts GLSL identifiers and refuses reserved ones', () => {
    for (const ok of ['amount', 'noiseTex', 'a_b2', '_x']) expect(shaderNameProblem(ok)).toBeUndefined()
    for (const bad of ['my-amount', '2d', 'ouaf_time', 'OUAF_MAX', 'gl_FragColor', 'a__b', 'float', 'texture', 'effect', 'main', 'sampler2D']) {
      expect(shaderNameProblem(bad), bad).toBeTypeOf('string')
    }
  })
})

describe('wrapShader', () => {
  it('declares the inputs, uniforms, textures and anchors before the author source, which starts at #line 1', () => {
    const w = wrapShader(EFFECT, {
      stage: 'post',
      maxFaces: 3,
      uniforms: [['amount', 'float'], ['on', 'bool'], ['tint', 'vec4']],
      textures: ['noise'],
      anchors: ['noseTip', 'leftEye'],
    })
    const [before, after] = w.fragment.split('#line 1\n')
    expect(before).toContain('#define OUAF_MAX_FACES 3')
    for (const decl of [
      'uniform float amount;',
      'uniform bool on;',
      'uniform vec4 tint;',
      'uniform sampler2D noise;',
      'uniform vec2 ouaf_anchor_noseTip[OUAF_MAX_FACES];',
      'uniform vec2 ouaf_anchor_leftEye[OUAF_MAX_FACES];',
      'uniform int ouaf_faceCount;',
      'uniform float ouaf_faceSize[OUAF_MAX_FACES];',
      'vec4 ouaf_sample(vec2 uv)',
      '#define ouaf_time',
      '#define ouaf_dt',
      '#define ouaf_resolution',
    ]) {
      expect(before).toContain(decl)
    }
    expect(before).not.toContain('#version')
    expect(after!.startsWith(EFFECT)).toBe(true)
    expect(after).toContain('void main()')
    expect(w.authorLines).toBe(3)
    expect(w).toMatchObject({ prevFrame: false, faceMask: false })
  })

  it('only declares ouaf_prevFrame and ouaf_faceMask for a source that uses them', () => {
    const plain = wrapShader(EFFECT, { stage: 'post', maxFaces: 1 }).fragment
    expect(plain).not.toContain('ouaf_prevFrame')
    expect(plain).not.toContain('ouaf_faceMask')
    const src = 'vec4 effect(vec2 uv) { return ouaf_prevFrame(uv) * ouaf_faceMask(uv); }'
    const w = wrapShader(src, { stage: 'post', maxFaces: 1 })
    expect(w).toMatchObject({ prevFrame: true, faceMask: true })
    expect(w.fragment).toContain('vec4 ouaf_prevFrame(vec2 uv)')
    expect(w.fragment).toContain('float ouaf_faceMask(vec2 uv)')
    expect(shaderUses('// ouaf_prevFrame(uv)\n' + EFFECT)).toEqual({ prevFrame: false, faceMask: false, faceSize: false, faceInputs: [] })
  })

  it('lists the face-tracking inputs a source uses, comments ignored', () => {
    const src = '/* ouaf_faceMask */ vec4 effect(vec2 uv) { return vec4(ouaf_faceSize[0] * float(ouaf_faceCount)); }'
    expect(shaderUses(src)).toEqual({ prevFrame: false, faceMask: false, faceSize: true, faceInputs: ['ouaf_faceCount', 'ouaf_faceSize'] })
    expect(shaderUses('vec4 effect(vec2 uv) { return ouaf_sample(uv) * ouaf_faceMask(uv); }').faceInputs).toEqual(['ouaf_faceMask'])
    // Whole identifiers only.
    expect(shaderUses('float my_ouaf_faceCount2 = 1.0;\n' + EFFECT).faceInputs).toEqual([])
  })

  it('limits the face stage to the mesh mask', () => {
    expect(wrapShader(EFFECT, { stage: 'face', maxFaces: 1 }).fragment).toContain('smoothstep(0.0, 1.0, ouaf_vMask)')
    expect(wrapShader(EFFECT, { stage: 'post', maxFaces: 1 }).fragment).not.toContain('ouaf_vMask')
  })

  it('counts the last line without a newline', () => {
    expect(wrapShader('vec4 effect(vec2 uv) { return vec4(1.0); }', { stage: 'post', maxFaces: 1 }).authorLines).toBe(1)
  })

  it('refuses names that are not GLSL, and a name used twice', () => {
    expect(() => wrapShader(EFFECT, { stage: 'post', maxFaces: 1, uniforms: [['my-amount', 'float']] })).toThrow(ShaderDeclarationError)
    expect(() => wrapShader(EFFECT, { stage: 'post', maxFaces: 1, uniforms: [['a', 'float']], textures: ['a'] })).toThrow(/both/)
    expect(() => wrapShader(EFFECT, { stage: 'post', maxFaces: 1, anchors: ['my:anchor'] })).toThrow(ShaderDeclarationError)
    expect(() => wrapShader(EFFECT, { stage: 'post', maxFaces: 0 })).toThrow(RangeError)
  })
})

describe('parseShaderLog', () => {
  const wrapped = { authorLines: 6 }

  it('keeps the author lines of ANGLE-style messages', () => {
    const log = "ERROR: 0:4: 'notDeclared' : undeclared identifier\nERROR: 0:4: '*=' : wrong operand types\nWARNING: 0:2: 'x' : unused\n\0"
    expect(parseShaderLog(log, wrapped)).toEqual([
      { severity: 'error', line: 4, message: "'notDeclared' : undeclared identifier" },
      { severity: 'error', line: 4, message: "'*=' : wrong operand types" },
      { severity: 'warning', line: 2, message: "'x' : unused" },
    ])
  })

  it('attributes later lines to the wrapper main(), keeps lines it cannot parse, and drops the error count', () => {
    const log = "ERROR: 0:9: 'effect' : no matching overloaded function found\nINTERNAL ERROR: out of memory\nERROR: 2 compilation errors.  No code generated.\n"
    expect(parseShaderLog(log, wrapped)).toEqual([
      { severity: 'error', message: "'effect' : no matching overloaded function found (in the engine's main(), which calls vec4 effect(vec2 uv))" },
      { severity: 'error', message: 'INTERNAL ERROR: out of memory' },
    ])
  })

  // Logs of Chromium, Firefox and WebKit (all ANGLE) for a 6-line source.
  it('reports a source that is not closed on its last line: a missing "}" or an open comment', () => {
    const hint = ' (at the end of the file: a "}", ")" or ";" may be missing, or a comment is not closed)'
    expect(parseShaderLog("ERROR: 0:7: '{' : syntax error\n", wrapped)).toEqual([{ severity: 'error', line: 6, message: `'{' : syntax error${hint}` }])
    expect(parseShaderLog("ERROR: 0:12: 'EOF while in a comment' : unexpected end of file found in comment\n", wrapped)).toEqual([
      { severity: 'error', line: 6, message: `'EOF while in a comment' : unexpected end of file found in comment${hint}` },
    ])
  })
})

describe('uniform types (spec §11)', () => {
  it('maps values and parameter types to GLSL types', () => {
    expect([1.5, true, [1, 2], [1, 2, 3], '#ff0000', '#f00a', 'red', [1], { a: 1 }].map(uniformTypeOf)).toEqual([
      'float', 'bool', 'vec2', 'vec3', 'vec4', 'vec4', undefined, undefined, undefined,
    ])
    expect(['number', 'boolean', 'color', 'vec2', 'vec3', 'string', 'select', 'asset'].map(uniformTypeOfParam)).toEqual([
      'float', 'bool', 'vec4', 'vec2', 'vec3', undefined, undefined, undefined,
    ])
  })
})
