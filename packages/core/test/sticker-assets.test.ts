import { resolveObjectURL } from 'node:buffer'
import { sniff, type TAssetEntry } from '@ouaf/spec'
import { LinearFilter, LinearMipmapLinearFilter, NoColorSpace, VideoTexture } from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssetRequest } from '../src/engine/assets.ts'
import { AssetError } from '../src/engine/errors.ts'
import {
  EMOJI_RASTER_SIZE,
  IMAGE_MAX_SIDE,
  STICKER_LOADERS,
  SVG_RASTER_SIZE,
  VIDEO_MAX,
  checkVideoSize,
  createStickerAsset,
  decodeImage,
  drawEmoji,
  emojiLoader,
  imageLoader,
  isStickerAsset,
  sizeSvg,
  spritesheetLoader,
  videoLoader,
  type StickerAsset,
} from '../src/layers/sticker/assets.ts'

// ---------------------------------------------------------------------------------------------
// Browser fakes: ImageBitmap, createImageBitmap, <img>, canvases, <video>

class FakeBitmap {
  readonly width: number
  readonly height: number
  /** What it was made from, and how. */
  readonly from: unknown
  readonly options: unknown
  closed = false
  constructor(width: number, height: number, from: unknown, options: unknown) {
    this.width = width
    this.height = height
    this.from = from
    this.options = options
  }
  close() {
    this.closed = true
  }
}

/** `createImageBitmap`: a blob gets the size its header gives, a canvas its own size. */
async function fakeCreateImageBitmap(source: unknown, options: unknown): Promise<FakeBitmap> {
  if (source instanceof Blob) {
    const info = sniff(new Uint8Array(await source.arrayBuffer()))
    return new FakeBitmap(info?.width ?? 0, info?.height ?? 0, source, options)
  }
  const s = source as { width: number; height: number }
  return new FakeBitmap(s.width, s.height, source, options)
}

/** A 2D context that records its calls; `measureText` boxes are `glyph` × the font size in px. */
class FakeContext {
  readonly log: string[] = []
  font = ''
  textAlign = ''
  textBaseline = ''
  glyph = { left: 0.5, right: 0.5, ascent: 0.8, descent: 0.2 }
  drawImage(img: FakeImage, x: number, y: number, w: number, h: number) {
    this.log.push(`drawImage ${img.width}×${img.height} ${x},${y},${w},${h}`)
  }
  measureText(text: string) {
    const px = Number(/^(\d+)px/.exec(this.font)?.[1])
    this.log.push(`measureText ${text} ${px}px`)
    const g = this.glyph
    return { actualBoundingBoxLeft: g.left * px, actualBoundingBoxRight: g.right * px, actualBoundingBoxAscent: g.ascent * px, actualBoundingBoxDescent: g.descent * px }
  }
  fillText(text: string, x: number, y: number) {
    this.log.push(`fillText ${text} ${x},${y}`)
  }
}

class FakeCanvas {
  static last: FakeCanvas | undefined
  static noContext = false
  width: number
  height: number
  readonly ctx = new FakeContext()
  constructor(width = 0, height = 0) {
    this.width = width
    this.height = height
    FakeCanvas.last = this
  }
  getContext(type: string) {
    return type === '2d' && !FakeCanvas.noContext ? this.ctx : null
  }
}

/** `<img>`: `decode()` fails for markup without `<rect` (stands for an invalid SVG); keeps the markup it was given. */
class FakeImage {
  static markups: string[] = []
  readonly width: number
  readonly height: number
  src = ''
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }
  async decode() {
    const blob = resolveObjectURL(this.src)
    if (!blob) throw new Error('revoked too early')
    const markup = await blob.text()
    FakeImage.markups.push(markup)
    if (!markup.includes('<rect')) throw new Error('EncodingError')
  }
}

type VideoScript = 'ready' | 'events' | 'error' | 'no-data' | 'silent'

