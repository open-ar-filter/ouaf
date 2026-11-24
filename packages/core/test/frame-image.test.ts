import { afterEach, describe, expect, it, vi } from 'vitest'
import { IncompatibleSourceError } from '../src/engine/errors.ts'
import {
  assertReadable,
  describeImage,
  imageHeight,
  imageWidth,
  isCanvas,
  isFrameImage,
  isSecurityError,
  taintedError,
  type FrameImage,
  type SourceImage,
} from '../src/frame-image.ts'

// Node has none of the browser image classes: these stand in for them (stubbed as globals where a test needs one).
class FakeCanvas {
  width = 4
  height = 3
}
class FakeOffscreenCanvas {
  width = 8
  height = 6
}
class FakeImage {
  naturalWidth = 0
  naturalHeight = 0
  width = 300
  height = 150
}
class FakeBitmap {
  width = 2
  height = 2
}
class FakeVideoFrame {
  displayWidth = 640
  displayHeight = 360
  codedWidth = 648
  codedHeight = 368
}

const as = <T>(value: object) => value as unknown as T

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isFrameImage / isCanvas', () => {
  it('are false for everything when the browser classes do not exist (Node, workers without them)', () => {
    for (const value of [new FakeCanvas(), new FakeImage(), { videoWidth: 1 }, null, undefined, 42, 'img']) {
      expect(isFrameImage(value)).toBe(false)
      expect(isCanvas(value)).toBe(false)
    }
  })

  it('recognise each image type of FrameImage, and only canvases as canvases', () => {
    vi.stubGlobal('HTMLCanvasElement', FakeCanvas)
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    vi.stubGlobal('HTMLImageElement', FakeImage)
    vi.stubGlobal('ImageBitmap', FakeBitmap)
    vi.stubGlobal('VideoFrame', FakeVideoFrame)
    for (const value of [new FakeCanvas(), new FakeOffscreenCanvas(), new FakeImage(), new FakeBitmap(), new FakeVideoFrame()]) {
      expect(isFrameImage(value)).toBe(true)
    }
    expect(isCanvas(new FakeCanvas())).toBe(true)
    expect(isCanvas(new FakeOffscreenCanvas())).toBe(true)
    expect(isCanvas(new FakeImage())).toBe(false)
    expect(isCanvas(new FakeBitmap())).toBe(false)
    // A `<video>` is a source image but not a frame image; a look-alike object is neither.
    expect(isFrameImage({ videoWidth: 640, videoHeight: 480 })).toBe(false)
    expect(isFrameImage({ width: 4, height: 3 })).toBe(false)
  })

  it('finds an OffscreenCanvas where there is no DOM (worker)', () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    expect(isCanvas(new FakeOffscreenCanvas())).toBe(true)
    expect(isFrameImage(new FakeOffscreenCanvas())).toBe(true)
    expect(isFrameImage(new FakeCanvas())).toBe(false)
  })
})

describe('imageWidth / imageHeight', () => {
  it('read the decoded size of each kind of image', () => {
    // `<video>`: the intrinsic size of the current frame, not the element's CSS size.
    const video = { videoWidth: 1280, videoHeight: 720, width: 100, height: 50 }
    expect(imageWidth(as<SourceImage>(video))).toBe(1280)
    expect(imageHeight(as<SourceImage>(video))).toBe(720)
    // `VideoFrame`: the display size, not the coded size.
    expect(imageWidth(as<SourceImage>(new FakeVideoFrame()))).toBe(640)
    expect(imageHeight(as<SourceImage>(new FakeVideoFrame()))).toBe(360)
    // `<img>`: the natural size (0 until loaded), not the layout size.
    const img = Object.assign(new FakeImage(), { naturalWidth: 50, naturalHeight: 40 })
    expect(imageWidth(as<SourceImage>(img))).toBe(50)
    expect(imageHeight(as<SourceImage>(img))).toBe(40)
    expect(imageWidth(as<SourceImage>(new FakeImage()))).toBe(0)
    // Canvas and ImageBitmap: their width and height.
    expect(imageWidth(as<SourceImage>(new FakeCanvas()))).toBe(4)
    expect(imageHeight(as<SourceImage>(new FakeCanvas()))).toBe(3)
  })
})

describe('describeImage', () => {
  it('names the image by its constructor, or "image" without one', () => {
    expect(describeImage(as<SourceImage>(new FakeVideoFrame()))).toBe('FakeVideoFrame')
    expect(describeImage(as<SourceImage>(Object.create(null) as object))).toBe('image')
  })
})

