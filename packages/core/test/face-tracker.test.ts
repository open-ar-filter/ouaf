import type { FaceLandmarkerOptions, FaceLandmarkerResult } from '@mediapipe/tasks-vision'
import { describe, expect, it, vi } from 'vitest'
import {
  BLENDSHAPE_NAMES,
  BLENDSHAPES_STRIDE,
  LANDMARK_COUNT,
  LANDMARKS_STRIDE,
  MATRIX_STRIDE,
  blendshapeIndex,
  createFaceFrame,
} from '../src/index.ts'
import { createFaceTrackerWith, type Landmarker, type LandmarkerBackend } from '../src/face-tracker.ts'

const WARMUP = { warmup: true } as unknown as TexImageSource
const MODEL = new Uint8Array([1, 2, 3])

/** A face whose values encode its index, so slices can be told apart. */
function fakeFace(face: number, { landmarks = LANDMARK_COUNT, names = BLENDSHAPE_NAMES as readonly string[] } = {}) {
  return {
    landmarks: Array.from({ length: landmarks }, (_, i) => ({ x: face + i / 1000, y: face + 0.5, z: -i, visibility: 0 })),
    blendshapes: {
      headIndex: 0,
      headName: '',
      categories: names.map((categoryName, index) => ({ index, score: (face * 100 + index) / 1000, categoryName, displayName: '' })),
    },
    matrix: { rows: 4, columns: 4, data: Array.from({ length: 16 }, (_, i) => face * 100 + i) },
  }
}

function result(faces: ReturnType<typeof fakeFace>[]): FaceLandmarkerResult {
  return {
    faceLandmarks: faces.map((f) => f.landmarks),
    faceBlendshapes: faces.map((f) => f.blendshapes),
    facialTransformationMatrixes: faces.map((f) => f.matrix),
  }
}

const EMPTY = result([])

interface FakeOptions {
  /** Delegates whose creation rejects. */
  failCreate?: Array<'GPU' | 'CPU'>
  /** Delegates whose warm-up inference throws. */
  failWarmup?: Array<'GPU' | 'CPU'>
  /** Results of the successive inferences after the warm-up; an `Error` is thrown instead. */
  results?: Array<FaceLandmarkerResult | Error>
}

/** Fake MediaPipe backend recording every created landmarker and call. */
function fakeBackend({ failCreate = [], failWarmup = [], results = [] }: FakeOptions = {}) {
  const created: Array<{ options: FaceLandmarkerOptions; loader: string; closed: number; calls: Array<{ frame: unknown; ts: number }> }> = []
  const loadModel = vi.fn(async (_url: string) => MODEL)
  const backend: LandmarkerBackend = {
    loadModel,
    async createLandmarker(_wasm, options, loader) {
      const delegate = options.baseOptions?.delegate ?? 'CPU'
      const record = { options, loader, closed: 0, calls: [] as Array<{ frame: unknown; ts: number }> }
      created.push(record)
      if (failCreate.includes(delegate)) throw new Error(`${delegate} create failed`)
      const landmarker: Landmarker = {
        detectForVideo(frame, ts) {
          record.calls.push({ frame, ts })
          if (frame === WARMUP) {
            if (failWarmup.includes(delegate)) throw new Error(`${delegate} warm-up failed`)
            return EMPTY
          }
          const next = results.shift() ?? EMPTY
          if (next instanceof Error) throw next
          return next
        },
        close() {
          record.closed++
        },
      }
      return landmarker
    },
    warmupFrame: () => WARMUP,
  }
  return { backend, created, loadModel }
}

const video = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement
const base = { wasmBaseUrl: '/mediapipe/wasm/', modelUrl: '/models/face_landmarker.task' }

