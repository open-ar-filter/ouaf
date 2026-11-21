/**
 * Built-in v1 layer types. Every layer type is provided by a plugin (here, the built-in plugins);
 * third-party plugins register their own types in the registry (see registry.ts).
 */
import { Type, type Static, type TObject, type TProperties } from 'typebox'
import { AssetPick, AssetRef, Color, Id, Name, Vec2, Vec3 } from './common.ts'
import { Bindable } from './bindings.ts'

/** Render stages, in order. Within a stage, order follows the filter stack, then the layer order. */
export const STAGES = ['background', 'video', 'face', 'warp', 'objects', 'color', 'overlay'] as const
export type Stage = (typeof STAGES)[number]

/** Anchor reference; checked against the registry (plugins can add anchors). */
export const AnchorName = Type.String({
  pattern: '^[a-z][A-Za-z0-9]*(:[a-z][A-Za-z0-9]*)?$',
  'x-registry': 'anchors',
  description: 'Anchor, e.g. "forehead", "leftEye", "noseTip", "screen".',
})

export const FacesSelector = Type.Union(
  [Type.Literal('all'), Type.Literal('first'), Type.Literal('largest'), Type.Integer({ minimum: 1, maximum: 16 })],
  { default: 'all', description: 'Faces affected: "all" (one instance per face), "first", "largest", or a maximum count.' },
)

/** Properties shared by every layer type (a plugin layer type can spread them too). */
export const LayerBase = {
  id: Type.Optional(Id),
  visible: Type.Optional(Bindable(Type.Boolean({ description: 'Visibility.' }))),
  opacity: Type.Optional(Bindable(Type.Number({ minimum: 0, maximum: 1, description: 'Opacity from 0 to 1.' }))),
}

/** Properties of the layer types attached to an anchor. */
export const Anchored = {
  anchor: Type.Optional({ ...AnchorName, default: 'head' }),
  offset: Type.Optional(
    Bindable({ ...Vec3, description: 'Offset [x, y, z] in the anchor frame (1 unit = distance between the eye centers).' }),
  ),
  rotation: Type.Optional(Bindable({ ...Vec3, description: 'Rotation [x, y, z] in degrees, in the anchor frame.' })),
  scale: Type.Optional(
    Bindable(Type.Union([Type.Number({ exclusiveMinimum: 0 }), Vec3], { default: 1, description: 'Size multiplier, a number or [x, y, z].' })),
  ),
  orient: Type.Optional(
    Type.Union([Type.Literal('face'), Type.Literal('screen')], {
      default: 'face',
      description: '"face": follows the head rotation; "screen": stays facing the screen (readable text).',
    }),
  ),
  follow: Type.Optional(
    Type.Union([Type.Literal('auto'), Type.Literal('rigid'), Type.Literal('expression')], {
      default: 'auto',
      description:
        'What the anchor position follows: "rigid": the head pose only (stable, ignores expressions); "expression": the live landmarks (moves with the mouth, brows…); "auto": the anchor default (expression for mouth, upperLip, lowerLip, chin; rigid otherwise). Rotation always follows the head. No effect on "screen".',
    }),
  ),
  faces: Type.Optional(FacesSelector),
  overlay: Type.Optional(
    Type.Boolean({ default: false, description: 'Drawn after color grading, on top of everything (UI, score).' }),
  ),
  excludeFromCapture: Type.Optional(
    Type.Boolean({ default: false, description: 'Left out of photos/videos and the output stream (overlay only).' }),
  ),
}

const Blend = Type.Enum(['normal', 'add', 'multiply', 'screen'], { default: 'normal' })

function layerType<L extends string, T extends TProperties>(type: L, props: T, description: string) {
  return Type.Object({ type: Type.Literal(type), ...LayerBase, ...props }, { additionalProperties: false, description })
}

export const TextLayer = layerType(
  'text',
  {
    ...Anchored,
    text: Bindable(Type.String({ maxLength: 500, description: 'Displayed text (emoji included).' })),
    size: Type.Optional(Bindable(Type.Number({ exclusiveMinimum: 0, default: 0.3, description: 'Line height, in anchor units.' }))),
    font: Type.Optional({ ...AssetRef, default: 'builtin:font/sans-bold', description: 'Font: WOFF2 asset or "builtin:font/…".' }),
    color: Type.Optional(Bindable({ ...Color, default: '#ffffff' })),
    outline: Type.Optional(
      Type.Object(
        { width: Type.Number({ minimum: 0, maximum: 0.5, description: 'Thickness relative to the text size.' }), color: Color },
        { additionalProperties: false },
      ),
    ),
    shadow: Type.Optional(
      Type.Object(
        { color: Color, blur: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), offset: Type.Optional(Vec2) },
        { additionalProperties: false },
      ),
    ),
    align: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('center'), Type.Literal('right')], { default: 'center' })),
    maxWidth: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: 'Maximum width before wrapping (anchor units).' })),
    lineHeight: Type.Optional(Type.Number({ minimum: 0.5, maximum: 3, default: 1.2 })),
  },
  'Text attached to an anchor. Rasterized once into a texture, redrawn only when it changes.',
)

