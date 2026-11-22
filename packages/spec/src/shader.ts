/**
 * The shader wrapper of spec §11: what the engine adds around the author's `vec4 effect(vec2 uv)` to make a GLSL ES
 * 3.00 fragment shader, and how compiler messages are mapped back to lines of the author's file.
 *
 * Pure string work, shared by the engine (`shader` layer of `@ouaf/core`) and tools (`ouaf validate`), so a shader
 * is compiled with exactly the same inputs everywhere.
 *
 * The wrapped fragment shader is, in order: precision statements, `OUAF_MAX_FACES`, the engine inputs (`ouaf_*`,
 * spec §11.1), one uniform per `uniforms` entry and one `sampler2D` per `textures` entry, a `#line 1` directive, the
 * author's source, then the engine's `main()`. Thanks to `#line`, every compiler reports lines of the author's file
 * directly; a message on a later line comes from `main()` (e.g. no `effect()`).
 *
 * `main()` calls `effect(uv)` and mixes its color over the image at this stage (`ouaf_sample(uv)`) by its alpha
 * times the layer's `opacity` (and, on the `face` stage, the soft edge of the face mesh). The result is opaque.
 */

/** GLSL types of the manifest's `uniforms` values (spec §11). */
export type ShaderUniformType = 'float' | 'bool' | 'vec2' | 'vec3' | 'vec4'

export type ShaderStage = 'background' | 'face' | 'post'

export interface ShaderWrapOptions {
  stage: ShaderStage
  /** The engine's maximum number of faces (`OUAF_MAX_FACES`, spec §5.4). */
  maxFaces: number
  /** Declared uniforms and their GLSL types, in declaration order. */
  uniforms?: ReadonlyArray<readonly [name: string, type: ShaderUniformType]>
  /** Declared textures (`sampler2D`). */
  textures?: readonly string[]
  /** Declared face anchors (`ouaf_anchor_<name>[OUAF_MAX_FACES]`). */
  anchors?: readonly string[]
}

/** What the author's source uses among the inputs that cost resources (spec §11.1: only allocate what is used). */
export interface ShaderUses {
  /** Calls `ouaf_prevFrame`: the engine keeps this shader's previous output (an extra image buffer). */
  prevFrame: boolean
  /** Calls `ouaf_faceMask`: the engine draws the face mask into a texture. */
  faceMask: boolean
}

export interface WrappedShader extends ShaderUses {
  /** The fragment shader, without the `#version 300 es` line (the first line of the program, added by the caller). */
  readonly fragment: string
  /** Number of lines of the author's source: a message on a later line comes from the wrapper's `main()`. */
  readonly authorLines: number
}

/**
 * Names of the engine's internal uniforms, varyings and outputs (all `ouaf_`-prefixed, so they cannot clash with the
 * author's names). The engine sets them; the author uses the documented inputs instead.
 */
export const SHADER_INTERNALS = {
  /** `sampler2D`: the image at this stage. */
  input: 'ouaf_input',
  /** `vec4`: time (s), dt (s), render width, height (px). */
  frame: 'ouaf_frame',
  /** `float`: the layer's opacity. */
  opacity: 'ouaf_opacity',
  /** `sampler2D`: this shader's previous output. */
  prev: 'ouaf_prev',
  /** `sampler2D`: the face mask (red channel). */
  mask: 'ouaf_mask',
  /** Varyings of the engine's vertex shaders: uv (0–1, origin bottom left) and, on the face stage, the mesh mask. */
  uv: 'ouaf_vUv',
  meshMask: 'ouaf_vMask',
} as const

/** GLSL ES 3.00 keywords, reserved words and built-in type names an identifier cannot take (spec §3.6 of GLSL ES). */
const GLSL_RESERVED = new Set(
  (
    'attribute const uniform varying layout centroid flat smooth break continue do for while switch case default if ' +
    'else in out inout float int void bool true false invariant discard return mat2 mat3 mat4 mat2x2 mat2x3 mat2x4 ' +
    'mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 vec2 vec3 vec4 ivec2 ivec3 ivec4 bvec2 bvec3 bvec4 uint uvec2 uvec3 ' +
    'uvec4 lowp mediump highp precision sampler2D sampler3D samplerCube sampler2DShadow samplerCubeShadow ' +
    'sampler2DArray sampler2DArrayShadow isampler2D isampler3D isamplerCube isampler2DArray usampler2D usampler3D ' +
    'usamplerCube usampler2DArray struct attribute varying coherent volatile restrict readonly writeonly resource ' +
    'atomic_uint noperspective patch sample subroutine common partition active asm class union enum typedef template ' +
    'this goto inline noinline public static extern external interface long short double half fixed unsigned superp ' +
    'input output hvec2 hvec3 hvec4 dvec2 dvec3 dvec4 fvec2 fvec3 fvec4 sampler3DRect filter image1D image2D image3D ' +
    'imageCube iimage1D iimage2D iimage3D iimageCube uimage1D uimage2D uimage3D uimageCube image1DArray image2DArray ' +
    'iimage1DArray iimage2DArray uimage1DArray uimage2DArray imageBuffer iimageBuffer uimageBuffer sampler1D ' +
    'sampler1DShadow sampler1DArray sampler1DArrayShadow isampler1D isampler1DArray usampler1D usampler1DArray ' +
    'sampler2DRect sampler2DRectShadow isampler2DRect usampler2DRect samplerBuffer isamplerBuffer usamplerBuffer ' +
    'sampler2DMS isampler2DMS usampler2DMS sampler2DMSArray isampler2DMSArray usampler2DMSArray sizeof cast namespace ' +
    'using texture main effect'
  ).split(' '),
)

