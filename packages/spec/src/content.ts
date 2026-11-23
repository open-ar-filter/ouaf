/**
 * Content properties (spec §8, §9): the layer properties that hold an asset (`sticker.src`, `model.src`, `text.font`,
 * `color.lut`) and can be bound to a parameter, the asset kinds each one shows, and the files a host may give for
 * them through an `asset` parameter (spec §15: what the content of an untrusted file must be).
 *
 * Shared by the validator (parameter types, `accept`, `map` values) and the engine (what it preloads, the checks of a
 * host file), so that what validates is what the engine shows.
 */
import { Type, type TSchema, type TUnion } from 'typebox'
import { AssetBinding } from './bindings.ts'
import type { TAssetKind } from './assets.ts'
import type { Format, MediaInfo } from './media.ts'
import type { ParamTypeName } from './params.ts'

/** What a content property shows: an image (sticker), a 3D model, a font, a color LUT. */
export type ContentKind = 'image' | 'model' | 'font' | 'lut'

export interface ContentKindDef {
  /** Asset kinds of the filter's own assets the property shows (spec §10.2). */
  readonly kinds: readonly TAssetKind[]
  /** What a host file must be, in messages: "an image". */
  readonly label: string
  /** The filter's assets it shows, in messages. */
  readonly assets: string
}

export const CONTENT_KINDS: Readonly<Record<ContentKind, ContentKindDef>> = {
  image: { kinds: ['image', 'spritesheet', 'video'], label: 'an image', assets: 'an image, spritesheet or video asset' },
  model: { kinds: ['model'], label: 'a glTF model', assets: 'a model asset' },
  font: { kinds: ['font'], label: 'a font', assets: 'a font asset' },
  lut: { kinds: ['lut'], label: 'a .cube LUT', assets: 'a LUT asset' },
}

/** Parameter types a content property can be bound to: `asset` (a host file), `select` or `string` (with `map`). */
export const CONTENT_PARAM_TYPES: readonly ParamTypeName[] = ['asset', 'select', 'string']

/**
 * Media types an `asset` parameter bound to a content property may accept (its `accept`), with the content kind and
 * the file formats (`sniff`) each one stands for. A host file is checked on its content, not on its declared type:
 * its sniffed format must be one of those of an accepted type (spec §15). `.cube` has no registered type:
 * `text/x-cube` names it.
 */
export const CONTENT_MEDIA_TYPES: Readonly<Record<string, { kind: ContentKind; formats: readonly Format[] }>> = {
  'image/png': { kind: 'image', formats: ['png'] },
  'image/jpeg': { kind: 'image', formats: ['jpeg'] },
  'image/webp': { kind: 'image', formats: ['webp'] },
  'image/avif': { kind: 'image', formats: ['avif'] },
  'image/svg+xml': { kind: 'image', formats: ['svg'] },
  'image/ktx2': { kind: 'image', formats: ['ktx2'] },
  'model/gltf-binary': { kind: 'model', formats: ['glb'] },
  'model/gltf+json': { kind: 'model', formats: ['json'] },
  'font/woff2': { kind: 'font', formats: ['woff2'] },
  'font/woff': { kind: 'font', formats: ['woff'] },
  'font/ttf': { kind: 'font', formats: ['sfnt'] },
  'font/otf': { kind: 'font', formats: ['sfnt'] },
  'text/x-cube': { kind: 'lut', formats: ['text'] },
}

/** The media types `accept` may list for a content property of `kind`. */
export function contentMediaTypes(kind: ContentKind): string[] {
  return Object.entries(CONTENT_MEDIA_TYPES).filter(([, t]) => t.kind === kind).map(([type]) => type)
}

/**
 * Why a host file, whose first bytes `sniff` read as `info`, cannot be shown by a content property of `kind` under an
 * `accept` list (spec §15: the content decides, whatever type the file declares); `undefined` when it can.
 */
export function hostFileProblem(kind: ContentKind, accept: readonly string[], info: MediaInfo | undefined): string | undefined {
  const types = accept.filter((t) => CONTENT_MEDIA_TYPES[t]?.kind === kind)
  if (!info) return `its content is not ${CONTENT_KINDS[kind].label} this parameter accepts (${accept.join(', ')}).`
  if (types.some((t) => CONTENT_MEDIA_TYPES[t]!.formats.includes(info.format))) return undefined
  return `its content is ${FORMAT_LABEL[info.format] ?? info.format}, not ${CONTENT_KINDS[kind].label} this parameter accepts (${accept.join(', ')}).`
}

const FORMAT_LABEL: Partial<Record<Format, string>> = {
  png: 'a PNG image', jpeg: 'a JPEG image', webp: 'a WebP image', avif: 'an AVIF image', svg: 'an SVG image',
  ktx2: 'a KTX2 texture', gif: 'a GIF image', heic: 'a HEIC image', mp4: 'an MP4 video', webm: 'a WebM video',
  glb: 'a GLB model', gltf: 'a glTF model', ogg: 'Ogg audio', mp3: 'MP3 audio', wav: 'WAV audio', woff2: 'a WOFF2 font',
  woff: 'a WOFF font', sfnt: 'a TrueType/OpenType font', ttc: 'a font collection', zip: 'a zip archive',
  json: 'JSON', text: 'text',
}

/**
 * A content property: the asset forms of `schema` (a reference, `{ pick }`…) or an `AssetBinding`. `x-content` tells
 * the validator and the engine what the property shows.
 */
export function Content<T extends TSchema>(schema: T, kind: ContentKind): TUnion<[T, typeof AssetBinding]> {
  const { description, default: fallback, ...rest } = schema as TSchema & { anyOf?: TSchema[]; description?: string; default?: unknown }
  const alternatives = rest.anyOf ?? [rest as TSchema]
  return Type.Union([...alternatives, AssetBinding], {
    description,
    ...(fallback === undefined ? {} : { default: fallback }),
    'x-content': kind,
    'x-hint': 'An asset reference, or { "param": "<asset param>" }, or { "param": "<select param>", "map": { "<value>": "<asset>" } }.',
  }) as unknown as TUnion<[T, typeof AssetBinding]>
}

/** The content properties of a layer type's schema (`x-content`): property name → kind. */
export function contentProperties(schema: TSchema): Array<[string, ContentKind]> {
  const props = ((schema as { properties?: Record<string, TSchema> }).properties ?? {})
  return Object.entries(props).flatMap(([name, s]) => {
    const kind = (s as { 'x-content'?: ContentKind })['x-content']
    return kind ? [[name, kind] as [string, ContentKind]] : []
  })
}

/** Whether a content property value is a parameter binding (`{ param }`, `{ param, map }`) rather than an asset. */
export function isAssetBinding(value: unknown): value is { param: string; map?: Record<string, string> } {
  return !!value && typeof value === 'object' && !Array.isArray(value) && 'param' in value
}