/** `<video>`: when its `src` is set, it plays `script` (`width` × `height`). */
class FakeVideo extends EventTarget {
  static all: FakeVideo[] = []
  static script: VideoScript = 'events'
  static size = [640, 360]
  muted = false
  defaultMuted = false
  playsInline = false
  disableRemotePlayback = false
  preload = ''
  readyState = 0
  videoWidth = 0
  videoHeight = 0
  loop = false
  readonly attributes = new Map<string, string>()
  readonly log: string[] = []
  constructor() {
    super()
    FakeVideo.all.push(this)
  }
  set src(url: string) {
    this.attributes.set('src', url)
    const [w, h] = FakeVideo.size as [number, number]
    const script = FakeVideo.script
    if (script === 'ready') {
      ;[this.readyState, this.videoWidth, this.videoHeight] = [4, w, h]
      return
    }
    if (script === 'silent') return
    queueMicrotask(() => {
      if (script === 'error') return void this.dispatchEvent(new Event('error'))
      ;[this.readyState, this.videoWidth, this.videoHeight] = [1, w, h]
      this.dispatchEvent(new Event('loadedmetadata'))
      if (script === 'no-data') return
      queueMicrotask(() => {
        this.readyState = 2
        this.dispatchEvent(new Event('loadeddata'))
      })
    })
  }
  get src(): string {
    return this.attributes.get('src') ?? ''
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  removeAttribute(name: string) {
    this.attributes.delete(name)
    this.log.push(`removeAttribute ${name}`)
  }
  load() {
    this.log.push('load')
  }
  pause() {
    this.log.push('pause')
  }
}

const revoked: string[] = []

beforeEach(() => {
  vi.stubGlobal('ImageBitmap', FakeBitmap)
  vi.stubGlobal('createImageBitmap', vi.fn(fakeCreateImageBitmap))
  vi.stubGlobal('Image', FakeImage)
  vi.stubGlobal('OffscreenCanvas', FakeCanvas)
  vi.stubGlobal('document', {
    createElement: (tag: string) => (tag === 'video' ? new FakeVideo() : tag === 'canvas' ? new FakeCanvas() : undefined),
  })
  const revoke = URL.revokeObjectURL.bind(URL)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    revoked.push(url)
    revoke(url)
  })
  FakeCanvas.noContext = false
  FakeImage.markups = []
  FakeVideo.all = []
  FakeVideo.script = 'events'
  FakeVideo.size = [640, 360]
  revoked.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------------------------
// Synthetic files

function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return b
}

const ascii = (s: string) => new TextEncoder().encode(s)

/** An ISO BMFF box: 32-bit size, type, content. */
function box(type: string, ...content: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const size = 8 + content.reduce((n, c) => n + c.length, 0)
  const b = new Uint8Array(size)
  new DataView(b.buffer).setUint32(0, size)
  b.set(ascii(type), 4)
  let p = 8
  for (const c of content) {
    b.set(c, p)
    p += c.length
  }
  return b
}

/** The header of an MP4 file with one H.264 video track of `width` × `height` (moov before the media data). */
function mp4(width: number, height: number): Uint8Array<ArrayBuffer> {
  const entry = new Uint8Array(78)
  new DataView(entry.buffer).setUint16(24, width)
  new DataView(entry.buffer).setUint16(26, height)
  const hdlr = box('hdlr', new Uint8Array(8), ascii('vide'), new Uint8Array(12))
  const stsd = box('stsd', new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), box('avc1', entry))
  const trak = box('trak', box('mdia', hdlr, box('minf', box('stbl', stsd))))
  return concat(box('ftyp', ascii('isom'), new Uint8Array(4), ascii('isom')), box('moov', trak))
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let p = 0
  for (const part of parts) {
    out.set(part, p)
    p += part.length
  }
  return out
}

function request(
  data: Uint8Array<ArrayBuffer> | string,
  options: { kind?: AssetRequest['kind']; entry?: TAssetEntry; path?: string; signal?: AbortSignal } = {},
): AssetRequest {
  return {
    ref: 'x',
    kind: options.kind ?? 'image',
    entry: options.entry,
    path: options.path ?? 'assets/x.bin',
    builtin: false,
    read: () => Promise.resolve(new Blob([data])),
    signal: options.signal ?? new AbortController().signal,
  }
}

const RECT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10"/></svg>'

// ---------------------------------------------------------------------------------------------

