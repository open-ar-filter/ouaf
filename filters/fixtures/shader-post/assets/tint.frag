// Mixes the image with `tint` by `amount`; with `showTexture`, the halves texture (red top, blue bottom) over the bottom-left quarter.
vec4 effect(vec2 uv) {
  vec4 c = ouaf_sample(uv + offset);
  c.rgb = mix(c.rgb, tint.rgb, amount);
  if (showTexture && uv.x < 0.5 && uv.y < 0.5) {
    vec4 t = texture(halves, uv * 2.0);
    c.rgb = mix(c.rgb, t.rgb, t.a);
  }
  return c;
}
