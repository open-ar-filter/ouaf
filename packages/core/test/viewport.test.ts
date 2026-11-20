import { describe, expect, it } from 'vitest'
import {
  clipToPixelX,
  clipToPixelY,
  computeVideoToClip,
  createVideoToClip,
  defaultLandmarkSize,
  resolveRenderSize,
  videoToClipX,
  videoToClipY,
  type FitMode,
  type Size,
  type VideoToClip,
} from '../src/index.ts'

function map(vw: number, vh: number, tw: number, th: number, fit: FitMode, mirrored: boolean): VideoToClip {
  return computeVideoToClip(vw, vh, tw, th, fit, mirrored, createVideoToClip())
}

/** Pixel position in the render target of a video-space point. */
function toPixel(m: VideoToClip, u: number, v: number, tw: number, th: number): [number, number] {
  return [clipToPixelX(videoToClipX(m, u), tw), clipToPixelY(videoToClipY(m, v), th)]
}

describe('computeVideoToClip', () => {
  it('maps the frame onto the whole target when the aspect ratios match', () => {
    const m = map(1280, 720, 640, 360, 'cover', false)
    expect(toPixel(m, 0, 0, 640, 360)).toEqual([0, 0])
    expect(toPixel(m, 1, 1, 640, 360)).toEqual([640, 360])
    expect(toPixel(m, 0.5, 0.5, 640, 360)).toEqual([320, 180])
    expect(map(1280, 720, 640, 360, 'contain', false)).toEqual(m)
  })

  it('keeps v pointing down (image top at the top of the screen)', () => {
    const m = map(640, 480, 640, 480, 'cover', false)
    expect(videoToClipY(m, 0)).toBe(1)
    expect(videoToClipY(m, 1)).toBe(-1)
  })

  it('mirrors horizontally around the centre, never vertically', () => {
    const plain = map(640, 480, 640, 480, 'cover', false)
    const mirrored = map(640, 480, 640, 480, 'cover', true)
    expect(toPixel(mirrored, 0, 0, 640, 480)).toEqual([640, 0])
    expect(toPixel(mirrored, 0.25, 0.75, 640, 480)).toEqual([480, 360])
    for (const u of [0, 0.1, 0.5, 0.9, 1]) {
      expect(videoToClipX(mirrored, u)).toBeCloseTo(-videoToClipX(plain, u))
      expect(videoToClipY(mirrored, u)).toBe(videoToClipY(plain, u))
    }
  })

  it('cover crops a landscape video symmetrically on a portrait target', () => {
    // 16:9 video on a 9:16 screen: the height fits, the visible width is 9/16 of the height → u ∈ [0.342, 0.658].
    const m = map(1280, 720, 720, 1280, 'cover', false)
    expect(videoToClipY(m, 0)).toBe(1)
    expect(videoToClipY(m, 1)).toBe(-1)
    const visible = (720 / 1280) * (720 / 1280)
    expect(videoToClipX(m, 0.5 - visible / 2)).toBeCloseTo(-1)
    expect(videoToClipX(m, 0.5 + visible / 2)).toBeCloseTo(1)
    expect(videoToClipX(m, 0.5)).toBeCloseTo(0)
  })

  it('cover crops a portrait video on a landscape target', () => {
    const m = map(720, 1280, 1280, 720, 'cover', false)
    expect(videoToClipX(m, 0)).toBe(-1)
    expect(videoToClipX(m, 1)).toBe(1)
    expect(videoToClipY(m, 0)).toBeGreaterThan(1)
    expect(videoToClipY(m, 0.5)).toBeCloseTo(0)
  })

  it('contain letterboxes a landscape video on a portrait target', () => {
    const m = map(1280, 720, 720, 1280, 'contain', false)
    expect(videoToClipX(m, 0)).toBe(-1)
    expect(videoToClipX(m, 1)).toBe(1)
    // The 16:9 frame is 720 × 405 px, centred vertically.
    const [, top] = toPixel(m, 0, 0, 720, 1280)
    const [, bottom] = toPixel(m, 0, 1, 720, 1280)
    expect(top).toBeCloseTo((1280 - 405) / 2)
    expect(bottom - top).toBeCloseTo(405)
  })

  it('contain pillarboxes a portrait video on a landscape target', () => {
    const m = map(720, 1280, 1280, 720, 'contain', true)
    const [left] = toPixel(m, 1, 0, 1280, 720) // mirrored: u = 1 is on the left
    const [right] = toPixel(m, 0, 0, 1280, 720)
    expect(right - left).toBeCloseTo(405)
    expect(left).toBeCloseTo((1280 - 405) / 2)
  })

  it('preserves the aspect ratio of the image (no stretching)', () => {
    for (const fit of ['cover', 'contain'] as const) {
      for (const [tw, th] of [[720, 1280], [1280, 720], [500, 500], [1920, 1080]] as const) {
        const m = map(1280, 720, tw, th, fit, false)
        const [x0, y0] = toPixel(m, 0, 0, tw, th)
        const [x1, y1] = toPixel(m, 1, 1, tw, th)
        expect((x1 - x0) / (y1 - y0)).toBeCloseTo(1280 / 720)
      }
    }
  })

  it('stretches to the target while a size is unknown', () => {
    expect(map(0, 0, 640, 480, 'cover', false)).toEqual({ ax: 2, bx: -1, ay: -2, by: 1 })
    expect(map(640, 480, 0, 0, 'contain', true)).toEqual({ ax: -2, bx: 1, ay: -2, by: 1 })
  })

  it('writes into and returns the given object', () => {
    const out = createVideoToClip()
    expect(computeVideoToClip(640, 480, 320, 240, 'cover', false, out)).toBe(out)
  })
})

describe('resolveRenderSize', () => {
  const out = (): Size => ({ width: 0, height: 0 })

  it('follows the video size times the scale', () => {
    expect(resolveRenderSize(1280, 720, undefined, 1, out())).toEqual({ width: 1280, height: 720 })
    expect(resolveRenderSize(1280, 720, undefined, 0.5, out())).toEqual({ width: 640, height: 360 })
    expect(resolveRenderSize(720, 1280, undefined, 1 / 3, out())).toEqual({ width: 240, height: 427 })
  })

  it('uses the fixed resolution when set', () => {
    expect(resolveRenderSize(1280, 720, { width: 720, height: 1280 }, 0.5, out())).toEqual({ width: 720, height: 1280 })
  })

  it('never returns an empty size', () => {
    expect(resolveRenderSize(0, 0, undefined, 1, out())).toEqual({ width: 1, height: 1 })
  })
})

describe('defaultLandmarkSize', () => {
  it('scales with the resolution, with a minimum', () => {
    expect(defaultLandmarkSize(1280, 720)).toBe(4)
    expect(defaultLandmarkSize(1920, 1080)).toBe(6)
    expect(defaultLandmarkSize(160, 120)).toBe(2)
  })
})
