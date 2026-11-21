// Horizontal jitter. The engine provides #version, main() and the ouaf_* inputs (spec §11).
vec4 effect(vec2 uv) {
  return ouaf_sample(uv + vec2(sin(ouaf_time * 20.0) * amount * 0.01, 0.0));
}
