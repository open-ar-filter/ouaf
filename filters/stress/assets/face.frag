// Face stage: a slowly cycling color wash over the face mesh, with moving stripes (a full shader pass per frame).
vec4 effect(vec2 uv) {
  vec4 c = ouaf_sample(uv);
  float t = ouaf_time;
  vec3 wash = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + 0.15 * t));
  float stripes = 0.5 + 0.5 * sin(uv.y * 160.0 - t * 6.0);
  return vec4(mix(c.rgb, c.rgb * wash * 1.3, 0.35 + 0.15 * stripes), 1.0);
}
