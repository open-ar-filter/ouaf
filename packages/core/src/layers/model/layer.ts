/**
 * The `model` layer type (spec §6.2, §6.3): a 3D object attached to an anchor.
 *
 * - **Source**: a glTF / GLB asset (`modelLoader`), `{ pick }` among several, or a procedural `{ shape }`. With
 *   `{ pick }`, each selected face gets one model, kept while the face keeps its stable id (spec §10.1): entry
 *   `(id − 1) mod n` with `by: "face"`, a random draw when the face gets its id with `by: "random"`; a screen model
 *   picks for its first selected face (id 0 while there is none). The rule and its code are the sticker's
 *   (`sticker/select.ts`).
 * - **Instances**: one copy of the model per selected face (`faces`), or one for `anchor: "screen"`, each with its own
 *   node hierarchy and animation mixer (copies are made once per face slot and model, then reused).
 * - **Transform**: anchor · T(offset) · R(rotation, Euler XYZ, degrees) · S(scale × fit). 1 glTF unit = 1 face unit
 *   (spec §5.1); `fit` rescales the model uniformly so its bounding box at rest has the given width (x) and/or height
 *   (y) in anchor units (both: the largest scale that fits in both). The model's origin stays on the anchor.
 *   `orient: "screen"` keeps the anchor's position and scale but not its rotation.
 * - **Animation**: `animation` names a glTF clip, played from its start when the layer is activated and on each face
 *   that appears (a new id); it advances with the frame time (the media time for a video file, so it is the same on
 *   every run, spec §12.5), repeats with `loop` (default) or holds its last pose. `play(name, faceId?)` starts another
 *   clip from its start: the entry point of the script API (`f.layer(id, face?).play(name)`, #26).
 * - **Occlusion**: `occlusion: "head"` adds a head occluder per face (`occluder.ts`), which hides the parts of the
 *   model behind the head. It writes depth for the whole objects stage, so it hides any object behind the head.
 * - **Lighting**: image-based, the same for every model (`environment.ts`).
 *
 * Bindable properties (`visible`, `opacity`, `offset`, `rotation`, `scale`) are evaluated per face. `update`
 * allocates nothing in the steady state (new faces copy a model once per face slot and model).
 */
import type { TModelLayer } from '@ouaf/spec'
import {
  AnimationMixer,
  Euler,
  Group,
  LoopOnce,
  LoopRepeat,
  Matrix4,
  Quaternion,
  Vector3,
  type AnimationAction,
  type Material,
  type Mesh,
  type Object3D,
  type Texture,
} from 'three'
import type { AnchorFollow } from '../../anchors.ts'
import { NO_FACE, compileBinding, compileNumberBinding, type CompiledBinding, type NumberBinding } from '../../bindings/index.ts'
import { OuafError } from '../../engine/errors.ts'
import type { FrameContext, LayerContext, LayerDecl, LayerTypeImpl, ObjectLayer } from '../../engine/layer-type.ts'
import { apparentSize } from '../sticker/layer.ts'
import { clockStep } from '../sticker/playback.ts'
import { instanceCount, pickIndex, selectFaces, type FacesSelector, type PickMode } from '../sticker/select.ts'
import { cloneModel, disposeScene, isModelAsset, type ModelAsset } from './assets.ts'
import { acquireEnvironment, applyEnvironment, releaseEnvironment } from './environment.ts'
import { HeadOccluders } from './occluder.ts'
import { createShapeAsset, type TShape } from './shapes.ts'

const DEG = Math.PI / 180
/** Indices in the clock state array. */
const LAST_TIME = 0
const STEP = 1

type Vec3 = readonly [number, number, number]
type Src = TModelLayer['src']

const isShape = (src: Src): src is TShape => typeof src === 'object' && 'shape' in src

/** The asset references of a model declaration: `src`, every entry of `{ pick }`, none for `{ shape }`. */
export function modelRefs(decl: LayerDecl): string[] {
  const src = (decl as unknown as TModelLayer).src
  if (typeof src === 'string') return [src]
  return isShape(src) ? [] : [...src.pick]
}

/**
 * Uniform scale that gives a box of size `w` × `h` the requested `fit` (spec §6.3): its width, its height, or both
 * (the largest scale that fits in both). 1 without `fit`, or when the box is flat along a requested axis.
 */
export function fitScale(fit: TModelLayer['fit'], w: number, h: number): number {
  if (!fit) return 1
  const sx = fit.width !== undefined && w > 1e-9 ? fit.width / w : Infinity
  const sy = fit.height !== undefined && h > 1e-9 ? fit.height / h : Infinity
  const s = Math.min(sx, sy)
  return Number.isFinite(s) ? s : 1
}