describe('sticker images (spec §10.2, §10.4)', () => {
  it('decodes a raster image of up to 4096 px per side into a premultiplied bitmap', async () => {
    for (const [w, h] of [[IMAGE_MAX_SIDE, 16], [16, IMAGE_MAX_SIDE], [1, 1]] as const) {
      const bitmap = (await decodeImage(request(png(w, h)))) as unknown as FakeBitmap
      expect([bitmap.width, bitmap.height]).toEqual([w, h])
      expect(bitmap.from).toBeInstanceOf(Blob)
      expect(bitmap.options).toEqual({ premultiplyAlpha: 'premultiply' })
    }
    await expect(decodeImage(request(png(16, IMAGE_MAX_SIDE + 1)))).rejects.toThrow(`is 16×4097 px: images are limited to 4096 px per side (spec §10.4)`)
    expect(createImageBitmap).toHaveBeenCalledTimes(3) // the oversized one is not decoded
  })

  it('refuses a file without a recognizable format, as an AssetError naming the reference', async () => {
    const error = await decodeImage(request(new Uint8Array([1, 2, 3, 0, 0]), { path: 'assets/x.png' })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AssetError)
    expect((error as AssetError).ref).toBe('x')
    expect((error as AssetError).message).toBe('"assets/x.png" is not a PNG, WebP, JPEG, AVIF, SVG or KTX2 image.')
  })

  it('gives the loaded image as a sticker asset: an sRGB-encoded texture with mipmaps, not flipped', async () => {
    const asset = await imageLoader.load(request(png(300, 200)))
    expect(isStickerAsset(asset)).toBe(true)
    expect(asset).toMatchObject({ kind: 'image', textureWidth: 300, textureHeight: 200, width: 300, height: 200, frames: undefined, packed: false, video: undefined, owner: undefined })
    const t = asset.texture
    expect([t.colorSpace, t.flipY, t.premultiplyAlpha, t.generateMipmaps, t.minFilter, t.magFilter]).toEqual([NoColorSpace, false, false, true, LinearMipmapLinearFilter, LinearFilter])
    expect(t.version).toBeGreaterThan(0) // needsUpdate
    let disposed = 0
    t.addEventListener('dispose', () => void disposed++)
    imageLoader.dispose!(asset)
    expect(disposed).toBe(1)
    expect((t.image as FakeBitmap).closed).toBe(true)
  })

  it('rasterizes an SVG as an image at its aspect ratio, from a blob URL it revokes', async () => {
    const bitmap = (await decodeImage(request(RECT, { path: 'assets/logo.svg' }))) as unknown as FakeBitmap
    expect([bitmap.width, bitmap.height]).toEqual([SVG_RASTER_SIZE, SVG_RASTER_SIZE / 2])
    expect(bitmap.from).toBe(FakeCanvas.last)
    expect(bitmap.options).toEqual({ premultiplyAlpha: 'premultiply' })
    expect(FakeImage.markups).toEqual([sizeSvg(RECT).markup]) // drawn at the raster size
    expect(FakeCanvas.last!.ctx.log).toEqual([`drawImage 1024×512 0,0,1024,512`])
    expect(revoked).toHaveLength(1)
    expect(resolveObjectURL(revoked[0]!)).toBeUndefined()
  })

  it('reports an SVG the browser cannot decode, and still revokes its URL', async () => {
    const error = await decodeImage(request('<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>', { path: 'assets/bad.svg' })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AssetError)
    expect((error as AssetError).message).toBe('"assets/bad.svg" is not a valid SVG image.')
    expect(((error as AssetError).cause as Error).message).toBe('EncodingError')
    expect(revoked).toHaveLength(1)
  })

  it('draws on a canvas element where there is no OffscreenCanvas, and fails clearly without a 2D context', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined)
    const bitmap = (await decodeImage(request(RECT))) as unknown as FakeBitmap
    expect(bitmap.from).toBeInstanceOf(FakeCanvas)
    expect([(bitmap.from as FakeCanvas).width, (bitmap.from as FakeCanvas).height]).toEqual([1024, 512])
    FakeCanvas.noContext = true
    await expect(decodeImage(request(RECT))).rejects.toThrow('Canvas 2D is not available.')
    expect(revoked).toHaveLength(2)
  })

  it('loads a spritesheet with its grid: one frame per cell, at most cols × rows frames, no mipmaps', async () => {
    const entry = (frames: Record<string, number>) => ({ src: 'assets/walk.png', frames }) as TAssetEntry
    const sheet = await spritesheetLoader.load(request(png(400, 200), { kind: 'spritesheet', entry: entry({ cols: 4, rows: 2, fps: 12 }) }))
    expect(sheet).toMatchObject({ kind: 'spritesheet', textureWidth: 400, textureHeight: 200, width: 100, height: 100, frames: { cols: 4, rows: 2, count: 8, fps: 12 } })
    expect([sheet.texture.generateMipmaps, sheet.texture.minFilter]).toEqual([false, LinearFilter])
    expect(isStickerAsset(sheet)).toBe(true)
    const counts = []
    for (const count of [5, 20]) {
      counts.push((await spritesheetLoader.load(request(png(400, 200), { kind: 'spritesheet', entry: entry({ cols: 4, rows: 2, fps: 12, count }) }))).frames!.count)
    }
    expect(counts).toEqual([5, 8])
    // The image checks apply to the sheet as a whole.
    await expect(spritesheetLoader.load(request(png(5000, 200), { kind: 'spritesheet', entry: entry({ cols: 4, rows: 2, fps: 12 }) }))).rejects.toThrow(/5000×200 px/)
  })
})

