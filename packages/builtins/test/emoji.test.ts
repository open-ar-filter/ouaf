import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EmojiSet, emojiBox, emojiImageUrl, emojiKey, mayContainEmoji, parseEmojiIndex } from '../src/index.ts'

const dir = fileURLToPath(new URL('../assets/emoji/', import.meta.url))
const index = parseEmojiIndex(JSON.parse(readFileSync(`${dir}/index.json`, 'utf8')))
const set = new EmojiSet(index)

/** The runs of a text, as [text, key] pairs (key undefined for a text run). */
const split = (text: string) => set.split(text).map((r) => [r.text, r.emoji ? r.key : undefined])

describe('emoji set', () => {
  it('has one PNG per key and nothing else', () => {
    const files = readdirSync(dir).filter((f) => f !== 'index.json')
    expect(files.sort()).toEqual(index.emoji.map((k) => `${k}.png`).sort())
    const png = readFileSync(`${dir}/1f600.png`)
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(index.width)
    expect(png.readUInt32BE(20)).toBe(index.height)
  })

  it('covers the whole RGI set', () => {
    expect(index.missing).toEqual([])
    expect(index.emoji.length + Object.keys(index.aliases).length).toBeGreaterThan(3900)
    for (const key of Object.values(index.aliases)) expect(index.emoji).toContain(key)
  })

  it('finds emoji, sequences, flags and keycaps', () => {
    expect(set.imageOf('😀')).toBe('1f600')
    expect(set.imageOf('👍🏽')).toBe('1f44d-1f3fd')
    expect(set.imageOf('👨‍👩‍👧')).toBe('1f468-200d-1f469-200d-1f467')
    expect(set.imageOf('🇫🇷')).toBe('1f1eb-1f1f7')
    expect(set.imageOf('🏴󠁧󠁢󠁳󠁣󠁴󠁿')).toBe('1f3f4-e0067-e0062-e0073-e0063-e0074-e007f')
    expect(set.imageOf('#️⃣')).toBe('23-20e3')
    expect(set.imageOf('❤️')).toBe('2764')
    expect(set.imageOf('a')).toBeUndefined()
    expect(emojiKey('🏳️‍🌈')).toBe('1f3f3-200d-1f308')
  })

  it('splits text into text and emoji runs', () => {
    expect(split('Hello 😎!')).toEqual([['Hello ', undefined], ['😎', '1f60e'], ['!', undefined]])
    expect(split('😀😀')).toEqual([['😀', '1f600'], ['😀', '1f600']])
    expect(split('🇫🇷🇩🇪')).toEqual([['🇫🇷', '1f1eb-1f1f7'], ['🇩🇪', '1f1e9-1f1ea']])
    expect(split('👍🏽 ok')).toEqual([['👍🏽', '1f44d-1f3fd'], [' ok', undefined]])
    expect(split('🏳️‍🌈')).toEqual([['🏳️‍🌈', '1f3f3-200d-1f308']])
    expect(split('plain text')).toEqual([['plain text', undefined]])
    expect(split('')).toEqual([])
  })

  it('keeps ©, ® and ™ as text unless U+FE0F asks for an emoji', () => {
    expect(index.text.sort()).toEqual(['2122', 'a9', 'ae'])
    expect(split('© 2026 ACME® Ouaf™')).toEqual([['© 2026 ACME® Ouaf™', undefined]])
    expect(split('©️')).toEqual([['©️', 'a9']])
  })

  it('draws the other text-default emoji from the set, unless U+FE0E asks for text', () => {
    expect(split('I ❤ U')).toEqual([['I ', undefined], ['❤', '2764'], [' U', undefined]])
    expect(split('I ❤️ U')).toEqual([['I ', undefined], ['❤️', '2764'], [' U', undefined]])
    expect(split('I ❤\uFE0E U')).toEqual([['I ❤\uFE0E U', undefined]])
    expect(split('1 #')).toEqual([['1 #', undefined]])
    expect(split('1️⃣')).toEqual([['1️⃣', '31-20e3']])
    // U+FE0E: text presentation, even for an emoji-presentation code point.
    expect(split('😀︎')).toEqual([['😀︎', undefined]])
    // A text-default code point followed by a skin tone is an emoji sequence.
    expect(split('☝🏽')).toEqual([['☝🏽', '261d-1f3fd']])
  })

  it('falls back to the known parts of an unknown sequence', () => {
    // A lone regional indicator is text; an unknown ZWJ sequence draws its parts.
    expect(split('🇫')).toEqual([['🇫', undefined]])
    expect(split('😀‍😎')).toEqual([['😀', '1f600'], ['‍', undefined], ['😎', '1f60e']])
  })

  it('maps aliases to their image', () => {
    expect(set.imageOf('🇨🇵')).toBe('1f1eb-1f1f7') // Clipperton Island: drawn with the French flag
  })

  it('pre-filters text without emoji', () => {
    expect(mayContainEmoji('Hello, world! 123 #')).toBe(false)
    expect(mayContainEmoji('Hi 😎')).toBe(true)
    expect(mayContainEmoji('🇫🇷')).toBe(true)
    expect(mayContainEmoji('1️⃣')).toBe(true)
    expect(mayContainEmoji('©')).toBe(true)
  })

  it('places images with the Noto metrics', () => {
    const box = emojiBox(index, index.ppem)
    expect(box).toEqual({ x: 0, y: -index.bearingY, width: index.width, height: index.height, advance: index.advance })
    expect(emojiBox(index, 2 * index.ppem).height).toBe(2 * index.height)
    expect(emojiImageUrl('1f600', 'https://example.com/ouaf/').href).toBe('https://example.com/ouaf/emoji/1f600.png')
    expect(() => emojiImageUrl('../x', 'https://example.com/')).toThrow()
  })
})