export interface ModelOptions {
  /** Random draws in [0, 1) for `{ pick, by: "random" }`, one per face. Default: `Math.random`. */
  random?: () => number
  /**
   * Environment map lighting the models (`environment.ts`). Default: the renderer's shared one; `null` for none
   * (tests without WebGL).
   */
  environment?: Texture | null
}

/** A `model` layer instance; `play` is what the script API calls. */
export interface ModelLayerInstance extends ObjectLayer {
  /**
   * Starts the glTF animation `name` from its start, on the instance of the face with stable id `faceId`, or on every
   * instance (and the faces that appear later) without it. False when none of the layer's models has that animation
   * (nothing changes then).
   */
  play(name: string, faceId?: number): boolean
  /** Names of the animations of the layer's models. */
  readonly animations: readonly string[]
}

/** One copy of one model, for one face slot. */
interface Copy {
  readonly root: Object3D
  readonly materials: readonly Material[]
  /** Opacity and transparency of each material as loaded. */
  readonly baseOpacity: Float32Array
  readonly baseTransparent: readonly boolean[]
  readonly mixer: AnimationMixer | undefined
  readonly actions: ReadonlyMap<string, AnimationAction>
  /** `fit` scale of this model. */
  readonly fit: number
  /** Opacity currently applied (−1: never applied). */
  alpha: number
  /** Action playing, if any. */
  action: AnimationAction | undefined
  /** The action was (re)started since the last frame: its first frame shows its start, without advancing. */
  started: boolean
}

/** What is shown for one selected face (or the screen). */
interface Instance {
  /** Positioned every frame; holds the copy of the picked model. */
  readonly holder: Group
  /** One copy per model, made the first time the face slot shows it. */
  readonly copies: Array<Copy | undefined>
  readonly occluder: Mesh | undefined
  current: Copy | undefined
  /** Face id the model was picked for (−1: none yet). */
  faceId: number
}

