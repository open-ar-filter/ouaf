/**
 * Canvas 2D rasterization of a `text` layer (spec §6.3: "rasterize text once and redraw it only when its content or
 * style changes"). A `TextRaster` owns one canvas; `update` redraws it only when the text, its color or its wrap width
 * changed since the last call, so transforms, opacity and visibility (which change every frame) never redraw it.
 *
 * The canvas grows in steps of 64 px, so text that changes often (a counter) reuses it: the part in use is given by
 * `uScale`/`vScale`, and `resized` tells the caller when the GPU texture must be reallocated. It shrinks only when
 * the image takes less than half of it each way (a lower resolution, a much shorter text).
 *
 * The font size in pixels (`pixelsPerEm`) is set by the layer from the text's size on screen (`resolution.ts`, #147);
 * a new one redraws on the next update.
 */
import { layoutBox, wrapText, type TextAlign, type TextBox } from './layout.ts'

/** The members of a 2D context the rasterizer uses (`CanvasRenderingContext2D` and its offscreen twin have them). */
export interface TextContext {
  font: string
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  lineJoin: CanvasLineJoin
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  shadowColor: string
  shadowBlur: number
  shadowOffsetX: number
  shadowOffsetY: number
  globalCompositeOperation: GlobalCompositeOperation
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number): void
  strokeText(text: string, x: number, y: number): void
  measureText(text: string): Pick<TextMetrics, 'width'> & Partial<Pick<TextMetrics, 'fontBoundingBoxAscent' | 'fontBoundingBoxDescent'>>
  drawImage(image: never, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void
}

export interface TextSurface {
  /** The canvas (an `OffscreenCanvas` or `HTMLCanvasElement`), handed to the GPU texture as is. */
  readonly canvas: { width: number; height: number }
  readonly ctx: TextContext
}

/** Creates the canvas a raster draws into (1×1 at first: it is sized on the first draw). */
export type SurfaceFactory = () => TextSurface

export interface TextStyle {
  /** CSS font family, weight and style of the loaded font face. */
  family: string
  weight: string
  style: string
  align: TextAlign
  /** Distance between baselines, in multiples of the font size. */
  lineHeight: number
  /** Outline thickness outside the glyphs, relative to the font size. */
  outline?: { width: number; color: string } | undefined
  /** Blur and offset relative to the font size, offset +y up. */
  shadow?: { color: string; blur: number; offset: readonly [number, number] } | undefined
}

export interface RasterOptions {
  /**
   * Initial font size in pixels of the raster (`pixelsPerEm`); smaller when the text would not fit in `maxSize`.
   * Default: 96.
   */
  basePx?: number
  /** Maximum width and height of the canvas in pixels. Default: 2048. */
  maxSize?: number
}

/** Distance used to draw shapes off the canvas so only their shadow lands on it (device pixels). */
const SHADOW_SHIFT = 16384
const STEP = 64
/**
 * A blurred shadow is drawn smaller, then enlarged: by a factor that keeps its blur at about this many pixels (at most
 * `MAX_SHADOW_REDUCTION`). Canvas 2D blurs cost grow with the radius: a 0.15 em blur at 362 px per em took 12 ms per
 * text in Chromium (#147), and the enlarged blur looks the same.
 */
const SHADOW_DETAIL = 8
const MAX_SHADOW_REDUCTION = 4

/** `#rgb[a]` / `#rrggbb[aa]` → opaque `#rrggbb` and the alpha in [0, 1]. */
export function splitAlpha(color: string): { rgb: string; alpha: number } {
  const hex = color.slice(1)
  if (hex.length === 3 || hex.length === 4) {
    const full = [...hex].map((c) => c + c).join('')
    return splitAlpha(`#${full}`)
  }
  const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
  return { rgb: `#${hex.slice(0, 6)}`, alpha }
}

export class TextRaster {
  readonly surface: TextSurface
  readonly #createSurface: SurfaceFactory
  /** Where a reduced shadow is drawn, created on first use. */
  #shadowSurface: TextSurface | undefined
  #style: TextStyle
  #basePx: number
  readonly #maxSize: number
  #ascent = 0.8
  #descent = 0.2
  #text: string | undefined
  #color: string | undefined
  #wrap = Number.NaN
  /** Number of redraws so far (tests, stats). */
  draws = 0
  /** The canvas was resized by the last redraw: the GPU texture must be reallocated. */
  resized = false
  /** Size of the drawn image in em (font-size units), and where the anchor point falls in it (em, +y down). */
  width = 0
  height = 0
  originX = 0
  originY = 0
  /** Fraction of the canvas the image covers, from its top-left corner. */
  uScale = 1
  vScale = 1

