// Old film, after the vintage LUT: gate weave and flicker, a warm light leak, scratches and dust that change at
// 24 frames per second, and the dark rounded edge of the film gate. Everything depends only on the pixel and the
// media time, so a file source gives the same image on every run (spec §12.5). Integer hashing, not sin(): the
// same random pattern on every GPU.
// Uniforms (manifest): float scratches, float dust, float flicker (0–1), vec4 leak (color, alpha = strength).

uint hashu(uint x) {
  x ^= x >> 16;
  x *= 0x7feb352dU;
  x ^= x >> 15;
  x *= 0x846ca68bU;
  x ^= x >> 16;
  return x;
}

// A number in [0, 1) for film frame `frame` and stream `k`.
float rnd(uint frame, uint k) {
  return float(hashu(frame * 0x9e3779b9U + hashu(k)) >> 8) / 16777216.0;
}

vec4 effect(vec2 uv) {
  uint frame = uint(floor(ouaf_time * 24.0));
  float aspect = ouaf_resolution.x / ouaf_resolution.y;

  // Gate weave: the picture shifts by a pixel or two from one film frame to the next.
  vec2 weave = (vec2(rnd(frame, 1U), rnd(frame, 2U)) - 0.5) * vec2(0.003, 0.004) * flicker;
  vec4 c = ouaf_sample(clamp(uv + weave, 0.0, 1.0));
  c.rgb *= 1.0 + (rnd(frame, 3U) - 0.5) * 0.12 * flicker;

  // Light leak: a warm glow from the top right corner, breathing slowly.
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  vec2 corner = vec2(0.5 * aspect, 0.5) + vec2(0.05, 0.05 * sin(ouaf_time * 0.8));
  float glow = smoothstep(0.9, 0.0, length(p - corner));
  c.rgb += leak.rgb * leak.a * glow * glow;

  // Scratches: up to three thin vertical lines, each on some film frames only.
  for (uint i = 0U; i < 3U; i++) {
    float on = step(1.0 - 0.5 * scratches, rnd(frame, 10U + i));
    float x = 0.05 + 0.9 * rnd(frame, 20U + i);
    float width = 0.0008 + 0.0012 * rnd(frame, 30U + i);
    float line = 1.0 - smoothstep(0.0, width, abs(uv.x - x) * aspect);
    float along = 0.6 + 0.4 * cos(uv.y * 23.0 + 6.2832 * rnd(frame, 40U + i));
    c.rgb = mix(c.rgb, vec3(0.96, 0.93, 0.84), on * line * along * 0.8);
  }

  // Dust: dark specks, a new set on every film frame.
  for (uint i = 0U; i < 8U; i++) {
    vec2 at = vec2(rnd(frame, 50U + i), rnd(frame, 60U + i));
    float r = 0.002 + 0.005 * rnd(frame, 70U + i);
    float d = length((uv - at) * vec2(aspect, 1.0));
    float speck = step(rnd(frame, 80U + i), dust) * (1.0 - smoothstep(0.5 * r, r, d));
    c.rgb *= 1.0 - 0.8 * speck;
  }

  // The film gate: a dark rounded edge around the picture.
  vec2 box = vec2(0.5 * aspect, 0.5) - 0.018;
  float radius = 0.05;
  vec2 q = abs(p) - box + radius;
  float outside = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  c.rgb = mix(c.rgb, vec3(0.04, 0.03, 0.02), smoothstep(-0.006, 0.004, outside));

  return vec4(clamp(c.rgb, 0.0, 1.0), 1.0);
}
