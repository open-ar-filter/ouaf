/**
 * The sticker material: a textured quad with premultiplied alpha, one frame of a spritesheet, or a video with packed
 * alpha (color in the left half, mask in the right half, spec §10.2), blended with one of the `blend` modes.
 *
 * Like the rest of the image pipeline (docs/decisions/engine-architecture.md), the shader reads and writes
 * sRGB-encoded bytes unchanged (textures in `NoColorSpace`, raw shader): blending happens on encoded values, as in
 * CSS and 2D canvas compositing.
 */
import {
  AddEquation,
  CustomBlending,
  DoubleSide,
  DstColorFactor,
  GLSL3,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OneMinusSrcColorFactor,
  RawShaderMaterial,
  Vector3,
  Vector4,
  ZeroFactor,
  type BlendingDstFactor,
  type BlendingSrcFactor,
  type Texture,
} from 'three'
import type { StickerAsset } from './assets.ts'
import { frameRect } from './playback.ts'

export type BlendMode = 'normal' | 'add' | 'multiply' | 'screen'

/**
 * Color blend factors of each mode, for a premultiplied source `S = (c·a, a)` over the destination `D`
 * (`out = S·src + D·dst`):
 *
 * | Mode       | Result                 | src        | dst              |
 * |------------|------------------------|------------|------------------|
 * | `normal`   | `S + D·(1 − a)`        | one        | 1 − src alpha    |
 * | `add`      | `S + D`                | one        | one              |
 * | `multiply` | `D·(c·a + 1 − a)`      | dst color  | 1 − src alpha    |
 * | `screen`   | `S + D·(1 − S)`        | one        | 1 − src color    |
 *
 * Opacity is folded into `S`, so every mode fades to "no change" at opacity 0. The destination alpha is kept.
 */
export const BLEND_FACTORS: Readonly<Record<BlendMode, { readonly src: BlendingSrcFactor; readonly dst: BlendingDstFactor }>> = {
  normal: { src: OneFactor, dst: OneMinusSrcAlphaFactor },
  add: { src: OneFactor, dst: OneFactor },
  multiply: { src: DstColorFactor, dst: OneMinusSrcAlphaFactor },
  screen: { src: OneFactor, dst: OneMinusSrcColorFactor },
}

/** Sets the blending of `material` for `mode`. */
export function applyBlend(material: RawShaderMaterial, mode: BlendMode): void {
  const f = BLEND_FACTORS[mode]
  material.blending = CustomBlending
  material.blendEquation = AddEquation
  material.blendSrc = f.src
  material.blendDst = f.dst
  material.blendEquationAlpha = AddEquation
  material.blendSrcAlpha = ZeroFactor
  material.blendDstAlpha = OneFactor
  material.premultipliedAlpha = true
}

const VERTEX = /* glsl */ `
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = vec2(uv.x, 1.0 - uv.y); // v = 0 at the top, like the textures (uploaded without flipY)
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform vec4 uRect;      // frame in the texture: top-left corner, size
uniform vec4 uClamp;     // sampling limits (half a texel inside the frame): min u, min v, max u, max v
uniform vec3 uParams;    // opacity; mask offset (> 0: packed alpha, the mask is this far to the right of the color);
                         // straight alpha (> 0: a transcoded KTX2 texture, premultiplied here)
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 uv = clamp(uRect.xy + vUv * uRect.zw, uClamp.xy, uClamp.zw);
  vec4 c = texture(uMap, uv);
  if (uParams.z > 0.0) c.rgb *= c.a;
  if (uParams.y > 0.0) {
    float a = texture(uMap, uv + vec2(uParams.y, 0.0)).g;
    c = vec4(c.rgb * a, a);
  }
  c *= uParams.x;
  if (c.a < 0.002) discard;
  fragColor = c;
}
`

/** One material per sticker instance; `setAsset` points it at a loaded image, spritesheet or video. */
export class StickerMaterial extends RawShaderMaterial {
  readonly #map: { value: Texture | null }
  readonly #rect: { value: Vector4 }
  readonly #clamp: { value: Vector4 }
  readonly #params: { value: Vector3 }
  #asset: StickerAsset | undefined

  constructor(blend: BlendMode) {
    const uniforms = {
      uMap: { value: null as Texture | null },
      uRect: { value: new Vector4(0, 0, 1, 1) },
      uClamp: { value: new Vector4(0, 0, 1, 1) },
      uParams: { value: new Vector3(1, 0, 0) },
    }
    super({
      glslVersion: GLSL3,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    })
    applyBlend(this, blend)
    this.#map = uniforms.uMap
    this.#rect = uniforms.uRect
    this.#clamp = uniforms.uClamp
    this.#params = uniforms.uParams
  }

  get asset(): StickerAsset | undefined {
    return this.#asset
  }

  /**
   * `x`: opacity of the instance, 0–1 (premultiplied into the color, so every blend mode fades out). Written
   * directly by the layer: a fractional number passed to a method, or stored in a `{ value }` uniform (a shape shared
   * with object uniforms), is boxed every frame; a `Vector3` field is not.
   */
  get params(): Vector3 {
    return this.#params.value
  }

  /** Shows `asset` (whole image, first frame of a spritesheet, video). */
  setAsset(asset: StickerAsset): void {
    if (asset === this.#asset) return
    this.#asset = asset
    this.#map.value = asset.texture
    this.#params.value.y = asset.packed ? 0.5 : 0
    this.#params.value.z = asset.straightAlpha ? 1 : 0
    if (asset.frames) this.setFrame(0)
    else {
      this.#rect.value.set(0, 0, asset.packed ? 0.5 : 1, 1)
      this.#setClamp()
    }
  }

  /** Shows frame `index` of the current spritesheet. */
  setFrame(index: number): void {
    const frames = this.#asset?.frames
    if (!frames) return
    frameRect(index, frames.cols, frames.rows, this.#rect.value)
    this.#setClamp()
  }

  /** Sampling limits half a texel inside the current rectangle, so linear filtering never reads the next frame. */
  #setClamp(): void {
    const asset = this.#asset
    if (!asset) return
    const r = this.#rect.value
    const hu = 0.5 / Math.max(1, asset.textureWidth)
    const hv = 0.5 / Math.max(1, asset.textureHeight)
    this.#clamp.value.set(r.x + hu, r.y + hv, r.x + r.z - hu, r.y + r.w - hv)
  }
}
