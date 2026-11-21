/**
 * Text layout of the `text` layer (spec §6.3), independent of any canvas so it runs in Node: line wrapping and the
 * box of the rasterized text. Every length here is in **em** (multiples of the font size, i.e. of the layer `size`);
 * the rasterizer multiplies by its pixel size.
 */

/** Width of a string in em (a canvas `measureText` divided by the font size, or a fake in tests). */
export type MeasureEm = (text: string) => number

export interface TextLines {
  readonly lines: readonly string[]
  /** Width of each line, in em. */
  readonly widths: readonly number[]
  /** Width of the widest line, in em. */
  readonly width: number
}

const SPACES = /[ \t]+/g

/** Grapheme clusters, so a long word is never broken inside an emoji sequence or a combining character. */
function graphemes(word: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(word), (s) => s.segment)
  }
  return Array.from(word)
}

/**
 * Splits `text` into lines: at every `\n`, and, when `maxWidth` (em) is given, greedily between words so no line is
 * wider than `maxWidth`. A word wider than `maxWidth` on its own is broken between graphemes. Runs of spaces and tabs
 * become one space; spaces at the start or end of a line are dropped.
 */
export function wrapText(text: string, measure: MeasureEm, maxWidth?: number): TextLines {
  const lines: string[] = []
  const widths: number[] = []
  const push = (line: string) => {
    lines.push(line)
    widths.push(line ? measure(line) : 0)
  }
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    const words = paragraph.replace(SPACES, ' ').trim().split(' ').filter((w) => w !== '')
    if (maxWidth === undefined || words.length === 0) {
      push(words.join(' '))
      continue
    }
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (measure(candidate) <= maxWidth) {
        line = candidate
        continue
      }
      if (line) push(line)
      line = ''
      if (measure(word) <= maxWidth) {
        line = word
        continue
      }
      // A word too long for a line on its own: break it between graphemes (at least one per line).
      for (const g of graphemes(word)) {
        const next = line + g
        if (line && measure(next) > maxWidth) {
          push(line)
          line = g
        } else {
          line = next
        }
      }
    }
    push(line)
  }
  return { lines, widths, width: widths.reduce((a, b) => Math.max(a, b), 0) }
}

export type TextAlign = 'left' | 'center' | 'right'

export interface TextBoxStyle {
  align: TextAlign
  /** Distance between baselines, in em (`lineHeight`). */
  lineHeight: number
  /** Font ascent and descent (em), from the font metrics. */
  ascent: number
  descent: number
  /** Outline thickness outside the glyphs (em), 0 for none. */
  outline: number
  /** Shadow blur radius and offset (em, +y up), or undefined for none. */
  shadow?: { blur: number; offsetX: number; offsetY: number } | undefined
}

export interface TextBox {
  /** Size of the image to draw, in em, margins included (outline, shadow). */
  readonly width: number
  readonly height: number
  /** Position of each line's baseline start in the image, in em from its top-left corner (+y down, canvas-like). */
  readonly x: readonly number[]
  readonly y: readonly number[]
  /**
   * Where the layer's anchor point falls in the image, in em from its top-left corner (+y down): on the alignment edge
   * of the text block (its left edge for `left`, centre for `center`, right edge for `right`), at the block's
   * vertical middle.
   */
  readonly originX: number
  readonly originY: number
}

/**
 * Lays out wrapped lines: each line is aligned in the text block (as wide as its widest line); lines are
 * `lineHeight` em apart, the glyphs centred vertically in each line (CSS half-leading). The image gets a margin
 * wide enough for the outline and the shadow.
 */
export function layoutBox(lines: TextLines, style: TextBoxStyle): TextBox {
  const n = lines.lines.length
  const blockW = lines.width
  const blockH = n * style.lineHeight
  const blur = style.shadow ? style.shadow.blur : 0
  const sx = style.shadow ? style.shadow.offsetX : 0
  const sy = style.shadow ? -style.shadow.offsetY : 0 // +y down in the image
  // Margins on each side: the outline, plus the shadow's blur on the side its offset pushes it to.
  const o = style.outline
  const left = Math.max(o, o + blur - sx)
  const right = Math.max(o, o + blur + sx)
  const top = Math.max(o, o + blur - sy)
  const bottom = Math.max(o, o + blur + sy)
  // Glyphs may overflow the line box when lineHeight < ascent + descent: keep them in the image.
  const overflow = Math.max(0, (style.ascent + style.descent - style.lineHeight) / 2)
  const padTop = top + overflow
  const x: number[] = []
  const y: number[] = []
  const halfLeading = (style.lineHeight - style.ascent - style.descent) / 2
  for (let i = 0; i < n; i++) {
    const w = lines.widths[i] ?? 0
    const dx = style.align === 'left' ? 0 : style.align === 'right' ? blockW - w : (blockW - w) / 2
    x.push(left + dx)
    y.push(padTop + i * style.lineHeight + halfLeading + style.ascent)
  }
  const originX = left + (style.align === 'left' ? 0 : style.align === 'right' ? blockW : blockW / 2)
  return {
    width: left + blockW + right,
    height: padTop + blockH + bottom + overflow,
    x,
    y,
    originX,
    originY: padTop + blockH / 2,
  }
}
