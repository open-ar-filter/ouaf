/**
 * Shared building blocks of the Ouaf v1 format.
 * These schemas are the single source of truth: TypeScript types (Static<>) and the published JSON Schema.
 */
import { Type, type Static } from 'typebox'

/** Short identifier: filter, layer. */
export const Id = Type.String({
  pattern: '^[a-z0-9][a-z0-9-]{0,63}$',
  description: 'Lowercase letters, digits and dashes (1 to 64 characters), e.g. "text-bubble".',
})

/** Asset or parameter name (camelCase allowed). */
export const Name = Type.String({
  pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$',
  description: 'Starts with a letter; letters, digits, "_" and "-" (64 characters max).',
})

export const SemVer = Type.String({
  pattern: '^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$',
  description: 'Semantic version, e.g. "1.0.0".',
})

export const SemVerRange = Type.String({
  pattern: '^[\\^~]?\\d+(\\.\\d+){0,2}(-[0-9A-Za-z.-]+)?$',
  description: 'Simple version range: "1", "^1.2.0", "~1.4.1".',
})

export const Color = Type.String({
  pattern: '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$',
  description: 'Hex color: #rgb, #rgba, #rrggbb or #rrggbbaa.',
})

export const Vec2 = Type.Tuple([Type.Number(), Type.Number()], { description: '[x, y]' })
export const Vec3 = Type.Tuple([Type.Number(), Type.Number(), Type.Number()], { description: '[x, y, z]' })

/** User-facing text: a plain string or translations keyed by BCP 47 language tag. */
export const LocalizedText = Type.Union(
  [
    Type.String({ minLength: 1, maxLength: 200 }),
    Type.Record(Type.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), Type.String({ minLength: 1, maxLength: 200 }), {
      minProperties: 1,
    }),
  ],
  {
    description: 'Text, or translations: { "en": "Color", "fr": "Couleur" }.',
    'x-hint': 'Use a string, or an object { "en": "…", "fr": "…" }.',
  },
)

/** SPDX license identifier (e.g. "CC0-1.0", "MIT", "CC-BY-4.0") or simple expression. */
export const Spdx = Type.String({
  pattern: '^[A-Za-z0-9.+-]+( (AND|OR|WITH) [A-Za-z0-9.+-]+)*$',
  description: 'SPDX license identifier, e.g. "CC0-1.0", "MIT", "CC-BY-4.0".',
})

/**
 * Asset reference: a name declared in `assets`, an `assets/…` path inside the package,
 * or an engine resource `builtin:…`. Never a remote URL.
 */
export const AssetRef = Type.String({
  pattern: '^(builtin:[a-z0-9][a-z0-9/_-]*|assets/(?!.*\\.\\.)[A-Za-z0-9._/-]+|[A-Za-z][A-Za-z0-9_-]{0,63})$',
  description: 'Asset name declared in "assets", "assets/…" path inside the package, or "builtin:…" resource. Remote URLs are forbidden.',
  'x-ref': 'asset',
  'x-hint': 'Declare the file in "assets" and reference it by name, e.g. "hat". http(s) URLs are forbidden.',
})

/** Pick one asset among several, stable per face or random. */
export const AssetPick = Type.Object(
  {
    pick: Type.Array(AssetRef, { minItems: 1, maxItems: 64 }),
    by: Type.Optional(Type.Union([Type.Literal('face'), Type.Literal('random')], { default: 'face' })),
  },
  { additionalProperties: false, description: 'Picks one asset from the list: stable per face ("face") or on each activation ("random").' },
)

export type TId = Static<typeof Id>
export type TColor = Static<typeof Color>
export type TVec2 = Static<typeof Vec2>
export type TVec3 = Static<typeof Vec3>
export type TLocalizedText = Static<typeof LocalizedText>
export type TAssetRef = Static<typeof AssetRef>
export type TAssetPick = Static<typeof AssetPick>
