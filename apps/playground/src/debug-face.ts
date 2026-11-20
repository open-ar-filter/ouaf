import { LANDMARK_COUNT, createFaceFrame, type FaceFrame } from '@ouaf/core'

/**
 * Debug only (`?debug-face`): a fake face, in the tracker's coordinates (normalized, unmirrored image space), to
 * check the landmark mapping without a tracker. Its 478 points draw:
 * - a rectangle inset by 5 % from the edges of the video frame: with `?fit=contain` it sits exactly 5 % inside
 *   the image; with `cover` it is cropped symmetrically on the overflowing axis;
 * - a cross at the centre of the frame;
 * - a filled square marking the image's top-left corner. With the front camera (mirrored), that corner is the
 *   person's right: raise your right hand to the top corner of the screen and it must appear next to the square.
 */
export function createSyntheticFace(): FaceFrame {
  const face = createFaceFrame(1)
  face.count = 1
  const p = face.landmarks
  let i = 0
  const put = (u: number, v: number) => {
    p[i * 3] = u
    p[i * 3 + 1] = v
    p[i * 3 + 2] = 0
    i++
  }

  const EDGE = 50
  for (let k = 0; k < EDGE; k++) {
    const t = 0.05 + (0.9 * k) / EDGE
    put(t, 0.05)
    put(0.95, t)
    put(1 - t, 0.95)
    put(0.05, 1 - t)
  }
  const CROSS = 50
  for (let k = 0; k < CROSS; k++) {
    const t = 0.4 + (0.2 * k) / (CROSS - 1)
    put(t, 0.5)
    put(0.5, t)
  }
  const side = Math.floor(Math.sqrt(LANDMARK_COUNT - i))
  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) put(0.1 + (0.1 * col) / side, 0.1 + (0.1 * row) / side)
  }
  while (i < LANDMARK_COUNT) put(0.5, 0.5)
  return face
}
