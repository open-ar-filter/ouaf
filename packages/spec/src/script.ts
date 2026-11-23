/**
 * Types of the script API (spec §12): what `filter.js` / `filter.ts` functions receive, and `defineFilter()`.
 *
 * The manifest data comes from the TypeBox schemas (single source); the functions cannot be described by a JSON
 * Schema, so their types are written here, next to the vocabulary they use. The lists below (easings, script data)
 * are checked against the registry by the tests.
 */
import type { Vec2 as TVec2, Vec3 as TVec3 } from './common.ts'
import type { Static } from 'typebox'
import type { TManifest } from './manifest.ts'
import type { BLENDSHAPES } from './registry.ts'

/** Easings of `.animate()` (spec §12.4): Robert Penner's equations. Default: `inOutQuad`. */
export const EASINGS = [
  'linear',
  ...(['Quad', 'Cubic', 'Back', 'Elastic', 'Bounce'] as const).flatMap((e) => [`in${e}`, `out${e}`, `inOut${e}`] as const),
] as const
export type Easing = 'linear' | `${'in' | 'out' | 'inOut'}${'Quad' | 'Cubic' | 'Back' | 'Elastic' | 'Bounce'}`
export const DEFAULT_EASING: Easing = 'inOutQuad'

/** Data a script may receive (`script.uses`, spec §12.4); the registry describes each one. */
export const SCRIPT_USES = ['face.pose', 'face.blendshapes', 'face.anchors', 'face.landmarks', 'pairs'] as const
export type ScriptUse = (typeof SCRIPT_USES)[number]
/** `uses` when the `script` section omits it. */
export const DEFAULT_SCRIPT_USES: readonly ScriptUse[] = ['face.pose', 'face.blendshapes']

/** Limits of spec §12.4 and §12.7. */
export const SCRIPT_LIMITS = {
  /** A script that does not answer within this delay is stopped (`SCRIPT_STOPPED`). */
  watchdogMs: 1000,
  /** Maximum size of the data of one `f.emit()` message, in bytes. */
  emitMaxBytes: 64 * 1024,
  /** Maximum size of the data of one host message (`engine.send`, `handle.send`), in bytes. */
  sendMaxBytes: 64 * 1024,
  /** An engine MAY drop `f.emit()` messages beyond this rate. */
  emitMaxPerSecond: 60,
} as const

type Vec2 = Static<typeof TVec2>
type Vec3 = Static<typeof TVec3>
export type Blendshape = Exclude<(typeof BLENDSHAPES)[number], '_neutral'>
/** v1 face anchors (spec §5.3); plugins may add more. */
export type FaceAnchor =
  | 'head' | 'forehead' | 'eyes' | 'leftEye' | 'rightEye' | 'noseBridge' | 'noseTip' | 'mouth' | 'upperLip'
  | 'lowerLip' | 'chin' | 'leftCheek' | 'rightCheek' | 'leftTemple' | 'rightTemple'

/** A face in `frame.faces` and in event payloads. Optional fields depend on `script.uses`. */
export interface FaceData<FS = Record<string, unknown>> {
  /** Stable while the face is tracked (spec §5.4); never reused for another person in the session. */
  readonly id: number
  readonly index: number
  /** Per-face state: starts empty, reset when the face leaves. */
  state: FS
  /** `face.pose`: degrees, as the data paths of spec §8. */
  readonly pose?: { readonly yaw: number; readonly pitch: number; readonly roll: number }
  /** `face.pose`: eye distance / screen height. */
  readonly size?: number
  /** `face.blendshapes`: 0 to 1; absent while the engine has dropped them (spec §16.2). */
  readonly blendshapes?: Readonly<Partial<Record<Blendshape, number>>>
  /** `face.anchors`: display space, normalized (0 to 1, origin top left, y down, mirroring applied). */
  readonly anchors?: Readonly<Partial<Record<FaceAnchor | (string & {}), Vec2>>>
  /** `face.landmarks`: 478 × (x, y, z), same space as `anchors`; z is a relative depth at the scale of x. */
  readonly landmarks?: Float32Array
}

/** One pair of faces (`uses: ["pairs"]`). */
export interface PairData<FS = Record<string, unknown>> {
  readonly a: FaceData<FS>
  readonly b: FaceData<FS>
  /** On-screen distance between the head centres, in face units (mean eye distance of the two faces). */
  readonly distance: number
  /** The face outlines touch or overlap on screen (threshold of the `pairContact` event). */
  readonly contact: boolean
}

export interface Frame<FS = Record<string, unknown>> {
  /** Media time, in seconds. */
  readonly time: number
  /** Seconds since the previous call to the script (covers the frames it skipped, spec §12.7). */
  readonly dt: number
  readonly faces: ReadonlyArray<FaceData<FS>>
  /** `uses: ["pairs"]` only. */
  readonly pairs?: ReadonlyArray<PairData<FS>>
}

/** A value `.animate()` can interpolate. */
export type AnimValue = number | Vec2 | Vec3 | string
/** Keyframes of `.animate()`, evenly spaced over `duration` (spec §12.4): at least two values. */
export interface Keyframes {
  keyframes: readonly [AnimValue, AnimValue, ...AnimValue[]]
}
/**
 * Properties `.set()` accepts (spec §12.4). `null` restores the manifest value (fixed or bound). Unknown names are
 * reported by the engine, since the set depends on the layer type.
 */
export interface SettableProps {
  visible?: boolean | null
  opacity?: number | null
  offset?: Vec3 | null
  rotation?: Vec3 | null
  scale?: number | Vec3 | null
  size?: number | null
  text?: string | null
  color?: string | null
  font?: string | null
  src?: string | null
  lut?: string | null
  animation?: string | null
  [property: string]: unknown
}

