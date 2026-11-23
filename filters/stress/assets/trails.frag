// Post stage: motion trails, mixing in this shader's own previous output (ouaf_prevFrame costs an extra buffer).
// Uniform (manifest): float amount (0–1).
vec4 effect(vec2 uv) {
  vec4 now = ouaf_sample(uv);
  vec4 before = ouaf_prevFrame(uv);
  return vec4(mix(now.rgb, max(now.rgb, before.rgb), 0.6 * amount), 1.0);
}
