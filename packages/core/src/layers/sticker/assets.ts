/**
 * Asset loaders of the sticker plugin (spec §10.2, §10.4): images, spritesheets, videos and emoji, decoded by the
 * browser into GPU textures.
 *
 * - Dimensions are read from the file header **before** decoding (`sniff`): images ≤ 4096 px per side, videos
 *   ≤ 1080p (checked again on the video's metadata, for MP4 files whose index comes after the media data).
 * - SVG (files and inline `{ "svg" }`) is drawn as an image (`<img>`: no script, no external resource), rasterized at
 *   `SVG_RASTER_SIZE` px on its long side. Emoji (`{ "emoji" }`) are drawn with the platform's emoji font.
 * - KTX2 images and spritesheets are GPU textures prepared for the engine's renderer (`ktx2.ts`): Basis Universal
 *   files are transcoded with the Basis transcoder the host serves under `assetsBaseUrl`.
 *
 * What a loader gives (`StickerAsset`), for any layer type that reads image or video assets: a texture holding
 * sRGB-encoded bytes (`NoColorSpace`), uploaded without flipY (v = 0 is the top row), with premultiplied alpha for
 * images (except transcoded KTX2 textures, `straightAlpha`); a video's texture is refreshed only when the video
 * presents a new frame.
 */
import { IMAGE_MAX_SIDE, VIDEO_MAX, sniff, type TAssetEntry } from '@ouaf/spec'
import {
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  Texture,
  VideoTexture,
} from 'three'
import type { AssetLoader, AssetRequest } from '../../engine/assets.ts'
import { AssetError } from '../../engine/errors.ts'
import { loadKtx2 } from './ktx2.ts'

/** §10.4 limits, shared with `ouaf validate`: images ≤ 4096 px per side, videos ≤ 1080p. */
export { IMAGE_MAX_SIDE, VIDEO_MAX }
/** Long side of rasterized SVG images and emoji (px). */
export const SVG_RASTER_SIZE = 1024
export const EMOJI_RASTER_SIZE = 256
/** Bytes read to find the dimensions in a header (a JPEG's frame header can come after a large EXIF block). */
const HEADER_BYTES = 1 << 20
/** How long a video may take to show its first frame before the filter is activated anyway (ms). */
const FIRST_FRAME_TIMEOUT_MS = 5000

const RASTER_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg', 'webp', 'avif'])

/** Spritesheet grid (spec §10.1 `frames`), with `count` resolved. */
export interface SpriteGrid {
  readonly cols: number
  readonly rows: number
  readonly count: number
  readonly fps: number
}

/** A loaded image, spritesheet or video. */
export interface StickerAsset {
  readonly kind: 'image' | 'spritesheet' | 'video'
  readonly texture: Texture
  /** Size of the texture (px). */
  readonly textureWidth: number
  readonly textureHeight: number
  /** Size of what is displayed (px): one frame of a spritesheet, the color half of a packed video. */
  readonly width: number
  readonly height: number
  /** Spritesheet grid. */
  readonly frames: SpriteGrid | undefined
  /** Video with packed alpha: color in the left half, mask in the right half. */
  readonly packed: boolean
  /**
   * Color not premultiplied by alpha (a transcoded KTX2 texture: compressed blocks cannot be premultiplied at
   * upload); the sticker shader premultiplies it. Default: false.
   */
  readonly straightAlpha?: boolean
  /** A KTX2 texture: GPU data only, no `ImageBitmap` behind it (shader layers and scripts cannot read it). */
  readonly ktx2?: boolean
  /** The video element of a video asset (muted, inline, not in the document). */
  readonly video: HTMLVideoElement | undefined
  /**
   * The layer instance driving a video's playback. A video asset used by several layers (or several faces) has one
   * playback, driven by the first layer that claims it; the others show the same frames.
   */
  owner: object | undefined
}

/** The loaded value of an asset, when it comes from this plugin's loaders. */
export function isStickerAsset(value: unknown): value is StickerAsset {
  return typeof value === 'object' && value !== null && STICKER.has(value)
}

const STICKER = new WeakSet<object>()

/** Makes a `StickerAsset` (the loaders' values; tests and plugins with their own sources). */
export function createStickerAsset(asset: StickerAsset): StickerAsset {
  STICKER.add(asset)
  return asset
}

