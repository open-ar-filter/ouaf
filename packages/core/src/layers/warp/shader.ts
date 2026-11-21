/**
 * Fragment shader of the `warp` pass: `warpSource` (warp-math.ts) in GLSL, applied for every packed centre. One
 * program per kind and capacity (`#define`s), so the loop has a constant bound and no per-pixel branch on the kind.
 */
import { BULGE_MAX, STRETCH_MAX, SWIRL_MAX_ANGLE, WARP_KINDS, type WarpKind } from './warp-math.ts'

const glslFloat = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x))

/** Fragment shader for `kind`, with uniform arrays of `capacity` centres (`WarpPacker`: one vec4 per centre). */
export function warpFragment(kind: WarpKind, capacity: number): string {
  return /* glsl */ `
precision highp float;
#define KIND ${WARP_KINDS.indexOf(kind)}
#define CAPACITY ${capacity}
uniform sampler2D uInput;
uniform float uAspect;  // width / height of the render size
uniform int uCount;     // centres packed this frame
uniform vec4 uA[CAPACITY]; // centre x, y (screen heights, origin at the centre, +y up), 1 / radius, strength
#if KIND == 3
uniform vec4 uB[CAPACITY]; // unit direction on screen (stretch)
#endif
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
  for (int i = 0; i < CAPACITY; i++) {
    if (i >= uCount) break;
    vec4 a = uA[i];
    vec2 e = p - a.xy;
    float r2 = dot(e, e) * a.z * a.z;
    if (r2 >= 1.0) continue;
    float w = (1.0 - r2) * (1.0 - r2);
#if KIND == 0
    p = a.xy + e * (1.0 - a.w * ${glslFloat(BULGE_MAX)} * w);
#elif KIND == 1
    p = a.xy + e * (1.0 + a.w * ${glslFloat(BULGE_MAX)} * w);
#elif KIND == 2
    float t = a.w * ${glslFloat(SWIRL_MAX_ANGLE)} * w;
    float c = cos(t);
    float s = sin(t);
    p = a.xy + vec2(c * e.x + s * e.y, -s * e.x + c * e.y);
#else
    p -= uB[i].xy * (a.w * ${glslFloat(STRETCH_MAX)} * w / a.z);
#endif
  }
  fragColor = vec4(texture(uInput, vec2(p.x / uAspect + 0.5, p.y + 0.5)).rgb, 1.0);
}
`
}
