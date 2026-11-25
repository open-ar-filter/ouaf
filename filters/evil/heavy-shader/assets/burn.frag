// Malicious shader (#27): `iterations` rounds of hashing for every pixel, with a loop bound the compiler cannot know.
// Uniform (manifest): float iterations.

vec4 effect(vec2 uv) {
  vec4 c = ouaf_sample(uv);
  uint h = uint(uv.x * 4096.0) ^ (uint(uv.y * 4096.0) << 12);
  int n = int(iterations);
  for (int i = 0; i < n; i++) {
    h ^= h >> 16;
    h *= 0x7feb352dU;
    h ^= h >> 15;
  }
  // Uses the result, so the loop cannot be removed.
  return vec4(c.rgb + float(h & 1U) * 1e-6, c.a);
}
