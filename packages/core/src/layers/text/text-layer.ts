/**
 * The `text` layer type (spec §6.3): text drawn with Canvas 2D into a texture, on a plane attached to an anchor
 * (spec §5, §6.2).
 *
 * - `font`: a font asset, or chosen by a param, or set by the script (spec §8.1, `compileContent`): none gives the
 *   default font. A new font redraws the texture.
 * - The texture is redrawn only when the text, its color or its wrap width change (`TextRaster`), or when its size on
 *   screen calls for another resolution (`resolution.ts`, #147: by √2 steps, with hysteresis, `scale` counted once
 *   settled); the transform (`offset`, `rotation`, `size`, `scale`), `opacity` and `visible` are applied on the GPU
 *   side every frame.
 * - One plane per selected face (`faces`). When neither `text` nor `color` (nor `size`, with `maxWidth`) reads face
 *   data, every face shares one texture; otherwise each face slot has its own.
 * - `size` is the font size (em) in anchor units; the anchor point is on the alignment edge of the text block
 *   (left edge for `align: "left"`, centre, right edge), at its vertical middle. `scale` multiplies the drawn block
 *   (per axis with `[x, y, z]`) around that point, after layout: it changes neither the wrapping nor the texture.
 * - `orient: "screen"`: the plane stays parallel to the screen, upright, at the anchor's position and scale.
 */
import { NO_FACE, compileBinding, compileNumberBinding, type CompiledBinding, type NumberBinding } from '../../bindings/index.ts'
import { createPlacement } from '../../engine/draw-order.ts'
import type { FrameContext, LayerContext, LayerDecl, ObjectLayer, ObjectPlacement } from '../../engine/layer-type.ts'
import type { AnchorFollow } from '../../anchors.ts'
import {
  CanvasTexture,
  Euler,
  Group,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three'
import { compileScale } from '../scale.ts'
import { selectFaces, type FacesSelector } from '../faces.ts'
import { compileContent } from '../../engine/content.ts'
import { isLoadedFont, type LoadedFont } from './font-loader.ts'
import type { TextAlign } from './layout.ts'
import { TextRaster, type SurfaceFactory, type TextContext, type TextStyle } from './raster.ts'
import { Resolution, SettledScale } from './resolution.ts'

export const DEFAULT_FONT = 'builtin:font/sans-bold'
/** Shadow defaults, relative to the font size (the schema leaves them open). */
export const DEFAULT_SHADOW_BLUR = 0.1
export const DEFAULT_SHADOW_OFFSET: readonly [number, number] = [0.04, -0.04]

/** The font reference of a text layer declaration. */
export function textFontRef(decl: LayerDecl): string {
  return typeof decl.font === 'string' ? decl.font : DEFAULT_FONT
}

/** A canvas element in a page, an `OffscreenCanvas` in a worker (the font set of each is where the font loader adds the face). */
export const defaultSurface: SurfaceFactory = () => {
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1)
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d') as TextContext | null
  if (!ctx) throw new Error('text layer: no 2D canvas context available.')
  return { canvas, ctx }
}

/** The style of a validated declaration (everything that is not bindable). */
export function textStyle(decl: LayerDecl, font: Pick<LoadedFont, 'family' | 'weight' | 'style'>): TextStyle {
  const outline = decl.outline as { width: number; color: string } | undefined
  const shadow = decl.shadow as { color: string; blur?: number; offset?: [number, number] } | undefined
  return {
    family: font.family,
    weight: font.weight,
    style: font.style,
    align: (decl.align as TextAlign | undefined) ?? 'center',
    lineHeight: typeof decl.lineHeight === 'number' ? decl.lineHeight : 1.2,
    outline: outline && outline.width > 0 ? { width: outline.width, color: outline.color } : undefined,
    shadow: shadow && { color: shadow.color, blur: shadow.blur ?? DEFAULT_SHADOW_BLUR, offset: shadow.offset ?? DEFAULT_SHADOW_OFFSET },
  }
}

