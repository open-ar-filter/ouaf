import { afterEach, describe, expect, it, vi } from 'vitest'
import { estimateFacePose } from '../src/anchoring/face-pose.ts'
import { BLENDSHAPES_STRIDE, createFaceFrame, LANDMARKS_STRIDE } from '../src/face.ts'
import type { TrackerConfig } from '../src/engine/plugin.ts'
import { RESULT_FLOATS, type FrameMessage, type FromWorker, type ToWorker } from '../src/litert/protocol.ts'
import { openLiteRtTracker } from '../src/litert/tracker.ts'
import { writeSyntheticFace } from './synthetic-face.ts'

const CONFIG: TrackerConfig = { maxFaces: 1, blendshapes: true, analysisScale: 1 }

class FakeVideoFrame {
  closed = false
  readonly displayWidth: number
  readonly displayHeight: number
  readonly source: unknown
  readonly init: { timestamp: number } | undefined
  constructor(source: unknown, init?: { timestamp: number }) {
    this.source = source
    this.init = init
    const s = source as { width?: number; height?: number; displayWidth?: number; displayHeight?: number }
    this.displayWidth = s.displayWidth ?? s.width ?? 0
    this.displayHeight = s.displayHeight ?? s.height ?? 0
  }
  clone() {
    return new FakeVideoFrame(this, this.init)
  }
  close() {
    this.closed = true
  }
}

