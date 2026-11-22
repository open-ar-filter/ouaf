// Black and white stripes, 24 per image height: a pattern the warps visibly deform.
vec4 effect(vec2 uv) {
  float s = step(0.5, fract(uv.y * 24.0));
  return vec4(vec3(s), 1.0);
}
