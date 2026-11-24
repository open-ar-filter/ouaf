/**
 * The `uniforms` of a shader layer (spec §11): each entry becomes a uniform of the same name, typed from its value
 * (number → `float`, boolean → `bool`, `vec2`, `vec3`, color → `vec4`). Values are bindable (spec §8): the type of a
 * binding comes from its parameter, its `map` values or its data path. Pure (no WebGL): unit tested in Node.
 *
 * A full-screen effect has one value per frame: bindings are evaluated for the first face (or their default when no
 * face is tracked), as for the `color` layer. `update` does not allocate: vectors and colors are written into the
 * typed arrays three.js uploads, floats are assigned only when they change.
 */
import { shaderUniformType, type ShaderUniformType } from '@ouaf/spec'
import { compileBinding, compileNumberBinding } from '../../bindings/compile.ts'
import type { BindingEnv, CompiledBinding, NumberBinding } from '../../bindings/types.ts'
import { writeColor } from '../../params/values.ts'

/** Why a `uniforms` entry has no GLSL type. */
export class UniformTypeError extends Error {
  override name = 'UniformTypeError'
}

/** GLSL type of a `uniforms` value: fixed, `{ param }`, or `{ bind }` (`shaderUniformType` of `@ouaf/spec`). */
export function resolveUniformType(name: string, value: unknown, env: BindingEnv): ShaderUniformType {
  const r = shaderUniformType(name, value, { param: (p) => env.params.type(p), data: (path) => env.data.resolve(path)?.type })
  if ('problem' in r) throw new UniformTypeError(r.problem)
  return r.type
}

/**
 * Holder of a float uniform. Its own class, so V8 keeps `value` as an unboxed double field: storing a new value
 * does not allocate, unlike a `{ value }` literal sharing its hidden class with texture and array uniforms.
 */
export class FloatUniform {
  value = 0.5
}

type Slot =
  | { type: 'float'; binding: NumberBinding; uniform: FloatUniform }
  | { type: 'bool'; binding: CompiledBinding<boolean>; uniform: { value: boolean } }
  | { type: 'vec2' | 'vec3'; binding: CompiledBinding<readonly number[]>; uniform: { value: Float32Array } }
  | { type: 'vec4'; binding: CompiledBinding<string>; uniform: { value: Float32Array }; last: string | undefined }

const FALLBACK: Record<ShaderUniformType, unknown> = { float: 0, bool: false, vec2: [0, 0], vec3: [0, 0, 0], vec4: '#000000' }
const BINDING_TYPE = { bool: 'boolean', vec2: 'vec2', vec3: 'vec3', vec4: 'color' } as const

/** The compiled `uniforms` of a layer: GLSL declarations, three.js uniform objects and the per-frame update. */
export class ShaderUniforms {
  /** Name and GLSL type of each uniform, in declaration order (for `wrapShader`). */
  readonly declarations: ReadonlyArray<readonly [string, ShaderUniformType]>
  /** Uniform objects by name, to merge into the material's uniforms. */
  readonly uniforms: Readonly<Record<string, { value: unknown }>>
  readonly #slots: Slot[] = []
  readonly #scratch = new Float64Array(4)

  /** Throws `UniformTypeError` or `BindingError`. */
  constructor(values: Readonly<Record<string, unknown>> | undefined, env: BindingEnv, path = 'uniforms') {
    const declarations: Array<readonly [string, ShaderUniformType]> = []
    const uniforms: Record<string, { value: unknown }> = {}
    for (const [name, value] of Object.entries(values ?? {})) {
      const type = resolveUniformType(name, value, env)
      const at = `${path}/${name}`
      // Settable by a script as `uniforms.<name>` (`.set({ uniforms: { name: value } })`, spec §12.4).
      const prop = `uniforms.${name}`
      declarations.push([name, type])
      let slot: Slot
      if (type === 'float') {
        slot = { type, binding: compileNumberBinding(value, { fallback: 0, path: at, name: prop }, env), uniform: new FloatUniform() }
      } else if (type === 'bool') {
        slot = { type, binding: compileBinding(value, { type: 'boolean', fallback: false, path: at, name: prop }, env), uniform: { value: false } }
      } else if (type === 'vec4') {
        slot = { type, binding: compileBinding(value, { type: 'color', fallback: '#000000', path: at, name: prop }, env), uniform: { value: new Float32Array(4) }, last: undefined }
      } else {
        const fallback = FALLBACK[type] as readonly [number, number] & readonly [number, number, number]
        slot = { type, binding: compileBinding(value, { type: BINDING_TYPE[type], fallback, path: at, name: prop }, env), uniform: { value: new Float32Array(type === 'vec2' ? 2 : 3) } }
      }
      this.#slots.push(slot)
      uniforms[name] = slot.uniform
    }
    this.declarations = declarations
    this.uniforms = uniforms
  }

  /** Evaluates every uniform for face slot `face` (or `NO_FACE`) and stores it in its uniform object. */
  update(face: number): void {
    const s = this.#scratch
    for (let i = 0; i < this.#slots.length; i++) {
      const slot = this.#slots[i]!
      switch (slot.type) {
        case 'float':
          slot.binding.write(face, s, 0)
          slot.uniform.value = s[0]!
          break
        case 'bool':
          slot.uniform.value = slot.binding.evaluate(face)
          break
        case 'vec2':
        case 'vec3': {
          const v = slot.binding.evaluate(face)
          const out = slot.uniform.value
          for (let k = 0; k < out.length; k++) out[k] = v[k]!
          break
        }
        case 'vec4': {
          const c = slot.binding.evaluate(face)
          if (c !== slot.last) {
            writeColor(c, s, 0)
            slot.uniform.value.set(s)
            slot.last = c
          }
          break
        }
      }
    }
  }
}
