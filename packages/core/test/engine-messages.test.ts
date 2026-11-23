import { describe, expect, it } from 'vitest'
import { OuafError } from '../src/engine/errors.ts'
import { messagePayload } from '../src/engine/messages.ts'

/** The code of the `OuafError` thrown by `fn`, or 'no error'. */
function codeOf(fn: () => unknown): string {
  try {
    fn()
    return 'no error'
  } catch (e) {
    return e instanceof OuafError ? e.code : String(e)
  }
}

describe('host messages (send)', () => {
  it('accepts names that make a message:<name> event', () => {
    for (const name of ['go', 'tint', 'setColor', 'level-2', 'a_b', 'X9']) expect(messagePayload(name, 1)).toEqual({ data: 1 })
  })

  it('refuses other names', () => {
    for (const name of ['', '2go', '-x', 'a b', 'a:b', 'é', 'go!']) expect(codeOf(() => messagePayload(name, 1))).toBe('invalid-message')
    expect(codeOf(() => messagePayload(undefined as unknown as string, 1))).toBe('invalid-message')
  })

  it('copies the data at the call, as postMessage would', () => {
    const data = { list: [1, 2], when: new Date(0), bytes: new Uint8Array([1, 2]), map: new Map([['k', 1]]) }
    const payload = messagePayload('go', data)
    data.list.push(3)
    data.bytes[0] = 9
    expect(payload.data).toEqual({ list: [1, 2], when: new Date(0), bytes: new Uint8Array([1, 2]), map: new Map([['k', 1]]) })
    expect(payload.data).not.toBe(data)
    expect(messagePayload('go', undefined)).toEqual({ data: undefined })
  })

  it('refuses data that cannot reach the sandbox, with an explicit error', () => {
    expect(codeOf(() => messagePayload('go', { fn: () => 1 }))).toBe('invalid-message')
    expect(codeOf(() => messagePayload('go', Symbol('s')))).toBe('invalid-message')
    expect(() => messagePayload('go', { fn: () => 1 })).toThrow(/send\("go"\): the data cannot be sent to a script, it must be structured-cloneable/)
  })

  it('refuses data larger than 64 KB, measured as f.emit measures it (spec §12.4)', () => {
    // Strings count 2 bytes a character: 32 768 characters are 64 KB.
    expect(messagePayload('go', 'x'.repeat(32_000))).toEqual({ data: 'x'.repeat(32_000) })
    expect(codeOf(() => messagePayload('go', 'x'.repeat(32_769)))).toBe('invalid-message')
    expect(codeOf(() => messagePayload('go', { bytes: new Uint8Array(64 * 1024) }))).toBe('invalid-message')
    expect(codeOf(() => messagePayload('go', new Uint8Array(60 * 1024)))).toBe('no error')
    expect(() => messagePayload('go', Array.from({ length: 10_000 }, (_, i) => i))).toThrow(/send\("go"\): the data is larger than 64 KB/)
  })
})
