import { afterEach, describe, expect, it, vi } from 'vitest'
import { CameraError, CameraSource, resolveMirror, toCameraError, videoConstraints } from '../src/index.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function domError(name: string) {
  return Object.assign(new Error(`${name} message`), { name })
}

describe('toCameraError', () => {
  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['SecurityError', 'permission-denied'],
    ['NotFoundError', 'not-found'],
    ['NotReadableError', 'in-use'],
    ['OverconstrainedError', 'overconstrained'],
    ['AbortError', 'aborted'],
  ])('%s → %s', (name, code) => {
    const err = toCameraError(domError(name))
    expect(err).toBeInstanceOf(CameraError)
    expect(err.code).toBe(code)
    expect(err.cause).toBeInstanceOf(Error)
  })

  it('maps unknown errors, keeping their message', () => {
    const err = toCameraError(new TypeError('weird'))
    expect(err.code).toBe('unknown')
    expect(err.message).toContain('weird')
  })

  it('keeps an existing CameraError', () => {
    const e = new CameraError('not-found', 'x')
    expect(toCameraError(e)).toBe(e)
  })
})

describe('videoConstraints', () => {
  it('defaults to the front camera, 1280×720 @ 30 fps, all ideal', () => {
    expect(videoConstraints()).toEqual({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
      facingMode: { ideal: 'user' },
    })
  })

  it('deviceId wins over facingMode', () => {
    const c = videoConstraints({ deviceId: 'abc', facingMode: 'environment' })
    expect(c.deviceId).toEqual({ exact: 'abc' })
    expect(c.facingMode).toBeUndefined()
  })
})

describe('resolveMirror', () => {
  it('mirrors front cameras and cameras that report nothing', () => {
    expect(resolveMirror('auto', 'user')).toBe(true)
    expect(resolveMirror(undefined, undefined)).toBe(true)
  })

  it('does not mirror rear cameras', () => {
    expect(resolveMirror('auto', 'environment')).toBe(false)
  })

  it('honours an explicit choice', () => {
    expect(resolveMirror(false, 'user')).toBe(false)
    expect(resolveMirror(true, 'environment')).toBe(true)
  })
})

describe('CameraSource.open', () => {
  it('refuses insecure contexts', async () => {
    vi.stubGlobal('window', { isSecureContext: false })
    await expect(CameraSource.open()).rejects.toMatchObject({ code: 'insecure-context' })
  })

  it('reports missing getUserMedia', async () => {
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', {})
    await expect(CameraSource.open()).rejects.toMatchObject({ code: 'not-supported' })
  })

  it('surfaces a permission refusal as an explicit error', async () => {
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.reject(domError('NotAllowedError')) } })
    await expect(CameraSource.open()).rejects.toMatchObject({ name: 'CameraError', code: 'permission-denied' })
  })

  it('plays the stream inline, resolves mirroring and releases the camera on dispose', async () => {
    const track = { stop: vi.fn(), getSettings: () => ({ facingMode: 'environment' }) }
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
    const video = {
      playsInline: false,
      muted: false,
      autoplay: false,
      srcObject: null as unknown,
      setAttribute: vi.fn(),
      play: vi.fn(() => Promise.resolve()),
      pause: vi.fn(),
    }
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.resolve(stream) } })

    const cam = await CameraSource.open({ facingMode: 'environment', video: video as unknown as HTMLVideoElement })
    expect(video.playsInline && video.muted).toBe(true)
    expect(video.setAttribute).toHaveBeenCalledWith('playsinline', '')
    expect(video.srcObject).toBe(stream)
    expect(cam.facingMode).toBe('environment')
    expect(cam.mirrored).toBe(false)

    cam.dispose()
    cam.dispose()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(video.srcObject).toBeNull()
    expect(cam.disposed).toBe(true)
  })

  it('releases the camera when playback fails', async () => {
    const track = { stop: vi.fn(), getSettings: () => ({}) }
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
    const video = { setAttribute() {}, play: () => Promise.reject(domError('NotAllowedError')), srcObject: null as unknown }
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.resolve(stream) } })

    await expect(CameraSource.open({ video: video as unknown as HTMLVideoElement })).rejects.toMatchObject({ code: 'permission-denied' })
    expect(track.stop).toHaveBeenCalled()
    expect(video.srcObject).toBeNull()
  })
})
