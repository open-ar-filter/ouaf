// A shader whose effect() is not closed: the compiler only notices after line 5.
vec4 effect(vec2 uv) {
  vec4 c = ouaf_sample(uv);
  c.rgb *= 0.5;
  return c;
