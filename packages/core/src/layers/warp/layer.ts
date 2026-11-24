/**
 * The `warp` layer type (spec §6.3): deformations around one or more anchors, in the `warp` stage, so they apply to
 * the video and to whatever the `face` stage painted on it (spec §7), not to the objects drawn after.
 *
 * One full-screen pass per layer. Every frame, `update` evaluates the bindable properties per selected face, places
 * each (face, anchor) centre on screen with the objects camera (`WarpPacker`), and the shader applies them all in
 * one draw. Uniform arrays are sized once for `maxFaces × anchors` centres; nothing is allocated per frame.
 *
 * - `radius` is in face units (1 = the eye distance, spec §5.1): it follows the distance of each face.
 * - `direction` (stretch) is in the anchor frame: it turns with the head, as seen on screen (mirroring included).
 * - `opacity` scales the strength (a deformation has no alpha); `visible: false` removes the face's centres.
 * - `anchor: "screen"` puts a centre at the middle of the screen, radius in screen heights (spec §5.2); it does
 *   not need a face.
 *
 * The pass is inactive (skipped, no full-screen copy) when no centre has an effect: no face tracked, strength,
 * opacity or radius 0, or not visible.
 */
import type { TWarpLayer } from '@ouaf/spec'
import { GLSL3, Matrix4, RawShaderMaterial, type Texture } from 'three'
import { compileBinding, compileNumberBinding } from '../../bindings/compile.ts'
import { NO_FACE } from '../../bindings/types.ts'
import { FULLSCREEN_VERTEX } from '../../engine/compositor.ts'
import type { LayerContext, LayerDecl, PassLayer } from '../../engine/layer-type.ts'
import { parseFacesSelector, selectFaces } from '../faces.ts'
import { warpFragment } from './shader.ts'
import { MAX_CENTRES, WARP_KINDS, WarpPacker, type WarpKind } from './warp-math.ts'

/** Defaults of the bindable properties: the schema's (packages/spec/src/layers.ts); direction from spec §6.3. */
const DEFAULT_RADIUS = 0.5
const DEFAULT_STRENGTH = 0.3
const DEFAULT_DIRECTION: readonly [number, number] = [0, 1]

export function createWarpLayer(layer: LayerDecl, ctx: LayerContext): PassLayer {
  const decl = layer as unknown as TWarpLayer
  const kind: WarpKind = (WARP_KINDS as readonly string[]).includes(decl.kind) ? decl.kind : 'bulge'
  const anchors = typeof decl.anchor === 'string' ? [decl.anchor] : [...decl.anchor]
  const faceAnchors = anchors.filter((a) => a !== 'screen')
  const screenAnchors = anchors.length - faceAnchors.length
  const facesSelector = parseFacesSelector(decl.faces)

  const wanted = faceAnchors.length * ctx.maxFaces + screenAnchors
  if (wanted > MAX_CENTRES) {
    ctx.warn(`${ctx.filterId}: warp layer${decl.id ? ` "${decl.id}"` : ''} has ${wanted} centres (faces × anchors), only the first ${MAX_CENTRES} are applied.`)
  }
  const packer = new WarpPacker(wanted)

  const env = ctx.bindings
  const radius = compileNumberBinding(decl.radius ?? DEFAULT_RADIUS, { fallback: DEFAULT_RADIUS, path: 'radius', name: 'radius' }, env)
  const strength = compileNumberBinding(decl.strength ?? DEFAULT_STRENGTH, { fallback: DEFAULT_STRENGTH, path: 'strength', name: 'strength' }, env)
  const opacity = compileNumberBinding(decl.opacity ?? 1, { fallback: 1, path: 'opacity', name: 'opacity' }, env)
  const visible = compileBinding(decl.visible ?? true, { type: 'boolean', fallback: true, path: 'visible', name: 'visible' }, env)
  const direction = compileBinding(decl.direction ?? DEFAULT_DIRECTION, { type: 'vec2', fallback: DEFAULT_DIRECTION, path: 'direction', name: 'direction' }, env)

  const uInput: { value: Texture | null } = { value: null }
  const uAspect = { value: 1 }
  const uCount = { value: 0 }
  const uniforms: Record<string, { value: unknown }> = { uInput, uAspect, uCount, uA: { value: packer.a } }
  if (kind === 'stretch') uniforms.uB = { value: packer.b }
  const material = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: warpFragment(kind, packer.capacity),
    uniforms,
    depthTest: false,
    depthWrite: false,
  })

  // Preallocated per-frame state.
  const values = new Float64Array(5) // radius, strength, direction x, y (`WarpProps`), then opacity
  const matrix = new Matrix4()
  const slots = new Int32Array(ctx.maxFaces)
  const ids = new Int32Array(ctx.maxFaces)
  const sizes = new Float64Array(ctx.maxFaces)

  /** Evaluates the properties for face `face` (or NO_FACE) into `values`; false when they have no effect. */
  const evaluate = (face: number): boolean => {
    if (!visible.evaluate(face)) return false
    radius.write(face, values, 0)
    strength.write(face, values, 1)
    opacity.write(face, values, 4)
    const o = values[4]!
    values[1] = values[1]! * (o < 0 ? 0 : o > 1 ? 1 : o)
    if (!(values[0]! > 0) || values[1] === 0) return false
    const d = direction.evaluate(face)
    values[2] = d[0]
    values[3] = d[1]
    return true
  }

  return {
    kind: 'pass',
    stage: 'warp',
    get active() {
      return packer.count > 0
    },
    update(frame) {
      packer.begin(ctx.view.camera.projectionMatrix.elements, frame.width, frame.height)
      if (screenAnchors > 0 && evaluate(NO_FACE)) {
        for (let i = 0; i < screenAnchors; i++) packer.addScreen(values)
      }
      const count = Math.min(frame.faces.count, ctx.maxFaces)
      if (faceAnchors.length > 0 && count > 0) {
        for (let i = 0; i < count; i++) {
          ids[i] = frame.anchors.id(i)
          if (facesSelector === 'largest') {
            if (frame.anchors.face(i, 'head', 'rigid', matrix)) packer.unitSize(matrix.elements, sizes, i)
            else sizes[i] = 0
          }
        }
        const n = selectFaces(facesSelector, count, ids, sizes, slots)
        for (let s = 0; s < n; s++) {
          const face = slots[s]!
          if (!evaluate(face)) continue
          for (let a = 0; a < faceAnchors.length; a++) {
            if (!frame.anchors.face(face, faceAnchors[a]!, 'auto', matrix)) continue
            packer.addFace(matrix.elements, values)
          }
        }
      }
      uCount.value = packer.count
      // Stored only when it changes: a fractional number written into a uniform object allocates a heap number.
      const aspect = frame.width > 0 && frame.height > 0 ? frame.width / frame.height : 1
      if (aspect !== uAspect.value) uAspect.value = aspect
    },
    render(pass) {
      uInput.value = pass.input
      pass.drawFullscreen(material)
    },
    dispose() {
      material.dispose()
    },
  }
}