describe('sticker emoji (spec §6.3)', () => {
  it('draws the emoji centred on a square, at 80 % of its size', async () => {
    const bitmap = (await drawEmoji('😎')) as unknown as FakeBitmap
    expect([bitmap.width, bitmap.height]).toEqual([EMOJI_RASTER_SIZE, EMOJI_RASTER_SIZE])
    const ctx = FakeCanvas.last!.ctx
    expect([ctx.textAlign, ctx.textBaseline]).toEqual(['center', 'alphabetic'])
    expect(ctx.font).toMatch(/^205px "Apple Color Emoji", .*"Noto Color Emoji".*, sans-serif$/)
    // Box 205 × 205 px, ascent 164, descent 41: the baseline sits so that the box is centred.
    expect(ctx.log).toEqual(['measureText 😎 205px', `fillText 😎 128,${128 + (164 - 41) / 2}`])
  })

  it('shrinks an emoji whose glyph overflows the square', async () => {
    vi.stubGlobal('OffscreenCanvas', class extends FakeCanvas {
      override readonly ctx = Object.assign(new FakeContext(), { glyph: { left: 0.2, right: 1.0, ascent: 1, descent: 0.5 } })
    })
    await drawEmoji('🎉', 100)
    const ctx = FakeCanvas.last!.ctx
    // 80 px: 120 px wide, over 94 px: 80 × 94 / 120 = 62 px.
    expect(ctx.font).toMatch(/^62px /)
    expect(ctx.log).toEqual(['measureText 🎉 80px', 'measureText 🎉 62px', `fillText 🎉 ${50 + (12.4 - 62) / 2},${50 + (62 - 31) / 2}`])
  })

  it('is loaded as an image asset from the emoji itself', async () => {
    const asset = await emojiLoader.load({ ...request(''), kind: 'emoji', path: '🐶' })
    expect(asset).toMatchObject({ kind: 'image', width: EMOJI_RASTER_SIZE, height: EMOJI_RASTER_SIZE })
    expect(FakeCanvas.last!.ctx.log.at(-1)).toMatch(/^fillText 🐶 /)
    emojiLoader.dispose!(asset)
    expect((asset.texture.image as FakeBitmap).closed).toBe(true)
  })
})

