import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameScheduler, type VideoFrameInfo } from '../src/index.ts'

type Cb = (now: number, meta?: unknown) => void

/** Fake animation-frame clock: `tick()` runs the pending callbacks, like a display refresh. */
function fakeRaf() {
  let next = 1
  const pending = new Map<number, Cb>()
  vi.stubGlobal('requestAnimationFrame', (cb: Cb) => (pending.set(next, cb), next++))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id))
  return {
    pending,
    tick(now: number) {
      const cbs = [...pending.values()]
      pending.clear()
      for (const cb of cbs) cb(now)
    },
  }
}

/** Fake video element; with `rvfc`, `present()` delivers a new frame to the registered callbacks. */
function fakeVideo({ rvfc }: { rvfc: boolean }) {
  let next = 1
  const pending = new Map<number, Cb>()
  const video = {
    readyState: 4,
    currentTime: 0,
    videoWidth: 640,
    videoHeight: 480,
    ...(rvfc
      ? {
          requestVideoFrameCallback: (cb: Cb) => (pending.set(next, cb), next++),
          cancelVideoFrameCallback: (id: number) => pending.delete(id),
        }
      : {}),
  }
  return {
    video: video as unknown as HTMLVideoElement,
    raw: video,
    pending,
    present(now: number, mediaTime: number, extra: Partial<VideoFrameCallbackMetadata> = {}) {
      const cbs = [...pending.values()]
      pending.clear()
      for (const cb of cbs) cb(now, { mediaTime, width: 640, height: 480, presentedFrames: 0, presentationTime: now, expectedDisplayTime: now, ...extra })
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('console', { ...console, error: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mode selection', () => {
  it('uses requestVideoFrameCallback when available', () => {
    fakeRaf()
    expect(new FrameScheduler(fakeVideo({ rvfc: true }).video, () => {}).mode).toBe('video-frame')
  })

  it('falls back to requestAnimationFrame', () => {
    fakeRaf()
    expect(new FrameScheduler(fakeVideo({ rvfc: false }).video, () => {}).mode).toBe('animation-frame')
  })

  it('refuses an explicit video-frame mode without support', () => {
    expect(() => new FrameScheduler(fakeVideo({ rvfc: false }).video, () => {}, { mode: 'video-frame' })).toThrow()
  })
})

describe('video-frame mode', () => {
  it('calls back once per presented frame, with its metadata', () => {
    const v = fakeVideo({ rvfc: true })
    const frames: VideoFrameInfo[] = []
    const s = new FrameScheduler(v.video, (f) => frames.push(f))
    s.start()
    v.present(16, 0.033)
    v.present(49, 0.066)
    expect(frames).toEqual([
      { now: 16, mediaTime: 0.033, width: 640, height: 480, presentedFrames: 0 },
      { now: 49, mediaTime: 0.066, width: 640, height: 480, presentedFrames: 0 },
    ])
    expect(v.pending.size).toBe(1)
  })

  it('passes the capture time when the browser reports it', () => {
    const v = fakeVideo({ rvfc: true })
    const frames: VideoFrameInfo[] = []
    const s = new FrameScheduler(v.video, (f) => frames.push({ ...f }))
    s.start()
    v.present(16, 0.033, { captureTime: 5.5 })
    v.present(49, 0.066)
    expect(frames[0]!.captureTime).toBe(5.5)
    expect(frames[1]!.captureTime).toBeUndefined()
  })

  it('passes the presented frame counter', () => {
    const v = fakeVideo({ rvfc: true })
    const frames: VideoFrameInfo[] = []
    const s = new FrameScheduler(v.video, (f) => frames.push({ ...f }))
    s.start()
    v.present(16, 0.033, { presentedFrames: 10 })
    v.present(83, 0.1, { presentedFrames: 12 })
    expect(frames.map((f) => f.presentedFrames)).toEqual([10, 12])
  })

  it('stop() cancels the pending request and start() resumes', () => {
    const v = fakeVideo({ rvfc: true })
    const cb = vi.fn()
    const s = new FrameScheduler(v.video, cb)
    s.start()
    s.stop()
    expect(v.pending.size).toBe(0)
    v.present(16, 0.033)
    expect(cb).not.toHaveBeenCalled()
    s.start()
    v.present(33, 0.066)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('does not double-register when the callback restarts the scheduler', () => {
    const v = fakeVideo({ rvfc: true })
    const s: FrameScheduler = new FrameScheduler(v.video, () => (s.stop(), s.start()))
    s.start()
    v.present(16, 0.033)
    expect(v.pending.size).toBe(1)
  })

  it('stops when the callback stops it', () => {
    const v = fakeVideo({ rvfc: true })
    const s: FrameScheduler = new FrameScheduler(v.video, () => s.stop())
    s.start()
    v.present(16, 0.033)
    expect(v.pending.size).toBe(0)
    expect(s.running).toBe(false)
  })
})

describe('animation-frame mode', () => {
  it('only processes new frames', () => {
    const raf = fakeRaf()
    const v = fakeVideo({ rvfc: false })
    const times: number[] = []
    new FrameScheduler(v.video, (f) => times.push(f.mediaTime)).start()

    raf.tick(8) // currentTime 0: first frame
    raf.tick(16) // same frame
    v.raw.currentTime = 0.033
    raf.tick(24)
    raf.tick(32) // same frame
    v.raw.currentTime = 0.066
    raf.tick(40)
    expect(times).toEqual([0, 0.033, 0.066])
  })

  it('waits until the video has data', () => {
    const raf = fakeRaf()
    const v = fakeVideo({ rvfc: false })
    v.raw.readyState = 1
    const cb = vi.fn()
    new FrameScheduler(v.video, cb).start()
    raf.tick(8)
    expect(cb).not.toHaveBeenCalled()
    v.raw.readyState = 2
    raf.tick(16)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('stop() cancels the pending animation frame', () => {
    const raf = fakeRaf()
    const s = new FrameScheduler(fakeVideo({ rvfc: false }).video, () => {})
    s.start()
    expect(raf.pending.size).toBe(1)
    s.stop()
    expect(raf.pending.size).toBe(0)
  })
})

describe('errors and lifecycle', () => {
  it('reports callback errors and keeps running', () => {
    const v = fakeVideo({ rvfc: true })
    const onError = vi.fn()
    const s = new FrameScheduler(v.video, () => { throw new Error('boom') }, { onError })
    s.start()
    v.present(16, 0.033)
    v.present(33, 0.066)
    expect(onError).toHaveBeenCalledTimes(2)
    expect(s.running).toBe(true)
  })

  it('cannot be restarted after dispose()', () => {
    const v = fakeVideo({ rvfc: true })
    const s = new FrameScheduler(v.video, () => {})
    s.start()
    s.dispose()
    s.dispose()
    expect(v.pending.size).toBe(0)
    expect(() => s.start()).toThrow(/disposed/)
  })
})
