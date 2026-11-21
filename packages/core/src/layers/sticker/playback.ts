/**
 * Playback math of animated stickers (spritesheets and videos), pure and allocation-free.
 *
 * Every sticker layer has one playback clock, in seconds, that advances with the engine's frame time (`frame.time`:
 * the media time of a video file, the clock of a live camera) times `rate`. A backwards jump (the source looped or was
 * seeked) or a gap longer than `MAX_STEP` (paused source, hidden tab) counts as no time, as for parameter transitions:
 * with a file source the animation then depends on the media time only, so it is the same on every run (spec §12.5).
 */

/** Longest frame-to-frame step of the playback clock (s); a longer gap is a pause or a seek, not playback. */
export const MAX_STEP = 1

/** How far the clock advances between two frames at times `previous` and `time` (s); `previous < 0`: first frame. */
export function clockStep(previous: number, time: number): number {
  if (previous < 0) return 0
  const dt = time - previous
  return dt > 0 && dt <= MAX_STEP ? dt : 0
}

/**
 * Frame of a spritesheet shown at clock time `t` (s): `fps` frames per second, `count` frames, wrapping around with
 * `loop`, else holding the last frame.
 */
export function spriteFrame(t: number, fps: number, count: number, loop: boolean): number {
  if (count <= 1 || !(t > 0)) return 0
  // A small epsilon so that t = k / fps, computed with rounding errors, shows frame k.
  const f = Math.floor(t * fps + 1e-6)
  return loop ? f % count : Math.min(f, count - 1)
}

/** Writable 4-vector (three's `Vector4`, or a test double). */
export interface Rect {
  x: number
  y: number
  z: number
  w: number
}

/**
 * Texture rectangle of frame `index` in a `cols` × `rows` grid read row by row from the top left: `x, y` = top-left
 * corner, `z, w` = size, in texture coordinates with v = 0 at the top row (textures are uploaded without flipY).
 */
export function frameRect(index: number, cols: number, rows: number, out: Rect): Rect {
  const col = index % cols
  const row = Math.floor(index / cols) % rows
  out.z = 1 / cols
  out.w = 1 / rows
  out.x = col * out.z
  out.y = row * out.w
  return out
}

/** Position (s) a video of `duration` s should show at clock time `t`: wrapped with `loop`, else held at the end. */
export function videoTarget(t: number, duration: number, loop: boolean): number {
  if (!(duration > 0) || !Number.isFinite(duration)) return Math.max(0, t)
  if (loop) return ((t % duration) + duration) % duration
  return Math.min(Math.max(0, t), duration)
}

/**
 * Signed distance (s) from the target position to the video's current position, the short way round for a looping
 * video (2.9 s against 0.1 s in a 3 s loop is 0.2 s behind, not 2.8 s ahead).
 */
export function videoDrift(current: number, target: number, duration: number, loop: boolean): number {
  const d = current - target
  if (!loop || !(duration > 0) || !Number.isFinite(duration)) return d
  const wrapped = ((d % duration) + duration) % duration // [0, duration)
  return wrapped > duration / 2 ? wrapped - duration : wrapped
}
