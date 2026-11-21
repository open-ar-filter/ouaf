/**
 * Canvas 2D rasterization of a `text` layer (spec §6.3: "rasterize text once and redraw it only when its content or
 * style changes"). A `TextRaster` owns one canvas; `update` redraws it only when the text, its color or its wrap width
 * changed since the last call, so transforms, opacity and visibility (which change every frame) never redraw it.
 *
 * The canvas only grows (in steps of 64 px), so text that changes often (a counter) reuses it: the part in use is
 * given by `uScale`/`vScale`, and `resized` tells the caller when the GPU texture must be reallocated.
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
  /** Font size in pixels of the raster; smaller when the text would not fit in `maxSize`. Default: 96. */
  basePx?: number
  /** Maximum width and height of the canvas in pixels. Default: 2048. */
  maxSize?: number
}

/** Distance used to draw shapes off the canvas so only their shadow lands on it (device pixels). */
const SHADOW_SHIFT = 16384
const STEP = 64

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
  readonly #style: TextStyle
  readonly #basePx: number
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
    this.surface = createSurface()
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
    this.resized = w > canvas.width || h > canvas.height
    if (this.resized) {
      // Resizing resets the context state; everything is set again below.
      canvas.width = Math.min(this.#maxSize, Math.max(canvas.width, Math.ceil(w / STEP) * STEP))
      canvas.height = Math.min(this.#maxSize, Math.max(canvas.height, Math.ceil(h / STEP) * STEP))
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
      // (shadow offsets and blur are in canvas pixels, outside the transform).
      const { rgb, alpha } = splitAlpha(shadow.color)
      ctx.setTransform(s, 0, 0, s, 1 - SHADOW_SHIFT, 1)
      ctx.shadowColor = rgb
      ctx.shadowBlur = shadow.blur * px
      ctx.shadowOffsetX = SHADOW_SHIFT + shadow.offset[0] * px
      ctx.shadowOffsetY = -shadow.offset[1] * px
      ctx.fillStyle = '#000'
      ctx.strokeStyle = '#000'
      ctx.lineWidth = stroke
      for (let i = 0; i < lines.lines.length; i++) {
        const line = lines.lines[i]!
        if (outline) ctx.strokeText(line, box.x[i]! * base, box.y[i]! * base)
        ctx.fillText(line, box.x[i]! * base, box.y[i]! * base)
      }
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = 0
      if (alpha < 1) {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.globalCompositeOperation = 'destination-in'
        ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.globalCompositeOperation = 'source-over'
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