describe('sticker videos (spec §10.2, §10.4)', () => {
  it('limits videos to 1080p in either orientation', () => {
    for (const [w, h] of [[VIDEO_MAX.long, VIDEO_MAX.short], [1080, 1920], [3840 / 2, 1080], [100, 100]] as const) {
      expect(() => checkVideoSize('v', 'assets/v.mp4', w, h)).not.toThrow()
    }
    for (const [w, h] of [[1921, 1080], [1080, 1921], [1200, 1200], [3840, 2160]] as const) {
      expect(() => checkVideoSize('v', 'assets/v.mp4', w, h)).toThrow(`"assets/v.mp4" is ${w}×${h} px: videos are limited to 1080p (spec §10.4).`)
    }
  })

  it('loads a muted, inline video once its first frame is there', async () => {
    const asset = await videoLoader.load(request(mp4(640, 360), { kind: 'video', path: 'assets/clip.mp4' }))
    const video = FakeVideo.all[0]!
    expect(asset.video).toBe(video as unknown as HTMLVideoElement)
    expect([video.muted, video.defaultMuted, video.playsInline, video.disableRemotePlayback, video.preload, video.attributes.has('playsinline')]).toEqual([
      true,
      true,
      true,
      true,
      'auto',
      true,
    ])
    expect(video.readyState).toBe(2) // waited for loadeddata
    expect(video.src).toMatch(/^blob:/)
    expect(asset).toMatchObject({ kind: 'video', textureWidth: 640, textureHeight: 360, width: 640, height: 360, packed: false, frames: undefined, owner: undefined })
    expect(asset.texture).toBeInstanceOf(VideoTexture)
    expect([asset.texture.colorSpace, asset.texture.flipY, asset.texture.generateMipmaps, asset.texture.minFilter]).toEqual([NoColorSpace, false, false, LinearFilter])
    expect(isStickerAsset(asset)).toBe(true)

    const url = video.src
    videoLoader.dispose!(asset)
    expect(video.log).toEqual(['pause', 'removeAttribute src', 'load'])
    expect(revoked).toEqual([url])
  })

  it('shows the color half of a packed-alpha video (spec §10.2)', async () => {
    FakeVideo.size = [1280, 360]
    FakeVideo.script = 'ready' // already has its data: no event to wait for
    const asset = await videoLoader.load(request(mp4(1280, 360), { kind: 'video', entry: { src: 'assets/fx.mp4', alpha: 'packed' } as TAssetEntry }))
    expect([asset.packed, asset.textureWidth, asset.width, asset.height]).toEqual([true, 1280, 640, 360])
  })

  it('refuses a video over 1080p from its header, before creating any video element', async () => {
    await expect(videoLoader.load(request(mp4(3840, 2160), { kind: 'video', path: 'assets/4k.mp4' }))).rejects.toThrow(
      '"assets/4k.mp4" is 3840×2160 px: videos are limited to 1080p (spec §10.4).',
    )
    expect(FakeVideo.all).toEqual([])
  })

  it('checks the size again on the metadata (index after the media data), and releases the video', async () => {
    FakeVideo.size = [2560, 1440]
    const error = await videoLoader.load(request(new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]), { kind: 'video' })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AssetError)
    expect((error as AssetError).message).toBe('"assets/x.bin" is 2560×1440 px: videos are limited to 1080p (spec §10.4).')
    const video = FakeVideo.all[0]!
    expect(video.log).toEqual(['removeAttribute src', 'load'])
    expect(revoked).toHaveLength(1)
  })

  it('reports a video the browser cannot play', async () => {
    FakeVideo.script = 'error'
    const error = await videoLoader.load(request(new Uint8Array(16), { kind: 'video', path: 'assets/v.webm' })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AssetError)
    expect((error as AssetError).message).toBe('Could not load video "assets/v.webm": the browser could not play it (format or codec not supported?)')
    expect(FakeVideo.all[0]!.log).toEqual(['removeAttribute src', 'load'])
    expect(revoked).toHaveLength(1)
  })

  it('stops waiting when the load is aborted', async () => {
    FakeVideo.script = 'silent'
    const abort = new AbortController()
    const loading = videoLoader.load(request(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), { kind: 'video', signal: abort.signal }))
    await vi.waitFor(() => expect(FakeVideo.all).toHaveLength(1))
    abort.abort(new Error('the filter was removed'))
    await expect(loading).rejects.toThrow('Could not load video "assets/x.bin": the filter was removed')
    expect(revoked).toHaveLength(1)
  })

  it('does not block activation on a first frame that never comes (5 s)', async () => {
    vi.useFakeTimers()
    FakeVideo.script = 'no-data'
    let done = false
    const loading = videoLoader.load(request(mp4(640, 360), { kind: 'video' })).then((asset) => ((done = true), asset))
    await vi.advanceTimersByTimeAsync(4900)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    const asset = await loading
    expect(asset.video!.readyState).toBe(1)
    expect(asset.width).toBe(640)
  })
})

describe('sticker assets', () => {
  it('are recognized only when made by createStickerAsset (the loaders, or a plugin)', () => {
    const fields: StickerAsset = {
      kind: 'image',
      texture: new VideoTexture({} as HTMLVideoElement),
      textureWidth: 1,
      textureHeight: 1,
      width: 1,
      height: 1,
      frames: undefined,
      packed: false,
      video: undefined,
      owner: undefined,
    }
    expect(isStickerAsset({ ...fields })).toBe(false)
    expect(isStickerAsset(createStickerAsset(fields))).toBe(true)
    for (const value of [null, undefined, 'image', 3]) expect(isStickerAsset(value)).toBe(false)
  })

  it('register a loader per kind', () => {
    expect(STICKER_LOADERS.map((l) => [...l.kinds])).toEqual([['image'], ['emoji'], ['spritesheet'], ['video']])
  })
})

describe('sizeSvg', () => {
  it('rasterizes a markup without an <svg> root, or without any size, as a square', () => {
    expect(sizeSvg('<g/>', 64)).toEqual({ width: 64, height: 64, markup: '<g/>' })
    expect(sizeSvg('<svg><g/></svg>', 64)).toEqual({ width: 64, height: 64, markup: '<svg width="64" height="64"><g/></svg>' })
  })

  it('prefers width/height over the viewBox, keeps an existing viewBox, and never gives 0 px', () => {
    const a = sizeSvg('<svg width="10" height="40" viewBox="0 0 100 100"/>', 200)
    expect(a).toEqual({ width: 50, height: 200, markup: '<svg width="50" height="200" viewBox="0 0 100 100"/>' })
    const b = sizeSvg('<SVG VIEWBOX="-5,-5,10,30"/>', 90)
    expect([b.width, b.height]).toEqual([30, 90])
    const thin = sizeSvg('<svg width="10000" height="1"/>', 100)
    expect([thin.width, thin.height]).toEqual([100, 1])
  })
})