export function createModel(decl: LayerDecl, ctx: LayerContext, options: ModelOptions = {}): ModelLayerInstance {
  const d = decl as unknown as TModelLayer
  const path = (name: string) => `${decl.id ? `layer "${decl.id}"` : 'model'}.${name}`

  // Models: preloaded assets, or a shape owned by the layer.
  const shape = isShape(d.src) ? createShapeAsset(d.src) : undefined
  const models: ModelAsset[] = shape
    ? [shape]
    : modelRefs(decl).map((ref) => {
        const value = ctx.assets.get(ref)
        if (!isModelAsset(value)) throw new OuafError('asset', `Filter "${ctx.filterId}": asset "${ref}" is not a glTF model, so a model layer cannot show it.`)
        return value
      })
  const by: PickMode = typeof d.src === 'object' && 'pick' in d.src && d.src.by === 'random' ? 'random' : 'face'
  const random = options.random ?? Math.random
  const fits = models.map((m) => {
    const size = m.bounds.isEmpty() ? new Vector3() : m.bounds.getSize(new Vector3())
    return fitScale(d.fit, size.x, size.y)
  })

  const animationNames = [...new Set(models.flatMap((m) => m.animations.map((a) => a.name)))]
  let animation: string | undefined = d.animation
  if (animation !== undefined && !animationNames.includes(animation)) {
    ctx.warn(`${path('animation')}: no animation "${animation}" in the model (${animationNames.length > 0 ? `it has ${animationNames.map((n) => `"${n}"`).join(', ')}` : 'it has none'}).`)
    animation = undefined
  }
  const loop = d.loop ?? true

  const anchor = d.anchor ?? 'head'
  const screen = anchor === 'screen'
  const follow: AnchorFollow | 'auto' = d.follow ?? 'auto'
  const orientScreen = d.orient === 'screen'
  const faces: FacesSelector = d.faces ?? 'all'
  const occlusion = d.occlusion === 'head' && !screen
  if (d.occlusion === 'head' && screen) ctx.warn(`${path('occlusion')}: "head" has no effect with anchor "screen".`)

  const env = ctx.bindings
  const visible: CompiledBinding<boolean> = compileBinding(d.visible ?? true, { type: 'boolean', fallback: true, path: path('visible') }, env)
  const opacity: NumberBinding = compileNumberBinding(d.opacity ?? 1, { fallback: 1, path: path('opacity') }, env)
  const offset: CompiledBinding<Vec3> = compileBinding(d.offset ?? [0, 0, 0], { type: 'vec3', fallback: [0, 0, 0], path: path('offset') }, env)
  const rotation: CompiledBinding<Vec3> = compileBinding(d.rotation ?? [0, 0, 0], { type: 'vec3', fallback: [0, 0, 0], path: path('rotation') }, env)
  const scale = compileScale(d.scale ?? 1, path('scale'), ctx)

  const renderer = ctx.renderer
  const envMap = options.environment !== undefined ? options.environment : acquireEnvironment(renderer)
  const ownsEnvironment = options.environment === undefined

  const root = new Group()
  root.name = decl.id ?? 'model'
  const occluders = occlusion ? new HeadOccluders() : undefined
  const count = screen ? 1 : instanceCount(faces, ctx.maxFaces)
  const instances: Instance[] = []
  for (let i = 0; i < count; i++) {
    const holder = new Group()
    holder.matrixAutoUpdate = false
    holder.visible = false
    root.add(holder)
    const occluder = occluders?.create()
    if (occluder) root.add(occluder)
    instances.push({ holder, copies: models.map(() => undefined), occluder, current: undefined, faceId: -1 })
  }

  const makeCopy = (index: number): Copy => {
    const model = models[index]!
    const { root: copyRoot, materials } = cloneModel(model)
    for (const m of materials) applyEnvironment(m, envMap)
    let mixer: AnimationMixer | undefined
    const actions = new Map<string, AnimationAction>()
    if (model.animations.length > 0) {
      mixer = new AnimationMixer(copyRoot)
      for (const clip of model.animations) {
        const action = mixer.clipAction(clip)
        action.setLoop(loop ? LoopRepeat : LoopOnce, Infinity)
        action.clampWhenFinished = !loop
        actions.set(clip.name, action)
      }
    }
    return {
      root: copyRoot,
      materials,
      baseOpacity: Float32Array.from(materials, (m) => m.opacity),
      baseTransparent: materials.map((m) => m.transparent),
      mixer,
      actions,
      fit: fits[index]!,
      alpha: -1,
      action: undefined,
      started: false,
    }
  }

  /** Starts `name` from its start on `copy` (stops what it played); `undefined` stops everything. */
  const start = (copy: Copy, name: string | undefined) => {
    if (!copy.mixer) return
    const action = name === undefined ? undefined : copy.actions.get(name)
    if (copy.action && copy.action !== action) copy.action.stop()
    copy.action = action
    copy.started = true
    if (action) action.reset().play()
    // Pose the first frame now, so a model never shows its rest pose for a frame.
    copy.mixer.update(0)
  }

  const pickFor = (inst: Instance, faceId: number) => {
    if (inst.faceId === faceId) return
    inst.faceId = faceId
    const index = pickIndex(by, faceId, models.length, by === 'random' && models.length > 1 ? random() : 0)
    const copy = (inst.copies[index] ??= makeCopy(index))
    if (inst.current !== copy) {
      if (inst.current) inst.holder.remove(inst.current.root)
      inst.holder.add(copy.root)
      inst.current = copy
    }
    // A new face: its animation starts from the beginning.
    start(copy, animation)
  }

  // Per-frame scratch, allocated once.
  const slots = new Int32Array(Math.max(1, ctx.maxFaces))
  const ids = new Int32Array(Math.max(1, ctx.maxFaces))
  const sizes = new Float64Array(Math.max(1, ctx.maxFaces))
  const num = new Float64Array(4) // opacity, scale x, y, z
  const clock = new Float64Array(2) // last frame time, step
  clock[LAST_TIME] = -1
  const anchorMatrix = new Matrix4()
  const headMatrix = new Matrix4()
  const local = new Matrix4()
  const position = new Vector3()
  const scaleVec = new Vector3()
  const euler = new Euler()
  const quaternion = new Quaternion()
  const anchorPosition = new Vector3()

  const setAlpha = (copy: Copy, alpha: number) => {
    if (copy.alpha === alpha) return
    copy.alpha = alpha
    const materials = copy.materials
    for (let i = 0; i < materials.length; i++) {
      const m = materials[i]!
      m.opacity = copy.baseOpacity[i]! * alpha
      const transparent = copy.baseTransparent[i]! || alpha < 1
      if (m.transparent !== transparent) {
        m.transparent = transparent
        m.needsUpdate = true // opaque materials force alpha to 1 in their program
      }
    }
  }

  /** Places `inst` for face slot `face` (NO_FACE for the screen); false when it is not shown this frame. */
  const place = (inst: Instance, face: number, frame: FrameContext): boolean => {
    const copy = inst.current
    if (!copy || !visible.evaluate(face)) return false
    opacity.write(face, num, 0)
    const alpha = num[0]!
    if (!(alpha > 0)) return false
    if (!scale.write(face, num, 1)) return false
    if (screen) frame.anchors.screen(anchorMatrix)
    else if (!frame.anchors.face(face, anchor, follow, anchorMatrix)) return false

    const o = offset.evaluate(face)
    const r = rotation.evaluate(face)
    quaternion.setFromEuler(euler.set(r[0] * DEG, r[1] * DEG, r[2] * DEG))
    const f = copy.fit
    const m = inst.holder.matrix
    if (orientScreen && !screen) {
      anchorPosition.set(o[0], o[1], o[2]).applyMatrix4(anchorMatrix)
      const e = anchorMatrix.elements
      const unit = Math.sqrt(e[0]! * e[0]! + e[1]! * e[1]! + e[2]! * e[2]!) * f
      m.compose(anchorPosition, quaternion, scaleVec.set(unit * num[1]!, unit * num[2]!, unit * num[3]!))
    } else {
      local.compose(position.set(o[0], o[1], o[2]), quaternion, scaleVec.set(f * num[1]!, f * num[2]!, f * num[3]!))
      m.multiplyMatrices(anchorMatrix, local)
    }
    setAlpha(copy, alpha < 1 ? alpha : 1)
    if (copy.started) copy.started = false
    else if (copy.mixer && copy.action) copy.mixer.update(clock[STEP]!)
    return true
  }

  const layer: ModelLayerInstance = {
    kind: 'object',
    stage: d.overlay ? 'overlay' : 'objects',
    object: root,
    excludeFromCapture: d.overlay === true && d.excludeFromCapture === true,
    animations: animationNames,
    update(frame) {
      const anchors = frame.anchors
      const tracked = frame.faces.count
      let selected = 0
      if (!screen && tracked > 0) {
        for (let i = 0; i < tracked && i < ids.length; i++) {
          ids[i] = anchors.id(i)
          if (faces === 'largest') apparentSize(anchors, i, anchorMatrix, sizes)
        }
        selected = selectFaces(faces, Math.min(tracked, ids.length), ids, sizes, slots)
      }
      const lead = selected > 0 ? slots[0]! : tracked > 0 ? 0 : NO_FACE
      clock[STEP] = clockStep(clock[LAST_TIME]!, frame.time) // s
      clock[LAST_TIME] = frame.time

      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i]!
        let shown = false
        let face = NO_FACE
        if (screen) {
          pickFor(inst, lead === NO_FACE ? 0 : anchors.id(lead))
          shown = place(inst, lead, frame)
        } else if (i < selected) {
          face = slots[i]!
          pickFor(inst, ids[face]!)
          shown = place(inst, face, frame)
        }
        inst.holder.visible = shown
        const occluder = inst.occluder
        if (occluder) {
          occluder.visible = shown && anchors.face(face, 'head', 'rigid', headMatrix)
          if (occluder.visible) occluders!.place(occluder, headMatrix)
        }
      }
    },
    play(name, faceId) {
      if (!animationNames.includes(name)) return false
      if (faceId === undefined) animation = name
      for (const inst of instances) {
        if (inst.current && (faceId === undefined || inst.faceId === faceId)) start(inst.current, name)
      }
      return true
    },
    dispose() {
      for (const inst of instances) {
        for (const copy of inst.copies) {
          if (!copy) continue
          copy.mixer?.stopAllAction()
          copy.mixer?.uncacheRoot(copy.root)
          for (const m of copy.materials) m.dispose()
        }
      }
      occluders?.dispose()
      if (shape) disposeScene(shape.scene)
      if (ownsEnvironment) releaseEnvironment(renderer)
      root.removeFromParent()
    },
  }
  return layer
}

