/**
 * The `color` layer (spec §6.3, #23): color grading in the `color` stage, chained in stack then layer order (spec §7).
 * A built-in plugin: it registers the layer type and the loader of `.cube` LUTs (spec §10.2), which belong to it.
 *
 * - `lut`: a `.cube` file (asset name, `assets/…` path or `builtin:lut/…`), as a 3D texture with trilinear filtering.
 * - `brightness`, `contrast`, `saturation`, `temperature`, `tint`, `vignette`, `grain`: see `grade.ts` for the math,
 *   done on the sRGB-encoded values of the image buffers.
 * - `intensity`: strength of the LUT only; `opacity`: mix of the graded image with the layer's input.
 * - `region: "face"`: only inside the face ovals, with a soft edge (`face-mask.ts`); the pass is skipped with no face.
 *
 * Every property but `lut` and `region` is bindable (spec §8). A full-screen pass has one value per frame: bindings
 * are evaluated for the first face (`face.*` data, or their default when no face is tracked).
 */
import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  ClampToEdgeWrapping,
  Data3DTexture,
  DoubleSide,
  DynamicDrawUsage,
  GLSL3,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoColorSpace,
  RGBAFormat,
  RawShaderMaterial,
  Scene,
  Sphere,
  Vector3,
  Vector4,
  type Texture,
} from 'three'
import { compileBinding, compileNumberBinding, NO_FACE, type NumberBinding } from '../../bindings/index.ts'
import type { AssetLoader } from '../../engine/assets.ts'
import { FULLSCREEN_VERTEX } from '../../engine/compositor.ts'
import { AssetError } from '../../engine/errors.ts'
import type { LayerContext, LayerDecl, LayerTypeImpl, PassLayer } from '../../engine/layer-type.ts'
import type { OuafPlugin } from '../../engine/plugin.ts'
import { writeColor } from '../../params/values.ts'
import { CubeError, lutTextureData, parseCube } from './cube.ts'
import { MASK_INDICES, MASK_VERTICES, faceMaskIndices, faceMaskValues, writeFaceMask } from './face-mask.ts'
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

/** Loader of `lut` assets (`.cube`): parses the file and builds an RGBA16F 3D texture. */
export const lutLoader: AssetLoader<LoadedLut> = {
  kinds: ['lut'],
  async load(r) {
    const text = await (await r.read()).text()
    let lut
    try {
      lut = parseCube(text)
    } catch (cause) {
      if (cause instanceof CubeError) {
        throw new AssetError(r.ref, `LUT "${r.ref}" (${r.path}) is not a valid .cube file: ${cause.message}`, { cause })
      }
      throw cause
    }
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
  },
  dispose(value) {
    value.texture.dispose()
  },
}

const AMOUNT_NAMES = Object.keys(AMOUNT) as AmountName[]

function material(vertexShader: string, fragmentShader: string, uniforms: Record<string, { value: unknown }>, defines: Record<string, string>) {
  return new RawShaderMaterial({ glslVersion: GLSL3, vertexShader, fragmentShader, uniforms, defines, depthTest: false, depthWrite: false })
}

function createColorLayer(decl: LayerDecl, ctx: LayerContext): PassLayer {
  const lut = typeof decl.lut === 'string' ? ctx.assets.get<LoadedLut>(decl.lut) : undefined
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
  if (lut) {
    Object.assign(uniforms, { uLut: { value: lut.texture }, uLutScale: { value: lut.scale }, uLutOffset: { value: lut.offset }, uLutSize: { value: lut.size }, uLutMix })
    defines.HAS_LUT = ''
  }

  let full: RawShaderMaterial | undefined
  let face: { copy: RawShaderMaterial; scene: Scene; camera: Camera; mesh: Mesh<BufferGeometry, RawShaderMaterial>; positions: BufferAttribute } | undefined
  if (faceRegion) {
    const geometry = new BufferGeometry()
    const positions = new BufferAttribute(new Float32Array(ctx.maxFaces * MASK_VERTICES * 2), 2).setUsage(DynamicDrawUsage)
    geometry.setAttribute('position', positions)
    geometry.setAttribute('mask', new BufferAttribute(faceMaskValues(ctx.maxFaces), 1))
    geometry.setIndex(new BufferAttribute(faceMaskIndices(ctx.maxFaces), 1))
    geometry.boundingSphere = new Sphere(new Vector3(), Infinity)
    const mesh = new Mesh(geometry, material(FACE_VERTEX, GRADE_FRAGMENT, uniforms, { ...defines, FACE_REGION: '' }))
    mesh.material.side = DoubleSide // the contour's winding flips with mirroring
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    const scene = new Scene()
    scene.add(mesh)
    face = { copy: material(FULLSCREEN_VERTEX, COPY_FRAGMENT, { uInput }, {}), scene, camera: new Camera(), mesh, positions }
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
      writeGradeUniforms(values, tintRgba, frame.time, u)
      active = visible.evaluate(slot) && !isNeutral(u, !!lut) && (!face || count > 0)
      if (!active) return
      uGrade.value.set(u[U.mix]!, u[U.gamma]!, u[U.contrast]!, u[U.saturation]!)
      uGrade2.value.set(u[U.redGain]!, u[U.blueGain]!, u[U.vignette]!, u[U.grain]!)
      uTint.value.set(u[U.tintR]!, u[U.tintG]!, u[U.tintB]!, u[U.tintA]!)
      uSeed.value = u[U.seed]!
      uLutMix.value = u[U.lut]!
      if (face) {
        const projection = ctx.view.camera.projectionMatrix.elements
        const out = face.positions.array as Float32Array
        for (let f = 0; f < count; f++) writeFaceMask(frame.faces, f, f, frame.mirrored, projection, out)
        face.positions.needsUpdate = true
        face.mesh.geometry.setDrawRange(0, count * MASK_INDICES)
      }
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
      if (face) {
        face.copy.dispose()
        face.mesh.material.dispose()
        face.mesh.geometry.dispose()
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
