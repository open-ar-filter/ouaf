import { BLENDSHAPES_STRIDE, LANDMARKS_STRIDE, MATRIX_STRIDE, type FaceFrame } from './face.ts'

/**
 * A `FaceFrame` stored in a single `ArrayBuffer` (or `SharedArrayBuffer`), so tracking results can cross a thread
 * boundary: a worker writes into the buffer, transfers it, and the receiving side reads it through a view.
 *
 * Layout (native byte order: both sides run on the same machine):
 *
 * | Offset (bytes)                  | Content                                                  |
 * |---------------------------------|----------------------------------------------------------|
 * | 0                               | header: `FACE_FRAME_HEADER_FLOATS` float64               |
 * | `FACE_FRAME_HEADER_BYTES`       | landmarks: `maxFaces × LANDMARKS_STRIDE` float32         |
 * | … + landmarks                   | blendshapes: `maxFaces × BLENDSHAPES_STRIDE` float32     |
 * | … + blendshapes                 | matrices: `maxFaces × MATRIX_STRIDE` float32             |
 *
 * Header slots (float64): `count`, `mediaTime`, `width`, `height`, then `FACE_FRAME_USER_SLOTS` slots free for the
 * producer (frame id, timings…), see `FaceFrameView.header`.
 */
export const FACE_FRAME_HEADER_FLOATS = 8
/** Header slots after the four `FaceFrame` scalars, free for the producer (frame id, timings…). */
export const FACE_FRAME_USER_SLOTS = FACE_FRAME_HEADER_FLOATS - 4
export const FACE_FRAME_HEADER_BYTES = FACE_FRAME_HEADER_FLOATS * 8

const COUNT = 0
const MEDIA_TIME = 1
const WIDTH = 2
const HEIGHT = 3

/** Size in bytes of a buffer holding a `FaceFrame` for `maxFaces` faces. */
export function faceFrameByteLength(maxFaces: number): number {
  checkMaxFaces(maxFaces)
  return FACE_FRAME_HEADER_BYTES + maxFaces * (LANDMARKS_STRIDE + BLENDSHAPES_STRIDE + MATRIX_STRIDE) * 4
}

/** Number of faces a buffer of `byteLength` bytes holds (the inverse of `faceFrameByteLength`), or 0 if invalid. */
export function faceFrameCapacity(byteLength: number): number {
  const perFace = (LANDMARKS_STRIDE + BLENDSHAPES_STRIDE + MATRIX_STRIDE) * 4
  const faces = (byteLength - FACE_FRAME_HEADER_BYTES) / perFace
  return Number.isInteger(faces) && faces >= 1 ? faces : 0
}

/** A `FaceFrame` whose scalars and arrays live in `buffer`. */
export interface FaceFrameView extends FaceFrame {
  readonly buffer: ArrayBufferLike
  /**
   * The whole float64 header; slots `4…FACE_FRAME_HEADER_FLOATS - 1` are free for the producer and travel with the
   * buffer (e.g. the id of the frame the results belong to, the inference time).
   */
  readonly header: Float64Array
}

/**
 * Wraps a buffer of `faceFrameByteLength(maxFaces)` bytes (`maxFaces` defaults to what the buffer holds). Writing
 * through the view writes into the buffer, so a `FaceTracker` can `detect` straight into it. Creates a few view
 * objects: build one per received buffer, not per access.
 */
export function faceFrameView(buffer: ArrayBufferLike, maxFaces: number = faceFrameCapacity(buffer.byteLength)): FaceFrameView {
  const expected = faceFrameByteLength(maxFaces)
  if (buffer.byteLength !== expected) {
    throw new RangeError(`A FaceFrame buffer for ${maxFaces} face(s) is ${expected} bytes, got ${buffer.byteLength}`)
  }
  const header = new Float64Array(buffer, 0, FACE_FRAME_HEADER_FLOATS)
  let offset = FACE_FRAME_HEADER_BYTES
  const landmarks = new Float32Array(buffer, offset, maxFaces * LANDMARKS_STRIDE)
  offset += landmarks.byteLength
  const blendshapes = new Float32Array(buffer, offset, maxFaces * BLENDSHAPES_STRIDE)
  offset += blendshapes.byteLength
  const matrices = new Float32Array(buffer, offset, maxFaces * MATRIX_STRIDE)
  return {
    buffer,
    header,
    maxFaces,
    get count() {
      return header[COUNT] as number
    },
    set count(v: number) {
      header[COUNT] = v
    },
    get mediaTime() {
      return header[MEDIA_TIME] as number
    },
    set mediaTime(v: number) {
      header[MEDIA_TIME] = v
    },
    get width() {
      return header[WIDTH] as number
    },
    set width(v: number) {
      header[WIDTH] = v
    },
    get height() {
      return header[HEIGHT] as number
    },
    set height(v: number) {
      header[HEIGHT] = v
    },
    landmarks,
    blendshapes,
    matrices,
  }
}

/**
 * Copies the results of `src` into `dst` (scalars and the first `count` face slices, clamped to `dst.maxFaces`),
 * e.g. from a `FaceFrameView` over a buffer that goes back to its pool into the frame the renderer reads. Does not
 * allocate.
 */
export function copyFaceFrame(src: Readonly<FaceFrame>, dst: FaceFrame): FaceFrame {
  const count = Math.max(0, Math.min(Math.trunc(src.count) || 0, src.maxFaces, dst.maxFaces))
  dst.count = count
  dst.mediaTime = src.mediaTime
  dst.width = src.width
  dst.height = src.height
  if (count > 0) {
    dst.landmarks.set(src.landmarks.subarray(0, count * LANDMARKS_STRIDE))
    dst.blendshapes.set(src.blendshapes.subarray(0, count * BLENDSHAPES_STRIDE))
    dst.matrices.set(src.matrices.subarray(0, count * MATRIX_STRIDE))
  }
  return dst
}

function checkMaxFaces(maxFaces: number): void {
  if (!Number.isInteger(maxFaces) || maxFaces < 1) throw new RangeError(`maxFaces must be a positive integer, got ${maxFaces}`)
}
