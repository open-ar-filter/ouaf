import { describe, expect, it } from 'vitest'
import { jsonLocator, jsonSyntaxError } from '../src/json-locate.ts'

const text = `{
  "id": "x",
  "a/b": { "c~d": [10, { "e": "s\\"]" }] },
  "layers": [
    { "type": "text" },
    {
      "type": "sticker"
    }
  ]
}`

describe('jsonLocator', () => {
  const locate = jsonLocator(text)

  it('points members at their key and array items at their value', () => {
    expect(locate('')).toEqual({ line: 1, column: 1 })
    expect(locate('/id')).toEqual({ line: 2, column: 3 })
    expect(locate('/layers/0')).toEqual({ line: 5, column: 5 })
    expect(locate('/layers/0/type')).toEqual({ line: 5, column: 7 })
    expect(locate('/layers/1/type')).toEqual({ line: 7, column: 7 })
  })

  it('decodes escaped pointer tokens and skips escaped quotes in strings', () => {
    expect(locate('/a~1b/c~0d/1/e')).toEqual({ line: 3, column: 26 })
    expect(locate('/a~1b/c~0d/0')).toEqual({ line: 3, column: 20 })
  })

  it('falls back to the closest existing ancestor', () => {
    expect(locate('/layers/1/anchor')).toEqual({ line: 6, column: 5 })
    expect(locate('/missing')).toEqual({ line: 1, column: 1 })
  })
})

describe('jsonSyntaxError', () => {
  it.each([
    ['{\n  "a": 1,\n}', 3, 1, 'Trailing comma before "}"'],
    ['{\n  "a": [1, 2,]\n}', 2, 14, 'Trailing comma before "]"'],
    ['{ "a": 1 "b": 2 }', 1, 10, 'Expected "," or "}", found """'],
    ["{ 'a': 1 }", 1, 3, 'Expected a property name in double quotes, found "\'"'],
    ['{\n  // note\n  "a": 1 }', 2, 3, 'Comments are not allowed in JSON'],
    ['[1, tru]', 1, 5, 'Unexpected "t"'],
    ['{ "a": "x\\q" }', 1, 10, 'Invalid escape sequence'],
    ['{ "a": 1 } x', 1, 12, 'Unexpected "x" after the end of the JSON value'],
    ['{ "a": ', 1, 8, 'Unexpected end of file'],
  ])('%s', (text, line, column, message) => {
    expect(() => JSON.parse(text)).toThrow()
    expect(jsonSyntaxError(text)).toEqual({ line, column, message })
  })

  it('accepts what JSON.parse accepts', () => {
    for (const text of ['{}', '[]', '"\\u00e9\\n"', '-0.5e+3', '\uFEFF{"a":[true,false,null,{"b":{}}]}', ' 1 ']) {
      expect(jsonSyntaxError(text), text).toBeUndefined()
    }
  })
})
