/**
 * Images the engine reads directly (#32): a still image, a canvas the host draws into, a decoded video frame. The
 * engine uploads them as they are (no copy into a `<video>`) and tracks them.
 */
import { IncompatibleSourceError } from './engine/errors.ts'

/** What `setSource` and `pushFrame` read directly, besides a `<video>`. */
export type FrameImage = HTMLCanvasElement | OffscreenCanvas | HTMLImageElement | ImageBitmap | VideoFrame

/** Any image the engine can draw and track. */
export type SourceImage = FrameImage | HTMLVideoElement

/** True for the image types of `FrameImage` (not a `<video>`). */
export function isFrameImage(input: unknown): input is FrameImage {
  return (
    (typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement) ||
    (typeof OffscreenCanvas !== 'undefined' && input instanceof OffscreenCanvas) ||
    (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement) ||
    (typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap) ||
    (typeof VideoFrame !== 'undefined' && input instanceof VideoFrame)
  )
}

export function isCanvas(input: unknown): input is HTMLCanvasElement | OffscreenCanvas {
  return (typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement) || (typeof OffscreenCanvas !== 'undefined' && input instanceof OffscreenCanvas)
}

/** Pixel size of an image as decoded (intrinsic size of an `<img>`, display size of a `VideoFrame`). 0 when not ready. */
export function imageWidth(image: SourceImage): number {
  if ('videoWidth' in image) return image.videoWidth
  if ('displayWidth' in image) return image.displayWidth
  if ('naturalWidth' in image) return image.naturalWidth
  return image.width
}

export function imageHeight(image: SourceImage): number {
  if ('videoHeight' in image) return image.videoHeight
  if ('displayHeight' in image) return image.displayHeight
  if ('naturalHeight' in image) return image.naturalHeight
  return image.height
}

/** Short name of an image type, for messages. */
export function describeImage(image: SourceImage): string {
  return (image as object).constructor?.name ?? 'image'
}

/**
 * Throws `IncompatibleSourceError` when the engine cannot read `image`: no pixels (empty canvas, image not loaded,
 * closed `ImageBitmap` or `VideoFrame`), or **tainted** (drawn from another origin without CORS: WebGL refuses to read
 * it). The check draws one pixel into a scratch canvas and reads it back.
 */
export function assertReadable(image: FrameImage, scratch: () => OffscreenCanvasRenderingContext2D | undefined): void {
  const what = describeImage(image)
  let w: number
  try {
    w = imageWidth(image)
  } catch (cause) {
    throw new IncompatibleSourceError(`The ${what} cannot be read (closed?).`, { cause })
  }
  if (!(w > 0) || !(imageHeight(image) > 0)) {
    const hint = 'naturalWidth' in image ? ' Wait until the image has loaded (await img.decode()).' : ' (empty or closed)'
    throw new IncompatibleSourceError(`The ${what} has no pixels.${hint}`)
  }
  // A VideoFrame is never tainted: creating one from a cross-origin source throws.
  if (typeof VideoFrame !== 'undefined' && image instanceof VideoFrame) return
  const ctx = scratch()
  if (!ctx) return
  try {
    ctx.drawImage(image, 0, 0, 1, 1)
    ctx.getImageData(0, 0, 1, 1)
  } catch (cause) {
    if (isSecurityError(cause)) throw taintedError(what, cause)
    throw new IncompatibleSourceError(`The ${what} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

export function taintedError(what: string, cause?: unknown): IncompatibleSourceError {
  return new IncompatibleSourceError(
    `The ${what} is tainted: it shows content from another origin loaded without CORS, which WebGL cannot read. Serve that content with CORS headers and set crossOrigin = "anonymous" on it.`,
    { cause },
  )
}

export function isSecurityError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'SecurityError'
}