/**
 * Why `name` cannot be the GLSL name of a declared uniform or texture, or `undefined` when it can: a GLSL
 * identifier, not a keyword or built-in name, not reserved for the engine (`ouaf_`, `OUAF_`, spec §11) or GLSL
 * (`gl_`, `__`).
 */
export function shaderNameProblem(name: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'is not a GLSL identifier (letters, digits and "_" only)'
  if (/^(ouaf_|OUAF_)/.test(name)) return 'starts with "ouaf_" / "OUAF_", which is reserved for the engine'
  if (name.startsWith('gl_') || name.includes('__')) return 'is reserved by GLSL ("gl_" prefix or "__")'
  if (GLSL_RESERVED.has(name)) return 'is a GLSL keyword or built-in name'
  return undefined
}

/** Replaces comments with spaces, keeping line and column numbers. */
export function stripGlslComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, ' '))
}

/** What the source uses among the costly inputs (comments ignored). */
export function shaderUses(src: string): ShaderUses {
  const code = stripGlslComments(src)
  return { prevFrame: /\bouaf_prevFrame\b/.test(code), faceMask: /\bouaf_faceMask\b/.test(code) }
}

/** A problem found in a shader source without compiling it. */
export interface ShaderSourceIssue {
  code: 'shader-version' | 'shader-main' | 'shader-no-effect'
  /** Line in the author's file (1-based), when it points at one. */
  line?: number
  message: string
  hint: string
}

/** Static checks of spec §11: no `#version`, no `main()`, a `vec4 effect(vec2 uv)` function. */
export function checkShaderSource(src: string): ShaderSourceIssue[] {
  const issues: ShaderSourceIssue[] = []
  const code = stripGlslComments(src)
  const lineOf = (index: number) => code.slice(0, index).split('\n').length
  const version = /^[ \t]*#[ \t]*version\b/m.exec(code)
  if (version) {
    issues.push({
      code: 'shader-version',
      line: lineOf(version.index),
      message: 'Shaders must not contain a #version directive: the engine adds it (spec §11).',
      hint: 'Remove the #version line.',
    })
  }
  const main = /\bvoid\s+main\s*\(/.exec(code)
  if (main) {
    issues.push({
      code: 'shader-main',
      line: lineOf(main.index),
      message: 'Shaders must not define main(): the engine provides it and calls effect() (spec §11).',
      hint: 'Move the body of main() into vec4 effect(vec2 uv) and return the color instead of writing an output.',
    })
  }
  if (!/\bvec4\s+effect\s*\(\s*(in\s+)?(highp\s+|mediump\s+|lowp\s+)?vec2\s+\w+\s*\)\s*\{/.test(code)) {
    issues.push({
      code: 'shader-no-effect',
      message: 'The shader does not define vec4 effect(vec2 uv).',
      hint: 'Define it, e.g. vec4 effect(vec2 uv) { return ouaf_sample(uv); } (spec §11).',
    })
  }
  return issues
}

/** Thrown by `wrapShader` for declarations that cannot become GLSL (the validator reports them first). */
export class ShaderDeclarationError extends Error {
  override name = 'ShaderDeclarationError'
}

/** Wraps the author's source into a complete fragment shader (see the module comment). */
export function wrapShader(src: string, options: ShaderWrapOptions): WrappedShader {
  const maxFaces = Math.trunc(options.maxFaces)
  if (!(maxFaces >= 1)) throw new RangeError(`maxFaces must be at least 1, got ${options.maxFaces}`)
  const uses = shaderUses(src)
  const I = SHADER_INTERNALS
  const seen = new Set<string>()
  const declare = (what: string, name: string) => {
    const problem = shaderNameProblem(name)
    if (problem) throw new ShaderDeclarationError(`${what} "${name}" ${problem}.`)
    if (seen.has(name)) throw new ShaderDeclarationError(`"${name}" is declared both as a uniform and as a texture.`)
    seen.add(name)
  }
  const lines: string[] = [
    'precision highp float;',
    'precision highp int;',
    `#define OUAF_MAX_FACES ${maxFaces}`,
    `uniform sampler2D ${I.input};`,
    `uniform vec4 ${I.frame};`,
    `uniform float ${I.opacity};`,
    `#define ouaf_time (${I.frame}.x)`,
    `#define ouaf_dt (${I.frame}.y)`,
    `#define ouaf_resolution (${I.frame}.zw)`,
    'uniform int ouaf_faceCount;',
    'uniform float ouaf_faceSize[OUAF_MAX_FACES];',
  ]
  for (const anchor of options.anchors ?? []) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(anchor)) throw new ShaderDeclarationError(`Anchor "${anchor}" cannot be named in GLSL.`)
    lines.push(`uniform vec2 ouaf_anchor_${anchor}[OUAF_MAX_FACES];`)
  }
  lines.push(`in vec2 ${I.uv};`)
  if (options.stage === 'face') lines.push(`in float ${I.meshMask};`)
  lines.push('out vec4 ouaf_fragColor;')
  lines.push(`vec4 ouaf_sample(vec2 uv) { return texture(${I.input}, uv); }`)
  if (uses.faceMask) {
    lines.push(`uniform sampler2D ${I.mask};`, `float ouaf_faceMask(vec2 uv) { return texture(${I.mask}, uv).r; }`)
  }
  if (uses.prevFrame) {
    lines.push(`uniform sampler2D ${I.prev};`, `vec4 ouaf_prevFrame(vec2 uv) { return texture(${I.prev}, uv); }`)
  }
  for (const [name, type] of options.uniforms ?? []) {
    declare('Uniform', name)
    lines.push(`uniform ${type} ${name};`)
  }
  for (const name of options.textures ?? []) {
    declare('Texture', name)
    lines.push(`uniform sampler2D ${name};`)
  }
  const body = src.endsWith('\n') ? src : `${src}\n`
  const authorLines = body.split('\n').length - 1
  const main = [
    'void main() {',
    `  vec4 ouaf_c = effect(${I.uv});`,
    `  float ouaf_a = clamp(ouaf_c.a, 0.0, 1.0) * ${I.opacity};`,
    ...(options.stage === 'face' ? [`  ouaf_a *= smoothstep(0.0, 1.0, ${I.meshMask});`] : []),
    `  ouaf_fragColor = vec4(mix(ouaf_sample(${I.uv}).rgb, ouaf_c.rgb, ouaf_a), 1.0);`,
    '}',
  ]
  return { fragment: `${lines.join('\n')}\n#line 1\n${body}${main.join('\n')}\n`, authorLines, ...uses }
}

