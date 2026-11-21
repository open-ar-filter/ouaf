/**
 * Registry of the extensible vocabulary: anchors, layer types, events, data paths, built-in resources.
 * The core registers the built-in vocabulary; plugins add theirs through the same mechanism.
 * The validator, the published JSON Schema and the AI-facing docs are generated from this registry.
 */
import { BUILTIN_LAYERS, type LayerTypeDef } from './layers.ts'

export type Status = 'stable' | 'reserved'

export interface AnchorDef {
  name: string
  subject: 'face' | 'screen' | string
  description: string
  plugin: string
  status: Status
}

export interface EventDef {
  /** Exact name, or a family prefix ending with ":" (e.g. "message:"). */
  name: string
  description: string
  plugin: string
  status: Status
  /** Default threshold (0–1) for blendshape-derived events. */
  threshold?: number
  /** Can the threshold be tuned via `events.<name>.threshold`? */
  tunable?: boolean
  /** The event is derived from face tracking (requires.face). */
  face?: boolean
}

export interface DataPathDef {
  path: string
  type: 'number' | 'string' | 'boolean'
  description: string
  plugin: string
}

/** Data families a script may request (`script.uses`), following data minimization. */
export interface ScriptDataDef {
  name: string
  description: string
  default: boolean
}

export interface BuiltinDef {
  kind: 'font' | 'lut'
  description: string
}

export interface SpecRegistry {
  anchors: Map<string, AnchorDef>
  layers: Map<string, LayerTypeDef>
  events: Map<string, EventDef>
  data: Map<string, DataPathDef>
  scriptData: Map<string, ScriptDataDef>
  /** Engine resources referenced as "builtin:<name>". */
  builtins: Map<string, BuiltinDef>
  /** Known plugins (name → version). "core" is always present. */
  plugins: Map<string, string>
}

/** The 52 blendshapes provided by MediaPipe FaceLandmarker (ARKit convention). */
export const BLENDSHAPES = [
  '_neutral', 'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight', 'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight',
  'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight', 'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight',
  'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight', 'mouthRollLower', 'mouthRollUpper',
  'mouthShrugLower', 'mouthShrugUpper', 'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight', 'noseSneerLeft', 'noseSneerRight',
] as const

const FACE_ANCHORS: Array<[string, string]> = [
  ['head', 'Center of the head; frame that follows the full pose (position, rotation, scale).'],
  ['forehead', 'Top of the forehead.'],
  ['eyes', 'Midpoint between the eyes (top of the nose bridge).'],
  ['leftEye', 'Center of the person\'s left eye (on the left of the screen in mirrored view).'],
  ['rightEye', 'Center of the person\'s right eye.'],
  ['noseBridge', 'Middle of the nose bridge.'],
  ['noseTip', 'Tip of the nose.'],
  ['mouth', 'Center of the mouth (between the lips).'],
  ['upperLip', 'Middle of the upper lip.'],
  ['lowerLip', 'Middle of the lower lip.'],
  ['chin', 'Bottom of the chin.'],
  ['leftCheek', 'Left cheekbone.'],
  ['rightCheek', 'Right cheekbone.'],
  ['leftTemple', 'Left temple (edge of the face at eye level).'],
  ['rightTemple', 'Right temple.'],
]