/** A worker double: records what the tracker posts, and answers like `worker.ts`. */
class FakeWorker {
  posted: Array<{ message: ToWorker; transfer: unknown[] }> = []
  terminated = false
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  postMessage(message: ToWorker, transfer: unknown[] = []) {
    this.posted.push({ message, transfer })
  }
  terminate() {
    this.terminated = true
  }
  reply(message: FromWorker) {
    this.onmessage?.({ data: message } as MessageEvent<FromWorker>)
  }
  get frames(): FrameMessage[] {
    return this.posted.map((p) => p.message).filter((m): m is FrameMessage => m.type === 'frame')
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

async function open(options: { crop?: 'gpu' | 'canvas'; warnings?: string[] } = {}) {
  vi.stubGlobal('Worker', function Worker() {})
  vi.stubGlobal('VideoFrame', FakeVideoFrame)
  const worker = new FakeWorker()
  const warnings: string[] = []
  const env = { assetsBaseUrl: 'https://example.test/app/', warn: (m: string) => void warnings.push(m) }
  const opening = openLiteRtTracker(CONFIG, env, { createWorker: () => worker as unknown as Worker })
  expect(worker.posted[0]!.message).toEqual({ type: 'init', assetsBaseUrl: 'https://example.test/app/', crop: 'gpu' })
  worker.reply({ type: 'ready', crop: options.crop ?? 'gpu', warnings: options.warnings ?? [] })
  const tracker = await opening
  return { tracker, worker, warnings }
}

/** The worker's answer to a frame: the landmarks of a synthetic face, normalized, and blendshape scores. */
function answer(frame: FrameMessage, options: { found?: boolean; blendshapes?: boolean; error?: string } = {}) {
  const face = createFaceFrame(1)
  face.width = frame.width
  face.height = frame.height
  writeSyntheticFace(face, 0, { yaw: 10, t: [2, -1, -50] })
  const data = new Float32Array(frame.buffer, 0, RESULT_FLOATS)
  data.set(face.landmarks.subarray(0, LANDMARKS_STRIDE), 0)
  for (let i = 0; i < BLENDSHAPES_STRIDE; i++) data[LANDMARKS_STRIDE + i] = i / 100
  return {
    type: 'result' as const,
    id: frame.id,
    buffer: frame.buffer,
    found: options.found ?? true,
    hasBlendshapes: options.blendshapes ?? frame.blendshapes,
    timings: { detectMs: Number.NaN, uploadMs: 2, cropMs: 3, landmarksMs: 7, blendshapesMs: 1 },
    warnings: [],
    receivedAt: frame.sentAt + 1,
    startedAt: frame.sentAt + 1,
    idleMs: 0,
    postedAt: frame.sentAt + 9,
    ...(options.error ? { error: options.error } : {}),
    face,
  }
}

describe('LiteRtFrameTracker (page side of the worker)', () => {
  it('transfers a VideoFrame and a result buffer, and writes the result into the FaceFrame with its matrix', async () => {
    const { tracker, worker, warnings } = await open()
    expect(tracker.description).toBe('LiteRT.js wasm in a worker, WebGL2 crops, VideoFrame')
    expect(tracker.eager).toBe(true)
    const video = { videoWidth: 720, videoHeight: 1280 } as HTMLVideoElement
    const out = createFaceFrame(1)
    const done = tracker.track(video, 1, 0.5, out)
    expect(done).toBeInstanceOf(Promise)
    const [frame] = worker.frames
    expect(frame).toMatchObject({ id: 1, width: 720, height: 1280, blendshapes: true, reset: false })
    expect(frame!.frame).toBeInstanceOf(FakeVideoFrame)
    expect((frame!.frame as unknown as FakeVideoFrame).init).toEqual({ timestamp: 500_000 })
    expect(worker.posted.at(-1)!.transfer).toEqual([frame!.frame, frame!.buffer])
    expect(() => tracker.track(video, 2, 0.6, createFaceFrame(1))).toThrow('already in flight')

    const reply = answer(frame!)
    worker.reply(reply)
    await done
    expect(out.count).toBe(1)
    expect(out.mediaTime).toBe(0.5)
    expect([out.width, out.height]).toEqual([720, 1280])
    expect(out.landmarks).toEqual(reply.face.landmarks)
    expect(out.blendshapes[3]).toBeCloseTo(0.03, 6)
    const matrix = new Float32Array(16)
    estimateFacePose(reply.face, 0, matrix, 0)
    expect(out.matrices.subarray(0, 16)).toEqual(matrix)
    expect(tracker.timings).toMatchObject({ toWorkerMs: 1, workerMs: 8, cropMs: 3, landmarksMs: 7, blendshapesMs: 1, detectMs: 0 })
    expect(warnings).toEqual([])
  })

  it('skips blendshapes when the engine does not want them, and forgets the face on reset', async () => {
    const { tracker, worker } = await open()
    const canvas = { width: 640, height: 480 } as OffscreenCanvas
    tracker.configure({ ...CONFIG, blendshapes: false })
    tracker.reset()
    const out = createFaceFrame(1)
    out.blendshapes.fill(0.5)
    const done = tracker.track(canvas, 1, 0, out)
    const frame = worker.frames[0]!
    expect(frame).toMatchObject({ blendshapes: false, reset: true })
    worker.reply(answer(frame))
    await done
    expect(out.count).toBe(1)
    expect(Math.max(...out.blendshapes)).toBe(0)
    // The reset applies once; result buffers come back to the pool and are reused.
    const next = tracker.track(canvas, 2, 0.1, out)
    expect(worker.frames[1]).toMatchObject({ reset: false })
    worker.reply(answer(worker.frames[1]!, { found: false }))
    await next
    expect(out.count).toBe(0)
  })

  it('copies a VideoFrame given by the caller (who keeps and closes it)', async () => {
    const { tracker, worker } = await open()
    const own = new FakeVideoFrame({ width: 320, height: 240 })
    const done = tracker.track(own as unknown as VideoFrame, 1, 0, createFaceFrame(1))
    const sent = worker.frames[0]!.frame as unknown as FakeVideoFrame
    expect(sent).not.toBe(own)
    expect(sent.source).toBe(own)
    worker.reply(answer(worker.frames[0]!))
    await done
    expect(own.closed).toBe(false)
  })

  it('a frame without size has no face, and nothing is sent', async () => {
    const { tracker, worker } = await open()
    const out = createFaceFrame(1)
    out.count = 1
    expect(tracker.track({ videoWidth: 0, videoHeight: 0 } as HTMLVideoElement, 1, 0, out)).toBeUndefined()
    expect(out.count).toBe(0)
    expect(worker.frames).toEqual([])
  })

  it('posts offered frames at once; the next call takes the newest one, done or in progress', async () => {
    const { tracker, worker } = await open()
    const video = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement
    const out = createFaceFrame(1)
    const first = tracker.track(video, 1, 0.1, out)
    // A frame that comes while the call is in flight goes to the worker now; one waits there at most.
    tracker.offer(video, 2, 0.2)
    tracker.offer(video, 2.5, 0.25)
    expect(worker.frames.map((f) => f.id)).toEqual([1, 2])
    worker.reply(answer(worker.frames[0]!))
    await first
    expect(out.mediaTime).toBe(0.1)
    tracker.offer(video, 3, 0.3)
    expect(worker.frames.map((f) => f.id)).toEqual([1, 2, 3])
    // The worker dropped frame 2 for frame 3, whose result comes before the next call: that call takes it at once.
    worker.reply({ ...answer(worker.frames[1]!, { found: false }), dropped: true })
    worker.reply(answer(worker.frames[2]!))
    expect(tracker.track(video, 4, 0.4, out)).toBeUndefined()
    expect([out.count, out.mediaTime]).toEqual([1, 0.3])
    // ...and starts the worker on the current frame for the call after.
    expect(worker.frames.at(-1)).toMatchObject({ id: 4 })
    const next = tracker.track(video, 5, 0.5, out)
    expect(worker.frames).toHaveLength(4) // frame 4 is still running: the call takes it
    worker.reply(answer(worker.frames[3]!))
    await next
    expect(out.mediaTime).toBe(0.4)
    // Buffers come back to the pool: no more than the frames in flight at once were allocated.
    expect(new Set(worker.frames.map((f) => f.buffer)).size).toBeLessThanOrEqual(3)
  })

  it('a call whose queued frame is dropped for a newer one takes the newer one', async () => {
    const { tracker, worker } = await open()
    const video = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement
    const out = createFaceFrame(1)
    const first = tracker.track(video, 1, 0.1, out)
    tracker.offer(video, 2, 0.2)
    worker.reply(answer(worker.frames[0]!))
    await first
    const second = tracker.track(video, 3, 0.3, out) // takes frame 2, queued in the worker
    tracker.offer(video, 4, 0.4) // replaces it there
    worker.reply({ ...answer(worker.frames[1]!, { found: false }), dropped: true })
    worker.reply(answer(worker.frames[2]!))
    await second
    expect([out.count, out.mediaTime]).toEqual([1, 0.4])
  })

  it('does not hand a frame of another source, nor one from before a reset', async () => {
    const { tracker, worker } = await open()
    const a = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement
    const b = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement
    const out = createFaceFrame(1)
    const first = tracker.track(a, 1, 0.1, out)
    tracker.offer(a, 2, 0.2)
    worker.reply(answer(worker.frames[0]!))
    await first
    worker.reply(answer(worker.frames[1]!))
    const other = tracker.track(b, 3, 0.3, out) // frame 2 is of `a`: a new frame of `b` is posted
    expect(worker.frames.at(-1)).toMatchObject({ id: 3 })
    worker.reply(answer(worker.frames[2]!))
    await other
    expect(out.mediaTime).toBe(0.3)
    tracker.offer(b, 4, 0.4)
    tracker.reset()
    const after = tracker.track(b, 5, 0.5, out)
    expect(worker.frames.at(-1)).toMatchObject({ id: 5, reset: true })
    worker.reply(answer(worker.frames[3]!))
    worker.reply(answer(worker.frames[4]!))
    await after
    expect(out.mediaTime).toBe(0.5)
  })

  it('reads a camera through its track in the worker, and goes back to the video element when the frames differ', async () => {
    class FakeElement {}
    class FakeStream {
      readonly tracks: unknown[]
      constructor(tracks: unknown[]) {
        this.tracks = tracks
      }
      getVideoTracks() {
        return this.tracks
      }
    }
    const readables: unknown[] = []
    vi.stubGlobal('HTMLVideoElement', FakeElement)
    vi.stubGlobal('MediaStream', FakeStream)
    vi.stubGlobal(
      'MediaStreamTrackProcessor',
      class {
        readonly readable = { id: readables.length }
        constructor() {
          readables.push(this.readable)
        }
      },
    )
    const { tracker, worker, warnings } = await open()
    const track = { readyState: 'live' }
    const video = Object.assign(new FakeElement(), { videoWidth: 720, videoHeight: 1280, srcObject: new FakeStream([track]) }) as unknown as HTMLVideoElement
    const out = createFaceFrame(1)
    const first = tracker.track(video, 1, 0.1, out)
    // The stream once, then frame messages without a frame: the worker takes the camera's newest one.
    expect(worker.posted.slice(1).map((p) => p.message.type)).toEqual(['stream', 'frame'])
    expect(worker.posted[1]!.transfer).toEqual([readables[0]])
    expect(worker.frames[0]!.frame).toBeUndefined()
    expect(tracker.description).toBe('LiteRT.js wasm in a worker, WebGL2 crops, camera track')
    worker.reply(answer(worker.frames[0]!))
    await first
    expect([out.count, out.width, out.height]).toEqual([1, 720, 1280])
    const second = tracker.track(video, 2, 0.2, out)
    expect(readables).toHaveLength(1)
    // The worker found the camera's frames rotated: this call ends without a face, the next ones capture frames.
    worker.reply({ ...answer(worker.frames[1]!, { found: false }), streamUnusable: "the camera's frames are rotated by 90°" })
    await second
    expect(out.count).toBe(0)
    expect(warnings).toEqual(["The face tracker reads the camera through the video element: the camera's frames are rotated by 90°."])
    void tracker.track(video, 3, 0.3, out)
    expect(worker.frames[2]!.frame).toBeInstanceOf(FakeVideoFrame)
    expect(tracker.description).toBe('LiteRT.js wasm in a worker, WebGL2 crops, VideoFrame')
  })

  it('reports a failed run once as a warning; a dead worker fails the call and every later one', async () => {
    const { tracker, worker, warnings } = await open()
    const video = { videoWidth: 64, videoHeight: 64 } as HTMLVideoElement
    for (let i = 0; i < 2; i++) {
      const done = tracker.track(video, i + 1, 0, createFaceFrame(1))
      worker.reply(answer(worker.frames[i]!, { found: false, error: 'boom' }))
      await done
    }
    expect(warnings).toEqual(['LiteRT.js face tracking failed on a frame: boom'])
    const done = tracker.track(video, 3, 0, createFaceFrame(1))
    worker.onerror!({ message: 'out of memory', preventDefault() {} } as ErrorEvent)
    await expect(done).rejects.toThrow("The LiteRT.js face tracker's worker failed: out of memory.")
    expect(tracker.broken).toBe(true)
    expect(() => tracker.track(video, 4, 0, createFaceFrame(1))).toThrow('out of memory')
    tracker.dispose()
    expect(worker.terminated).toBe(true)
  })

  it('passes on the warnings of the worker, and fails to open when the worker cannot start', async () => {
    const { warnings } = await open({ crop: 'canvas', warnings: ['No WebGL2 on OffscreenCanvas in workers here: face crops on a 2D canvas (slower).'] })
    expect(warnings).toEqual(['No WebGL2 on OffscreenCanvas in workers here: face crops on a 2D canvas (slower).'])

    vi.stubGlobal('Worker', function Worker() {})
    const worker = new FakeWorker()
    const opening = openLiteRtTracker(CONFIG, { assetsBaseUrl: 'https://example.test/', warn: () => {} }, { createWorker: () => worker as unknown as Worker })
    worker.reply({ type: 'error', message: 'Could not download /models/face_detector.tflite: HTTP 404.' })
    await expect(opening).rejects.toThrow('The LiteRT.js face tracker could not start: Could not download /models/face_detector.tflite: HTTP 404.')
    expect(worker.terminated).toBe(true)
  })
})