describe('createFaceTracker', () => {
  it('configures MediaPipe for VIDEO mode with blendshapes and matrices, GPU first', async () => {
    const { backend, created, loadModel } = fakeBackend()
    const tracker = await createFaceTrackerWith({ ...base, maxFaces: 3 }, backend)
    expect(tracker.delegate).toBe('GPU')
    expect(tracker.maxFaces).toBe(3)
    expect(loadModel).toHaveBeenCalledWith('/models/face_landmarker.task')
    expect(created).toHaveLength(1)
    expect(created[0]!.options).toEqual({
      baseOptions: { modelAssetBuffer: MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 3,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    })
    // One warm-up inference validates the delegate.
    expect(created[0]!.calls).toEqual([{ frame: WARMUP, ts: 0 }])
    expect(created[0]!.loader).toBe('classic')
  })

  it('passes the wasm loader and the canvas (worker use)', async () => {
    const { backend, created } = fakeBackend({ failCreate: ['GPU'] })
    const canvas = { offscreen: true } as unknown as OffscreenCanvas
    await createFaceTrackerWith({ ...base, wasmLoader: 'module', canvas, onWarning: () => {} }, backend)
    // The CPU fallback gets them too.
    for (const c of created) {
      expect(c.loader).toBe('module')
      expect(c.options.canvas).toBe(canvas)
    }
    expect(created).toHaveLength(2)
  })

  it('can skip the blendshapes model', async () => {
    const { backend, created } = fakeBackend()
    await createFaceTrackerWith({ ...base, blendshapes: false }, backend)
    expect(created[0]!.options.outputFaceBlendshapes).toBe(false)
  })

  it('falls back to CPU when the GPU landmarker cannot be created, and reports it', async () => {
    const { backend, created, loadModel } = fakeBackend({ failCreate: ['GPU'] })
    const onWarning = vi.fn()
    const tracker = await createFaceTrackerWith({ ...base, onWarning }, backend)
    expect(tracker.delegate).toBe('CPU')
    expect(created.map((c) => c.options.baseOptions?.delegate)).toEqual(['GPU', 'CPU'])
    expect(onWarning).toHaveBeenCalledWith(expect.stringMatching(/falling back to CPU/), expect.any(Error))
    expect(loadModel).toHaveBeenCalledTimes(1) // the model is downloaded once
  })

  it('falls back to CPU when the GPU warm-up inference fails, closing the GPU landmarker', async () => {
    const { backend, created } = fakeBackend({ failWarmup: ['GPU'] })
    const tracker = await createFaceTrackerWith({ ...base, onWarning: () => {} }, backend)
    expect(tracker.delegate).toBe('CPU')
    expect(created[0]!.closed).toBe(1)
    expect(created[1]!.closed).toBe(0)
  })

  it('skips the GPU when CPU is requested', async () => {
    const { backend, created } = fakeBackend()
    const tracker = await createFaceTrackerWith({ ...base, delegate: 'CPU' }, backend)
    expect(tracker.delegate).toBe('CPU')
    expect(created).toHaveLength(1)
  })

  it('rejects when neither delegate works', async () => {
    const { backend } = fakeBackend({ failCreate: ['GPU'], failWarmup: ['CPU'] })
    await expect(createFaceTrackerWith({ ...base, onWarning: () => {} }, backend)).rejects.toThrow(/CPU warm-up failed/)
  })

  it('rejects an invalid maxFaces', async () => {
    const { backend } = fakeBackend()
    await expect(createFaceTrackerWith({ ...base, maxFaces: 0 }, backend)).rejects.toThrow(RangeError)
  })
})

describe('FaceTracker.detect', () => {
  it('copies landmarks, blendshapes and matrices into the face slices', async () => {
    const { backend } = fakeBackend({ results: [result([fakeFace(0), fakeFace(1)])] })
    const tracker = await createFaceTrackerWith({ ...base, maxFaces: 2 }, backend)
    const out = createFaceFrame(2)
    tracker.detect(video, 100, 3.5, out)

    expect(out.count).toBe(2)
    expect(out.mediaTime).toBe(3.5)
    expect([out.width, out.height]).toEqual([640, 480])
    for (const f of [0, 1]) {
      const l = f * LANDMARKS_STRIDE
      expect(out.landmarks[l + 0]).toBeCloseTo(f)
      expect(out.landmarks[l + 1]).toBeCloseTo(f + 0.5)
      expect(out.landmarks[l + 3 * 477 + 0]).toBeCloseTo(f + 0.477)
      expect(out.landmarks[l + 3 * 477 + 2]).toBe(-477)
      const b = f * BLENDSHAPES_STRIDE
      expect(out.blendshapes[b + blendshapeIndex('jawOpen')]).toBeCloseTo((f * 100 + 25) / 1000)
      expect(out.blendshapes[b + 51]).toBeCloseTo((f * 100 + 51) / 1000)
      expect(Array.from(out.matrices.subarray(f * MATRIX_STRIDE, (f + 1) * MATRIX_STRIDE))).toEqual(
        Array.from({ length: 16 }, (_, i) => f * 100 + i),
      )
    }
  })

  it('reads the size of captured frames (VideoFrame, ImageBitmap) and passes them to MediaPipe', async () => {
    const { backend, created } = fakeBackend({ results: [result([fakeFace(0)]), result([fakeFace(0)])] })
    const tracker = await createFaceTrackerWith(base, backend)
    const out = createFaceFrame(1)
    const frame = { displayWidth: 1280, displayHeight: 720, codedWidth: 1296, codedHeight: 736 } as VideoFrame
    tracker.detect(frame, 100, 1, out)
    expect([out.width, out.height, out.count]).toEqual([1280, 720, 1])
    const bitmap = { width: 320, height: 240 } as ImageBitmap
    tracker.detect(bitmap, 133, 1.033, out)
    expect([out.width, out.height, out.count]).toEqual([320, 240, 1])
    expect(created[0]!.calls.map((c) => c.frame)).toEqual([WARMUP, frame, bitmap])
  })

  it('clamps the count to maxFaces', async () => {
    const { backend } = fakeBackend({ results: [result([fakeFace(0), fakeFace(1), fakeFace(2)])] })
    const tracker = await createFaceTrackerWith({ ...base, maxFaces: 2 }, backend)
    const out = createFaceFrame(2)
    tracker.detect(video, 100, 0, out)
    expect(out.count).toBe(2)
  })

  it('also clamps to a smaller FaceFrame', async () => {
    const { backend } = fakeBackend({ results: [result([fakeFace(0), fakeFace(1)])] })
    const tracker = await createFaceTrackerWith({ ...base, maxFaces: 2 }, backend)
    const out = createFaceFrame(1)
    tracker.detect(video, 100, 0, out)
    expect(out.count).toBe(1)
  })

  it('reports zero faces', async () => {
    const { backend } = fakeBackend({ results: [result([fakeFace(0)]), EMPTY] })
    const tracker = await createFaceTrackerWith(base, backend)
    const out = createFaceFrame(1)
    tracker.detect(video, 100, 0, out)
    expect(out.count).toBe(1)
    tracker.detect(video, 133, 0.033, out)
    expect(out.count).toBe(0)
    expect(out.mediaTime).toBe(0.033)
  })

  it('skips inference while the video has no frame', async () => {
    const { backend, created } = fakeBackend()
    const tracker = await createFaceTrackerWith(base, backend)
    const out = createFaceFrame(1)
    out.count = 1
    tracker.detect({ videoWidth: 0, videoHeight: 0 } as HTMLVideoElement, 100, 0, out)
    expect(out.count).toBe(0)
    expect(created[0]!.calls).toHaveLength(1) // warm-up only
  })

  it('zeroes missing landmarks and uses an identity matrix when none is provided', async () => {
    const face = fakeFace(1, { landmarks: 468 })
    const res = result([face])
    res.facialTransformationMatrixes = []
    const { backend } = fakeBackend({ results: [result([fakeFace(2)]), res] })
    const tracker = await createFaceTrackerWith(base, backend)
    const out = createFaceFrame(1)
    tracker.detect(video, 100, 0, out) // fills every slot with face 2
    tracker.detect(video, 133, 0, out)
    expect(out.count).toBe(1)
    expect(out.landmarks[3 * 467]).toBeCloseTo(1.467)
    expect(Array.from(out.landmarks.subarray(3 * 468, LANDMARKS_STRIDE)).every((v) => v === 0)).toBe(true)
    expect(Array.from(out.matrices)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  })

  it('maps blendshapes by name when MediaPipe uses another layout, and warns once', async () => {
    // Swap two categories and drop the last one.
    const names = [...BLENDSHAPE_NAMES] as string[]
    ;[names[1], names[2]] = [names[2]!, names[1]!]
    names.pop()
    const onWarning = vi.fn()
    const { backend } = fakeBackend({ results: [result([fakeFace(0, { names })]), result([fakeFace(0, { names })])] })
    const tracker = await createFaceTrackerWith({ ...base, onWarning }, backend)
    const out = createFaceFrame(1)
    tracker.detect(video, 100, 0, out)
    tracker.detect(video, 133, 0, out)
    expect(onWarning).toHaveBeenCalledTimes(1)
    expect(onWarning.mock.calls[0]![0]).toMatch(/noseSneerRight/)
    expect(out.blendshapes[blendshapeIndex('browDownLeft')]).toBeCloseTo(2 / 1000) // MediaPipe index 2
    expect(out.blendshapes[blendshapeIndex('browDownRight')]).toBeCloseTo(1 / 1000)
    expect(out.blendshapes[blendshapeIndex('noseSneerRight')]).toBe(0)
  })

  it('does not warn when blendshapes match BLENDSHAPE_NAMES', async () => {
    const onWarning = vi.fn()
    const { backend } = fakeBackend({ results: [result([fakeFace(0)])] })
    const tracker = await createFaceTrackerWith({ ...base, onWarning }, backend)
    tracker.detect(video, 100, 0, createFaceFrame(1))
    expect(onWarning).not.toHaveBeenCalled()
  })

  it('keeps MediaPipe timestamps strictly increasing', async () => {
    const { backend, created } = fakeBackend()
    const tracker = await createFaceTrackerWith(base, backend)
    const out = createFaceFrame(1)
    for (const ts of [100, 133, 133, 50, 83]) tracker.detect(video, ts, 0, out)
    // Warm-up at 0; the repeated 133 becomes 134; the jump back to 50 continues from 135, keeping the 33 ms step.
    expect(created[0]!.calls.map((c) => c.ts)).toEqual([0, 100, 133, 134, 135, 168])
  })

  it('rejects a non-finite timestamp', async () => {
    const { backend } = fakeBackend()
    const tracker = await createFaceTrackerWith(base, backend)
    expect(() => tracker.detect(video, Number.NaN, 0, createFaceFrame(1))).toThrow(RangeError)
  })

  it('leaves an empty frame when MediaPipe throws', async () => {
    const { backend } = fakeBackend({ results: [new Error('inference failed')] })
    const tracker = await createFaceTrackerWith(base, backend)
    const out = createFaceFrame(1)
    out.count = 1
    expect(() => tracker.detect(video, 100, 2, out)).toThrow(/inference failed/)
    expect(out.count).toBe(0)
    expect(out.mediaTime).toBe(2)
  })

  it('dispose() closes the landmarker once; detect then yields empty frames', async () => {
    const { backend, created } = fakeBackend({ results: [result([fakeFace(0)])] })
    const tracker = await createFaceTrackerWith(base, backend)
    tracker.dispose()
    tracker.dispose()
    expect(created[0]!.closed).toBe(1)
    const out = createFaceFrame(1)
    out.count = 1
    tracker.detect(video, 100, 1, out)
    expect(out.count).toBe(0)
    expect(created[0]!.calls).toHaveLength(1) // warm-up only
  })
})
