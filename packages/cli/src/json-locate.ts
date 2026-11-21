/**
 * Maps JSON pointers to line/column positions in a JSON text, so manifest issues can point to `manifest.json:12:7`
 * as well as to `/layers/2/anchor`. Runs on text that JSON.parse already accepted.
 */

export interface Position {
  /** 1-based. */
  line: number
  /** 1-based, in UTF-16 code units. */
  column: number
}

export type JsonLocator = (pointer: string) => Position

const escapeToken = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1')

/** Builds a locator. A pointer that does not exist (e.g. a missing property) resolves to its closest ancestor. */
export function jsonLocator(text: string): JsonLocator {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  const toPosition = (offset: number): Position => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, column: offset - starts[lo]! + 1 }
  }

  // Offset of each pointer: the member key for object properties, the value for array items and the root.
  const offsets = new Map<string, number>()
  let p = 0
  const ws = () => {
    while (p < text.length && ' \t\n\r\uFEFF'.includes(text[p]!)) p++
  }
  const str = (): string => {
    const start = p
    p++
    while (p < text.length && text[p] !== '"') p += text[p] === '\\' ? 2 : 1
    p++
    return JSON.parse(text.slice(start, p)) as string
  }
  const value = (pointer: string): void => {
    ws()
    const c = text[p]
    if (c === '{') {
      p++
      ws()
      while (text[p] !== '}' && p < text.length) {
        const keyAt = p
        const key = `${pointer}/${escapeToken(str())}`
        offsets.set(key, keyAt)
        ws()
        p++ // ':'
        value(key)
        ws()
        if (text[p] === ',') p++
        ws()
      }
      p++
    } else if (c === '[') {
      p++
      ws()
      let i = 0
      while (text[p] !== ']' && p < text.length) {
        const item = `${pointer}/${i++}`
        ws()
        offsets.set(item, p)
        value(item)
        ws()
        if (text[p] === ',') p++
        ws()
      }
      p++
    } else if (c === '"') str()
    else while (p < text.length && !',]} \t\n\r'.includes(text[p]!)) p++
  }
  ws()
  offsets.set('', p)
  value('')

  return (pointer) => {
    let cur = pointer
    for (;;) {
      const at = offsets.get(cur)
      if (at !== undefined) return toPosition(at)
      if (cur === '') return { line: 1, column: 1 }
      cur = cur.slice(0, cur.lastIndexOf('/'))
    }
  }
}

export interface JsonSyntaxError extends Position {
  message: string
}

/**
 * First syntax error of a JSON text, located (V8's JSON.parse messages do not always carry a position).
 * Returns undefined for valid JSON.
 */
export function jsonSyntaxError(text: string): JsonSyntaxError | undefined {
  let p = 0
  const fail = (message: string): never => {
    throw Object.assign(new Error(message), { offset: p })
  }
  const ws = () => {
    while (p < text.length && ' \t\n\r'.includes(text[p]!)) p++
  }
  const show = () => (p >= text.length ? 'end of file' : `"${text[p]}"`)
  const expect = (c: string, what: string) => {
    ws()
    if (text[p] !== c) fail(`Expected ${what}, found ${show()}`)
    p++
  }
  const string = () => {
    p++
    for (;;) {
      if (p >= text.length) fail('Unterminated string')
      const c = text.charCodeAt(p)
      if (c === 34) break
      if (c < 0x20) fail('Control character in a string (use \\n, \\t…)')
      if (c === 92) {
        const e = text[p + 1] ?? ''
        if (e === 'u' ? !/^[0-9a-fA-F]{4}$/.test(text.slice(p + 2, p + 6)) : e === '' || !'"\\/bfnrt'.includes(e)) {
          fail('Invalid escape sequence')
        }
        p += e === 'u' ? 6 : 2
      } else p++
    }
    p++
  }
  const NUMBER = /-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/y
  const value = (): void => {
    ws()
    const c = text[p]
    if (c === '{') {
      p++
      ws()
      if (text[p] === '}') return void p++
      for (;;) {
        ws()
        if (text[p] === '}') fail('Trailing comma before "}"')
        if (text[p] === '/') fail('Comments are not allowed in JSON')
        if (text[p] !== '"') fail(`Expected a property name in double quotes, found ${show()}`)
        string()
        expect(':', '":"')
        value()
        ws()
        if (text[p] === ',') {
          p++
          continue
        }
        if (text[p] === '}') return void p++
        fail(`Expected "," or "}", found ${show()}`)
      }
    }
    if (c === '[') {
      p++
      ws()
      if (text[p] === ']') return void p++
      for (;;) {
        ws()
        if (text[p] === ']') fail('Trailing comma before "]"')
        value()
        ws()
        if (text[p] === ',') {
          p++
          continue
        }
        if (text[p] === ']') return void p++
        fail(`Expected "," or "]", found ${show()}`)
      }
    }
    if (c === '"') return string()
    for (const word of ['true', 'false', 'null']) if (text.startsWith(word, p)) return void (p += word.length)
    NUMBER.lastIndex = p
    if (c !== undefined && /[-0-9]/.test(c) && NUMBER.test(text)) return void (p = NUMBER.lastIndex)
    fail(c === '/' ? 'Comments are not allowed in JSON' : c === "'" ? 'Strings use double quotes in JSON' : `Unexpected ${show()}`)
  }
  try {
    if (text.startsWith('\uFEFF')) p = 1
    value()
    ws()
    if (p < text.length) fail(`Unexpected ${show()} after the end of the JSON value`)
    return undefined
  } catch (e) {
    const offset = Math.min((e as { offset: number }).offset, text.length)
    const before = text.slice(0, offset)
    return { line: before.split('\n').length, column: offset - before.lastIndexOf('\n'), message: (e as Error).message }
  }
}