/** A compiler message, with its line in the author's file. */
export interface ShaderDiagnostic {
  severity: 'error' | 'warning'
  /** Line in the author's file (1-based); absent when the message has none or comes from the wrapper. */
  line?: number
  message: string
}

/**
 * Parses a GLSL compiler info log (`ERROR: 0:12: 'x' : undeclared identifier`, the format of ANGLE and of most
 * drivers) into diagnostics with lines of the author's file. Messages on lines after the author's source come from
 * the wrapper's `main()`: they lose their line (`effect` missing or with a wrong signature).
 */
export function parseShaderLog(log: string, wrapped: Pick<WrappedShader, 'authorLines'>): ShaderDiagnostic[] {
  const out: ShaderDiagnostic[] = []
  for (const raw of log.split('\n')) {
    const text = raw.replace(/\0/g, '').trim()
    if (!text) continue
    const m = /^(ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/i.exec(text)
    if (!m) {
      out.push({ severity: /^warning/i.test(text) ? 'warning' : 'error', message: text })
      continue
    }
    const severity = m[1]!.toUpperCase() === 'WARNING' ? 'warning' : 'error'
    const line = Number(m[2])
    const message = m[3]!.trim()
    if (line >= 1 && line <= wrapped.authorLines) out.push({ severity, line, message })
    else out.push({ severity, message: `${message} (in the engine's main(), which calls vec4 effect(vec2 uv))` })
  }
  return out
}

/** GLSL type of a fixed `uniforms` value (spec §11), `undefined` for anything else. */
export function uniformTypeOf(value: unknown): ShaderUniformType | undefined {
  if (typeof value === 'number') return 'float'
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'string') return /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) ? 'vec4' : undefined
  if (Array.isArray(value) && value.every((v) => typeof v === 'number')) return value.length === 2 ? 'vec2' : value.length === 3 ? 'vec3' : undefined
  return undefined
}

/** GLSL type of a parameter type bound to a uniform (`{ "param": … }`), `undefined` when it cannot be one. */
export function uniformTypeOfParam(type: string): ShaderUniformType | undefined {
  switch (type) {
    case 'number':
      return 'float'
    case 'boolean':
      return 'bool'
    case 'color':
      return 'vec4'
    case 'vec2':
    case 'vec3':
      return type
    default:
      return undefined
  }
}