/** `scale`: a number or `[x, y, z]`, bindable (spec §6.2); `write` gives the three factors, false when one is ≤ 0. */
interface ScaleBinding {
  write(face: number, out: Float64Array, index: number): boolean
}

function compileScale(value: unknown, path: string, ctx: LayerContext): ScaleBinding {
  const env = ctx.bindings
  // Number bindings (`{ bind }` without `map`, number params) go through `write`, which never allocates.
  const isNumber =
    typeof value === 'number' ||
    (typeof value === 'object' && value !== null && !Array.isArray(value) &&
      (('bind' in value && !('map' in value)) || ('param' in value && env.params.type(String((value as { param: unknown }).param)) === 'number')))
  if (isNumber) {
    const n = compileNumberBinding(value, { fallback: 1, path }, env)
    return {
      write(face, out, index) {
        n.write(face, out, index)
        const s = out[index]!
        out[index + 1] = s
        out[index + 2] = s
        return s > 0
      },
    }
  }
  const b = compileBinding(value, { type: ['number', 'vec3'], fallback: 1, path }, env)
  return {
    write(face, out, index) {
      const v = b.evaluate(face)
      if (typeof v === 'number') {
        out[index] = v
        out[index + 1] = v
        out[index + 2] = v
      } else {
        out[index] = v[0]
        out[index + 1] = v[1]
        out[index + 2] = v[2]
      }
      return out[index]! > 0 && out[index + 1]! > 0 && out[index + 2]! > 0
    },
  }
}

export const modelLayerType: LayerTypeImpl = {
  type: 'model',
  assets: modelRefs,
  create: (decl, ctx) => createModel(decl, ctx),
}
