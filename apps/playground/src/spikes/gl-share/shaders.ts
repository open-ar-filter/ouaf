/** GLSL ES 3.0 shaders of the WebGL paths (the WebGPU path builds the same effect with TSL). */

/** Blur taps: a golden-angle spiral, the same in GLSL and TSL. */
export const BLUR_TAPS = 16
export const GOLDEN_ANGLE = 2.39996323
/** Blur radius as a fraction of the video width. */
export const BLUR_RADIUS = 0.02
/** Background treatment: desaturation amount kept and tint. */
export const BG_SATURATION = 0.35
export const BG_TINT = [0.45, 0.6, 1.0] as const
/** Mask view: colour painted where the mask says "person". */
export const MASK_COLOR = [1.0, 0.2, 0.6] as const

// Same video → clip mapping as @ouaf/core's renderer: x = ax·u + bx, y = ay·v + by (u right, v down).
export const VERTEX = /* glsl */ `
precision highp float;
in vec2 position; // video-space corner of the frame
uniform vec4 uVideoToClip;
out vec2 vUv;
void main() {
  vUv = position; // textures are uploaded without flipY: t = 0 is the top row, like v
  gl_Position = vec4(uVideoToClip.x * position.x + uVideoToClip.y, uVideoToClip.z * position.y + uVideoToClip.w, 0.0, 1.0);
}
`

const f = (n: number) => n.toFixed(6)
const vec3 = (v: readonly number[]) => `vec3(${v.map(f).join(', ')})`

/**
 * uMode: 0 = blurred, desaturated, tinted background behind the person; 1 = same without blur; 2 = mask view
 * (darkened video, person painted over: shows mask/video alignment). uMaskFlipY: 1 when the mask texture is
 * stored bottom row first.
 */
export const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform sampler2D uMask;
uniform vec2 uBlurRadius;
uniform float uMaskFlipY;
uniform int uMode;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 c = texture(uMap, vUv).rgb;
  float m = clamp(texture(uMask, vec2(vUv.x, mix(vUv.y, 1.0 - vUv.y, uMaskFlipY))).r, 0.0, 1.0);
  if (uMode == 2) {
    fragColor = vec4(mix(c * 0.3, ${vec3(MASK_COLOR)}, m * 0.8), 1.0);
    return;
  }
  vec3 b = c;
  if (uMode == 0) {
    vec3 acc = c;
    for (int i = 1; i < ${BLUR_TAPS}; i++) {
      float r = sqrt(float(i) / ${f(BLUR_TAPS - 1)});
      float a = float(i) * ${f(GOLDEN_ANGLE)};
      acc += texture(uMap, vUv + uBlurRadius * r * vec2(cos(a), sin(a))).rgb;
    }
    b = acc / ${f(BLUR_TAPS)};
  }
  float l = dot(b, vec3(0.2126, 0.7152, 0.0722));
  vec3 bg = mix(vec3(l), b, ${f(BG_SATURATION)}) * ${vec3(BG_TINT)};
  fragColor = vec4(mix(bg, c, m), 1.0);
}
`
