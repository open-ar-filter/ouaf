vec4 effect(vec2 uv) {
  return vec4(fract(ouaf_time), clamp(ouaf_dt, 0.0, 1.0), ouaf_sample(uv).g, 1.0);
}
