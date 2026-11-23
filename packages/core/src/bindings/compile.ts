/**
 * Bindings evaluator (spec §8). Each bindable value is compiled once, when the filter loads, into a small object
 * evaluated every frame:
 *
 * | Value                                  | Result                                                               |
 * |----------------------------------------|----------------------------------------------------------------------|
 * | fixed value                            | the value                                                            |
 * | `{ param }`                            | the parameter's current value                                        |
 * | `{ bind }`                             | the data value                                                       |
 * | `{ bind, range: [a, b], to: [c, d] }`  | the data value clamped to `[a, b]`, then mapped linearly to `[c, d]` |
 * | `{ bind, map }`                        | `map[value]`                                                         |
 *
 * When the data is missing (no face at that slot, blendshapes dropped, value absent from `map`), a data binding
 * gives its `default`, or else the property's fallback. `default` is the property value itself: it is not passed
 * through `range`/`to` or `map`.
 *
 * Type errors (wrong `default`, `map` value or parameter type for the property, `range` on non-numeric data…) are
 * reported at compile time with a `BindingError`.
 *
 * Numbers travel through typed arrays (`NumberBinding.write`, `DataReader.read`) rather than return values, so that
 * evaluating any number of bindings through shared call sites never makes V8 box a number: numeric bindings do not
 * allocate per frame.
 */
import { mapKeyValue, type ParamTypeName } from '@ouaf/spec'
import type {
  BindableProperty,
  BindingEnv,
  CompiledBinding,
  DataReader,
  NumberArray,
  NumberBinding,
  ParamsReader,
  ValueType,
  ValueTypes,
} from './types.ts'

export class BindingError extends Error {
  /** Location of the value in the manifest, when known. */
  readonly path: string | undefined

  constructor(message: string, path?: string) {
    super(path ? `${path}: ${message}` : message)
    this.name = 'BindingError'
    this.path = path
  }
}

/** Whether a property value is a binding (`{ param }` or `{ bind }`) rather than a fixed value. */
export function isBinding(value: unknown): value is { param: string } | { bind: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value) && ('param' in value || 'bind' in value)
}

/** Parameter types accepted by each property type (spec §8: "types must be compatible"); same table as the validator. */
const PARAM_COMPAT: Readonly<Record<ValueType, readonly ParamTypeName[]>> = {
  number: ['number'],
  boolean: ['boolean'],
  string: ['string', 'text', 'select', 'color'],
  color: ['color'],
  vec2: ['vec2'],
  vec3: ['vec3'],
}

const COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

function isVec(v: unknown, n: number): boolean {
  return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x))
}

function isOfType(v: unknown, type: ValueType): boolean {
  switch (type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'boolean':
      return typeof v === 'boolean'
    case 'string':
      return typeof v === 'string'
    case 'color':
      return typeof v === 'string' && COLOR.test(v)
    case 'vec2':
      return isVec(v, 2)
    case 'vec3':
      return isVec(v, 3)
  }
}

function describe(v: unknown): string {
  return JSON.stringify(v) ?? String(v)
}

/**
 * Compiles a bindable property value: a fixed value, `{ param }` or `{ bind }` (spec §8). The manifest is expected
 * to have passed `validateManifest`; this re-checks what the evaluator relies on and throws a `BindingError`
 * otherwise. For numeric properties, `compileNumberBinding` also gives the allocation-free `write`.
 */
export function compileBinding<K extends ValueType>(
  value: unknown,
  property: BindableProperty<K>,
  env: BindingEnv,
): CompiledBinding<ValueTypes[K]> {
  return compile(value, property, env) as CompiledBinding<ValueTypes[K]>
}

/** Compiles the value of a numeric property (`opacity`, `size`, `strength`…); see `NumberBinding.write`. */
export function compileNumberBinding(
  value: unknown,
  property: Omit<BindableProperty<'number'>, 'type'>,
  env: BindingEnv,
): NumberBinding {
  // With type 'number', every evaluator compile() can return yields a number.
  return compile(value, { ...property, type: 'number' }, env) as NumberBinding
}

/** What every evaluator implements; `write` is only meaningful when the value is a number. */
interface Evaluator extends CompiledBinding<unknown> {
  write(face: number, out: NumberArray, index: number): void
}

type NumberReader = Extract<DataReader, { type: 'number' }>
type OtherReader = Exclude<DataReader, NumberReader>

function compile(value: unknown, property: BindableProperty<ValueType>, env: BindingEnv): Evaluator {
  const evaluator = compileValue(value, property, env)
  if (!env.overrides || property.name === undefined) return evaluator
  const types: readonly ValueType[] = typeof property.type === 'string' ? [property.type] : property.type
  return env.overrides.wrap(property.name, types, evaluator)
}

