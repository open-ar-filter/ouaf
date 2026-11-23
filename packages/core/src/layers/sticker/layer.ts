/**
 * The `sticker` layer type (spec §6.2, §6.3): an image, spritesheet or video on a quad attached to an anchor.
 *
 * One quad per selected face (`faces`), or a single one for `anchor: "screen"`. Each quad shows the layer's asset, or
 * with `{ pick }` the asset chosen for its face, kept while the face keeps its stable id: `(id − 1) mod n` with
 * `by: "face"`, a random draw when the face appears with `by: "random"`; a screen sticker picks for its first
 * selected face (id 0 while there is none). `size` is the
 * height in anchor units, the width follows the asset's aspect ratio; `scale` multiplies it (per axis with `[x, y, z]`).
 * Bindable properties (`visible`, `opacity`, `size`, `scale`, `offset`, `rotation`) are evaluated per face; `rate`
 * once per layer, for the first selected face.
 *
 * Playback (spritesheets, videos) follows the layer's clock (`playback.ts`): it starts from the first frame when the
 * layer is activated and, for a face sticker, when the first selected face appears after none was; faces that appear
 * while one is selected join the running animation. The clock keeps advancing while the layer is hidden by `visible`
 * or `opacity` 0 (as CSS `visibility: hidden`), so it resumes where it is when shown again. It advances with the frame
 * time times `rate`, stays on the first frame with `autoplay: false` (a script will start it, #26) and holds the last
 * frame at the end without `loop`. A video plays natively at `rate` and is re-synchronized to the clock when it drifts
 * by more than `VIDEO_SYNC_TOLERANCE` (so also when shown again after a pause); it is paused while no quad has shown it
 * for `VIDEO_IDLE_PAUSE_MS` (spec §10.4 recommends at most two videos playing at once on mobile).
 *
 * `update` allocates nothing in the steady state.
 */
import type { TStickerLayer } from '@ouaf/spec'
import { Euler, Group, Matrix4, Mesh, PlaneGeometry, Quaternion, Vector3 } from 'three'
import type { AnchorFollow } from '../../anchors.ts'
import { NO_FACE, compileBinding, compileNumberBinding, type CompiledBinding, type NumberBinding } from '../../bindings/index.ts'
import { createPlacement } from '../../engine/draw-order.ts'
import { OuafError } from '../../engine/errors.ts'
import type { FrameContext, LayerContext, LayerDecl, LayerTypeImpl, ObjectLayer, ObjectPlacement } from '../../engine/layer-type.ts'
import { compileScale } from '../scale.ts'
import { isStickerAsset, type StickerAsset } from './assets.ts'
import { StickerMaterial, type BlendMode } from './material.ts'
import { clockStep, spriteFrame, videoDrift, videoTarget } from './playback.ts'
import { instanceCount, pickIndex, selectFaces, type FacesSelector, type PickMode } from './select.ts'

/** Drift (s) between a video and the layer clock beyond which the video is seeked back to the clock. */
export const VIDEO_SYNC_TOLERANCE = 0.2
/** A video no quad has shown for this long is paused (ms). */
export const VIDEO_IDLE_PAUSE_MS = 1000
/** Slowest playback rate browsers play at; below it the video is paused and seeked to the clock. */
const MIN_PLAYBACK_RATE = 0.0625
const DEG = Math.PI / 180
/** Indices in the playback state array. */
const CLOCK = 0
const LAST_TIME = 1
const RATE = 2

type Vec3 = readonly [number, number, number]

/** The asset references of a sticker declaration: `src`, or every entry of `{ pick }`. */
export function stickerRefs(decl: LayerDecl): string[] {
  const src = (decl as unknown as TStickerLayer).src
  return typeof src === 'string' ? [src] : [...src.pick]
}

export interface StickerOptions {
  /** Random draws in [0, 1) for `{ pick, by: "random" }`, one per face. Default: the seeded `ctx.random` (spec §12.5). */
  random?: () => number
  /**
   * What the quads show instead of the declaration's `src` (other object layers placed like stickers: `canvas`).
   * Several assets are picked from as with `{ pick, by: "face" }`.
   */
  assets?: readonly StickerAsset[]
}

