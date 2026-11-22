/**
 * The `shader` layer type (spec §11, #24): a GLSL ES 3.00 `vec4 effect(vec2 uv)` written by the filter's author, run
 * as a pass in the stage it declares (spec §7):
 *
 * - `background`: full screen, before the video (the image so far is empty: black). Only one filter of the stack
 *   draws a background (the engine keeps the last one). The video is opaque, so it covers a background until a
 *   segmentation plugin cuts the person out of it.
 * - `face`: limited to the face mesh (the face oval of every tracked face, with a soft edge), after the video and
 *   before the warps, which deform it with the image. Skipped when no face is tracked.
 * - `post` (default): full screen, in the `color` stage, chained with the color layers in stack then layer order.
 *
 * The author's source is wrapped by `wrapShader` (`@ouaf/spec`), which declares the inputs (`ouaf_sample`,
 * `ouaf_time`… spec §11.1), the `uniforms` and `textures`, and the `main()` that mixes `effect()`'s color over the
 * image by its alpha × `opacity`. The program is compiled and linked when the layer is created (`checkProgram`):
 * errors reject the filter with a `ShaderCompileError`, lines counted in the author's file.
 *
 * Costly inputs are only set up when the source uses them (spec §11.1): `ouaf_prevFrame` keeps two image buffers
 * (this shader's output at the previous frame, black at the first one), `ouaf_faceMask` draws the face ovals into a
 * half-resolution mask texture, `ouaf_faceSize` and the declared anchors are projected every frame.
 *
 * `textures` are images (PNG, WebP, JPEG, AVIF, SVG, emoji), spritesheets (the whole sheet) or videos (played in a
 * loop), sampled like the image: origin at the bottom left, straight (not premultiplied) alpha, sRGB-encoded values,
 * repeated outside 0–1.
 *
 * `visible`, `opacity` and every uniform are bindable (spec §8), evaluated for the first face.
 */
import {
  checkShaderSource,
  ShaderDeclarationError,
  wrapShader,
  SHADER_INTERNALS as I,
  type ShaderStage,
  type TShaderLayer,
  type WrappedShader,
} from '@ouaf/spec'
import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  ClampToEdgeWrapping,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  GLSL3,
  LinearFilter,
  LinearMipmapLinearFilter,
  MaxEquation,
  Mesh,
  NoColorSpace,
  OneFactor,
  RawShaderMaterial,
  RepeatWrapping,
  Scene,
  Sphere,
  Texture,
  Vector3,
  VideoTexture,
  WebGLRenderTarget,
  type Material,
  type WebGLRenderer,
} from 'three'
import { BindingError, compileBinding, compileNumberBinding } from '../../bindings/compile.ts'
import { NO_FACE } from '../../bindings/types.ts'
import { OuafError, ShaderCompileError } from '../../engine/errors.ts'
import type { LayerContext, LayerDecl, PassContext, PassLayer } from '../../engine/layer-type.ts'
import { MASK_INDICES, MASK_VERTICES, faceMaskIndices, faceMaskValues, writeFaceMask } from '../color/face-mask.ts'
import { isStickerAsset, type StickerAsset } from '../sticker/assets.ts'
import { checkProgram, type CompileContext } from './compile.ts'
import { ShaderFaceInputs } from './inputs.ts'
import { ShaderUniforms, UniformTypeError } from './uniforms.ts'

/** Vertex shader of full-screen passes: `position` in clip space (the compositor's triangle, or ours). */
export const SHADER_FULLSCREEN_VERTEX = /* glsl */ `
precision highp float;
in vec2 position;
out vec2 ${I.uv};
void main() {
  ${I.uv} = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`

/** Vertex shader of the face mesh (`face` stage, face mask): clip-space positions and the mask value (`face-mask.ts`). */
export const SHADER_FACE_VERTEX = /* glsl */ `
precision highp float;
in vec2 position;
in float mask;
out vec2 ${I.uv};
out float ${I.meshMask};
void main() {
  ${I.uv} = position * 0.5 + 0.5;
  ${I.meshMask} = mask;
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const MASK_FRAGMENT = /* glsl */ `
precision highp float;
in float ${I.meshMask};
out vec4 fragColor;
void main() {
  fragColor = vec4(vec3(smoothstep(0.0, 1.0, ${I.meshMask})), 1.0);
}
`

const COPY_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D ouaf_src;
in vec2 ${I.uv};
out vec4 fragColor;
void main() {
  fragColor = texture(ouaf_src, ${I.uv});
}
`