function imageTexture(bitmap: ImageBitmap, mipmaps: boolean): Texture {
  const texture = new Texture(bitmap)
  texture.colorSpace = NoColorSpace
  texture.flipY = false // ignored for an ImageBitmap anyway: v = 0 is the top row
  texture.premultiplyAlpha = false // the bitmap is premultiplied at decode time
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.magFilter = LinearFilter
  texture.minFilter = mipmaps ? LinearMipmapLinearFilter : LinearFilter
  texture.generateMipmaps = mipmaps
  texture.needsUpdate = true
  return texture
}

async function readHeader(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer())
}

/** Decodes an image asset (raster formats and SVG) into a premultiplied `ImageBitmap`, after checking its header. */
export async function decodeImage(r: AssetRequest): Promise<ImageBitmap> {
  const blob = await r.read()
  return decodeImageBlob(r, blob, sniff(await readHeader(blob)))
}

async function decodeImageBlob(r: AssetRequest, blob: Blob, info: ReturnType<typeof sniff>): Promise<ImageBitmap> {
  if (info?.format === 'svg') return rasterizeSvg(await blob.text(), r)
  if (info?.format === 'ktx2') throw new AssetError(r.ref, `"${r.path}" is a KTX2 texture: it is loaded as a GPU texture, not decoded to an image.`)
  if (!info || !RASTER_FORMATS.has(info.format)) {
    throw new AssetError(r.ref, `"${r.path}" is not a PNG, WebP, JPEG, AVIF, SVG or KTX2 image${info ? ` (its content is ${info.format})` : ''}.`)
  }
  const { width, height } = info
  if (!width || !height) {
    throw new AssetError(r.ref, `Could not read the dimensions of "${r.path}" from its header: images are checked before decoding (spec §10.4).`)
  }
  if (width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) {
    throw new AssetError(r.ref, `"${r.path}" is ${width}×${height} px: images are limited to ${IMAGE_MAX_SIDE} px per side (spec §10.4).`)
  }
  return createImageBitmap(blob, { premultiplyAlpha: 'premultiply' })
}

// ---------------------------------------------------------------------------------------------
// SVG

const ROOT_TAG = /<svg\b[^>]*>/i
const LENGTH = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(px)?\\s*["']`, 'i')
const VIEW_BOX = /\sviewBox\s*=\s*["']\s*(-?[0-9.]+)[\s,]+(-?[0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i

/**
 * Raster size of an SVG image: its aspect ratio (from `width`/`height` in px, else the `viewBox`, else square) with
 * `longSide` px on the long side, and the markup rewritten to that size, so every browser draws it at that resolution
 * (Firefox cannot draw an SVG without a size into a canvas). Without a `viewBox`, one is added from the original size
 * so the drawing scales.
 */
export function sizeSvg(markup: string, longSide = SVG_RASTER_SIZE): { width: number; height: number; markup: string } {
  const root = ROOT_TAG.exec(markup)
  if (!root) return { width: longSide, height: longSide, markup }
  const tag = root[0]
  const w = Number(LENGTH('width').exec(tag)?.[1])
  const h = Number(LENGTH('height').exec(tag)?.[1])
  const box = VIEW_BOX.exec(tag)
  const bw = Number(box?.[3])
  const bh = Number(box?.[4])
  let aspect = 1
  if (w > 0 && h > 0) aspect = w / h
  else if (bw > 0 && bh > 0) aspect = bw / bh
  const width = Math.max(1, Math.round(aspect >= 1 ? longSide : longSide * aspect))
  const height = Math.max(1, Math.round(aspect >= 1 ? longSide / aspect : longSide))
  let rewritten = tag.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, '')
  const viewBox = !box && w > 0 && h > 0 ? ` viewBox="0 0 ${w} ${h}"` : ''
  rewritten = rewritten.replace(/^<svg/i, `<svg width="${width}" height="${height}"${viewBox}`)
  return { width, height, markup: markup.slice(0, root.index) + rewritten + markup.slice(root.index + tag.length) }
}

function canvas2d(width: number, height: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height })
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) throw new Error('Canvas 2D is not available.')
  return { canvas, ctx }
}

async function rasterizeSvg(text: string, r: AssetRequest): Promise<ImageBitmap> {
  const sized = sizeSvg(text)
  // As an <img>, an SVG runs no script and loads no external resource (spec §10.2, §15.4).
  const url = URL.createObjectURL(new Blob([sized.markup], { type: 'image/svg+xml' }))
  try {
    const img = new Image(sized.width, sized.height)
    img.src = url
    try {
      await img.decode()
    } catch (cause) {
      throw new AssetError(r.ref, `"${r.path}" is not a valid SVG image.`, { cause })
    }
    const { canvas, ctx } = canvas2d(sized.width, sized.height)
    ctx.drawImage(img, 0, 0, sized.width, sized.height)
    return await createImageBitmap(canvas, { premultiplyAlpha: 'premultiply' })
  } finally {
    URL.revokeObjectURL(url)
  }
}

