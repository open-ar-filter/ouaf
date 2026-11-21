import { describe, expect, it } from 'vitest'
import {
  BLENDSHAPES_STRIDE,
  FACE_FRAME_HEADER_BYTES,
  FACE_FRAME_HEADER_FLOATS,
  LANDMARKS_STRIDE,
  MATRIX_STRIDE,
  copyFaceFrame,
  createFaceFrame,
  faceFrameByteLength,
  faceFrameCapacity,
  faceFrameView,
} from '../src/index.ts'

const PER_FACE = (LANDMARKS_STRIDE + BLENDSHAPES_STRIDE + MATRIX_STRIDE) * 4

describe('faceFrameByteLength / faceFrameCapacity', () => {
  it('is a float64 header followed by the three float32 arrays', () => {
    expect(FACE_FRAME_HEADER_BYTES).toBe(FACE_FRAME_HEADER_FLOATS * 8)
    expect(faceFrameByteLength(1)).toBe(FACE_FRAME_HEADER_BYTES + PER_FACE)
    expect(faceFrameByteLength(4)).toBe(FACE_FRAME_HEADER_BYTES + 4 * PER_FACE)
  })

  it('inverts the byte length, and returns 0 for a size that is not a FaceFrame buffer', () => {
    for (const n of [1, 2, 8]) expect(faceFrameCapacity(faceFrameByteLength(n))).toBe(n)
    expect(faceFrameCapacity(FACE_FRAME_HEADER_BYTES)).toBe(0)
    expect(faceFrameCapacity(faceFrameByteLength(2) + 4)).toBe(0)
    expect(faceFrameCapacity(0)).toBe(0)
  })

  it('rejects an invalid maxFaces', () => {
    expect(() => faceFrameByteLength(0)).toThrow(RangeError)
    expect(() => faceFrameByteLength(1.5)).toThrow(RangeError)
  })
})

describe('faceFrameView', () => {
  it('lays the arrays out back to back, 8-byte aligned header first', () => {
    const buffer = new ArrayBuffer(faceFrameByteLength(2))
    const v = faceFrameView(buffer)
    expect(v.maxFaces).toBe(2)
    expect(v.buffer).toBe(buffer)
    expect(v.header.byteOffset).toBe(0)
    expect(v.landmarks.byteOffset).toBe(FACE_FRAME_HEADER_BYTES)
    expect(v.landmarks.length).toBe(2 * LANDMARKS_STRIDE)
    expect(v.blendshapes.byteOffset).toBe(v.landmarks.byteOffset + v.landmarks.byteLength)
    expect(v.blendshapes.length).toBe(2 * BLENDSHAPES_STRIDE)
    expect(v.matrices.byteOffset).toBe(v.blendshapes.byteOffset + v.blendshapes.byteLength)
    expect(v.matrices.length).toBe(2 * MATRIX_STRIDE)
    expect(v.matrices.byteOffset + v.matrices.byteLength).toBe(buffer.byteLength)
  })

  it('stores the scalars in the header, so they travel with the buffer', () => {
    const buffer = new ArrayBuffer(faceFrameByteLength(1))
    const writer = faceFrameView(buffer, 1)
    writer.count = 1
    writer.mediaTime = 1234.56789
    writer.width = 1280
    writer.height = 720
    writer.header[4] = 42 // producer slot
    writer.landmarks[0] = 0.25
    writer.blendshapes[BLENDSHAPES_STRIDE - 1] = 0.5
    writer.matrices[15] = 1

    // What the receiving side sees (e.g. after a transfer): a fresh view over the same bytes.
    const reader = faceFrameView(structuredClone(buffer))
    expect([reader.count, reader.mediaTime, reader.width, reader.height]).toEqual([1, 1234.56789, 1280, 720])
    expect(reader.header[4]).toBe(42)
    expect(reader.landmarks[0]).toBe(0.25)
    expect(reader.blendshapes[BLENDSHAPES_STRIDE - 1]).toBe(0.5)
    expect(reader.matrices[15]).toBe(1)
  })

  it('starts empty on a new buffer', () => {
    const v = faceFrameView(new ArrayBuffer(faceFrameByteLength(1)))
    expect([v.count, v.mediaTime, v.width, v.height]).toEqual([0, 0, 0, 0])
  })

  it('works on a SharedArrayBuffer', () => {
    const v = faceFrameView(new SharedArrayBuffer(faceFrameByteLength(1)))
    v.count = 1
    expect(v.count).toBe(1)
  })

  it('rejects a buffer of the wrong size', () => {
    expect(() => faceFrameView(new ArrayBuffer(faceFrameByteLength(2)), 1)).toThrow(RangeError)
    expect(() => faceFrameView(new ArrayBuffer(100))).toThrow(RangeError)
  })
})

describe('copyFaceFrame', () => {
  it('copies the scalars and the valid face slices', () => {
    const src = faceFrameView(new ArrayBuffer(faceFrameByteLength(2)))
    src.count = 2
    src.mediaTime = 1.5
    src.width = 640
    src.height = 480
    src.landmarks.fill(0.5)
    src.blendshapes.fill(0.25)
    src.matrices.fill(2)
    const dst = createFaceFrame(2)
    expect(copyFaceFrame(src, dst)).toBe(dst)
    expect([dst.count, dst.mediaTime, dst.width, dst.height]).toEqual([2, 1.5, 640, 480])
    expect(dst.landmarks).toEqual(src.landmarks)
    expect(dst.blendshapes).toEqual(src.blendshapes)
    expect(dst.matrices).toEqual(src.matrices)
  })

  it('clamps the count to the destination capacity', () => {
    const src = createFaceFrame(3)
    src.count = 3
    src.landmarks.fill(1)
    const dst = createFaceFrame(1)
    copyFaceFrame(src, dst)
    expect(dst.count).toBe(1)
    expect(dst.landmarks.every((v) => v === 1)).toBe(true)
  })

  it('leaves the face slices alone for an empty frame', () => {
    const src = createFaceFrame(1)
    const dst = createFaceFrame(1)
    dst.count = 1
    dst.landmarks[0] = 0.75
    copyFaceFrame(src, dst)
    expect(dst.count).toBe(0)
    expect(dst.landmarks[0]).toBe(0.75)
  })
})