describe('assertReadable', () => {
  /** A fake 2D context: records the calls, throws `error` from `step` when given. */
  function context(error?: unknown, step: 'drawImage' | 'getImageData' = 'drawImage') {
    const calls: string[] = []
    const ctx = {
      drawImage(_image: unknown, ...args: number[]) {
        calls.push(`drawImage ${args.join(' ')}`)
        if (error !== undefined && step === 'drawImage') throw error
      },
      getImageData(...args: number[]) {
        calls.push(`getImageData ${args.join(' ')}`)
        if (error !== undefined && step === 'getImageData') throw error
      },
    }
    return { scratch: () => ctx as unknown as OffscreenCanvasRenderingContext2D, calls }
  }

  const securityError = () => Object.assign(new Error('The canvas has been tainted by cross-origin data.'), { name: 'SecurityError' })

  it('accepts an image with pixels after drawing one of them and reading it back', () => {
    const { scratch, calls } = context()
    expect(() => assertReadable(as<FrameImage>(new FakeCanvas()), scratch)).not.toThrow()
    expect(calls).toEqual(['drawImage 0 0 1 1', 'getImageData 0 0 1 1'])
  })

  it('refuses an image that is not loaded yet, with how to wait for it', () => {
    const { scratch, calls } = context()
    const error = (() => {
      try {
        assertReadable(as<FrameImage>(new FakeImage()), scratch)
      } catch (e) {
        return e
      }
    })()
    expect(error).toBeInstanceOf(IncompatibleSourceError)
    expect((error as IncompatibleSourceError).code).toBe('incompatible-source')
    expect((error as Error).message).toBe('The FakeImage has no pixels. Wait until the image has loaded (await img.decode()).')
    expect(calls).toEqual([]) // nothing drawn
  })

  it('refuses an empty canvas or a zero-height image, as empty or closed', () => {
    const { scratch } = context()
    expect(() => assertReadable(as<FrameImage>(Object.assign(new FakeCanvas(), { width: 0 })), scratch)).toThrow(
      'The FakeCanvas has no pixels. (empty or closed)',
    )
    expect(() => assertReadable(as<FrameImage>(Object.assign(new FakeBitmap(), { height: 0 })), scratch)).toThrow(
      'The FakeBitmap has no pixels. (empty or closed)',
    )
    // NaN sizes are not pixels either.
    expect(() => assertReadable(as<FrameImage>(Object.assign(new FakeBitmap(), { width: Number.NaN })), scratch)).toThrow(
      IncompatibleSourceError,
    )
  })

  it('refuses an image whose size cannot be read (closed), keeping the cause', () => {
    const cause = new Error('InvalidStateError: closed')
    const closed = {
      constructor: FakeVideoFrame,
      get displayWidth(): number {
        throw cause
      },
      displayHeight: 1,
    }
    let error: unknown
    try {
      assertReadable(as<FrameImage>(closed), context().scratch)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(IncompatibleSourceError)
    expect((error as Error).message).toBe('The FakeVideoFrame cannot be read (closed?).')
    expect((error as Error).cause).toBe(cause)
  })

  it('reports a tainted image (SecurityError) with the CORS fix', () => {
    const cause = securityError()
    const { scratch } = context(cause, 'getImageData')
    let error: unknown
    try {
      assertReadable(as<FrameImage>(new FakeCanvas()), scratch)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(IncompatibleSourceError)
    expect((error as Error).message).toBe(
      'The FakeCanvas is tainted: it shows content from another origin loaded without CORS, which WebGL cannot read. Serve that content with CORS headers and set crossOrigin = "anonymous" on it.',
    )
    expect((error as Error).cause).toBe(cause)
    // A DOMException-like object (not an Error) is recognised by its name too.
    expect(() => assertReadable(as<FrameImage>(new FakeCanvas()), context({ name: 'SecurityError' }).scratch)).toThrow('is tainted')
  })

  it('reports any other read failure with its message', () => {
    const cause = new TypeError('drawImage: unsupported image')
    let error: unknown
    try {
      assertReadable(as<FrameImage>(new FakeBitmap()), context(cause).scratch)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(IncompatibleSourceError)
    expect((error as Error).message).toBe('The FakeBitmap cannot be read: drawImage: unsupported image')
    expect((error as Error).cause).toBe(cause)
    expect(() => assertReadable(as<FrameImage>(new FakeBitmap()), context('out of memory').scratch)).toThrow(
      'The FakeBitmap cannot be read: out of memory',
    )
  })

  it('skips the pixel check without a scratch context', () => {
    const scratch = vi.fn(() => undefined)
    expect(() => assertReadable(as<FrameImage>(new FakeCanvas()), scratch)).not.toThrow()
    expect(scratch).toHaveBeenCalledOnce()
  })

  it('never draws a VideoFrame (one cannot be tainted), but still checks its size', () => {
    vi.stubGlobal('VideoFrame', FakeVideoFrame)
    const scratch = vi.fn(() => undefined)
    assertReadable(as<FrameImage>(new FakeVideoFrame()), scratch)
    expect(scratch).not.toHaveBeenCalled()
    expect(() => assertReadable(as<FrameImage>(Object.assign(new FakeVideoFrame(), { displayHeight: 0 })), scratch)).toThrow(
      'The FakeVideoFrame has no pixels. (empty or closed)',
    )
  })
})

describe('taintedError / isSecurityError', () => {
  it('builds the tainted error without a cause', () => {
    const error = taintedError('HTMLImageElement')
    expect(error).toBeInstanceOf(IncompatibleSourceError)
    expect(error.message).toMatch(/^The HTMLImageElement is tainted: /)
    expect(error.cause).toBeUndefined()
  })

  it('recognises a SecurityError by its name only', () => {
    expect(isSecurityError(Object.assign(new Error('x'), { name: 'SecurityError' }))).toBe(true)
    expect(isSecurityError({ name: 'SecurityError' })).toBe(true)
    expect(isSecurityError(new Error('SecurityError'))).toBe(false)
    expect(isSecurityError({ name: 'NotAllowedError' })).toBe(false)
    expect(isSecurityError(null)).toBe(false)
    expect(isSecurityError('SecurityError')).toBe(false)
    expect(isSecurityError(undefined)).toBe(false)
  })
})