// ---------------------------------------------------------------------------------------------
// Emoji

const EMOJI_FONTS = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", "EmojiOne Color", sans-serif'

/** Draws an emoji with the platform's emoji font, centred in a square (spec §6.3). */
export async function drawEmoji(emoji: string, size = EMOJI_RASTER_SIZE): Promise<ImageBitmap> {
  const { canvas, ctx } = canvas2d(size, size)
  let px = Math.round(size * 0.8)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `${px}px ${EMOJI_FONTS}`
  let m = ctx.measureText(emoji)
  const extent = Math.max(m.actualBoundingBoxLeft + m.actualBoundingBoxRight, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent)
  if (extent > size * 0.94) {
    px = Math.floor((px * size * 0.94) / extent)
    ctx.font = `${px}px ${EMOJI_FONTS}`
    m = ctx.measureText(emoji)
  }
  const x = size / 2 + (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2
  const y = size / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2
  ctx.fillText(emoji, x, y)
  return createImageBitmap(canvas, { premultiplyAlpha: 'premultiply' })
}

// ---------------------------------------------------------------------------------------------
// Videos

/** Checks video dimensions against §10.4 (packed videos included: the limit is on the file). */
export function checkVideoSize(ref: string, path: string, width: number, height: number): void {
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  if (long > VIDEO_MAX.long || short > VIDEO_MAX.short) {
    throw new AssetError(ref, `"${path}" is ${width}×${height} px: videos are limited to 1080p (spec §10.4).`)
  }
}

function once(target: EventTarget, ok: string, signal: AbortSignal, timeoutMs?: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const done = (value: boolean, error?: unknown) => {
      target.removeEventListener(ok, onOk)
      target.removeEventListener('error', onError)
      signal.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const onOk = () => done(true)
    const onError = () => done(false, new Error('the browser could not play it (format or codec not supported?)'))
    const onAbort = () => done(false, signal.reason ?? new Error('aborted'))
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => done(false), timeoutMs)
    target.addEventListener(ok, onOk)
    target.addEventListener('error', onError)
    signal.addEventListener('abort', onAbort)
  })
}

const HAVE_METADATA = 1
const HAVE_CURRENT_DATA = 2

function packedAlpha(entry: TAssetEntry | undefined): boolean {
  return typeof entry === 'object' && 'src' in entry && entry.alpha === 'packed'
}

const videoUrls = new WeakMap<HTMLVideoElement, string>()