/** Playback of a video asset by the layer that owns it. */
class VideoPlayback {
  readonly asset: StickerAsset
  readonly video: HTMLVideoElement
  readonly #loop: boolean
  readonly #warn: (message: string) => void
  #hiddenSince = -1
  #playFailed = false
  #onPlayError = (error: unknown) => {
    if (this.#playFailed) return
    this.#playFailed = true
    this.#warn(`a video sticker could not start playing: ${error instanceof Error ? error.message : String(error)}`)
  }

  constructor(asset: StickerAsset, video: HTMLVideoElement, loop: boolean, warn: (message: string) => void) {
    this.asset = asset
    this.video = video
    this.#loop = loop
    this.#warn = warn
    video.loop = loop
  }

  /**
   * Follows the layer clock (`play[CLOCK]`, s) at `play[RATE]`; `shown`: some quad displays the video this frame.
   * Numbers come through a typed array: a fractional number passed to a call V8 does not inline is boxed.
   */
  sync(play: Float64Array, shown: boolean, frame: FrameContext): void {
    const t = play[CLOCK]!
    const rate = play[RATE]!
    const now = frame.now
    const video = this.video
    if (!shown) {
      if (this.#hiddenSince < 0) this.#hiddenSince = now
      else if (now - this.#hiddenSince >= VIDEO_IDLE_PAUSE_MS && !video.paused) video.pause()
      return
    }
    this.#hiddenSince = -1
    const duration = video.duration
    const loop = this.#loop
    const target = videoTarget(t, duration, loop)
    const atEnd = !loop && Number.isFinite(duration) && t >= duration
    const drift = videoDrift(video.currentTime, target, duration, loop)
    if (rate < MIN_PLAYBACK_RATE || atEnd) {
      if (!video.paused) video.pause()
      // Paused: show the clock's frame exactly (a seek is cheap when the position rarely changes).
      if (!atEnd && Math.abs(drift) > 0.5 / 30 && !video.seeking) video.currentTime = target
      return
    }
    if (Math.abs(video.playbackRate - rate) > 0.01 * rate) video.playbackRate = rate
    if (Math.abs(drift) > VIDEO_SYNC_TOLERANCE && !video.seeking && Number.isFinite(duration)) video.currentTime = target
    if (video.paused && !this.#playFailed) video.play().catch(this.#onPlayError)
  }

  release(): void {
    this.video.pause()
    this.asset.owner = undefined
  }
}

/** One quad: the sticker shown for one selected face (or the screen). */
interface Instance {
  readonly mesh: Mesh<PlaneGeometry, StickerMaterial>
  /** Its place on the anchor, for the draw order (spec §7). */
  readonly placement: ObjectPlacement
  /** Face id the asset was picked for (−1: not picked yet). */
  faceId: number
}

export function createSticker(decl: LayerDecl, ctx: LayerContext, options: StickerOptions = {}): ObjectLayer {
  const d = decl as unknown as TStickerLayer
  const path = (name: string) => `${decl.id ? `layer "${decl.id}"` : 'sticker'}.${name}`

  const assets: readonly StickerAsset[] =
    options.assets ??
    stickerRefs(decl).map((ref) => {
      const value = ctx.assets.get(ref)
      if (!isStickerAsset(value)) throw new OuafError('asset', `Filter "${ctx.filterId}": asset "${ref}" is not an image, spritesheet or video, so a sticker cannot show it.`)
      return value
    })
  const by: PickMode = !options.assets && typeof d.src === 'object' && d.src.by === 'random' ? 'random' : 'face'
  const random = options.random ?? ctx.random

  const anchor = d.anchor ?? 'head'
  const screen = anchor === 'screen'
  const follow: AnchorFollow | 'auto' = d.follow ?? 'auto'
  const orientScreen = d.orient === 'screen'
  const faces: FacesSelector = d.faces ?? 'all'
  const blend: BlendMode = (d.blend as BlendMode | undefined) ?? 'normal'
  const loop = d.loop ?? true
  const autoplay = d.autoplay ?? true

  const env = ctx.bindings
  const visible: CompiledBinding<boolean> = compileBinding(d.visible ?? true, { type: 'boolean', fallback: true, path: path('visible'), name: 'visible' }, env)
  const opacity: NumberBinding = compileNumberBinding(d.opacity ?? 1, { fallback: 1, path: path('opacity'), name: 'opacity' }, env)
  const size: NumberBinding = compileNumberBinding(d.size ?? 1, { fallback: 1, path: path('size'), name: 'size' }, env)
  const scaleBinding = compileScale(d.scale ?? 1, path('scale'), ctx)
  const rate: NumberBinding = compileNumberBinding(d.rate ?? 1, { fallback: 1, path: path('rate'), name: 'rate' }, env)
  const offset: CompiledBinding<Vec3> = compileBinding(d.offset ?? [0, 0, 0], { type: 'vec3', fallback: [0, 0, 0], path: path('offset'), name: 'offset' }, env)
  const rotation: CompiledBinding<Vec3> = compileBinding(d.rotation ?? [0, 0, 0], { type: 'vec3', fallback: [0, 0, 0], path: path('rotation'), name: 'rotation' }, env)

  const root = new Group()
  root.name = decl.id ?? 'sticker'
  const geometry = new PlaneGeometry(1, 1)
  const count = screen ? 1 : instanceCount(faces, ctx.maxFaces)
  const instances: Instance[] = []
  for (let i = 0; i < count; i++) {
    const material = new StickerMaterial(blend)
    material.setAsset(assets[0]!)
    const mesh = new Mesh(geometry, material)
    mesh.matrixAutoUpdate = false
    mesh.frustumCulled = false
    mesh.visible = false
    root.add(mesh)
    instances.push({ mesh, placement: createPlacement(mesh, anchor), faceId: -1 })
  }

  // Videos this layer drives (the first layer to claim a video asset owns its playback).
  const players: VideoPlayback[] = []
  for (const asset of new Set(assets)) {
    if (asset.kind !== 'video' || !asset.video) continue
    if (asset.owner === undefined) {
      asset.owner = root
      players.push(new VideoPlayback(asset, asset.video, loop, ctx.warn))
    }
  }
  const shownVideos = new Uint8Array(players.length)

  // Per-frame scratch, allocated once.
  const slots = new Int32Array(Math.max(1, ctx.maxFaces))
  const ids = new Int32Array(Math.max(1, ctx.maxFaces))
  const sizes = new Float64Array(Math.max(1, ctx.maxFaces))
  const num = new Float64Array(6) // opacity, size, rate, scale x, y, z
  const anchorMatrix = new Matrix4()
  const local = new Matrix4()
  const position = new Vector3()
  const scale = new Vector3()
  const euler = new Euler()
  const quaternion = new Quaternion()
  const anchorPosition = new Vector3()
  // Playback state (clock, last frame time, rate) in a typed array: a double in a closure variable is boxed on write.
  const play = new Float64Array(3)
  play[LAST_TIME] = -1
  // A face was selected on the previous frame (face stickers): when none was, the first face to appear restarts
  // playback.
  let hadFace = false

  const pickFor = (inst: Instance, faceId: number) => {
    if (inst.faceId === faceId) return
    inst.faceId = faceId
    inst.mesh.material.setAsset(assets[pickIndex(by, faceId, assets.length, by === 'random' && assets.length > 1 ? random() : 0)]!)
  }

  /** Places `inst` for face slot `face` (NO_FACE for the screen); false when it is not shown this frame. */
  const place = (inst: Instance, face: number, frame: FrameContext): boolean => {
    if (!visible.evaluate(face)) return false
    opacity.write(face, num, 0)
    size.write(face, num, 1)
    const alpha = num[0]!
    const height = num[1]!
    if (!(alpha > 0) || !(height > 0)) return false
    if (!scaleBinding.write(face, num, 3)) return false
    if (screen) frame.anchors.screen(anchorMatrix)
    else if (!frame.anchors.face(face, anchor, follow, anchorMatrix)) return false

    const material = inst.mesh.material
    const asset = material.asset!
    const aspect = asset.height > 0 ? asset.width / asset.height : 1
    const o = offset.evaluate(face)
    const r = rotation.evaluate(face)
    inst.placement.face = screen ? 0 : frame.anchors.id(face)
    inst.placement.z = o[2]
    quaternion.setFromEuler(euler.set(r[0] * DEG, r[1] * DEG, r[2] * DEG))
    const m = inst.mesh.matrix
    const sx = height * aspect * num[3]!
    const sy = height * num[4]!
    const sz = num[5]!
    if (orientScreen && !screen) {
      // Position from the anchor frame, orientation from the screen: T(anchor · offset) · S(anchor scale) · R · S(size × scale).
      anchorPosition.set(o[0], o[1], o[2]).applyMatrix4(anchorMatrix)
      const e = anchorMatrix.elements
      const unit = Math.sqrt(e[0]! * e[0]! + e[1]! * e[1]! + e[2]! * e[2]!)
      m.compose(anchorPosition, quaternion, scale.set(unit * sx, unit * sy, unit * sz))
    } else {
      local.compose(position.set(o[0], o[1], o[2]), quaternion, scale.set(sx, sy, sz))
      m.multiplyMatrices(anchorMatrix, local)
    }
    material.params.x = alpha < 1 ? alpha : 1
    if (asset.frames) material.setFrame(spriteFrame(play[CLOCK]!, asset.frames.fps, asset.frames.count, loop))
    return true
  }

  return {
    kind: 'object',
    stage: d.overlay ? 'overlay' : 'objects',
    object: root,
    excludeFromCapture: d.overlay === true && d.excludeFromCapture === true,
    placements: instances.map((inst) => inst.placement),
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
      // Bindings of a screen sticker, and the layer's rate, read the first selected face (or the first tracked one).
      const lead = selected > 0 ? slots[0]! : tracked > 0 ? 0 : NO_FACE

      rate.write(lead, num, 2)
      const r = autoplay ? Math.max(0, num[2]!) : 0
      play[RATE] = r
      // (Re)start from the first frame at activation, and when the first selected face appears after none was; hidden
      // by `visible` or `opacity`, the clock keeps running (spec §6.3).
      if (play[LAST_TIME]! < 0 || (!screen && selected > 0 && !hadFace)) play[CLOCK] = 0
      else play[CLOCK]! += clockStep(play[LAST_TIME]!, frame.time) * r
      play[LAST_TIME] = frame.time

      shownVideos.fill(0)
      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i]!
        let shown = false
        if (screen) {
          pickFor(inst, lead === NO_FACE ? 0 : anchors.id(lead))
          shown = place(inst, lead, frame)
        } else if (i < selected) {
          const face = slots[i]!
          pickFor(inst, ids[face]!)
          shown = place(inst, face, frame)
        }
        inst.mesh.visible = shown
        if (shown && players.length > 0) {
          const asset = inst.mesh.material.asset
          for (let p = 0; p < players.length; p++) if (players[p]!.asset === asset) shownVideos[p] = 1
        }
      }
      for (let p = 0; p < players.length; p++) players[p]!.sync(play, shownVideos[p] === 1, frame)
      hadFace = selected > 0
    },
    dispose() {
      for (const p of players) p.release()
      for (const inst of instances) inst.mesh.material.dispose()
      geometry.dispose()
      root.removeFromParent()
    },
  }
}

/** Writes `out[face]`, the apparent size of face slot `face`: its face unit over its distance (`faces: "largest"`). */
export function apparentSize(anchors: FrameContext['anchors'], face: number, scratch: Matrix4, out: Float64Array): void {
  out[face] = 0
  if (!anchors.face(face, 'eyes', 'rigid', scratch)) return
  const e = scratch.elements
  out[face] = Math.sqrt(e[0]! * e[0]! + e[1]! * e[1]! + e[2]! * e[2]!) / Math.max(1e-3, -e[14]!)
}

export const stickerLayerType: LayerTypeImpl = {
  type: 'sticker',
  assets: stickerRefs,
  create: (decl, ctx) => createSticker(decl, ctx),
}
