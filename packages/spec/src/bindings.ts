/**
 * Bindings: connect a layer property to a parameter or to tracking data, without a script
 * (evaluated by the engine every frame, outside the sandbox).
 * Deliberately tiny language: param, bind + map, bind + range/to. Anything richer belongs in the script.
 */
import { Type, type Static, type TSchema } from 'typebox'
import { Name } from './common.ts'

export const ParamBinding = Type.Object(
  { param: Name },
  { additionalProperties: false, description: 'Value of the named parameter, e.g. { "param": "color" }.' },
)

export const DataBinding = Type.Object(
  {
    bind: Type.String({
      pattern: '^[a-z][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*$',
      description: 'Data path, e.g. "face.blendshapes.jawOpen", "face.pose.roll", "time".',
    }),
    map: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), { description: 'Lookup table value → result, e.g. { "happy": "😄" }.' }),
    ),
    range: Type.Optional(Type.Tuple([Type.Number(), Type.Number()], { description: 'Input range [min, max] (clamped).' })),
    to: Type.Optional(Type.Tuple([Type.Number(), Type.Number()], { description: 'Output range [min, max] (linear interpolation).' })),
    default: Type.Optional(Type.Unknown({ description: 'Value used when the data is missing (e.g. no face).' })),
  },
  {
    additionalProperties: false,
    description: 'Tracking data, optionally transformed: { "bind": "face.blendshapes.jawOpen", "range": [0, 1], "to": [0.1, 0.6] }.',
  },
)

/** A { param } or a { bind }: the non-fixed values of a bindable property. */
export const Binding = Type.Union([ParamBinding, DataBinding])

/** A "bindable" property accepts a fixed value, a { param } or a { bind }. */
export function Bindable<T extends TSchema>(schema: T) {
  return Type.Union([schema, ...Binding.anyOf], {
    description: (schema as { description?: string }).description,
    'x-bindable': true,
    'x-hint': 'Fixed value, { "param": "name" } or { "bind": "face.…" }.',
  })
}

export type TParamBinding = Static<typeof ParamBinding>
export type TDataBinding = Static<typeof DataBinding>
export type TBinding = Static<typeof Binding>

/** Type of the values of a data path (`DataPathDef.type`, spec §8). */
export type DataValueType = 'number' | 'string' | 'boolean'

/**
 * The data value a `map` key matches for data of `type` (spec §8), or `undefined` when it can never match: a string
 * key matches the same string; for booleans only `"true"` and `"false"`; for numbers only the canonical JSON form of a
 * number (`"1"`, `"-2"`, `"0.5"`), so `"1.0"`, `"01"`, `"1e0"` or `" 1"` never match. Shared by the engine (lookup
 * table) and the validator (keys that can never match).
 */
export function mapKeyValue(key: string, type: DataValueType): string | number | boolean | undefined {
  if (type === 'string') return key
  if (type === 'boolean') return key === 'true' ? true : key === 'false' ? false : undefined
  const n = Number(key)
  return key.trim() !== '' && Number.isFinite(n) && String(n) === key ? n : undefined
}
