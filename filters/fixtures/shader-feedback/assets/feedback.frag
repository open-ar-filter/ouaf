vec4 effect(vec2 uv) {
  return vec4(ouaf_prevFrame(uv).rgb + 1.0 / 16.0, 1.0);
}
