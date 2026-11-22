// A red disc of 0.15 face units in radius on the nose tip of every face.
vec4 effect(vec2 uv) {
  vec4 c = ouaf_sample(uv);
  vec2 aspect = vec2(ouaf_resolution.x / ouaf_resolution.y, 1.0);
  for (int i = 0; i < OUAF_MAX_FACES; i++) {
    if (i >= ouaf_faceCount) break;
    float d = length((uv - ouaf_anchor_noseTip[i]) * aspect);
    if (d < 0.15 * ouaf_faceSize[i]) c = vec4(1.0, 0.0, 0.0, 1.0);
  }
  return c;
}