  constructor(style: TextStyle, createSurface: SurfaceFactory, options: RasterOptions = {}) {
    this.#style = style
    this.#basePx = options.basePx ?? 96
    this.#maxSize = options.maxSize ?? 2048
    this.#createSurface = createSurface
    this.surface = createSurface()
    this.#measure()
  }

  /** Font size of the raster in pixels (before the `maxSize` limit). */
  get pixelsPerEm(): number {
    return this.#basePx
  }

  /** Draws at `px` pixels per em from now on: redrawn next update when it differs. */
  setPixelsPerEm(px: number): void {
    if (!(px > 0) || px === this.#basePx) return
    this.#basePx = px
    this.#measure()
    this.#text = undefined
  }

  /** Draws with another font face from now on (a `font` bound to a parameter or set by a script): redrawn next update. */
  setFont(font: Pick<TextStyle, 'family' | 'weight' | 'style'>): void {
    const s = this.#style
    if (s.family === font.family && s.weight === font.weight && s.style === font.style) return
    this.#style = { ...s, family: font.family, weight: font.weight, style: font.style }
    this.#measure()
    this.#text = undefined
  }

  /** Ascent and descent of the font, in em. */
  #measure(): void {
    const ctx = this.surface.ctx
    ctx.font = this.font
    const m = ctx.measureText('Hg')
    const asc = m.fontBoundingBoxAscent
    const desc = m.fontBoundingBoxDescent
    if (asc !== undefined && desc !== undefined && asc + desc > 0) {
      this.#ascent = asc / this.#basePx
      this.#descent = desc / this.#basePx
    }
  }

  /** CSS font of the raster, at `basePx`; the generic fallback draws characters the font lacks (emoji). */
  get font(): string {
    const s = this.#style
    return `${s.style} ${s.weight} ${this.#basePx}px "${s.family}", sans-serif`
  }

  /**
   * Redraws the text when `text`, `color` or `wrap` (maximum line width in em, `Infinity` for none) differ from the
   * previous call. Returns true when it redrew. Does not allocate when nothing changed.
   */
  update(text: string, color: string, wrap: number): boolean {
    if (text === this.#text && color === this.#color && wrap === this.#wrap) {
      this.resized = false
      return false
    }
    this.#text = text
    this.#color = color
    this.#wrap = wrap
    this.#draw(text, color, wrap)
    this.draws++
    return true
  }

  #draw(text: string, color: string, wrap: number): void {
    const { ctx, canvas } = this.surface
    const style = this.#style
    const base = this.#basePx
    ctx.font = this.font
    const lines = wrapText(text, (s) => ctx.measureText(s).width / base, Number.isFinite(wrap) ? wrap : undefined)
    const shadow = style.shadow
    const box: TextBox = layoutBox(lines, {
      align: style.align,
      lineHeight: style.lineHeight,
      ascent: this.#ascent,
      descent: this.#descent,
      outline: style.outline?.width ?? 0,
      shadow: shadow && { blur: shadow.blur, offsetX: shadow.offset[0], offsetY: shadow.offset[1] },
    })