function compileValue(value: unknown, property: BindableProperty<ValueType>, env: BindingEnv): Evaluator {
  const types: readonly ValueType[] = typeof property.type === 'string' ? [property.type] : property.type
  const path = property.path
  const fits = (v: unknown) => types.some((t) => isOfType(v, t))
  const expected = types.join(' or ')

  if (!isBinding(value)) {
    if (!fits(value)) throw new BindingError(`expected a ${expected}, got ${describe(value)}.`, path)
    return new ConstantBinding(value)
  }

  if ('param' in value) {
    const extra = Object.keys(value).filter((k) => k !== 'param')
    if (extra.length) throw new BindingError(`unexpected ${extra.join(', ')} in a { param } binding.`, path)
    const name: unknown = value.param
    if (typeof name !== 'string') throw new BindingError('"param" must be a parameter name.', path)
    const type = env.params.type(name)
    if (type === undefined) throw new BindingError(`unknown parameter "${name}".`, path)
    if (!types.some((t) => PARAM_COMPAT[t].includes(type))) {
      throw new BindingError(`parameter "${name}" has type "${type}", which does not fit a ${expected}.`, path)
    }
    return new ParamValueBinding(env.params, name, property.fallback)
  }

  const b = value as { bind: unknown; range?: unknown; to?: unknown; map?: unknown; default?: unknown }
  if (typeof b.bind !== 'string') throw new BindingError('"bind" must be a data path.', path)
  const reader = env.data.resolve(b.bind)
  if (!reader) throw new BindingError(`unknown data path "${b.bind}".`, path)

  let missing: unknown = property.fallback
  if ('default' in b) {
    if (!fits(b.default)) throw new BindingError(`"default" must be a ${expected}, got ${describe(b.default)}.`, path)
    missing = b.default
  }

  const hasRange = b.range !== undefined || b.to !== undefined
  if (hasRange && b.map !== undefined) throw new BindingError('"map" cannot be combined with "range"/"to".', path)

  if (hasRange) {
    if (b.range === undefined || b.to === undefined) throw new BindingError('"range" and "to" go together.', path)
    if (!isVec(b.range, 2) || !isVec(b.to, 2)) throw new BindingError('"range" and "to" must be [number, number].', path)
    const [lo, hi] = b.range as [number, number]
    const [c, d] = b.to as [number, number]
    if (lo === hi) throw new BindingError(`"range" must not be empty, got [${lo}, ${hi}].`, path)
    if (reader.type !== 'number') {
      throw new BindingError(`"range" needs numeric data, "${b.bind}" is a ${reader.type}.`, path)
    }
    if (!types.includes('number') || typeof missing !== 'number') {
      throw new BindingError(`"range"/"to" give a number, this property expects a ${expected}.`, path)
    }
    return new RangeBinding(reader, lo, hi, c, d, missing)
  }

  if (b.map !== undefined) {
    if (!b.map || typeof b.map !== 'object' || Array.isArray(b.map)) throw new BindingError('"map" must be an object.', path)
    const table = new Map<unknown, unknown>()
    for (const [key, v] of Object.entries(b.map as Record<string, unknown>)) {
      if (!fits(v)) throw new BindingError(`"map" value for "${key}" must be a ${expected}, got ${describe(v)}.`, path)
      // Numbers: keys written as JSON numbers ("0", "1", "0.5") match by value, without converting the data.
      const k = mapKeyValue(key, reader.type)
      if (k !== undefined) table.set(k, v)
    }
    return reader.type === 'number' ? new NumberMapBinding(reader, table, missing) : new MapBinding(reader, table, missing)
  }

  // Plain { bind }: the data must already have the property's type (numbers may also feed a text).
  if (reader.type === 'number') {
    if (types.includes('number') && typeof missing === 'number') return new NumberDataBinding(reader, missing)
    if (types.includes('string') && typeof missing === 'string') return new NumberTextBinding(reader, missing)
  } else if (types.includes(reader.type)) {
    return new RawDataBinding(reader, missing)
  }
  throw new BindingError(
    `"${b.bind}" is a ${reader.type}, this property expects a ${expected}: add "map" to convert it.`,
    path,
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluators, one class per form. Those that compute a number do it in `write`, straight into the output array;
// the others return values that already exist (constants, parameter values, `map` entries), which costs nothing.

class ConstantBinding implements Evaluator {
  readonly kind = 'constant'
  readonly perFace = false
  readonly #value: unknown

  constructor(value: unknown) {
    this.#value = value
  }

  evaluate(): unknown {
    return this.#value
  }

  write(_face: number, out: NumberArray, index: number): void {
    out[index] = this.#value as number
  }
}

class ParamValueBinding implements Evaluator {
  readonly kind = 'param'
  readonly perFace = false
  readonly #params: ParamsReader
  readonly #name: string
  readonly #fallback: unknown

  constructor(params: ParamsReader, name: string, fallback: unknown) {
    this.#params = params
    this.#name = name
    this.#fallback = fallback
  }

  evaluate(): unknown {
    const v = this.#params.get(this.#name)
    return v === undefined ? this.#fallback : v
  }

  write(_face: number, out: NumberArray, index: number): void {
    out[index] = this.evaluate() as number
  }
}

class NumberDataBinding implements Evaluator {
  readonly kind = 'data'
  readonly perFace: boolean
  readonly #reader: NumberReader
  readonly #missing: number
  readonly #x = new Float64Array(1)

  constructor(reader: NumberReader, missing: number) {
    this.perFace = reader.perFace
    this.#reader = reader
    this.#missing = missing
  }

  evaluate(face: number): number {
    this.write(face, this.#x, 0)
    return this.#x[0]!
  }

  write(face: number, out: NumberArray, index: number): void {
    this.#reader.read(face, this.#x, 0)
    const x = this.#x[0]!
    // Two stores, not `x === x ? x : missing`: merging the raw number with a field can make V8 box it.
    if (x === x) out[index] = x
    else out[index] = this.#missing
  }
}

class RangeBinding implements Evaluator {
  readonly kind = 'data'
  readonly perFace: boolean
  readonly #reader: NumberReader
  /** x, then a, b, min(a, b), max(a, b), c, d, missing: numbers in a typed array are never boxed. */
  readonly #v: Float64Array

  constructor(reader: NumberReader, a: number, b: number, c: number, d: number, missing: number) {
    this.perFace = reader.perFace
    this.#reader = reader
    // A decreasing range ([1, 0]) still maps its first bound to the first bound of `to`.
    this.#v = Float64Array.of(0, a, b, Math.min(a, b), Math.max(a, b), c, d, missing)
  }

  evaluate(face: number): number {
    this.write(face, this.#v, 0)
    return this.#v[0]!
  }

  write(face: number, out: NumberArray, index: number): void {
    const v = this.#v
    this.#reader.read(face, v, 0)
    const x = v[0]!
    if (x !== x) {
      out[index] = v[7]!
      return
    }
    const clamped = Math.min(Math.max(x, v[3]!), v[4]!)
    const t = (clamped - v[1]!) / (v[2]! - v[1]!)
    // Exact at both ends: t = 0 gives c, t = 1 gives d.
    out[index] = v[5]! * (1 - t) + v[6]! * t
  }
}

/** `map` over numeric data. Lookups by integer values (`face.index`, `faces.count`) do not allocate. */
class NumberMapBinding implements Evaluator {
  readonly kind = 'data'
  readonly perFace: boolean
  readonly #reader: NumberReader
  readonly #table: Map<unknown, unknown>
  readonly #missing: unknown
  readonly #x = new Float64Array(1)

  constructor(reader: NumberReader, table: Map<unknown, unknown>, missing: unknown) {
    this.perFace = reader.perFace
    this.#reader = reader
    this.#table = table
    this.#missing = missing
  }

  evaluate(face: number): unknown {
    this.#reader.read(face, this.#x, 0)
    const x = this.#x[0]!
    if (x !== x) return this.#missing
    // An integer key goes to the table as a small integer, which needs no boxing (other numbers are boxed).
    const k = x | 0
    const v = k === x ? this.#table.get(k) : this.#table.get(x)
    return v === undefined ? this.#missing : v
  }

  write(face: number, out: NumberArray, index: number): void {
    out[index] = this.evaluate(face) as number
  }
}

/** `map` over string or boolean data. */
class MapBinding implements Evaluator {
  readonly kind = 'data'
  readonly perFace: boolean
  readonly #reader: OtherReader
  readonly #table: Map<unknown, unknown>
  readonly #missing: unknown

  constructor(reader: OtherReader, table: Map<unknown, unknown>, missing: unknown) {
    this.perFace = reader.perFace
    this.#reader = reader
    this.#table = table
    this.#missing = missing
  }

  evaluate(face: number): unknown {
    const v = this.#table.get(this.#reader.read(face))
    return v === undefined ? this.#missing : v
  }

  write(face: number, out: NumberArray, index: number): void {
    out[index] = this.evaluate(face) as number
  }
}

/** String or boolean data used as it is. */
class RawDataBinding implements Evaluator {
  readonly kind = 'data'
  readonly perFace: boolean
  readonly #reader: OtherReader
  readonly #missing: unknown

  constructor(reader: OtherReader, missing: unknown) {
    this.perFace = reader.perFace
    this.#reader = reader
    this.#missing = missing
  }

  evaluate(face: number): unknown {
    const v = this.#reader.read(face)
    return v === undefined ? this.#missing : v
  }

  write(face: number, out: NumberArray, index: number): void {
    out[index] = this.evaluate(face) as number
  }
}

/** Number shown as text (e.g. `faces.count` in a text layer). Converts only when the number changes. */
class NumberTextBinding implements Evaluator {
  readonly kind = 'data'
  readonly perFace: boolean
  readonly #reader: NumberReader
  readonly #missing: string
  readonly #x = new Float64Array(1)
  #last = NaN
  #text = ''

  constructor(reader: NumberReader, missing: string) {
    this.perFace = reader.perFace
    this.#reader = reader
    this.#missing = missing
  }

  evaluate(face: number): string {
    this.#reader.read(face, this.#x, 0)
    const x = this.#x[0]!
    if (x !== x) return this.#missing
    if (x !== this.#last) {
      this.#last = x
      this.#text = String(x)
    }
    return this.#text
  }

  write(face: number, out: NumberArray, index: number): void {
    out[index] = this.evaluate(face) as unknown as number
  }
}