const FACE_EVENTS: Array<Omit<EventDef, 'plugin'>> = [
  { name: 'faceEnter', description: 'A face appears (new id).', status: 'stable', face: true },
  { name: 'faceLeave', description: 'A face disappears (after the grace delay).', status: 'stable', face: true },
  { name: 'blink', description: 'Both eyes close briefly (eyeBlinkLeft and eyeBlinkRight).', status: 'stable', threshold: 0.5, tunable: true, face: true },
  { name: 'wink', description: 'A single eye closes; payload.side = "left" | "right".', status: 'stable', threshold: 0.5, tunable: true, face: true },
  { name: 'mouthOpen', description: 'The mouth opens (jawOpen crosses the threshold).', status: 'stable', threshold: 0.35, tunable: true, face: true },
  { name: 'mouthClose', description: 'The mouth closes again.', status: 'stable', face: true },
  { name: 'smile', description: 'A smile starts (average of mouthSmileLeft/Right).', status: 'stable', threshold: 0.5, tunable: true, face: true },
  { name: 'smileEnd', description: 'The smile ends.', status: 'stable', face: true },
  { name: 'eyebrowRaise', description: 'Eyebrows raised (browInnerUp).', status: 'stable', threshold: 0.5, tunable: true, face: true },
  { name: 'kiss', description: 'Kissing lips (mouthPucker).', status: 'stable', threshold: 0.7, tunable: true, face: true },
  { name: 'nod', description: 'Head nod "yes" (pitch oscillation).', status: 'stable', threshold: 0.5, tunable: true, face: true },
  { name: 'shake', description: 'Head shake "no" (yaw oscillation).', status: 'stable', threshold: 0.5, tunable: true, face: true },
]

const HOST_EVENTS: Array<Omit<EventDef, 'plugin'>> = [
  { name: 'paramChange', description: 'A parameter changed; payload = { name, value, previous }.', status: 'stable' },
  { name: 'message:', description: 'Message sent by the host page via engine.send(name, data); e.g. "message:startGame".', status: 'stable' },
]

const RESERVED_EVENTS: Array<Omit<EventDef, 'plugin'>> = [
  ...['tap', 'doubleTap', 'longPress', 'drag', 'pinch', 'swipe'].map((name) => ({
    name,
    description: 'Screen interaction (reserved, phase 2); payload = { x, y, layer? }.',
    status: 'reserved' as const,
  })),
  { name: 'tap:', description: 'Tap on a specific layer, e.g. "tap:crown" (reserved, phase 2).', status: 'reserved' },
  { name: 'ended', description: 'Video playback ended (reserved).', status: 'reserved' },
  { name: 'cue:', description: 'Video time reached (reserved).', status: 'reserved' },
]

const DATA: Array<Omit<DataPathDef, 'plugin'>> = [
  { path: 'time', type: 'number', description: 'Media time in seconds (deterministic in file mode).' },
  { path: 'faces.count', type: 'number', description: 'Number of detected faces.' },
  { path: 'face.index', type: 'number', description: 'Index of the current face (0, 1…).' },
  { path: 'face.size', type: 'number', description: 'Apparent face size (eye distance / screen height).' },
  { path: 'face.pose.yaw', type: 'number', description: 'Left/right head rotation, in degrees.' },
  { path: 'face.pose.pitch', type: 'number', description: 'Up/down head rotation, in degrees.' },
  { path: 'face.pose.roll', type: 'number', description: 'Sideways head tilt, in degrees.' },
  ...BLENDSHAPES.filter((b) => b !== '_neutral').map((b) => ({
    path: `face.blendshapes.${b}`,
    type: 'number' as const,
    description: `Blendshape ${b}, from 0 to 1.`,
  })),
]

const SCRIPT_DATA: ScriptDataDef[] = [
  { name: 'face.pose', description: 'Head pose (yaw, pitch, roll) and size.', default: true },
  { name: 'face.blendshapes', description: 'The 52 blendshapes.', default: true },
  { name: 'face.anchors', description: 'Screen position of the anchors (collisions, mini-games).', default: false },
  { name: 'face.landmarks', description: 'The 478 raw face landmarks.', default: false },
]

export const BUILTINS: Array<[string, BuiltinDef['kind'], string]> = [
  ['font/sans', 'font', 'Sans-serif, regular.'],
  ['font/sans-bold', 'font', 'Sans-serif, bold (default for text layers).'],
  ['font/rounded-bold', 'font', 'Rounded, bold.'],
  ['font/serif', 'font', 'Serif.'],
  ['font/mono', 'font', 'Monospace.'],
  ['font/handwritten', 'font', 'Handwritten.'],
  ['lut/vintage', 'lut', 'Faded warm tones.'],
  ['lut/noir', 'lut', 'High-contrast black and white.'],
  ['lut/warm', 'lut', 'Warms the image.'],
  ['lut/cool', 'lut', 'Cools the image.'],
  ['lut/vivid', 'lut', 'Saturated colors.'],
]

