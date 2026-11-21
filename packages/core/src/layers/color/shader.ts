/**
 * GLSL of the color layer. One fragment shader, specialised with defines: `HAS_LUT` (a `.cube` LUT is set) and
 * `FACE_REGION` (drawn on the face mask mesh instead of full screen). The formulas are documented in `grade.ts`.
 */

/** Vertex shader of the face mask mesh: positions already in clip space, plus the mask value. */
export const FACE_VERTEX = /* glsl */ `
precision highp float;
in vec2 position;
in float mask;
out vec2 vUv;
out float vMask;
void main() {
  vUv = position * 0.5 + 0.5;
  vMask = mask;
  gl_Position = vec4(position, 0.0, 1.0);
}
`

export const GRADE_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
uniform sampler2D uInput;
#ifdef HAS_LUT
uniform sampler3D uLut;
uniform vec3 uLutScale;  // input → [0, 1]: 1 / (DOMAIN_MAX - DOMAIN_MIN)
uniform vec3 uLutOffset; // -DOMAIN_MIN / (DOMAIN_MAX - DOMAIN_MIN)
uniform float uLutSize;
#endif
uniform vec4 uGrade;  // mix, brightness exponent, contrast factor, saturation factor
uniform vec4 uGrade2; // red gain, blue gain, vignette, grain amplitude
uniform vec4 uTint;   // rgb, strength
uniform float uSeed;  // grain pattern (integer)
in vec2 vUv;
#ifdef FACE_REGION
in float vMask;
#endif
out vec4 fragColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Integer hash (PCG-style): the same on every GPU, so grain is deterministic (spec 12.5).
uint hash(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v.x;
}

void main() {
  vec3 src = texture(uInput, vUv).rgb;
  vec3 c = src;
#ifdef HAS_LUT
  vec3 t = clamp(c * uLutScale + uLutOffset, 0.0, 1.0);
  c = texture(uLut, t * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize).rgb;
#endif
  c = pow(max(c, 0.0), vec3(uGrade.y));
  c = (c - 0.5) * uGrade.z + 0.5;
  float y = dot(c, LUMA);
  c = y + (c - y) * uGrade.w;
  c *= vec3(uGrade2.x, 1.0, uGrade2.y);
  c = mix(c, c * uTint.rgb, uTint.a);
  float r = length(vUv - 0.5) * 1.41421356;
  c *= 1.0 - uGrade2.z * smoothstep(0.35, 1.0, r);
  float n = float(hash(uvec3(uvec2(gl_FragCoord.xy), uint(uSeed))) >> 8u) / 16777215.0;
  c += uGrade2.w * (n - 0.5);
  float amount = uGrade.x;
#ifdef FACE_REGION
  amount *= smoothstep(0.0, 1.0, vMask);
#endif
  fragColor = vec4(mix(src, clamp(c, 0.0, 1.0), amount), 1.0);
}
`

/** Plain copy, drawn under the face mask mesh with `region: "face"`. */
export const COPY_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uInput;
in vec2 vUv;
out vec4 fragColor;
void main() {
  fragColor = texture(uInput, vUv);
}
`
