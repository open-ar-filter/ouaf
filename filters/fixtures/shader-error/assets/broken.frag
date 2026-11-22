// A shader with an error on line 4.
vec4 effect(vec2 uv) {
  vec4 c = ouaf_sample(uv);
  c.rgb *= notDeclared;
  return c;
}