    // Pixel size: `basePx`, or less so the image fits in maxSize (1 px of margin on each side).
    const room = this.#maxSize - 2
    const px = Math.max(1, Math.min(base, room / Math.max(box.width, 1e-6), room / Math.max(box.height, 1e-6)))
    const w = Math.min(this.#maxSize, Math.ceil(box.width * px) + 2)
    const h = Math.min(this.#maxSize, Math.ceil(box.height * px) + 2)
    const shrink = w * 2 <= canvas.width && h * 2 <= canvas.height
    this.resized = w > canvas.width || h > canvas.height || shrink
    if (this.resized) {
      // Resizing resets the context state; everything is set again below.
      const fit = (size: number, current: number) => Math.min(this.#maxSize, shrink ? Math.ceil(size / STEP) * STEP : Math.max(current, Math.ceil(size / STEP) * STEP))
      canvas.width = fit(w, canvas.width)
      canvas.height = fit(h, canvas.height)
    }
    this.width = w / px
    this.height = h / px
    this.originX = (1 + box.originX * px) / px
    this.originY = (1 + box.originY * px) / px
    this.uScale = w / canvas.width
    this.vScale = h / canvas.height

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // Layout units are em at `base` px; the transform scales them to `px` with the 1 px margin.
    const s = px / base
    ctx.font = this.font
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.lineJoin = 'round'
    const outline = style.outline && style.outline.width > 0 ? style.outline : undefined
    const stroke = outline ? 2 * outline.width * base : 0

    if (shadow) {
      // The shadow of the whole silhouette (outline and fill), drawn opaque then faded once, so overlapping shapes do
      // not darken it twice. The shapes themselves are drawn far off the canvas: only their shadow lands on it
      // (shadow offsets and blur are in canvas pixels, outside the transform). A large blur is drawn `f` times smaller
      // on its own canvas, then enlarged into this one.
      const { rgb, alpha } = splitAlpha(shadow.color)
      const f = Math.min(MAX_SHADOW_REDUCTION, Math.max(1, Math.floor((shadow.blur * px) / SHADOW_DETAIL)))
      const target = f > 1 ? (this.#shadowSurface ??= this.#createSurface()) : this.surface
      const c = target.ctx
      if (f > 1) {
        const sw = Math.ceil(w / f) + 1
        const sh = Math.ceil(h / f) + 1
        if (target.canvas.width < sw || target.canvas.height < sh || target.canvas.width > 2 * sw || target.canvas.height > 2 * sh) {
          target.canvas.width = Math.ceil(sw / 16) * 16
          target.canvas.height = Math.ceil(sh / 16) * 16
        }
        c.setTransform(1, 0, 0, 1, 0, 0)
        c.globalCompositeOperation = 'source-over'
        c.clearRect(0, 0, target.canvas.width, target.canvas.height)
        c.font = this.font
        c.textAlign = 'left'
        c.textBaseline = 'alphabetic'
        c.lineJoin = 'round'
      }
      const q = px / f
      c.setTransform(s / f, 0, 0, s / f, 1 / f - SHADOW_SHIFT, 1 / f)
      c.shadowColor = rgb
      c.shadowBlur = shadow.blur * q
      c.shadowOffsetX = SHADOW_SHIFT + shadow.offset[0] * q
      c.shadowOffsetY = -shadow.offset[1] * q
      c.fillStyle = '#000'
      c.strokeStyle = '#000'
      c.lineWidth = stroke
      for (let i = 0; i < lines.lines.length; i++) {
        const line = lines.lines[i]!
        if (outline) c.strokeText(line, box.x[i]! * base, box.y[i]! * base)
        c.fillText(line, box.x[i]! * base, box.y[i]! * base)
      }
      c.shadowColor = 'transparent'
      c.shadowBlur = 0
      c.shadowOffsetX = 0
      c.shadowOffsetY = 0
      if (alpha < 1) {
        c.setTransform(1, 0, 0, 1, 0, 0)
        c.globalCompositeOperation = 'destination-in'
        c.fillStyle = `rgba(0, 0, 0, ${alpha})`
        c.fillRect(0, 0, target.canvas.width, target.canvas.height)
        c.globalCompositeOperation = 'source-over'
      }
      if (f > 1) {
        const sw = Math.ceil(w / f) + 1
        const sh = Math.ceil(h / f) + 1
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.drawImage(target.canvas as never, 0, 0, sw, sh, 0, 0, sw * f, sh * f)
      }
    }

    ctx.setTransform(s, 0, 0, s, 1, 1)
    if (outline) {
      ctx.strokeStyle = outline.color
      ctx.lineWidth = stroke
      for (let i = 0; i < lines.lines.length; i++) ctx.strokeText(lines.lines[i]!, box.x[i]! * base, box.y[i]! * base)
    }
    ctx.fillStyle = color
    for (let i = 0; i < lines.lines.length; i++) ctx.fillText(lines.lines[i]!, box.x[i]! * base, box.y[i]! * base)
  }
}
