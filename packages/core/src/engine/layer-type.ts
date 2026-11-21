/**
 * Contract between the engine and a layer type (spec §6, §7, §14). Every layer type, built-in or third-party, is
 * provided by a plugin as a `LayerTypeImpl`; the engine creates one `LayerInstance` per layer declaration of an
 * active filter and drives it every frame.
 *
 * Two kinds of instances, by render stage (spec §7):
 * - **pass** layers (`background`, `face`, `warp`, `color` stages: `shader`, `warp`, `color`) are full-screen image
 *   operations, chained: each reads the image produced so far and writes the next one (`PassLayer.render`).
 * - **object** layers (`objects` and `overlay` stages: `text`, `sticker`, `model`, `canvas`) contribute three.js
 *   objects to a scene shared by the whole stack (`ObjectLayer.object`). The engine renders the `objects` scene once,
 *   depth-sorted, with a camera matched to the tracker (see `ObjectsView`), and the `overlay` scene after color grading,
 *   with the same camera. Screen-anchored objects (`anchor: "screen"`) sit on a plane in front of the faces
 *   (`AnchorProvider.screen`).
 *
 * Instances are updated once per rendered frame (`update`), after tracking and params, before rendering. They must not
 * allocate in `update`/`render` in the steady state.
 */
import type { Stage } from '@ouaf/spec'
import type { Camera, Material, Object3D, Texture, WebGLRenderTarget, WebGLRenderer } from 'three'
import type { FaceFrame } from '../face.ts'
import type { AnchorProvider } from './anchor-provider.ts'
import type { LoadedAssets } from './assets.ts'
import type { ParamReader } from './params.ts'

/** A layer declaration as written in the manifest (already validated against the layer type's schema). */
export type LayerDecl = { readonly type: string; readonly id?: string } & Readonly<Record<string, unknown>>

/** Per-frame data shared by every layer of the stack. Valid during `update`/`render` only; never retain it. */
export interface FrameContext {
  /** Media time of the frame in seconds (`time` data path; deterministic with file sources, spec §12.5). */
  readonly time: number
  /** Monotonic clock of the frame in milliseconds. */
  readonly now: number
  /** Milliseconds since the previous rendered frame (0 on the first one). */
  readonly dt: number
  /** Latest tracking result shared by the stack (spec §7); `count = 0` when no face, or no face tracking. */
  readonly faces: FaceFrame
  /** Anchor frames of the tracked faces, in the objects camera space (spec §5). */
  readonly anchors: AnchorProvider
  /** Internal render resolution in pixels. */
  readonly width: number
  readonly height: number
  /** True when the image is displayed mirrored (front camera); anchors already account for it. */
  readonly mirrored: boolean
}

/** What a pass layer gets to draw with. */
export interface PassContext {
  readonly renderer: WebGLRenderer
  /** The image produced by the previous stages and passes (sRGB-encoded, like the canvas). */
  readonly input: Texture
  /** Where to write the result; `null` = the canvas (never the same target as `input`). */
  readonly output: WebGLRenderTarget | null
  /** Draws a full-screen triangle with `material` into `output` (`material` samples `input` itself). */
  drawFullscreen(material: Material): void
}

/** Shared scene and camera of the `objects` stage (and the screen-space `overlay` stage). */
export interface ObjectsView {
  /**
   * Perspective camera of the objects stage: camera space with +x right, +y up, looking down -z, vertical field of
   * view of the tracker over the analysed frame, the cover crop applied in its projection. Anchor matrices from
   * `AnchorProvider` are in this space.
   */
  readonly camera: Camera
}

/** Services available to a layer instance for its whole life. */
export interface LayerContext {
  /** The filter's id (for messages). */
  readonly filterId: string
  readonly renderer: WebGLRenderer
  readonly view: ObjectsView
  /** The filter's preloaded assets (spec §10.4: every asset is loaded before the filter is activated). */
  readonly assets: LoadedAssets
  /** The filter's current parameter values (spec §9), read-only. */
  readonly params: ParamReader
  /** Maximum number of faces of the engine: size per-face resources for it. */
  readonly maxFaces: number
  /** Reports a non-fatal problem to the host (`engine.on('warning')`). */
  warn(message: string): void
}

interface LayerInstanceBase {
  readonly stage: Stage
  /** Called once per rendered frame before rendering. */
  update(frame: FrameContext): void
  /** Frees GPU and other resources. Called once, when the filter is removed or the engine disposed. */
  dispose(): void
}

export interface PassLayer extends LayerInstanceBase {
  readonly kind: 'pass'
  /**
   * False when the pass would leave the image unchanged this frame (no face for a face-only effect, opacity 0,
   * strength 0…): the engine then skips it, saving a full-screen copy.
   */
  readonly active: boolean
  render(pass: PassContext): void
}

export interface ObjectLayer extends LayerInstanceBase {
  readonly kind: 'object'
  /**
   * Root of the layer's objects, added by the engine to the `objects` scene (or the overlay scene when `stage` is
   * `overlay`). The layer positions its children in `update` (one child per face when `faces` selects several) and
   * sets `visible`. The root's own matrix is managed by the engine (identity): do not move it.
   */
  readonly object: Object3D
  /** The layer is left out of photos, recordings and the output stream (`excludeFromCapture`, spec §6.2). */
  readonly excludeFromCapture?: boolean
}

export type LayerInstance = PassLayer | ObjectLayer

/** Implementation of a layer type, registered by a plugin (`PluginApi.registerLayerType`). */
export interface LayerTypeImpl {
  /** Layer `type`, matching the vocabulary the plugin declares (`OuafPlugin.vocabulary.layers`). */
  readonly type: string
  /**
   * Asset references the layer needs (`src`, `font`, `lut`, `textures`…), so the engine preloads them before activating
   * the filter. References are as written: asset names, `assets/…` paths or `builtin:…`. Default: none.
   */
  assets?(layer: LayerDecl): Iterable<string>
  /** Creates the instance; may be async (shader compilation, glTF parsing). Errors reject the whole filter. */
  create(layer: LayerDecl, ctx: LayerContext): LayerInstance | Promise<LayerInstance>
}
