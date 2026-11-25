/**
 * The `color` layer (spec §6.3, #23): color grading in the `color` stage, chained in stack then layer order (spec §7).
 * A built-in plugin: it registers the layer type and the loader of `.cube` LUTs (spec §10.2), which belong to it.
 *
 * - `lut`: a `.cube` file (asset name, `assets/…` path or `builtin:lut/…`), as a 3D texture with trilinear filtering;
 *   or chosen by a param, or set by the script (spec §8.1, `compileContent`): none applies no LUT.
 * - `brightness`, `contrast`, `saturation`, `temperature`, `tint`, `vignette`, `grain`: see `grade.ts` for the math,
 *   done on the sRGB-encoded values of the image buffers.
 * - `intensity`: strength of the LUT only; `opacity`: mix of the graded image with the layer's input.
 * - `region: "face"`: only inside the face ovals, with a soft edge (`face-mask.ts`); the pass is skipped with no face.
 *
 * Every property but `lut` and `region` is bindable (spec §8). A full-screen pass has one value per frame: bindings
 * are evaluated for the first face (`face.*` data, or their default when no face is tracked).
 */
import {
  Camera,
  ClampToEdgeWrapping,
  Data3DTexture,
  DoubleSide,
  GLSL3,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoColorSpace,
  RGBAFormat,
  RawShaderMaterial,
  Scene,
  Vector3,
  Vector4,
  type Texture,
} from 'three'
import { compileBinding, compileNumberBinding, NO_FACE, type NumberBinding } from '../../bindings/index.ts'
import type { AssetLoader } from '../../engine/assets.ts'
import { FULLSCREEN_VERTEX } from '../../engine/compositor.ts'
import { compileContent } from '../../engine/content.ts'
import { AssetError } from '../../engine/errors.ts'
import type { LayerContext, LayerDecl, LayerTypeImpl, PassLayer } from '../../engine/layer-type.ts'
import type { OuafPlugin } from '../../engine/plugin.ts'
import { writeColor } from '../../params/values.ts'
import { CubeError, lutTextureData, parseCube } from './cube.ts'
import { FaceMaskMesh } from './face-mask-mesh.ts'
import { AMOUNT, AMOUNT_COUNT, AMOUNT_DEFS, U, UNIFORM_COUNT, isNeutral, writeGradeUniforms, type AmountName } from './grade.ts'
import { COPY_FRAGMENT, FACE_VERTEX, GRADE_FRAGMENT } from './shader.ts'

export { CubeError, LUT_1D_GRID, MAX_LUT_1D_SIZE, MAX_LUT_3D_SIZE, lutTextureData, parseCube, type CubeLut } from './cube.ts'

/** A loaded `.cube` LUT: its 3D texture (shared by every layer using it) and the input mapping of its domain. */
export interface LoadedLut {
  readonly texture: Data3DTexture
  /** Grid size of the texture. */
  readonly size: number
  /** Input mapping to [0, 1]: `c × scale + offset` (DOMAIN_MIN → 0, DOMAIN_MAX → 1). */
  readonly scale: Vector3
  readonly offset: Vector3
}

/** The loaded value of a `lut` asset (`lutLoader`). */
export function isLoadedLut(value: unknown): value is LoadedLut {
  const l = value as Partial<LoadedLut> | null
  return typeof l === 'object' && l !== null && (l.texture as { isData3DTexture?: boolean } | undefined)?.isData3DTexture === true &&
    typeof l.size === 'number'
}

/** Loader of `lut` assets (`.cube`): parses the file and builds an RGBA16F 3D texture. */
export const lutLoader: AssetLoader<LoadedLut> = {
  kinds: ['lut'],
  async load(r) {
    const text = await (await r.read()).text()
    try {
      return lutFromCube(text)
    } catch (cause) {
      if (cause instanceof CubeError) {
        throw new AssetError(r.ref, `LUT "${r.ref}" (${r.path}) is not a valid .cube file: ${cause.message}`, { cause })
      }
      throw cause
    }
  },
  dispose(value) {
    value.texture.dispose()
  },
}