export interface TextLayerOptions {
  /** Canvas factory (tests); default `defaultSurface`. */
  surface?: SurfaceFactory
}

interface Slot {
  raster: TextRaster
  texture: CanvasTexture<OffscreenCanvas>
  /** The font the raster draws with. */
  font: LoadedFont
  resolution: Resolution
  /** Largest size on screen of the instances drawn with it this frame, in pixels per em. */
  need: number
}

export function createTextLayer(decl: LayerDecl, ctx: LayerContext, options: TextLayerOptions = {}): ObjectLayer {
  // The manifest's font; the default one when `font` is bound to a parameter (shown while it gives no font).
  const font = ctx.assets.get<LoadedFont>(textFontRef(decl))
  const style = textStyle(decl, font)
  const env = ctx.bindings
  const at = (p: string) => (decl.id ? `${decl.id}.${p}` : p)
  // `font` bound to a parameter, or set by the script (spec §8, §12.4).
  const fontContent = compileContent(decl.font, { name: 'font', path: at('font'), accepts: isLoadedFont, what: 'a font' }, ctx)

  const text: CompiledBinding<string> = compileBinding(decl.text, { type: 'string', fallback: '', path: at('text'), name: 'text' }, env)
  const color: CompiledBinding<string> = compileBinding(decl.color ?? '#ffffff', { type: 'color', fallback: '#ffffff', path: at('color'), name: 'color' }, env)
  const size: NumberBinding = compileNumberBinding(decl.size ?? 0.3, { fallback: 0.3, path: at('size'), name: 'size' }, env)
  const scale = compileScale(decl.scale ?? 1, at('scale'), ctx)
  const opacity: NumberBinding = compileNumberBinding(decl.opacity ?? 1, { fallback: 1, path: at('opacity'), name: 'opacity' }, env)
  const visible: CompiledBinding<boolean> = compileBinding(decl.visible ?? true, { type: 'boolean', fallback: true, path: at('visible'), name: 'visible' }, env)
  const zero = [0, 0, 0] as const
  const offset = compileBinding(decl.offset ?? zero, { type: 'vec3', fallback: zero, path: at('offset'), name: 'offset' }, env)
  const rotation = compileBinding(decl.rotation ?? zero, { type: 'vec3', fallback: zero, path: at('rotation'), name: 'rotation' }, env)

  const anchor = typeof decl.anchor === 'string' ? decl.anchor : 'head'
  const onScreen = anchor === 'screen'
  const follow = (decl.follow as AnchorFollow | 'auto' | undefined) ?? 'auto'
  const faces = (decl.faces as FacesSelector | undefined) ?? 'all'
  const orientScreen = decl.orient === 'screen'
  const overlay = decl.overlay === true
  const maxWidth = typeof decl.maxWidth === 'number' ? decl.maxWidth : undefined

  // Instances: one for the screen, else as many as the selector can pick.
  const instances = onScreen ? 1 : faces === 'all' ? ctx.maxFaces : faces === 'first' || faces === 'largest' ? 1 : Math.min(faces, ctx.maxFaces)
  // One texture per instance only when the drawn content can differ between faces.
  const perFace = text.perFace || color.perFace || (maxWidth !== undefined && size.perFace)
  const createSurface = options.surface ?? defaultSurface
  const slots: Slot[] = []
  for (let i = 0; i < (perFace ? instances : 1); i++) {
    const raster = new TextRaster(style, createSurface)
    const texture = new CanvasTexture(raster.surface.canvas as OffscreenCanvas)
    texture.colorSpace = SRGBColorSpace
    slots.push({ raster, texture, font, resolution: new Resolution(), need: 0 })
  }

  const root = new Group()
  const geometry = new PlaneGeometry(1, 1)
  const meshes: Mesh<PlaneGeometry, MeshBasicMaterial>[] = []
  const placements: ObjectPlacement[] = []
  for (let i = 0; i < instances; i++) {
    const material = new MeshBasicMaterial({
      map: slots[perFace ? i : 0]!.texture,
      transparent: true,
      depthWrite: false,
      // The overlay is drawn on top of everything (spec §6.2).
      depthTest: !overlay,
      toneMapped: false,
    })
    const mesh = new Mesh(geometry, material)
    mesh.matrixAutoUpdate = false
    mesh.frustumCulled = false
    mesh.visible = false
    root.add(mesh)
    meshes.push(mesh)
    placements.push(createPlacement(mesh, anchor))
  }

  // Per-frame scratch, allocated once.
  const maxFaces = ctx.maxFaces
  const anchorMatrices = Array.from({ length: maxFaces }, () => new Matrix4())
  const ok = new Uint8Array(maxFaces)
  const ids = new Int32Array(maxFaces)
  const apparent = new Float64Array(maxFaces)
  const selected = new Int32Array(instances)
  const num = new Float64Array(5) // opacity, size, scale x, y, z
  // Per instance, between the two passes of `update`: shown, opacity, size, the matrix before the plane.
  const shown = new Uint8Array(instances)
  const alphas = new Float64Array(instances)
  const sizes = new Float64Array(instances)
  const bases = Array.from({ length: instances }, () => new Matrix4())
  const settled = Array.from({ length: instances }, () => new SettledScale())
  const euler = new Euler()
  const quat = new Quaternion()
  const pos = new Vector3()
  const scl = new Vector3()
  const local = new Matrix4()
  const plane = new Matrix4()
  const screenMatrix = new Matrix4()
  const projection = (ctx.view?.camera as { projectionMatrix?: Matrix4 } | undefined)?.projectionMatrix

  /** The content of the slot's texture for `face`: draws it if needed (at the slot's resolution); false when empty. */
  const refresh = (slot: Slot, face: number, sizeValue: number): boolean => {
    const chosen = fontContent.evaluate(face) ?? font
    if (chosen !== slot.font) {
      slot.font = chosen
      slot.raster.setFont(chosen)
    }
    const content = text.evaluate(face)
    const wrap = maxWidth === undefined ? Infinity : maxWidth / sizeValue
    if (slot.raster.update(content, color.evaluate(face), wrap)) {
      const { raster, texture } = slot
      if (raster.resized) texture.dispose() // the GPU texture is reallocated at the new canvas size
      texture.repeat.set(raster.uScale, raster.vScale)
      texture.offset.set(0, 1 - raster.vScale) // the image is at the top of the canvas (flipY)
      texture.needsUpdate = true
    }
    return content !== ''
  }

  /**
   * The matrix of instance `k` before its plane (anchor · offset · rotation · size × scale, in camera space) into
   * `bases[k]`, and its draw-order place; returns its size on screen in pixels per em, with `scale` counted once
   * settled. The size and scale factors are in `num[1..4]`.
   */
  const placeBase = (k: number, placement: ObjectPlacement, face: number, anchorMatrix: Matrix4, frame: FrameContext): number => {
    const sizeValue = num[1]!
    const off = offset.evaluate(face)
    placement.face = onScreen ? 0 : frame.anchors.id(face)
    placement.z = off[2]
    const rot = rotation.evaluate(face)
    euler.set(MathUtils.degToRad(rot[0]), MathUtils.degToRad(rot[1]), MathUtils.degToRad(rot[2]))
    quat.setFromEuler(euler)
    const base = bases[k]!
    const a = anchorMatrix.elements
    const anchorUnit = Math.max(Math.hypot(a[0]!, a[1]!, a[2]!), Math.hypot(a[4]!, a[5]!, a[6]!))
    if (orientScreen && !onScreen) {
      // Position and scale of the anchor (offset in the anchor frame), axes of the screen.
      pos.set(off[0], off[1], off[2]).applyMatrix4(anchorMatrix)
      const unit = anchorUnit * sizeValue
      scl.set(unit * num[2]!, unit * num[3]!, unit * num[4]!)
      base.compose(pos, quat, scl)
    } else {
      pos.set(off[0], off[1], off[2])
      scl.set(sizeValue * num[2]!, sizeValue * num[3]!, sizeValue * num[4]!)
      local.compose(pos, quat, scl)
      base.multiplyMatrices(anchorMatrix, local)
    }
    // An em on screen: its length in camera space over its distance, times the focal length in pixels.
    const depth = -base.elements[14]!
    if (!(depth > 1e-6) || !projection) return 0
    const focal = (projection.elements[5]! * frame.height) / 2
    const scale = settled[k]!.update(Math.max(num[2]!, num[3]!), frame.time)
    return ((anchorUnit * sizeValue) / depth) * focal * scale
  }

  return {
    kind: 'object',
    stage: overlay ? 'overlay' : 'objects',
    object: root,
    excludeFromCapture: overlay && decl.excludeFromCapture === true,
    placements,
    update(frame) {
      let n: number
      if (onScreen) {
        frame.anchors.screen(screenMatrix)
        selected[0] = frame.faces.count > 0 ? 0 : NO_FACE
        n = 1
      } else {
        const count = Math.min(frame.faces.count, maxFaces)
        for (let i = 0; i < count; i++) {
          const m = anchorMatrices[i]!
          ok[i] = frame.anchors.face(i, anchor, follow, m) ? 1 : 0
          ids[i] = frame.anchors.id(i)
          // Apparent size: scale of the anchor frame over its distance to the camera.
          const e = m.elements
          apparent[i] = ok[i] ? Math.hypot(e[0]!, e[1]!, e[2]!) / Math.max(1e-6, -e[14]!) : 0
        }
        n = selectFaces(faces, count, ids, apparent, selected, ok)
      }
      for (const slot of slots) slot.need = 0
      // First pass: what is shown, where, and how large on screen.
      for (let k = 0; k < meshes.length; k++) {
        shown[k] = 0
        if (k >= n) continue
        const face = selected[k]!
        opacity.write(face, num, 0)
        size.write(face, num, 1)
        if (!visible.evaluate(face) || !(num[0]! > 0) || !(num[1]! > 0) || !scale.write(face, num, 2)) continue
        alphas[k] = num[0]!
        sizes[k] = num[1]!
        const need = placeBase(k, placements[k]!, face, onScreen ? screenMatrix : anchorMatrices[face]!, frame)
        const slot = slots[perFace ? k : 0]!
        slot.need = Math.max(slot.need, need)
        shown[k] = 1
      }
      // The resolution of each texture, then its content and the planes.
      for (const slot of slots) {
        const px = slot.resolution.update(slot.need, frame.time)
        if (px !== undefined) slot.raster.setPixelsPerEm(px)
      }
      for (let k = 0; k < meshes.length; k++) {
        const mesh = meshes[k]!
        const slot = slots[perFace ? k : 0]!
        if (!shown[k] || !refresh(slot, selected[k]!, sizes[k]!)) {
          mesh.visible = false
          continue
        }
        // The plane in em: its centre relative to the anchor point, its size.
        const raster = slot.raster
        const w = raster.width
        const h = raster.height
        plane.set(w, 0, 0, w / 2 - raster.originX, 0, h, 0, raster.originY - h / 2, 0, 0, 1, 0, 0, 0, 0, 1)
        mesh.matrix.multiplyMatrices(bases[k]!, plane)
        mesh.material.opacity = Math.min(1, alphas[k]!)
        mesh.visible = true
      }
    },
    dispose() {
      geometry.dispose()
      for (const m of meshes) m.material.dispose()
      for (const s of slots) s.texture.dispose()
    },
  }
}
