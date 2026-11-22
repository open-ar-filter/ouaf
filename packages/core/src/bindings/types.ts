/**
 * Interfaces of the bindings evaluator (spec §8): what a compiled binding exposes, and the two inputs it reads,
 * tracking data and parameters.
 */
import type { ParamTypeName } from '@ouaf/spec'

/** Value types of bindable properties, and the TypeScript type of their values. */
export interface ValueTypes {
  number: number
  boolean: boolean
  string: string
  /** Hex color string (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`). */
  color: string
  vec2: readonly [number, number]
  vec3: readonly [number, number, number]
}

export type ValueType = keyof ValueTypes

/** Face slot meaning "no face": face data reads as missing, so face bindings take their `default`. */
export const NO_FACE = -1

/**
 * A bindable property value, compiled once when the filter loads and evaluated every frame.
 * `evaluate` returns references to existing values (constants, `map` entries, parameter values) and only allocates
 * when a number is shown as text; numeric properties use `NumberBinding.write` for a guaranteed allocation-free path.
 */
export interface CompiledBinding<T> {
  /** `constant`: fixed value; `param`: reads a parameter; `data`: reads tracking data (`{ bind }`). */
  readonly kind: 'constant' | 'param' | 'data'
  /** The value can differ between faces (it reads `face.*` data): evaluate it once per face instance. */
  readonly perFace: boolean
  /**
   * Current value for face slot `face` (index in the `FaceFrame`, 0 ≤ face < count), or `NO_FACE`.
   * Constants and parameters ignore `face`.
   */
  evaluate(face: number): T
}

/** Typed arrays numeric bindings write into. */
export type NumberArray = Float32Array | Float64Array

/**
 * A numeric property value. `evaluate` returns the number, but V8 boxes a fractional number returned through a
 * call it cannot inline (e.g. a loop over the bindings of every layer); `write` stores it into a typed array
 * instead and never allocates.
 */
export interface NumberBinding extends CompiledBinding<number> {
  /** Writes the current value for face slot `face` into `out[index]`. */
  write(face: number, out: NumberArray, index: number): void
}

/** Value of a data path for a face slot. `perFace: false` paths (`time`, `faces.count`) ignore the face. */
export type DataReader =
  | {
      readonly type: 'number'
      readonly perFace: boolean
      /**
       * Writes the current value into `out[index]`, or `NaN` when the data is missing (no face, capability
       * dropped). Numbers go through a typed array so that no call returns a number V8 would have to box.
       */
      read(face: number, out: Float64Array, index: number): void
    }
  | {
      readonly type: 'string'
      readonly perFace: boolean
      /** Current value, or `undefined` when the data is missing. */
      read(face: number): string | undefined
    }
  | {
      readonly type: 'boolean'
      readonly perFace: boolean
      /** Current value, or `undefined` when the data is missing. */
      read(face: number): boolean | undefined
    }

/**
 * Resolves data paths (`{ "bind": "face.pose.yaw" }`). Called once per binding when the filter loads; the reader it
 * returns is called every frame. The core's `FaceBindingData` provides the v1 paths; plugins provide theirs.
 */
export interface BindingDataSource {
  /** Reader for `path`, or `undefined` when this source does not provide it. */
  resolve(path: string): DataReader | undefined
}

/** Parameters as bindings see them (`{ "param": "name" }`); the params runtime implements it. */
export interface ParamsReader {
  /** Declared type of parameter `name`, or `undefined` when the filter declares no such parameter. */
  type(name: string): ParamTypeName | undefined
  /**
   * Current value of parameter `name`, already validated (and possibly animated by a `transition`) by the params
   * runtime. `undefined` when it has no value (e.g. an optional asset): the property then takes its fallback.
   */
  get(name: string): unknown
}

/** Inputs shared by every binding of a filter. */
export interface BindingEnv {
  data: BindingDataSource
  params: ParamsReader
  /**
   * Set for the layers of a filter with a script (spec §12.4): every property compiled with a `name` is wrapped so
   * that the script's `.set()` and `.animate()` values replace it.
   */
  overrides?: PropertyOverrides
}

/** Where a layer's bindable properties register, so that a script can set them (`ScriptOverrides.forLayer`). */
export interface PropertyOverrides {
  /** Wraps the compiled value of property `name` (accepting `types`); the wrapper reports `perFace`. */
  wrap<T extends CompiledBinding<unknown>>(name: string, types: readonly ValueType[], binding: T): T
}

/** The property a value is compiled for. */
export interface BindableProperty<K extends ValueType> {
  /** Accepted value type(s), e.g. `'number'` for `opacity`, `['number', 'vec3']` for `model.scale`. */
  type: K | readonly K[]
  /**
   * Value used when the data is missing and the binding has no `default` (usually the property's default value
   * from the schema).
   */
  fallback: ValueTypes[K]
  /** Location of the value in the manifest, for error messages (e.g. `/layers/1/opacity`). */
  path?: string
  /** Property name as a script sets it (`opacity`, `offset`); needed for the script to set the property. */
  name?: string
}