/** The identity, 2³: what a layer whose LUT can change binds while it has none (its strength is then 0). */
const IDENTITY_CUBE = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'

/** Parses a `.cube` file into a LUT texture. Throws `CubeError`. */
function lutFromCube(text: string): LoadedLut {
  const lut = parseCube(text)
  const { size, data } = lutTextureData(lut)
  const texture = new Data3DTexture(data, size, size, size)
  texture.format = RGBAFormat
  texture.type = HalfFloatType
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.wrapS = texture.wrapT = texture.wrapR = ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.unpackAlignment = 1
  texture.colorSpace = NoColorSpace // values used as written: sRGB-encoded in, sRGB-encoded out
  texture.needsUpdate = true
  const [x0, y0, z0] = lut.domainMin
  const [x1, y1, z1] = lut.domainMax
  const scale = new Vector3(1 / (x1 - x0), 1 / (y1 - y0), 1 / (z1 - z0))
  return { texture, size, scale, offset: new Vector3(-x0 * scale.x, -y0 * scale.y, -z0 * scale.z) }
}

const AMOUNT_NAMES = Object.keys(AMOUNT) as AmountName[]

function material(vertexShader: string, fragmentShader: string, uniforms: Record<string, { value: unknown }>, defines: Record<string, string>) {
  return new RawShaderMaterial({ glslVersion: GLSL3, vertexShader, fragmentShader, uniforms, defines, depthTest: false, depthWrite: false })
}