/** Creates a registry holding the built-in v1 vocabulary. */
export function createRegistry(): SpecRegistry {
  const reg: SpecRegistry = {
    anchors: new Map(),
    layers: new Map(),
    events: new Map(),
    data: new Map(),
    scriptData: new Map(),
    builtins: new Map(BUILTINS.map(([name, kind, description]) => [name, { kind, description }])),
    plugins: new Map([['core', '1.0.0']]),
  }
  for (const [name, description] of FACE_ANCHORS) {
    reg.anchors.set(name, { name, subject: 'face', description, plugin: 'core', status: 'stable' })
  }
  reg.anchors.set('screen', {
    name: 'screen',
    subject: 'screen',
    description: 'Screen: origin at the center, x to the right, y up, 1 unit = screen height.',
    plugin: 'core',
    status: 'stable',
  })
  for (const l of BUILTIN_LAYERS) reg.layers.set(l.type, l)
  for (const e of [...FACE_EVENTS, ...HOST_EVENTS, ...RESERVED_EVENTS]) reg.events.set(e.name, { ...e, plugin: 'core' })
  for (const d of DATA) reg.data.set(d.path, { ...d, plugin: 'core' })
  for (const s of SCRIPT_DATA) reg.scriptData.set(s.name, s)
  return reg
}

/** Vocabulary contributed by a plugin (used by engine.use() and by the CLI). */
export interface SpecContribution {
  plugin: string
  version: string
  anchors?: Array<Omit<AnchorDef, 'plugin'>>
  layers?: Array<Omit<LayerTypeDef, 'plugin'>>
  events?: Array<Omit<EventDef, 'plugin'>>
  data?: Array<Omit<DataPathDef, 'plugin'>>
}

/**
 * Adds a plugin's vocabulary. Third-party plugins prefix their names with "<plugin>:"
 * (data paths: "ext.<plugin>.") to avoid collisions; official plugins use plain names.
 */
export function extendRegistry(reg: SpecRegistry, c: SpecContribution, opts: { official?: boolean } = {}): void {
  const check = (kind: string, name: string, map: Map<string, unknown>) => {
    if (map.has(name)) throw new Error(`Plugin "${c.plugin}" redefines ${kind} "${name}", which is already registered.`)
    // Data paths are dotted: prefix "ext.<plugin>."; everything else: "<plugin>:".
    const prefix = kind === 'data path' ? `ext.${c.plugin}.` : `${c.plugin}:`
    if (!opts.official && !name.startsWith(prefix)) {
      throw new Error(`Third-party plugin "${c.plugin}" must prefix ${kind} "${name}": "${prefix}${name}".`)
    }
  }
  reg.plugins.set(c.plugin, c.version)
  for (const a of c.anchors ?? []) (check('anchor', a.name, reg.anchors), reg.anchors.set(a.name, { ...a, plugin: c.plugin }))
  for (const l of c.layers ?? []) (check('layer type', l.type, reg.layers), reg.layers.set(l.type, { ...l, plugin: c.plugin }))
  for (const e of c.events ?? []) (check('event', e.name, reg.events), reg.events.set(e.name, { ...e, plugin: c.plugin }))
  for (const d of c.data ?? []) (check('data path', d.path, reg.data), reg.data.set(d.path, { ...d, plugin: c.plugin }))
}

/** Resolves an event name (exact, or a "prefix:" family). */
export function findEvent(reg: SpecRegistry, name: string): EventDef | undefined {
  const exact = reg.events.get(name)
  if (exact) return exact
  const i = name.indexOf(':')
  if (i > 0) return reg.events.get(name.slice(0, i + 1))
  return undefined
}
