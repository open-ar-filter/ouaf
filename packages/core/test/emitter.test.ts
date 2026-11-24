import { afterEach, describe, expect, it, vi } from 'vitest'
import { Emitter } from '../src/engine/emitter.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Emitter', () => {
  it('reports a throwing listener to console.error by default, and the others still run', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const e = new Emitter<{ x: number }>()
    const boom = new Error('boom')
    const calls: number[] = []
    e.on('x', () => {
      throw boom
    })
    e.on('x', (n) => calls.push(n))
    e.emit('x', 7)
    expect(logged).toHaveBeenCalledWith(boom)
    expect(calls).toEqual([7])
  })

  it('gives the event name to onListenerError', () => {
    const onError = vi.fn()
    const e = new Emitter<{ a: number; b: string }>(onError)
    const boom = new Error('boom')
    e.on('b', () => {
      throw boom
    })
    e.emit('a', 1)
    expect(onError).not.toHaveBeenCalled()
    e.emit('b', 'x')
    expect(onError).toHaveBeenCalledWith(boom, 'b')
  })

  it('has() is true only while a listener is subscribed', () => {
    const e = new Emitter<{ x: number; y: number }>()
    expect(e.has('x')).toBe(false)
    const listener = () => {}
    const off = e.on('x', listener)
    e.on('x', listener) // the same function twice: two subscriptions
    expect(e.has('x')).toBe(true)
    expect(e.has('y')).toBe(false)
    off()
    expect(e.has('x')).toBe(true)
    e.off('x', listener)
    expect(e.has('x')).toBe(false)
  })

  it('off() of an unknown event or listener does nothing', () => {
    const e = new Emitter<{ x: number; y: number }>()
    const calls: number[] = []
    const listener = (n: number) => calls.push(n)
    e.on('x', listener)
    e.off('y', listener)
    e.off('x', () => {})
    const off = e.on('y', listener)
    off()
    off() // twice: no effect
    e.emit('x', 1)
    expect(calls).toEqual([1])
  })

  it('a listener added during an emit is called from the next one', () => {
    const e = new Emitter<{ x: number }>()
    const calls: string[] = []
    e.on('x', (n) => {
      calls.push(`a${n}`)
      if (n === 1) e.on('x', (m) => calls.push(`late${m}`))
    })
    e.emit('x', 1)
    e.emit('x', 2)
    expect(calls).toEqual(['a1', 'a2', 'late2'])
  })

  it('clear() removes every listener', () => {
    const e = new Emitter<{ x: number; y: number }>()
    const calls: number[] = []
    e.on('x', (n) => calls.push(n))
    e.on('y', (n) => calls.push(n))
    e.clear()
    e.emit('x', 1)
    e.emit('y', 2)
    expect(calls).toEqual([])
    expect(e.has('x') || e.has('y')).toBe(false)
  })
})
