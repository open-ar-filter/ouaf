/**
 * Pure coordinate math shared by the renderer's background and every overlay drawn on top of it (no WebGL here,
 * so it is unit tested in Node).
 *
 * Spaces:
 * - **Video space**: normalized image coordinates of the camera frame, as MediaPipe returns them — `u` right,
 *   `v` down, origin at the top-left of the frame, `[0, 1]` across the frame. Never mirrored.
 * - **Clip space**: WebGL normalized device coordinates of the render target — `x` right, `y` up, `[-1, 1]`.
 *   It is what is displayed (and later captured): mirroring is applied when going from video to clip space.
 */

/**
 * How the video frame is fitted into a render target of a different aspect ratio.
 * - `cover` (default): fills the whole target, cropping the video symmetrically on the overflowing axis — the
 *   usual camera-app view, no black bars.
 * - `contain`: shows the whole video, letterboxed (or pillarboxed) with the clear colour.
 */
export type FitMode = 'cover' | 'contain'

/**
 * Affine map from video space to clip space, separable per axis: `x = ax·u + bx`, `y = ay·v + by`.
 * The renderer uploads it as one `vec4(ax, bx, ay, by)` uniform shared by the background and the landmarks, so
 * both use exactly the same mapping.
 */
export interface VideoToClip {
  ax: number
  bx: number
  ay: number
  by: number
}

export function createVideoToClip(): VideoToClip {
  return { ax: 2, bx: -1, ay: -2, by: 1 }
}

/**
 * Computes the video → clip mapping for a `videoWidth × videoHeight` frame shown in a `targetWidth × targetHeight`
 * render target, and writes it into `out` (no allocation). Mirroring flips the image horizontally around the
 * centre of the target. With an unknown size (0), the video is stretched to the target.
 */
export function computeVideoToClip(
  videoWidth: number,
  videoHeight: number,
  targetWidth: number,
  targetHeight: number,
  fit: FitMode,
  mirrored: boolean,
  out: VideoToClip,
): VideoToClip {
  // Half-extent of the video quad in clip units: 1 on an axis means the video exactly spans the target on it.
  let sx = 1
  let sy = 1
  if (videoWidth > 0 && videoHeight > 0 && targetWidth > 0 && targetHeight > 0) {
    // ratio > 1: the video is wider than the target (relative to their heights).
    const ratio = (videoWidth / videoHeight) / (targetWidth / targetHeight)
    if (fit === 'cover') {
      if (ratio > 1) sx = ratio
      else sy = 1 / ratio
    } else {
      if (ratio > 1) sy = 1 / ratio
      else sx = ratio
    }
  }
  // u: 0 → -sx, 1 → +sx (or the reverse when mirrored). v: 0 (top) → +sy, 1 (bottom) → -sy.
  out.ax = mirrored ? -2 * sx : 2 * sx
  out.bx = mirrored ? sx : -sx
  out.ay = -2 * sy
  out.by = sy
  return out
}

/** Clip-space x of a video-space `u`. */
export function videoToClipX(m: Readonly<VideoToClip>, u: number): number {
  return m.ax * u + m.bx
}

/** Clip-space y of a video-space `v`. */
export function videoToClipY(m: Readonly<VideoToClip>, v: number): number {
  return m.ay * v + m.by
}

/** Pixel x in the render target (origin top-left) of a clip-space x. */
export function clipToPixelX(x: number, targetWidth: number): number {
  return ((x + 1) / 2) * targetWidth
}

/** Pixel y in the render target (origin top-left, y down) of a clip-space y. */
export function clipToPixelY(y: number, targetHeight: number): number {
  return ((1 - y) / 2) * targetHeight
}

export interface Size {
  width: number
  height: number
}

/**
 * Internal render resolution: `fixed` when the host set one, otherwise the video frame size times `scale`.
 * Always at least 1×1 (a WebGL drawing buffer cannot be empty), rounded to whole pixels. Writes into `out`.
 */
export function resolveRenderSize(
  videoWidth: number,
  videoHeight: number,
  fixed: Readonly<Size> | undefined,
  scale: number,
  out: Size,
): Size {
  const w = fixed ? fixed.width : videoWidth * scale
  const h = fixed ? fixed.height : videoHeight * scale
  out.width = Math.max(1, Math.round(w))
  out.height = Math.max(1, Math.round(h))
  return out
}