const STAGES = { background: 'background', face: 'face', post: 'color' } as const

/** Asset references of a shader layer: its source and its textures. */
export function shaderAssets(decl: LayerDecl): string[] {
  const d = decl as unknown as TShaderLayer
  return [d.src, ...Object.values(d.textures ?? {})]
}

function rawMaterial(vertexShader: string, fragmentShader: string, uniforms: Record<string, { value: unknown }>): RawShaderMaterial {
  return new RawShaderMaterial({ glslVersion: GLSL3, vertexShader, fragmentShader, uniforms, depthTest: false, depthWrite: false })
}

function makeTarget(): WebGLRenderTarget {
  const target = new WebGLRenderTarget(1, 1, { depthBuffer: false })
  target.texture.generateMipmaps = false
  target.texture.colorSpace = NoColorSpace
  return target
}

/** A texture of the layer, built from a loaded image or video asset, and how to release it. */
interface LayerTexture {
  texture: Texture
  dispose(): void
}

async function layerTexture(name: string, ref: string, asset: unknown, owner: object): Promise<LayerTexture> {
  if (!isStickerAsset(asset)) throw new OuafError('shader', `texture "${name}" ("${ref}") is not an image or a video.`)
  const a: StickerAsset = asset
  if (a.kind === 'video' && a.video) {
    // Its own texture object, uploaded with flipY (origin at the bottom left); the video element is shared.
    const texture = new VideoTexture(a.video)
    texture.colorSpace = NoColorSpace
    texture.flipY = true
    texture.generateMipmaps = false
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    texture.wrapS = texture.wrapT = RepeatWrapping
    let owns = false
    if (a.owner === undefined) {
      a.owner = owner
      owns = true
      a.video.loop = true
      void a.video.play().catch(() => {})
    }
    return {
      texture,
      dispose() {
        texture.dispose()
        if (owns && a.owner === owner) {
          a.video!.pause()
          a.owner = undefined
        }
      },
    }
  }
  // Images are premultiplied ImageBitmaps with v = 0 at the top (sticker loaders): make a flipped, straight-alpha copy.
  const source = a.texture.image as ImageBitmap
  const bitmap = await createImageBitmap(source, { imageOrientation: 'flipY', premultiplyAlpha: 'none' })
  const texture = new Texture(bitmap)
  texture.colorSpace = NoColorSpace
  texture.flipY = false
  texture.premultiplyAlpha = false
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.magFilter = LinearFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return {
    texture,
    dispose() {
      texture.dispose()
      bitmap.close()
    },
  }
}

/** Builds the wrapped source and checks it; throws `ShaderCompileError`. */
function prepare(decl: TShaderLayer, ctx: LayerContext, uniforms: ShaderUniforms, stage: ShaderStage): WrappedShader {
  const source = ctx.assets.get<string>(decl.src)
  const fail = (details: ShaderCompileError['details'], cause?: unknown): never => {
    throw new ShaderCompileError(ctx.filterId, decl.src, details, cause === undefined ? undefined : { cause })
  }
  const issues = checkShaderSource(source)
  if (issues.length) fail(issues.map((i) => ({ severity: 'error', ...(i.line !== undefined ? { line: i.line } : {}), message: i.message })))
  let wrapped: WrappedShader
  try {
    wrapped = wrapShader(source, {
      stage,
      maxFaces: ctx.maxFaces,
      uniforms: uniforms.declarations,
      textures: Object.keys(decl.textures ?? {}),
      anchors: decl.anchors ?? [],
    })
  } catch (cause) {
    if (cause instanceof ShaderDeclarationError) return fail([{ severity: 'error', message: cause.message }], cause)
    throw cause
  }
  const gl = ctx.renderer.getContext() as unknown as CompileContext
  const errors = checkProgram(gl, stage === 'face' ? SHADER_FACE_VERTEX : SHADER_FULLSCREEN_VERTEX, wrapped)
  if (errors === undefined) throw new OuafError('gpu-context-lost', `Filter "${ctx.filterId}": shader "${decl.src}" cannot be compiled while the GPU context is lost.`)
  if (errors.length) fail(errors)
  return wrapped
}

