import { describe, expect, it, vi } from 'vitest'
import { VideoFileError, VideoFileSource } from '../src/index.ts'

/** Minimal `<video>` double: `load()` fires `loadeddata`, or `error` with `failWith`. */
function fakeVideo(failWith?: number) {
  const listeners = new Map<string, () => void>()
  const video = {
    playsInline: false,
    muted: false,
    autoplay: false,
    loop: false,
    playbackRate: 1,
    currentTime: 0,
    srcObject: {} as unknown,
    src: '',
    videoWidth: 720,
    videoHeight: 1280,
    error: null as null | { code: number },
    setAttribute: vi.fn(),
    removeAttribute: vi.fn((name: string) => {
      if (name === 'src') video.src = ''
    }),
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    load: vi.fn(() => {
      if (!video.src) return
      queueMicrotask(() => {
        if (failWith) {
          video.error = { code: failWith }
          listeners.get('error')?.()
        } else listeners.get('loadeddata')?.()
      })
    }),
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
  }
  return video
}

describe('VideoFileSource', () => {
  it('plays the file muted, inline and looping, not mirrored by default', async () => {
    const v = fakeVideo()
    const src = await VideoFileSource.open('/clip.mp4', { video: v as unknown as HTMLVideoElement, startTime: 1.5 })
    expect(v.src).toBe('/clip.mp4')
    expect(v.srcObject).toBeNull()
    expect(v.muted && v.playsInline && v.loop).toBe(true)
    expect(v.setAttribute).toHaveBeenCalledWith('playsinline', '')
    expect(v.currentTime).toBe(1.5)
    expect(v.play).toHaveBeenCalled()
    expect(src.mirrored).toBe(false)
    expect([src.width, src.height]).toEqual([720, 1280])
  })

  it('honours loop, mirror and playbackRate', async () => {
    const v = fakeVideo()
    const src = await VideoFileSource.open('/clip.mp4', { video: v as unknown as HTMLVideoElement, loop: false, mirror: true, playbackRate: 0.5 })
    expect(v.loop).toBe(false)
    expect(v.playbackRate).toBe(0.5)
    expect(src.mirrored).toBe(true)
  })

  it('rejects with a VideoFileError when the file cannot be loaded', async () => {
    const v = fakeVideo(4)
    const p = VideoFileSource.open('/missing.mp4', { video: v as unknown as HTMLVideoElement })
    await expect(p).rejects.toBeInstanceOf(VideoFileError)
    await expect(p).rejects.toMatchObject({ url: '/missing.mp4', message: expect.stringContaining('not found') })
    expect(v.src).toBe('')
  })

  it('rejects when playback is refused', async () => {
    const v = fakeVideo()
    v.play.mockReturnValueOnce(Promise.reject(Object.assign(new Error('nope'), { name: 'NotAllowedError' })))
    await expect(VideoFileSource.open('/clip.mp4', { video: v as unknown as HTMLVideoElement })).rejects.toMatchObject({
      name: 'VideoFileError',
      message: expect.stringContaining('nope'),
    })
  })

  it('dispose() stops and unloads, once', async () => {
    const v = fakeVideo()
    const src = await VideoFileSource.open('/clip.mp4', { video: v as unknown as HTMLVideoElement })
    src.dispose()
    src.dispose()
    expect(v.pause).toHaveBeenCalledTimes(1)
    expect(v.src).toBe('')
    expect(src.disposed).toBe(true)
  })
})