export interface AnimateOptions {
  /** Milliseconds. */
  duration: number
  easing?: Easing
  /** Milliseconds before the animation starts. */
  delay?: number
  /** Extra runs; -1 for endless. */
  repeat?: number
}

export interface LayerHandle {
  set(props: SettableProps): void
  /** A value is the target; `{ keyframes: [...] }` plays a list of values evenly spaced over `duration` (spec §12.4). */
  animate(props: Record<string, AnimValue | Keyframes>, options: AnimateOptions): void
  /** Model layers: start a glTF animation. */
  play(animation: string): void
  /** Canvas layers: redraw at the next frame. */
  invalidate(): void
}

export interface Timer {
  cancel(): void
}

export type ParamValue = number | boolean | string | Vec2 | Vec3 | null

export interface FilterApi<Ids extends string = string, S = Record<string, unknown>, FS = Record<string, unknown>> {
  /** Handle on a layer; with `face`, only that face's instance. */
  layer(id: Ids, face?: FaceData<FS>): LayerHandle
  /** Global state (plain data). */
  state: S
  /** Parameters, read-only (spec §9). */
  readonly params: Readonly<Record<string, ParamValue>>
  /** Message to the host: `handle.on('filter:<name>')`. Structured-cloneable, at most 64 KB. */
  emit(name: string, data?: unknown): void
  /** Image asset (preloaded), drawable in a canvas. */
  asset(name: string): ImageBitmap
  /** [0, 1), from the filter's seeded generator (spec §12.5). */
  random(): number
  /** Runs `fn` once, `ms` milliseconds of media time from now. */
  after(ms: number, fn: (f: FilterApi<Ids, S, FS>) => void): Timer
  /** Runs `fn` every `ms` milliseconds of media time. */
  every(ms: number, fn: (f: FilterApi<Ids, S, FS>) => void): Timer
}

/** Payloads of the events of spec §13. */
export interface FaceEventPayload<FS = Record<string, unknown>> {
  readonly face: FaceData<FS>
  /** `wink` only. */
  readonly side?: 'left' | 'right'
}
export interface PairEventPayload<FS = Record<string, unknown>> {
  readonly faces: readonly [FaceData<FS>, FaceData<FS>]
}
export interface ParamChangePayload {
  readonly name: string
  readonly value: ParamValue
  readonly previous: ParamValue
}
export interface MessagePayload {
  readonly data: unknown
}
export type EventPayload<E extends string, FS> = E extends 'paramChange'
  ? ParamChangePayload
  : E extends `message:${string}`
    ? MessagePayload
    : E extends 'pairContact' | 'pairSeparate'
      ? PairEventPayload<FS>
      : FaceEventPayload<FS>

type V1Event =
  | 'faceEnter' | 'faceLeave' | 'blink' | 'wink' | 'mouthOpen' | 'mouthClose' | 'smile' | 'smileEnd' | 'eyebrowRaise'
  | 'kiss' | 'nod' | 'shake' | 'pairContact' | 'pairSeparate' | 'paramChange' | `message:${string}`

/** Layer declarations as written in `filter.js`; their ids type `f.layer()`. */
type LayerDecl = { readonly type: string; readonly id?: string; readonly [k: string]: unknown }
type IdsOf<L extends readonly LayerDecl[]> = L[number] extends infer D ? (D extends { readonly id: infer I extends string } ? I : never) : never

/** What `filter.js` exports (spec §3.1, §12.3): the manifest data plus the script functions. */
export type FilterDefinition<L extends readonly LayerDecl[] = readonly LayerDecl[], S = Record<string, unknown>, FS = Record<string, unknown>> =
  Omit<TManifest, 'ouaf' | 'layers' | 'script'> & {
    /** Filled in by `ouaf pack`. */
    ouaf?: '1'
    layers: L
    /**
     * `ouaf pack` fills in the manifest's `script` section from the functions below; the author only chooses the data
     * the script receives (spec §12.2, §12.4). Default: `["face.pose", "face.blendshapes"]`.
     */
    script?: { readonly uses?: ReadonlyArray<ScriptUse | (string & {})> }
    /** Initial global state. */
    state?: S
    setup?(f: FilterApi<IdsOf<L>, S, FS>): void
    update?(f: FilterApi<IdsOf<L>, S, FS>, frame: Frame<FS>): void
    on?: { [E in V1Event]?: (f: FilterApi<IdsOf<L>, S, FS>, payload: EventPayload<E, FS>) => void } & {
      // Plugin events (`acme:glow`): annotate the payload.
      [event: string]: ((f: FilterApi<IdsOf<L>, S, FS>, payload: never) => void) | undefined
    }
    /** Canvas layers, by id (the validator checks that each one is a canvas layer). */
    draw?: { [id: string]: ((ctx: OffscreenCanvasRenderingContext2D, f: FilterApi<IdsOf<L>, S, FS>, frame: Frame<FS>) => void) | undefined }
  }

/**
 * Identity function that types a filter definition: `f.layer()` only accepts the declared layer ids, event handlers
 * get their payload type, `f.state` the type of `state`.
 *
 *   export default defineFilter({ id: 'smiles', …, layers: [{ id: 'label', type: 'text', text: '' }], … })
 */
export function defineFilter<const L extends readonly LayerDecl[], S = Record<string, unknown>, FS = Record<string, unknown>>(
  def: FilterDefinition<L, S, FS>,
): FilterDefinition<L, S, FS> {
  return def
}