export async function createShaderLayer(layer: LayerDecl, ctx: LayerContext): Promise<PassLayer> {
  const decl = layer as unknown as TShaderLayer
  const stage: ShaderStage = decl.stage ?? 'post'
  const env = ctx.bindings
  let uniforms: ShaderUniforms
  try {
    uniforms = new ShaderUniforms(decl.uniforms as Record<string, unknown> | undefined, env)
  } catch (cause) {
    if (cause instanceof UniformTypeError || cause instanceof BindingError) {
      throw new ShaderCompileError(ctx.filterId, decl.src, [{ severity: 'error', message: cause.message }], { cause })
    }
    throw cause
  }
  const wrapped = prepare(decl, ctx, uniforms, stage)
  const source = ctx.assets.get<string>(decl.src)
  const usesSizes = /\bouaf_faceSize\b/.test(source)
  const anchors = decl.anchors ?? []
  const inputs = anchors.length > 0 || usesSizes ? new ShaderFaceInputs(ctx.maxFaces, anchors, usesSizes) : undefined
  const visible = compileBinding(decl.visible ?? true, { type: 'boolean', fallback: true, path: 'visible', name: 'visible' }, env)
  const opacity = compileNumberBinding(decl.opacity ?? 1, { fallback: 1, path: 'opacity', name: 'opacity' }, env)

  // Engine inputs (spec §11.1) and the layer's uniforms and textures.
  const uInput: { value: Texture | null } = { value: null }
  const uFrame = { value: new Float32Array(4) }
  const uOpacity = { value: 1 }
  const uFaceCount = { value: 0 }
  const uniformMap: Record<string, { value: unknown }> = {
    [I.input]: uInput,
    [I.frame]: uFrame,
    [I.opacity]: uOpacity,
    ouaf_faceCount: uFaceCount,
    ouaf_faceSize: { value: inputs?.sizes ?? new Float32Array(ctx.maxFaces) },
    ...uniforms.uniforms,
  }
  anchors.forEach((name, i) => (uniformMap[`ouaf_anchor_${name}`] = { value: inputs!.positions[i]! }))
  const owned: Array<{ dispose(): void }> = []
  const owner = {}
  try {
    for (const [name, ref] of Object.entries(decl.textures ?? {})) {
      const t = await layerTexture(name, ref, ctx.assets.get(ref), owner)
      owned.push(t)
      uniformMap[name] = { value: t.texture }
    }
  } catch (error) {
    for (const t of owned) t.dispose()
    if (error instanceof OuafError && error.code === 'shader') throw new ShaderCompileError(ctx.filterId, decl.src, [{ severity: 'error', message: error.message }])
    throw error
  }

  // Face mesh: the `face` stage draws on it, `ouaf_faceMask` draws it into the mask texture.
  const camera = new Camera()
  const needsMesh = stage === 'face' || wrapped.faceMask
  let positions: BufferAttribute | undefined
  let geometry: BufferGeometry | undefined
  if (needsMesh) {
    geometry = new BufferGeometry()
    positions = new BufferAttribute(new Float32Array(ctx.maxFaces * MASK_VERTICES * 2), 2).setUsage(DynamicDrawUsage)
    geometry.setAttribute('position', positions)
    geometry.setAttribute('mask', new BufferAttribute(faceMaskValues(ctx.maxFaces), 1))
    geometry.setIndex(new BufferAttribute(faceMaskIndices(ctx.maxFaces), 1))
    geometry.boundingSphere = new Sphere(new Vector3(), Infinity)
  }
  const sceneOf = (material: Material, geo: BufferGeometry): Scene => {
    const mesh = new Mesh(geo, material)
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    const scene = new Scene()
    scene.add(mesh)
    return scene
  }
  const triangle = new BufferGeometry()
  triangle.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 3, -1, -1, 3]), 2))
  triangle.boundingSphere = new Sphere(new Vector3(), Infinity)

  const effect = rawMaterial(stage === 'face' ? SHADER_FACE_VERTEX : SHADER_FULLSCREEN_VERTEX, wrapped.fragment, uniformMap)
  if (stage === 'face') effect.side = DoubleSide // the oval's winding flips with mirroring
  const effectScene = sceneOf(effect, stage === 'face' ? geometry! : triangle)
  const uCopy: { value: Texture | null } = { value: null }
  const copy = rawMaterial(SHADER_FULLSCREEN_VERTEX, COPY_FRAGMENT, { ouaf_src: uCopy })
  const copyScene = sceneOf(copy, triangle)

  let mask: { target: WebGLRenderTarget; material: RawShaderMaterial; scene: Scene } | undefined
  if (wrapped.faceMask) {
    const material = rawMaterial(SHADER_FACE_VERTEX, MASK_FRAGMENT, {})
    material.side = DoubleSide
    material.blending = CustomBlending
    material.blendEquation = MaxEquation
    material.blendSrc = OneFactor
    material.blendDst = OneFactor
    const target = makeTarget()
    target.texture.wrapS = target.texture.wrapT = ClampToEdgeWrapping
    mask = { target, material, scene: sceneOf(material, geometry!) }
    uniformMap[I.mask] = { value: target.texture }
  }
  let history: { targets: [WebGLRenderTarget, WebGLRenderTarget]; current: 0 | 1; width: number; height: number } | undefined
  const uPrev: { value: Texture | null } = { value: null }
  if (wrapped.prevFrame) {
    history = { targets: [makeTarget(), makeTarget()], current: 0, width: 0, height: 0 }
    uniformMap[I.prev] = uPrev
  }

  const values = new Float64Array(1)
  let faceCount = 0
  let width = 0
  let height = 0
  let active = false

  const draw = (renderer: WebGLRenderer, input: Texture, output: WebGLRenderTarget | null) => {
    if (stage === 'face') {
      // The image unchanged, then the effect on the face mesh over it (it reads the input itself).
      uCopy.value = input
      renderer.setRenderTarget(output)
      renderer.render(copyScene, camera)
    }
    renderer.setRenderTarget(output)
    renderer.render(effectScene, camera)
  }

  return {
    kind: 'pass',
    stage: STAGES[stage],
    authorShader: true,
    get active() {
      return active
    },
    update(frame) {
      faceCount = Math.min(frame.faces.count, ctx.maxFaces)
      const slot = faceCount > 0 ? 0 : NO_FACE
      opacity.write(slot, values, 0)
      const o = values[0]! < 0 ? 0 : values[0]! > 1 ? 1 : values[0]!
      active = visible.evaluate(slot) && o > 0 && (stage !== 'face' || faceCount > 0)
      if (!active) return
      if (uOpacity.value !== o) uOpacity.value = o
      uniforms.update(slot)
      width = frame.width
      height = frame.height
      const f = uFrame.value
      f[0] = frame.time
      f[1] = frame.dt / 1000
      f[2] = width
      f[3] = height
      uFaceCount.value = faceCount
      const projection = ctx.view.camera.projectionMatrix.elements
      inputs?.update(frame.anchors, faceCount, projection)
      if (positions && geometry) {
        const out = positions.array as Float32Array
        for (let i = 0; i < faceCount; i++) writeFaceMask(frame.faces, i, i, frame.mirrored, projection, out)
        positions.needsUpdate = true
        geometry.setDrawRange(0, faceCount * MASK_INDICES)
      }
    },
    render(pass: PassContext) {
      const renderer = pass.renderer
      uInput.value = pass.input
      if (mask) {
        const w = Math.max(1, Math.ceil(width / 2))
        const h = Math.max(1, Math.ceil(height / 2))
        if (mask.target.width !== w || mask.target.height !== h) mask.target.setSize(w, h)
        renderer.setRenderTarget(mask.target)
        renderer.clear()
        if (faceCount > 0) renderer.render(mask.scene, camera)
      }
      if (!history) {
        draw(renderer, pass.input, pass.output)
        return
      }
      const [a, b] = history.targets
      if (history.width !== width || history.height !== height) {
        // New size: the previous frame is black again (spec §11.1: black at the first frame).
        history.width = width
        history.height = height
        for (const t of history.targets) {
          t.setSize(Math.max(1, width), Math.max(1, height))
          renderer.setRenderTarget(t)
          renderer.clear()
        }
      }
      const target = history.current === 0 ? a : b
      uPrev.value = (history.current === 0 ? b : a).texture
      draw(renderer, pass.input, target)
      uCopy.value = target.texture
      renderer.setRenderTarget(pass.output)
      renderer.render(copyScene, camera)
      history.current = history.current === 0 ? 1 : 0
    },
    dispose() {
      effect.dispose()
      copy.dispose()
      triangle.dispose()
      geometry?.dispose()
      if (mask) {
        mask.material.dispose()
        mask.target.dispose()
      }
      if (history) for (const t of history.targets) t.dispose()
      for (const t of owned) t.dispose()
    },
  }
}
