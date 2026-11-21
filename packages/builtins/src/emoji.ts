/**
 * The built-in emoji set (`builtin:font/emoji`, spec §6.3): Noto Color Emoji, one PNG per emoji.
 *
 * Emoji are drawn from these images rather than from a font because no color font format renders the same in
 * every browser: Safari has no COLRv1 and no CBDT, Chrome has no SVG-in-OpenType (assets/CREDITS.md). A text layer
 * splits its text with `EmojiSet.split`, draws the text runs with `fillText` and the emoji runs with `drawImage`
 * (`emojiImageUrl(run.key)`, placed with `emojiBox`): plain Canvas 2D images, identical on every device, usable in
 * a worker (`createImageBitmap`).
 */

/** The set's `index.json`, written by scripts/extract-emoji.py. */
export interface EmojiIndex {
  source: string
  format: 'png'
  /**
   * Metrics shared by every image, in pixels at `ppem` pixels per em (the font's bitmap strike): the image's
   * top-left corner is `bearingX` right of the pen and `bearingY` above the baseline; the pen then advances by
   * `advance`.
   */
  ppem: number
  width: number
  height: number
  bearingX: number
  bearingY: number
  advance: number
  /** Keys of the images: code points in lowercase hex, joined by "-", without U+FE0F. */
  emoji: string[]
  /** Other sequences drawn with an image of `emoji` (alias → key). */
  aliases: Record<string, string>
  /**
   * Single code points drawn as emoji only when followed by U+FE0F: the emoji with a default text presentation that
   * every built-in font draws (©, ®, ™). The other text-default emoji (❤, ☺, ✌…) are drawn from the set even
   * without U+FE0F, because the fallback would be a system font, which differs per device.
   */
  text: string[]
  /** RGI sequences the set does not draw. */
  missing: string[]
}

/** A piece of text: drawn with the text font, or one emoji drawn from the image `key`. */
export type TextRun = { emoji: false; text: string } | { emoji: true; text: string; key: string }

/** Where to draw one emoji, for a font size in pixels: offsets from the pen position on the baseline. */
export interface EmojiBox {
  /** Left edge, from the pen. */
  x: number
  /** Top edge, from the baseline (negative: above). */
  y: number
  width: number
  height: number
  /** Pen advance. */
  advance: number
}

const VS15 = 0xfe0e
const VS16 = 0xfe0f

/**
 * Cheap test before loading the index: false when the text certainly has no emoji (no pictographic code point, no
 * regional indicator, no keycap).
 */
export function mayContainEmoji(text: string): boolean {
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(text)
}

/** Key of an emoji sequence: its code points in lowercase hex, joined by "-", without U+FE0F. */
export function emojiKey(sequence: string): string {
  const parts: string[] = []
  for (const ch of sequence) {
    const cp = ch.codePointAt(0)!
    if (cp !== VS16) parts.push(cp.toString(16))
  }
  return parts.join('-')
}

/** Draw box of the emoji images at a font size, matching the proportions of the Noto Color Emoji font. */
export function emojiBox(index: EmojiIndex, fontSize: number): EmojiBox {
  const s = fontSize / index.ppem
  return {
    x: index.bearingX * s,
    y: -index.bearingY * s,
    width: index.width * s,
    height: index.height * s,
    advance: index.advance * s,
  }
}

/** Parses and checks an `index.json`. */
export function parseEmojiIndex(json: unknown): EmojiIndex {
  const o = json as Partial<EmojiIndex> | null
  const ok =
    o !== null && typeof o === 'object' && o.format === 'png' && Array.isArray(o.emoji) && Array.isArray(o.text) &&
    typeof o.aliases === 'object' && o.aliases !== null &&
    [o.ppem, o.width, o.height, o.bearingX, o.bearingY, o.advance].every((n) => typeof n === 'number')
  if (!ok) throw new Error('Invalid emoji index')
  return { missing: [], ...o } as EmojiIndex
}

/** Lookup of the emoji set's sequences. */
export class EmojiSet {
  readonly index: EmojiIndex
  /** Key (or alias) → image key. */
  private readonly images = new Map<string, string>()
  private readonly textDefault: Set<string>
  /** Longest sequence, in code points (without U+FE0F). */
  private readonly maxLength: number

  constructor(index: EmojiIndex) {
    this.index = index
    for (const key of index.emoji) this.images.set(key, key)
    for (const [alias, key] of Object.entries(index.aliases)) this.images.set(alias, key)
    this.textDefault = new Set(index.text)
    let max = 1
    for (const key of this.images.keys()) max = Math.max(max, key.split('-').length)
    this.maxLength = max
  }

  /** Image key of an emoji sequence (U+FE0F optional), or undefined when the set does not draw it. */
  imageOf(sequence: string): string | undefined {
    return this.images.get(emojiKey(sequence))
  }

  /**
   * Splits a text into text runs and emoji runs (one per emoji). Longest match against the set, so the result
   * does not depend on the browser's Unicode version. Any emoji followed by U+FE0E stays text, and so do ©, ® and ™
   * unless followed by U+FE0F (`EmojiIndex.text`). Sequences the set does not know (newer Unicode) fall apart into
   * their known parts, as in a font.
   */
  split(text: string): TextRun[] {
    const cps = Array.from(text, (ch) => ch.codePointAt(0)!)
    const runs: TextRun[] = []
    let plain = ''
    let i = 0
    while (i < cps.length) {
      const match = this.matchAt(cps, i)
      if (!match) {
        plain += String.fromCodePoint(cps[i]!)
        i++
        continue
      }
      if (plain) runs.push({ emoji: false, text: plain })
      plain = ''
      runs.push({ emoji: true, text: String.fromCodePoint(...cps.slice(i, match.end)), key: match.key })
      i = match.end
    }
    if (plain) runs.push({ emoji: false, text: plain })
    return runs
  }

  /** Longest emoji starting at `start`: image key and end index (past a trailing U+FE0F). */
  private matchAt(cps: number[], start: number): { key: string; end: number } | undefined {
    const first = cps[start]!
    if (first === VS16 || first === VS15) return undefined
    let key = ''
    let parts = 0
    let found: { key: string; end: number } | undefined
    for (let j = start; j < cps.length && parts < this.maxLength; j++) {
      const cp = cps[j]!
      if (cp === VS16) continue
      if (cp === VS15) break
      key = parts === 0 ? cp.toString(16) : `${key}-${cp.toString(16)}`
      parts++
      const image = this.images.get(key)
      if (image === undefined) continue
      let end = j + 1
      const next = cps[end]
      if (next === VS15) continue
      if (next === VS16) end++
      else if (parts === 1 && this.textDefault.has(key)) continue
      found = { key: image, end }
    }
    return found
  }
}