async function loadVideo(r: AssetRequest): Promise<StickerAsset> {
  const blob = await r.read()
  const info = sniff(await readHeader(blob))
  if (info && info.format !== 'mp4' && info.format !== 'webm') {
    throw new AssetError(r.ref, `"${r.path}" is not an MP4 or WebM video (its content is ${info.format}).`)
  }
  if (info?.width && info.height) checkVideoSize(r.ref, r.path, info.width, info.height)

  const video = document.createElement('video')
  video.muted = true // spec §10.2: muted by default (and allowed to play without a user gesture)
  video.defaultMuted = true
  video.playsInline = true
  video.setAttribute('playsinline', '')
  video.disableRemotePlayback = true
  video.preload = 'auto'
  const url = URL.createObjectURL(blob)
  videoUrls.set(video, url)
  const release = () => {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
  try {
    video.src = url
    if (video.readyState < HAVE_METADATA) await once(video, 'loadedmetadata', r.signal)
    checkVideoSize(r.ref, r.path, video.videoWidth, video.videoHeight)
    // Preloaded before activation (spec §10.4): wait for the first frame, but do not block on a browser that only
    // loads media data once playing (iOS in low-power mode).
    if (video.readyState < HAVE_CURRENT_DATA) await once(video, 'loadeddata', r.signal, FIRST_FRAME_TIMEOUT_MS)
  } catch (cause) {
    release()
    if (cause instanceof AssetError) throw cause
    throw new AssetError(r.ref, `Could not load video "${r.path}": ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }

  // VideoTexture flags an upload only when the video presents a new frame (requestVideoFrameCallback).
  const texture = new VideoTexture(video)
  texture.colorSpace = NoColorSpace
  texture.flipY = false
  texture.generateMipmaps = false
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  const packed = packedAlpha(r.entry)
  const w = video.videoWidth
  const h = video.videoHeight
  return createStickerAsset({
    kind: 'video',
    texture,
    textureWidth: w,
    textureHeight: h,
    width: packed ? w / 2 : w,
    height: h,
    frames: undefined,
    packed,
    video,
    owner: undefined,
  })
}

function disposeAsset(asset: StickerAsset): void {
  asset.texture.dispose()
  const image: unknown = asset.texture.image
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close()
  const video = asset.video
  if (video) {
    video.pause()
    video.removeAttribute('src')
    video.load()
    const url = videoUrls.get(video)
    if (url) URL.revokeObjectURL(url)
  }
}

function imageAsset(bitmap: ImageBitmap): StickerAsset {
  return createStickerAsset({
    kind: 'image',
    texture: imageTexture(bitmap, true),
    textureWidth: bitmap.width,
    textureHeight: bitmap.height,
    width: bitmap.width,
    height: bitmap.height,
    frames: undefined,
    packed: false,
    video: undefined,
    owner: undefined,
  })
}

/** A decoded image, or a KTX2 texture: what a texture is made from. */
type ImageSource = { bitmap: ImageBitmap } | { ktx2: Awaited<ReturnType<typeof loadKtx2>> }

/** Reads an image or spritesheet file: KTX2 is loaded as a GPU texture, the other formats decoded to a bitmap. */
async function readImage(r: AssetRequest, spritesheet: boolean): Promise<ImageSource> {
  const blob = await r.read()
  const info = sniff(await readHeader(blob))
  if (info?.format === 'ktx2') return { ktx2: await loadKtx2(r, blob, spritesheet) }
  return { bitmap: await decodeImageBlob(r, blob, info) }
}

type SourceTexture = Pick<StickerAsset, 'texture' | 'textureWidth' | 'textureHeight' | 'straightAlpha' | 'ktx2'>

/** The texture of an image source, its size and how its alpha is stored. */
function sourceTexture(source: ImageSource, mipmaps: boolean): SourceTexture {
  if ('ktx2' in source) {
    const { texture, width, height, straightAlpha } = source.ktx2
    return { texture, textureWidth: width, textureHeight: height, straightAlpha, ktx2: true }
  }
  const { bitmap } = source
  return { texture: imageTexture(bitmap, mipmaps), textureWidth: bitmap.width, textureHeight: bitmap.height }
}

/** Images: PNG, WebP, JPEG, AVIF, SVG (files and inline), KTX2. */
export const imageLoader: AssetLoader<StickerAsset> = {
  kinds: ['image'],
  async load(r) {
    const source = await readImage(r, false)
    if ('bitmap' in source) return imageAsset(source.bitmap)
    const t = sourceTexture(source, true)
    const asset = { kind: 'image', ...t, width: t.textureWidth, height: t.textureHeight, frames: undefined, packed: false } as const
    return createStickerAsset({ ...asset, video: undefined, owner: undefined })
  },
  dispose: disposeAsset,
}

/** `{ "emoji": "😎" }` assets, drawn as images. */
export const emojiLoader: AssetLoader<StickerAsset> = {
  kinds: ['emoji'],
  async load(r) {
    return imageAsset(await drawEmoji(r.path))
  },
  dispose: disposeAsset,
}

/** Spritesheets: an image and its `frames` grid. */
export const spritesheetLoader: AssetLoader<StickerAsset> = {
  kinds: ['spritesheet'],
  async load(r) {
    const entry = r.entry
    const frames = typeof entry === 'object' && 'src' in entry ? entry.frames : undefined
    if (!frames) throw new AssetError(r.ref, `Spritesheet "${r.ref}" has no "frames" grid: declare it in "assets" with { "src", "frames": { "cols", "rows", "fps" } }.`)
    const cells = frames.cols * frames.rows
    // No mipmaps: minified levels would blend neighbouring frames.
    const t = sourceTexture(await readImage(r, true), false)
    return createStickerAsset({
      kind: 'spritesheet',
      ...t,
      width: t.textureWidth / frames.cols,
      height: t.textureHeight / frames.rows,
      frames: { cols: frames.cols, rows: frames.rows, count: Math.min(frames.count ?? cells, cells), fps: frames.fps },
      packed: false,
      video: undefined,
      owner: undefined,
    })
  },
  dispose: disposeAsset,
}

/** Videos: MP4 (H.264), WebM (VP9), with `alpha: "packed"` transparency. */
export const videoLoader: AssetLoader<StickerAsset> = {
  kinds: ['video'],
  load: loadVideo,
  dispose: disposeAsset,
}

export const STICKER_LOADERS: readonly AssetLoader<StickerAsset>[] = [imageLoader, emojiLoader, spritesheetLoader, videoLoader]