export const StickerLayer = layerType(
  'sticker',
  {
    ...Anchored,
    src: Type.Union([AssetRef, AssetPick], { description: 'Image, spritesheet or video.' }),
    size: Type.Optional(Bindable(Type.Number({ exclusiveMinimum: 0, default: 1, description: 'Height in anchor units (width follows the aspect ratio).' }))),
    blend: Type.Optional(Blend),
    loop: Type.Optional(Type.Boolean({ default: true, description: 'Video / spritesheet: loop playback.' })),
    autoplay: Type.Optional(Type.Boolean({ default: true })),
    rate: Type.Optional(Bindable(Type.Number({ minimum: 0, maximum: 4, default: 1, description: 'Playback rate.' }))),
  },
  '2D image or animation attached to an anchor.',
)

export const Shape = Type.Object(
  {
    shape: Type.Enum(['box', 'sphere', 'torus', 'ring', 'cone', 'cylinder', 'plane'], {
      description: 'Procedural 3D primitive (size 1 unit, adjusted with scale).',
    }),
    color: Type.Optional({ ...Color, default: '#ffffff' }),
    metalness: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0 })),
    roughness: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.5 })),
    emissive: Type.Optional(Color),
    thickness: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1, default: 0.2, description: 'Relative thickness (torus, ring, cylinder).' })),
  },
  { additionalProperties: false, description: 'Shape generated without a file, e.g. { "shape": "torus", "color": "#ff00cc" }.' },
)

export const ModelLayer = layerType(
  'model',
  {
    ...Anchored,
    src: Type.Union([AssetRef, AssetPick, Shape], { description: 'glTF/GLB model, random pick, or procedural primitive.' }),
    fit: Type.Optional(
      Type.Object(
        { width: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), height: Type.Optional(Type.Number({ exclusiveMinimum: 0 })) },
        { additionalProperties: false, description: 'Rescales the model so its bounding box has this width/height (anchor units).' },
      ),
    ),
    animation: Type.Optional(Type.String({ description: 'glTF animation started on activation.' })),
    loop: Type.Optional(Type.Boolean({ default: true })),
    occlusion: Type.Optional(
      Type.Union([Type.Literal('none'), Type.Literal('head')], {
        default: 'none',
        description: '"head": the part of the model hidden by the head is masked (hat, glasses temples).',
      }),
    ),
  },
  '3D object attached to an anchor.',
)

export const WarpLayer = layerType(
  'warp',
  {
    kind: Type.Enum(['bulge', 'pinch', 'swirl', 'stretch'], { description: 'Kind of deformation.' }),
    anchor: Type.Union([AnchorName, Type.Array(AnchorName, { minItems: 1, maxItems: 8 })], { description: 'Center(s) of the deformation.' }),
    radius: Type.Optional(Bindable(Type.Number({ exclusiveMinimum: 0, maximum: 5, default: 0.5, description: 'Radius in face units.' }))),
    strength: Type.Optional(Bindable(Type.Number({ minimum: -1, maximum: 1, default: 0.3, description: 'Strength from -1 to 1.' }))),
    direction: Type.Optional(Bindable({ ...Vec2, description: 'Direction (stretch), in the anchor frame.' })),
    faces: Type.Optional(FacesSelector),
  },
  'Image deformation around anchors (big eyes, stretched face…). Also deforms face textures.',
)

const Amount = (description: string, min = -1, max = 1) => Type.Optional(Bindable(Type.Number({ minimum: min, maximum: max, default: 0, description })))

export const ColorLayer = layerType(
  'color',
  {
    lut: Type.Optional({ ...AssetRef, description: '.cube color lookup table (or "builtin:lut/…").' }),
    intensity: Type.Optional(Bindable(Type.Number({ minimum: 0, maximum: 1, default: 1, description: 'Mix with the original image.' }))),
    brightness: Amount('Brightness.'),
    contrast: Amount('Contrast.'),
    saturation: Amount('Saturation (-1 = black and white).'),
    temperature: Amount('Temperature (-1 cool, +1 warm).'),
    tint: Type.Optional(Bindable(Color)),
    vignette: Amount('Vignette.', 0, 1),
    grain: Amount('Film grain.', 0, 1),
    region: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('face')], { default: 'all' })),
  },
  'Color grading. Several color layers are chained in stack order.',
)

