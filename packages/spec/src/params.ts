/**
 * Filter parameters: settings exposed to the host / the user.
 * They belong to the outside world: the script reads them, never writes them.
 */
import { Type, type Static, type TProperties } from 'typebox'
import { Color, LocalizedText, Name, Vec2, Vec3 } from './common.ts'

/** Properties shared by every parameter type. */
export const ParamCommon = {
  label: Type.Optional(LocalizedText),
  description: Type.Optional(LocalizedText),
  group: Type.Optional(LocalizedText),
  visibleIf: Type.Optional(
    Type.Record(Name, Type.Union([Type.String(), Type.Number(), Type.Boolean()]), {
      description: 'Shows this parameter only when other parameters have these values, e.g. { "confetti": true }.',
    }),
  ),
  apply: Type.Optional(
    Type.Union([Type.Literal('live'), Type.Literal('reload')], {
      default: 'live',
      description: '"live": applied on the next frame; "reload": preloaded then swapped (e.g. a different model).',
    }),
  ),
  transition: Type.Optional(
    Type.Integer({ minimum: 0, maximum: 10000, description: 'Default transition duration in ms (numbers, colors, vectors).' }),
  ),
}

function paramType<L extends string, T extends TProperties>(type: L, props: T, description: string) {
  return Type.Object({ type: Type.Literal(type), ...ParamCommon, ...props }, { additionalProperties: false, description })
}

export const NumberParam = paramType(
  'number',
  {
    default: Type.Number(),
    min: Type.Optional(Type.Number()),
    max: Type.Optional(Type.Number()),
    step: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  },
  'Number, e.g. { "type": "number", "default": 1, "min": 0.5, "max": 2, "step": 0.1 }.',
)

export const BooleanParam = paramType('boolean', { default: Type.Boolean() }, 'Checkbox.')

export const StringParam = paramType(
  'string',
  { default: Type.String(), maxLength: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) },
  'Short single-line text.',
)

export const TextParam = paramType(
  'text',
  { default: Type.String(), maxLength: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })) },
  'Long multi-line text.',
)

export const ColorParam = paramType('color', { default: Color }, 'Hex color.')

export const SelectParam = paramType(
  'select',
  {
    default: Type.String(),
    options: Type.Union([
      Type.Record(Type.String({ minLength: 1 }), LocalizedText, { minProperties: 1, description: 'Value → label.' }),
      Type.Object({ from: Type.Literal('host') }, { additionalProperties: false, description: 'Options supplied at runtime by the host page.' }),
    ]),
  },
  'Choice list, e.g. { "type": "select", "default": "gold", "options": { "gold": "Gold crown", "flowers": "Flowers" } }.',
)

export const Vec2Param = paramType('vec2', { default: Vec2 }, '2D vector.')
export const Vec3Param = paramType('vec3', { default: Vec3 }, '3D vector (e.g. an offset).')

export const AssetParam = paramType(
  'asset',
  {
    accept: Type.Array(Type.String({ pattern: '^[a-z]+/[a-z0-9.+-]+$' }), {
      minItems: 1,
      description: 'Accepted MIME types, e.g. ["image/png", "image/svg+xml"].',
    }),
    maxSize: Type.Optional(Type.Integer({ minimum: 1, description: 'Maximum size in bytes.' })),
    optional: Type.Optional(Type.Boolean({ default: false })),
  },
  'File supplied by the user or the host (logo, photo…). Treated as an untrusted asset.',
)

/** Parameter types, keyed by their `type` discriminant. */
export const ParamTypes = {
  number: NumberParam,
  boolean: BooleanParam,
  string: StringParam,
  text: TextParam,
  color: ColorParam,
  select: SelectParam,
  vec2: Vec2Param,
  vec3: Vec3Param,
  asset: AssetParam,
} as const

export type ParamTypeName = keyof typeof ParamTypes

export const ParamDef = Type.Union([NumberParam, BooleanParam, StringParam, TextParam, ColorParam, SelectParam, Vec2Param, Vec3Param, AssetParam], {
  'x-discriminator': 'type',
  description: 'Parameter definition; the "type" field determines the other fields.',
})

export const Params = Type.Record(Name, ParamDef, { maxProperties: 64, description: 'Tunable filter parameters.' })

export const Presets = Type.Record(
  Name,
  Type.Record(Name, Type.Unknown(), { description: 'Parameter values.' }),
  { description: 'Named presets, e.g. { "party": { "size": 1.5 } }.' },
)

export type TParamDef = Static<typeof ParamDef>
export type TParams = Static<typeof Params>
export type TPresets = Static<typeof Presets>
