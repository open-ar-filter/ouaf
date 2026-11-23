/**
 * Assets embedded in the package. Always local: no remote URL (that would be an exfiltration channel).
 */
import { Type, type Static } from 'typebox'
import { Name } from './common.ts'

export const AssetPath = Type.String({
  pattern: '^assets/(?!.*\\.\\.)[A-Za-z0-9._/-]+$',
  maxLength: 256,
  description: 'Relative path inside the package, under "assets/", without "..".',
  'x-hint': 'Put the file in the filter\'s assets/ folder, e.g. "assets/hat.glb".',
})

export const AssetKind = Type.Enum(['image', 'spritesheet', 'video', 'model', 'audio', 'lut', 'shader', 'font', 'lottie', 'data'], {
  description: 'Kind of asset (inferred from the file extension when omitted). "lottie" and "data" are reserved: no v1 layer or script API reads them, only plugin layers.',
},
)

export const AssetFile = Type.Object(
  {
    src: AssetPath,
    kind: Type.Optional(AssetKind),
    alpha: Type.Optional(
      Type.Union([Type.Literal('none'), Type.Literal('packed')], {
        description: 'Video: "packed" = color on the left half, alpha mask on the right half.',
      }),
    ),
    frames: Type.Optional(
      Type.Object(
        {
          cols: Type.Integer({ minimum: 1, maximum: 64 }),
          rows: Type.Integer({ minimum: 1, maximum: 64 }),
          count: Type.Optional(Type.Integer({ minimum: 1 })),
          fps: Type.Number({ exclusiveMinimum: 0, maximum: 60 }),
        },
        { additionalProperties: false, description: 'Spritesheet: animated grid of frames.' },
      ),
    ),
  },
  { additionalProperties: false },
)

export const AssetInlineSvg = Type.Object(
  { svg: Type.String({ minLength: 10, maxLength: 100_000, pattern: '^\\s*(<\\?xml[^>]*>\\s*)?<svg[\\s>]' }) },
  {
    additionalProperties: false,
    description: 'SVG written inline in the manifest (rendered as an image: no script, no external resource).',
  },
)

export const AssetEmoji = Type.Object(
  { emoji: Type.String({ minLength: 1, maxLength: 32 }) },
  { additionalProperties: false, description: "Emoji drawn as an image, with the platform's emoji font or the host's reference set." },
)

export const AssetEntry = Type.Union([AssetPath, AssetFile, AssetInlineSvg, AssetEmoji], {
  'x-hint': 'An "assets/…" path, { "src": "assets/…" }, { "svg": "<svg…>" } or { "emoji": "⭐" }.',
})

export const Assets = Type.Record(Name, AssetEntry, { maxProperties: 256, description: 'Asset table: name → file or inline content.' })

export type TAssetEntry = Static<typeof AssetEntry>
export type TAssets = Static<typeof Assets>
export type TAssetKind = Static<typeof AssetKind>

const EXT_KIND: Record<string, TAssetKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', avif: 'image', svg: 'image', ktx2: 'image',
  mp4: 'video', webm: 'video',
  glb: 'model', gltf: 'model',
  ogg: 'audio', mp3: 'audio', wav: 'audio', opus: 'audio',
  cube: 'lut',
  frag: 'shader', glsl: 'shader',
  woff2: 'font', woff: 'font', ttf: 'font', otf: 'font',
  lottie: 'lottie',
  json: 'data',
}

/** Infers the kind of an asset from its entry (extension, inline form). */
export function assetKind(entry: TAssetEntry): TAssetKind | undefined {
  if (typeof entry === 'string') return kindFromPath(entry)
  if ('svg' in entry || 'emoji' in entry) return 'image'
  if (entry.kind) return entry.kind
  if (entry.frames) return 'spritesheet'
  return kindFromPath(entry.src)
}

export function kindFromPath(path: string): TAssetKind | undefined {
  const ext = path.split('.').pop()?.toLowerCase()
  return ext ? EXT_KIND[ext] : undefined
}