function createColorLayer(decl: LayerDecl, ctx: LayerContext): PassLayer {
  const fixedLut = typeof decl.lut === 'string' ? ctx.assets.get<LoadedLut>(decl.lut) : undefined
  // `lut` bound to a parameter, or set by the script (spec §8, §12.4): the shader then always has a LUT input, the
  // identity at strength 0 while there is no LUT.
  const lutContent = compileContent(decl.lut, { name: 'lut', path: 'lut', accepts: isLoadedLut, what: 'a .cube LUT' }, ctx)
  const variable = lutContent.bound || ctx.bindings.overrides !== undefined
  const identity = variable && !fixedLut ? lutFromCube(IDENTITY_CUBE) : undefined
  let lut = fixedLut
  const faceRegion = decl.region === 'face'

  const visible = compileBinding(decl.visible ?? true, { type: 'boolean', fallback: true, path: 'visible', name: 'visible' }, ctx.bindings)
  const tint = compileBinding(decl.tint ?? '#ffffff', { type: 'color', fallback: '#ffffff', path: 'tint', name: 'tint' }, ctx.bindings)
  const amounts: NumberBinding[] = AMOUNT_NAMES.map((name) => {
    const { fallback } = AMOUNT_DEFS[name]
    return compileNumberBinding(decl[name] ?? fallback, { fallback, path: name, name }, ctx.bindings)
  })
  const values = new Float64Array(AMOUNT_COUNT)
  const tintRgba = new Float64Array(4)
  let lastTint: string | undefined
  const u = new Float32Array(UNIFORM_COUNT)

  const uInput: { value: Texture | null } = { value: null }
  const uGrade = { value: new Vector4() }
  const uGrade2 = { value: new Vector4() }
  const uTint = { value: new Vector4() }
  const uSeed = { value: 0 }
  const uLutMix = { value: 1 }
  const uniforms: Record<string, { value: unknown }> = { uInput, uGrade, uGrade2, uTint, uSeed }
  const defines: Record<string, string> = {}
  const bound = lut ?? identity
  const uLut = { value: bound?.texture }
  const uLutScale = { value: bound?.scale }
  const uLutOffset = { value: bound?.offset }
  const uLutSize = { value: bound?.size ?? 2 }
  if (bound) {
    Object.assign(uniforms, { uLut, uLutScale, uLutOffset, uLutSize, uLutMix })
    defines.HAS_LUT = ''
  }
  /** Points the shader at `next` (`undefined`: the identity, unused at strength 0). */
  const useLut = (next: LoadedLut | undefined) => {
    lut = next
    const l = next ?? identity!
    uLut.value = l.texture
    uLutScale.value = l.scale
    uLutOffset.value = l.offset
    uLutSize.value = l.size
  }

  let full: RawShaderMaterial | undefined
  let face: { copy: RawShaderMaterial; scene: Scene; camera: Camera; mask: FaceMaskMesh; mesh: Mesh<FaceMaskMesh['geometry'], RawShaderMaterial> } | undefined
  if (faceRegion) {
    const mask = new FaceMaskMesh(ctx.maxFaces)
    const mesh = new Mesh(mask.geometry, material(FACE_VERTEX, GRADE_FRAGMENT, uniforms, { ...defines, FACE_REGION: '' }))
    mesh.material.side = DoubleSide // the contour's winding flips with mirroring
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    const scene = new Scene()
    scene.add(mesh)
    face = { copy: material(FULLSCREEN_VERTEX, COPY_FRAGMENT, { uInput }, {}), scene, camera: new Camera(), mask, mesh }
  } else {
    full = material(FULLSCREEN_VERTEX, GRADE_FRAGMENT, uniforms, defines)
  }

  let active = false
  return {
    kind: 'pass',
    stage: 'color',
    get active() {
      return active
    },
    update(frame) {
      const count = Math.min(frame.faces.count, ctx.maxFaces)
      const slot = count > 0 ? 0 : NO_FACE
      for (let i = 0; i < AMOUNT_COUNT; i++) amounts[i]!.write(slot, values, i)
      const t = tint.evaluate(slot)
      if (t !== lastTint) {
        writeColor(t, tintRgba, 0)
        lastTint = t
      }
      if (variable) {
        // `null`: an asset parameter without a file, or a value `map` does not list: no LUT.
        const chosen = lutContent.evaluate(slot)
        const next = chosen === undefined ? fixedLut : (chosen ?? undefined)
        if (next !== lut) useLut(next)
      }
      writeGradeUniforms(values, tintRgba, frame.time, u)
      active = visible.evaluate(slot) && !isNeutral(u, !!lut) && (!face || count > 0)
      if (!active) return
      uGrade.value.set(u[U.mix]!, u[U.gamma]!, u[U.contrast]!, u[U.saturation]!)
      uGrade2.value.set(u[U.redGain]!, u[U.blueGain]!, u[U.vignette]!, u[U.grain]!)
      uTint.value.set(u[U.tintR]!, u[U.tintG]!, u[U.tintB]!, u[U.tintA]!)
      uSeed.value = u[U.seed]!
      uLutMix.value = lut ? u[U.lut]! : 0
      if (face) face.mask.update(frame.faces, count, frame.mirrored, ctx.view.camera.projectionMatrix.elements)
    },
    render(pass) {
      uInput.value = pass.input
      if (full) {
        pass.drawFullscreen(full)
        return
      }
      // Face region: the input unchanged, then the graded face ovals over it (they read the input themselves).
      pass.drawFullscreen(face!.copy)
      pass.renderer.setRenderTarget(pass.output)
      pass.renderer.render(face!.scene, face!.camera)
    },
    dispose() {
      full?.dispose()
      identity?.texture.dispose()
      if (face) {
        face.copy.dispose()
        face.mesh.material.dispose()
        face.mask.dispose()
      }
    },
  }
}

export const colorLayerType: LayerTypeImpl = {
  type: 'color',
  assets: (decl) => (typeof decl.lut === 'string' ? [decl.lut] : []),
  create: createColorLayer,
}

/** Built-in plugin of the `color` layer type and `.cube` LUTs. */
export const colorPlugin: OuafPlugin = {
  name: 'color',
  version: '1.0.0',
  official: true,
  setup(api) {
    api.registerAssetLoader(lutLoader)
    api.registerLayerType(colorLayerType)
  },
}
