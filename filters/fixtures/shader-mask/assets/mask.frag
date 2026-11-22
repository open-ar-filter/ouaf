vec4 effect(vec2 uv) {
  return vec4(0.0, 0.0, ouaf_faceMask(uv), 1.0);
}
