/**
 * Filter manifest (`manifest.json` at the root of a .ouaf package).
 * It is extracted from `filter.js` by `ouaf pack`; the engine reads it without running any code.
 */
import { Type, type Static, type TSchema } from 'typebox'
import { AssetPath, Assets } from './assets.ts'
import { Id, LocalizedText, SemVer, SemVerRange, Spdx } from './common.ts'
import { Params, Presets } from './params.ts'
import type { SpecRegistry } from './registry.ts'

/** Major version of the format, stored in the manifest's `ouaf` field. */
export const FORMAT_VERSION = '1'

export const Requires = Type.Object(
  {
    face: Type.Optional(Type.Boolean({ description: 'Face tracking (478 landmarks, pose, and blendshapes when used).' })),
    blendshapes: Type.Optional(
      Type.Boolean({
        description: 'The filter does not work without blendshapes: the engine never drops them and hides the filter rather than degrading it (spec 16.2). Requires "face".',
      }),
    ),
    hands: Type.Optional(Type.Boolean({ description: 'Hand tracking (reserved, phase 2).' })),
    segmentation: Type.Optional(Type.Boolean({ description: 'Person / background mask (reserved, phase 2).' })),
    pose: Type.Optional(Type.Boolean({ description: 'Body pose (reserved, pose plugin).' })),
    audio: Type.Optional(Type.Boolean({ description: 'Microphone and audio analysis (reserved, phase 3).' })),
    plugins: Type.Optional(
      Type.Array(Type.String({ pattern: '^[a-z0-9][a-z0-9-]*(@[\\^~]?\\d+(\\.\\d+){0,2})?$', description: 'Required plugin, e.g. "mood@^1".' }), {
        maxItems: 16,
        uniqueItems: true,
      }),
    ),
  },
  { additionalProperties: false, description: 'Required capabilities: the engine only loads these trackers.' },
)

export const Credit = Type.Object(
  {
    what: Type.String({ minLength: 1, maxLength: 200, description: 'Credited item, e.g. "assets/hat.glb" or "Pirata font".' }),
    author: Type.String({ minLength: 1, maxLength: 200 }),
    license: Spdx,
    source: Type.Optional(Type.String({ maxLength: 500, description: 'Origin (informational only, never loaded).' })),
  },
  { additionalProperties: false },
)

export const EventOptions = Type.Record(
  Type.String(),
  Type.Object(
    {
      threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: 'Trigger threshold (0–1).' })),
      minDurationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 5000, description: 'Minimum duration before triggering.' })),
    },
    { additionalProperties: false },
  ),
  { description: 'Tuning of derived events, e.g. { "mouthOpen": { "threshold": 0.5 } }.' },
)

export const ScriptInfo = Type.Object(
  {
    entry: Type.Literal('script.js'),
    setup: Type.Optional(Type.Boolean({ description: 'The script defines setup(f).' })),
    update: Type.Optional(Type.Boolean({ description: 'The script defines update(f, frame).' })),
    on: Type.Optional(Type.Array(Type.String(), { uniqueItems: true, description: 'Events listened to.' })),
    draw: Type.Optional(Type.Array(Id, { uniqueItems: true, description: 'Canvas layers drawn by the script.' })),
    uses: Type.Optional(
      Type.Array(Type.String({ 'x-registry': 'scriptData' }), {
        uniqueItems: true,
        description: 'Data sent to the script (minimization). Default: face.pose and face.blendshapes.',
      }),
    ),
  },
  { additionalProperties: false, description: 'Filled in by ouaf pack: what script.js contains.' },
)

/** Manifest envelope; layers are validated per type through the registry. */
function manifestSchema(layerItem: TSchema) {
  return Type.Object(
    {
      $schema: Type.Optional(Type.String()),
      ouaf: Type.Literal(FORMAT_VERSION, { description: 'Major version of the Ouaf format.' }),
      engine: Type.Optional({ ...SemVerRange, default: '^1', description: 'Compatible engine versions.' }),
      id: Id,
      name: LocalizedText,
      version: SemVer,
      description: Type.Optional(LocalizedText),
      author: Type.Optional(Type.String({ maxLength: 200 })),
      license: Spdx,
      credits: Type.Optional(Type.Array(Credit, { maxItems: 256 })),
      thumbnail: Type.Optional(AssetPath),
      tags: Type.Optional(Type.Array(Type.String({ pattern: '^[a-z0-9-]{1,32}$' }), { maxItems: 16, uniqueItems: true })),
      requires: Requires,
      params: Type.Optional(Params),
      presets: Type.Optional(Presets),
      assets: Type.Optional(Assets),
      layers: Type.Array(layerItem, { maxItems: 64, description: 'Layers, in order (within each render stage).' }),
      events: Type.Optional(EventOptions),
      script: Type.Optional(ScriptInfo),
    },
    { additionalProperties: false, $id: 'urn:ouaf:schema:manifest:1', title: 'Ouaf v1 filter manifest (Open Universal AR Filter)' },
  )
}

/** Envelope used by the validator: the exact shape of layers is checked afterwards, type by type. */
export const ManifestEnvelope = manifestSchema(
  Type.Object({ type: Type.String({ description: 'Layer type, e.g. "text".' }) }, { additionalProperties: true }),
)

/** Full schema (layers included) for a given registry: this is what gets published. */
export function buildManifestSchema(reg: SpecRegistry) {
  const layers = [...reg.layers.values()].map((l) => l.schema)
  return manifestSchema(Type.Union(layers, { 'x-discriminator': 'type' }))
}

export type TRequires = Static<typeof Requires>
export type TScriptInfo = Static<typeof ScriptInfo>
export type TManifest = Omit<Static<typeof ManifestEnvelope>, 'layers'> & {
  layers: Array<{ type: string; id?: string; [k: string]: unknown }>
}