const UniformValue = Type.Union([Type.Number(), Type.Boolean(), Vec2, Vec3, Color])

export const ShaderLayer = layerType(
  'shader',
  {
    src: { ...AssetRef, description: 'GLSL ES 3.0 .frag file defining vec4 effect(vec2 uv).' },
    stage: Type.Optional(
      Type.Union([Type.Literal('background'), Type.Literal('face'), Type.Literal('post')], {
        default: 'post',
        description: 'Where the effect applies: background, face only, or full screen.',
      }),
    ),
    uniforms: Type.Optional(Type.Record(Name, Bindable(UniformValue), { maxProperties: 32, description: 'Declared uniforms, available by name in the shader.' })),
    textures: Type.Optional(Type.Record(Name, AssetRef, { maxProperties: 4, description: 'Extra textures (sampler2D of the same name).' })),
    anchors: Type.Optional(
      Type.Array(AnchorName, { minItems: 1, maxItems: 16, uniqueItems: true, description: 'Face anchors given to the shader as ouaf_anchor_<name>[OUAF_MAX_FACES].' }),
    ),
  },
  'Custom effect written in GLSL (fragment only).',
)

export const CanvasLayer = layerType(
  'canvas',
  {
    ...Anchored,
    width: Type.Integer({ minimum: 16, maximum: 2048, description: 'Canvas width in pixels.' }),
    height: Type.Integer({ minimum: 16, maximum: 2048, description: 'Canvas height in pixels.' }),
    size: Type.Optional(Bindable(Type.Number({ exclusiveMinimum: 0, default: 1, description: 'Displayed height in anchor units.' }))),
    fps: Type.Optional(Type.Number({ minimum: 0, maximum: 60, default: 30, description: 'Maximum redraws per second; 0 = only on invalidate().' })),
  },
  'Free-form Canvas 2D drawing by the script (draw.<id> function). Requires an id.',
)

/** Definition of a layer type in the registry. */
export interface LayerTypeDef {
  type: string
  schema: TObject
  /** Render stage (or computed from the layer, e.g. shader.stage). */
  stage: Stage | ((layer: Record<string, unknown>) => Stage)
  /** Owning plugin; "core" for built-ins. */
  plugin: string
  /** Spec version that introduced it. */
  since: string
  /** Attached to an anchor (accepts anchor/offset/…). */
  anchored: boolean
  /** Requires an id (e.g. canvas, referenced by draw.<id>). */
  requiresId?: boolean
}

export const BUILTIN_LAYERS: LayerTypeDef[] = [
  { type: 'text', schema: TextLayer, stage: (l) => (l.overlay ? 'overlay' : 'objects'), plugin: 'core', since: '1.0', anchored: true },
  { type: 'sticker', schema: StickerLayer, stage: (l) => (l.overlay ? 'overlay' : 'objects'), plugin: 'core', since: '1.0', anchored: true },
  { type: 'model', schema: ModelLayer, stage: 'objects', plugin: 'core', since: '1.0', anchored: true },
  { type: 'warp', schema: WarpLayer, stage: 'warp', plugin: 'core', since: '1.0', anchored: false },
  { type: 'color', schema: ColorLayer, stage: 'color', plugin: 'core', since: '1.0', anchored: false },
  {
    type: 'shader',
    schema: ShaderLayer,
    stage: (l) => (l.stage === 'background' ? 'background' : l.stage === 'face' ? 'face' : 'color'),
    plugin: 'core',
    since: '1.0',
    anchored: false,
  },
  { type: 'canvas', schema: CanvasLayer, stage: (l) => (l.overlay ? 'overlay' : 'objects'), plugin: 'core', since: '1.0', anchored: true, requiresId: true },
]

export type TTextLayer = Static<typeof TextLayer>
export type TStickerLayer = Static<typeof StickerLayer>
export type TModelLayer = Static<typeof ModelLayer>
export type TWarpLayer = Static<typeof WarpLayer>
export type TColorLayer = Static<typeof ColorLayer>
export type TShaderLayer = Static<typeof ShaderLayer>
export type TCanvasLayer = Static<typeof CanvasLayer>
export type TLayer = TTextLayer | TStickerLayer | TModelLayer | TWarpLayer | TColorLayer | TShaderLayer | TCanvasLayer
