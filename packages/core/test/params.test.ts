import { describe, expect, it, vi } from 'vitest'
import type { TParams, TPresets } from '@ouaf/spec'
import { ParamError, ParamStore, writeColor, type ParamChange, type ReloadHooks, type ReloadRequest } from '../src/index.ts'

const PARAMS: TParams = {
  size: { type: 'number', default: 1, min: 0.5, max: 2, step: 0.1, transition: 100 },
  count: { type: 'number', default: 3 },
  confetti: { type: 'boolean', default: false },
  label: { type: 'string', default: 'hi', maxLength: 5 },
  body: { type: 'text', default: '' },
  color: { type: 'color', default: '#ff0000' },
  style: { type: 'select', default: 'gold', options: { gold: 'Gold crown', flowers: { en: 'Flowers', fr: 'Fleurs' } } },
  team: { type: 'select', default: '', options: { from: 'host' } },
  offset: { type: 'vec3', default: [0, 0, 0] },
  pos: { type: 'vec2', default: [0.5, 0.5] },
  logo: { type: 'asset', accept: ['image/png', 'image/svg+xml'], maxSize: 1000, optional: true },
  photo: { type: 'asset', accept: ['image/jpeg'] },
}

const PRESETS: TPresets = {
  subtle: { size: 0.7 },
  party: { size: 1.5, confetti: true, style: 'flowers' },
  broken: { size: 1.2, color: 'red' },
}

function store(params: TParams = PARAMS, presets: TPresets = PRESETS) {
  return new ParamStore(params, { presets })
}

function code(fn: () => void): string | undefined {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ParamError)
    return (err as ParamError).code
  }
  return undefined
}

function components(s: ParamStore, name: string): number[] {
  const i = s.indexOf(name)
  return Array.from(s.numbers.subarray(s.offsetOf(i), s.offsetOf(i) + s.sizeOf(i)))
}

describe('ParamStore: reads', () => {
  it('starts at the defaults, with assets empty', () => {
    const s = store()
    expect(s.names).toEqual(Object.keys(PARAMS))
    expect(s.values()).toEqual({
      size: 1, count: 3, confetti: false, label: 'hi', body: '', color: '#ff0000', style: 'gold', team: '',
      offset: [0, 0, 0], pos: [0.5, 0.5], logo: null, photo: null,
    })
  })

  it('lays the numeric components out back to back, by index', () => {
    const s = store()
    expect(s.indexOf('nope')).toBe(-1)
    const layout = s.names.map((n) => [n, s.offsetOf(s.indexOf(n)), s.sizeOf(s.indexOf(n))])
    expect(layout).toEqual([
      ['size', 0, 1], ['count', 1, 1], ['confetti', 2, 1], ['label', -1, 0], ['body', -1, 0], ['color', 3, 4],
      ['style', -1, 0], ['team', -1, 0], ['offset', 7, 3], ['pos', 10, 2], ['logo', -1, 0], ['photo', -1, 0],
    ])
    expect(s.numbers.length).toBe(12)
    expect(s.numberAt(s.indexOf('count'))).toBe(3)
    expect(s.numberAt(s.indexOf('label'))).toBeNaN()
    expect(components(s, 'color')).toEqual([1, 0, 0, 1])
    expect(s.defAt(s.indexOf('team')).type).toBe('select')
    expect(s.valueAt(s.indexOf('label'))).toBe('hi')
    expect(() => s.valueAt(99)).toThrow(RangeError)
  })

  it('parses every hex color form into 0-1 components', () => {
    const out = new Float64Array(4)
    const rgba = (hex: string) => (writeColor(hex, out, 0), Array.from(out, (v) => Math.round(v * 255)))
    expect(rgba('#f00')).toEqual([255, 0, 0, 255])
    expect(rgba('#0F08')).toEqual([0, 255, 0, 136])
    expect(rgba('#336699')).toEqual([0x33, 0x66, 0x99, 255])
    expect(rgba('#AbCdEf80')).toEqual([0xab, 0xcd, 0xef, 0x80])
  })

  it('works without parameters', () => {
    const s = new ParamStore(undefined)
    expect(s.names).toEqual([])
    expect(s.beginFrame(0)).toBe(false)
    expect(code(() => s.set('size', 1))).toBe('unknown-param')
  })
})

describe('ParamStore: validation', () => {
  it('rejects invalid values with an explicit code, and never fixes them', () => {
    const s = store()
    const cases: [string, unknown, string][] = [
      ['nope', 1, 'unknown-param'],
      ['size', '1', 'type'],
      ['size', NaN, 'type'],
      ['size', Infinity, 'type'],
      ['size', 2.5, 'range'],
      ['size', 0.4, 'range'],
      ['confetti', 1, 'type'],
      ['label', 42, 'type'],
      ['label', 'toolong', 'too-long'],
      ['color', 'red', 'type'],
      ['color', '#12345', 'type'],
      ['style', 'silver', 'enum'],
      ['style', 1, 'type'],
      ['offset', [1, 2], 'type'],
      ['offset', [1, 2, NaN], 'type'],
      ['offset', '1,2,3', 'type'],
      ['pos', [1, 2, 3], 'type'],
      ['logo', 'logo.png', 'type'],
      ['logo', new Blob(['x'], { type: 'image/gif' }), 'mime'],
      ['logo', new Blob([new Uint8Array(1001)], { type: 'image/png' }), 'too-large'],
      ['photo', null, 'required'],
    ]
    for (const [name, value, expected] of cases) expect([name, value, code(() => s.set(name, value))]).toEqual([name, value, expected])
    s.beginFrame(0)
    expect(s.hasPendingChanges).toBe(false)
    expect(s.get('size')).toBe(1)
  })

  it('names the parameter and the bounds in the message', () => {
    const s = store()
    expect(() => s.set('size', 3)).toThrow('Invalid value for parameter "size": 3 is outside [0.5, 2].')
    expect(() => s.set('nope', 1)).toThrow(/Unknown parameter "nope"\. Parameters: "size", "count"/)
    try {
      s.set('label', 'toolong')
    } catch (err) {
      expect(err).toMatchObject({ name: 'ParamError', code: 'too-long', param: 'label', preset: undefined })
    }
  })

  it('accepts the bounds, steps off the grid, and code points up to maxLength', () => {
    const s = store()
    for (const v of [0.5, 2, 1.23]) expect(() => s.set('size', v)).not.toThrow()
    expect(() => s.set('label', '😀😀😀😀😀')).not.toThrow() // 5 code points, 10 UTF-16 units
    expect(() => s.set('label', '😀😀😀😀😀😀')).toThrow(ParamError)
    expect(() => s.set('body', 'any\nlength')).not.toThrow()
    expect(() => s.set('logo', new Blob(['<svg/>'], { type: 'image/svg+xml' }))).not.toThrow()
    expect(() => s.set('logo', { type: 'image/svg+xml;charset=utf-8', size: 10 })).not.toThrow()
    expect(() => s.set('logo', null)).not.toThrow()
  })

  it('copies vectors, so a later change of the host array has no effect', () => {
    const s = store()
    const v = [1, 2, 3]
    s.set('offset', v)
    v[0] = 9
    s.beginFrame(0)
    expect(s.get('offset')).toEqual([1, 2, 3])
    expect(Object.isFrozen(s.get('offset'))).toBe(true)
  })

  it('rejects an invalid transition duration', () => {
    const s = store()
    expect(code(() => s.set('size', 1.5, { transition: -1 }))).toBe('invalid-transition')
    expect(code(() => s.setMany({ size: 1.5 }, { transition: NaN }))).toBe('invalid-transition')
  })

  it('rejects an invalid default at construction', () => {
    expect(code(() => new ParamStore({ a: { type: 'number', default: 5, max: 1 } }))).toBe('range')
  })
})

describe('ParamStore: per-frame batching', () => {
  it('applies changes at the start of the next frame only', () => {
    const s = store()
    s.set('count', 5)
    expect(s.get('count')).toBe(3)
    expect(s.numberAt(s.indexOf('count'))).toBe(3)
    expect(s.hasPendingChanges).toBe(true)
    const rev = s.revision
    expect(s.beginFrame(0)).toBe(true)
    expect(s.get('count')).toBe(5)
    expect(s.numberAt(s.indexOf('count'))).toBe(5)
    expect(s.revision).toBe(rev + 1)
  })

  it('keeps the last value set within a frame and reports one change against the previous frame', () => {
    const s = store()
    const changes: ParamChange[] = []
    s.onChange((c) => changes.push(c))
    s.set('count', 4)
    s.set('count', 5)
    s.set('count', 6)
    s.beginFrame(0)
    expect(changes).toEqual([{ name: 'count', value: 6, previous: 3 }])
  })

  it('reports nothing for a value set back to the current one', () => {
    const s = store()
    const listener = vi.fn()
    s.onChange(listener)
    s.set('count', 4)
    s.set('count', 3)
    s.set('offset', [0, 0, 0])
    const rev = s.revision
    expect(s.beginFrame(0)).toBe(false)
    expect(listener).not.toHaveBeenCalled()
    expect(s.revision).toBe(rev)
  })

  it('notifies after every change of the frame is applied, in the order they were set', () => {
    const s = store()
    const seen: unknown[] = []
    s.onChange((c) => seen.push([c.name, s.get('count'), s.get('confetti')]))
    s.set('confetti', true)
    s.set('count', 7)
    s.beginFrame(0)
    expect(seen).toEqual([['confetti', 7, true], ['count', 7, true]])
  })

  it('setMany is atomic: one invalid value queues nothing', () => {
    const s = store()
    expect(code(() => s.setMany({ count: 9, size: 5 }))).toBe('range')
    expect(code(() => s.setMany({ count: 9, nope: 1 }))).toBe('unknown-param')
    s.beginFrame(0)
    expect(s.get('count')).toBe(3)
    s.setMany({ count: 9, confetti: true })
    s.beginFrame(16)
    expect([s.get('count'), s.get('confetti')]).toEqual([9, true])
  })

  it('queues a value set from a listener for the following frame', () => {
    const s = store()
    s.onChange((c) => {
      if (c.name === 'confetti') s.set('count', 10)
    })
    s.set('confetti', true)
    s.beginFrame(0)
    expect(s.get('count')).toBe(3)
    s.beginFrame(16)
    expect(s.get('count')).toBe(10)
  })

  it('stays consistent when the host sets values faster than frames (60 Hz host, 30 fps engine)', () => {
    const s = store()
    const changes: ParamChange[] = []
    s.onChange((c) => changes.push(c))
    let hostValue = 3
    let frames = 0
    for (let ms = 0; ms <= 2000; ms++) {
      if (ms % 16 === 0) s.set('count', ++hostValue)
      if (ms % 33 === 0) {
        s.beginFrame(ms)
        frames++
        // Every frame sees exactly the last value set before it, never an intermediate state.
        expect(s.get('count')).toBe(hostValue)
        expect(s.numberAt(s.indexOf('count'))).toBe(hostValue)
      }
    }
    s.beginFrame(2001)
    frames++
    // At most one change per frame, and the changes chain without a gap.
    expect(changes.length).toBeLessThanOrEqual(frames)
    for (let i = 1; i < changes.length; i++) expect(changes[i]!.previous).toBe(changes[i - 1]!.value)
    expect(changes[0]!.previous).toBe(3)
    expect(changes.at(-1)!.value).toBe(hostValue)
  })

  it('isolates listener errors', () => {
    const onError = vi.fn()
    const s = new ParamStore(PARAMS, { onError })
    const after = vi.fn()
    s.onChange(() => {
      throw new Error('boom')
    })
    s.onChange(after)
    s.set('count', 4)
    s.beginFrame(0)
    expect(onError).toHaveBeenCalledOnce()
    expect(after).toHaveBeenCalledOnce()
  })

  it('removes a listener', () => {
    const s = store()
    const listener = vi.fn()
    const off = s.onChange(listener)
    off()
    s.set('count', 4)
    s.beginFrame(0)
    expect(listener).not.toHaveBeenCalled()
  })

  it('does no work and keeps the same arrays on a frame without changes', () => {
    const s = store()
    const numbers = s.numbers
    const snapshot = Array.from(numbers)
    for (let i = 0; i < 100; i++) expect(s.beginFrame(i * 16)).toBe(false)
    expect(s.numbers).toBe(numbers)
    expect(Array.from(numbers)).toEqual(snapshot)
  })
})

describe('ParamStore: transitions', () => {
  it('animates a number over its default duration; the value is the target at once', () => {
    const s = store()
    const changes: ParamChange[] = []
    s.onChange((c) => changes.push(c))
    const i = s.indexOf('size')
    s.beginFrame(0)
    s.set('size', 2)
    s.beginFrame(10) // the transition starts on this frame
    expect(s.get('size')).toBe(2)
    expect(s.valueAt(i)).toBe(2)
    expect(changes).toEqual([{ name: 'size', value: 2, previous: 1 }])
    expect(s.numberAt(i)).toBe(1)
    s.beginFrame(35)
    expect(s.numberAt(i)).toBeCloseTo(1.25)
    s.beginFrame(60)
    expect(s.numberAt(i)).toBeCloseTo(1.5)
    expect(s.beginFrame(200)).toBe(true)
    expect(s.numberAt(i)).toBe(2)
    expect(s.beginFrame(216)).toBe(false) // finished
    expect(changes).toHaveLength(1)
  })

  it('retargets from the value on screen', () => {
    const s = store()
    const i = s.indexOf('size')
    s.beginFrame(0)
    s.set('size', 2)
    s.beginFrame(0)
    s.beginFrame(50) // 1.5
    s.set('size', 0.5)
    s.beginFrame(50)
    expect(s.numberAt(i)).toBeCloseTo(1.5)
    s.beginFrame(100)
    expect(s.numberAt(i)).toBeCloseTo(1)
    s.beginFrame(150)
    expect(s.numberAt(i)).toBe(0.5)
  })

  it('lets the host override the duration, or cut a running transition', () => {
    const s = store()
    const i = s.indexOf('size')
    s.beginFrame(0)
    s.set('size', 2, { transition: 0 })
    s.beginFrame(0)
    expect(s.numberAt(i)).toBe(2)
    s.set('count', 13, { transition: 1000 })
    s.beginFrame(0)
    s.beginFrame(500)
    expect(s.numberAt(s.indexOf('count'))).toBeCloseTo(8)
    s.set('count', 0, { transition: 0 })
    s.beginFrame(600)
    expect(s.numberAt(s.indexOf('count'))).toBe(0)
    expect(s.beginFrame(1500)).toBe(false)
  })

  it('animates colors and vectors component-wise', () => {
    const s = store()
    s.beginFrame(0)
    s.setMany({ color: '#0000ff', offset: [2, -2, 4], pos: [1, 0] }, { transition: 100 })
    s.beginFrame(0)
    s.beginFrame(50)
    expect(components(s, 'color')).toEqual([0.5, 0, 0.5, 1])
    expect(components(s, 'offset')).toEqual([1, -1, 2])
    expect(components(s, 'pos')).toEqual([0.75, 0.25])
    s.beginFrame(100)
    expect(components(s, 'color')).toEqual([0, 0, 1, 1])
    expect(s.get('color')).toBe('#0000ff')
  })

  it('never animates booleans', () => {
    const s = store()
    s.beginFrame(0)
    s.set('confetti', true, { transition: 500 })
    s.beginFrame(0)
    expect(s.numberAt(s.indexOf('confetti'))).toBe(1)
  })

  it('does not run backwards when the clock goes back (seek)', () => {
    const s = store()
    const i = s.indexOf('size')
    s.beginFrame(1000)
    s.set('size', 2)
    s.beginFrame(1000)
    s.beginFrame(1050)
    s.beginFrame(10) // seek back: counts as no time
    expect(s.numberAt(i)).toBeCloseTo(1.5)
    s.beginFrame(60)
    expect(s.numberAt(i)).toBe(2)
  })
})

describe('ParamStore: presets', () => {
  it('sets the listed parameters only, at the next frame', () => {
    const s = store()
    s.set('count', 8)
    s.applyPreset('party', { transition: 0 })
    expect(s.get('size')).toBe(1)
    s.beginFrame(0)
    expect(s.values()).toMatchObject({ size: 1.5, confetti: true, style: 'flowers', count: 8 })
    expect(s.numberAt(s.indexOf('size'))).toBe(1.5)
    expect(s.presetNames).toEqual(['subtle', 'party', 'broken'])
  })

  it('uses the parameters\' transitions by default', () => {
    const s = store()
    s.beginFrame(0)
    s.applyPreset('subtle')
    s.beginFrame(0)
    s.beginFrame(50)
    expect(s.numberAt(s.indexOf('size'))).toBeCloseTo(0.85)
  })

  it('rejects an unknown preset and an invalid preset value, atomically', () => {
    const s = store()
    expect(code(() => s.applyPreset('nope'))).toBe('unknown-preset')
    expect(code(() => s.applyPreset('toString'))).toBe('unknown-preset')
    let err: unknown
    try {
      s.applyPreset('broken')
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ code: 'type', param: 'color', preset: 'broken' })
    expect((err as Error).message).toContain('preset "broken"')
    s.beginFrame(0)
    expect(s.get('size')).toBe(1)
    const bad = new ParamStore(PARAMS, { presets: { x: { nope: 1 } } })
    expect(code(() => bad.applyPreset('x'))).toBe('unknown-param')
  })
})

describe('ParamStore: options supplied by the host', () => {
  it('rejects values until the host supplies the options, except the declared default', () => {
    const s = store()
    expect(s.optionsOf('team')).toBeUndefined()
    expect(code(() => s.set('team', 'red'))).toBe('enum')
    expect(() => s.set('team', '')).not.toThrow()
  })

  it('checks values against the supplied options', () => {
    const s = store()
    s.setOptions('team', { red: 'Red team', blue: { en: 'Blue team', fr: 'Équipe bleue' } })
    expect([...s.optionsOf('team')!.keys()]).toEqual(['red', 'blue'])
    s.set('team', 'blue')
    expect(code(() => s.set('team', 'green'))).toBe('enum')
    s.beginFrame(0)
    expect(s.get('team')).toBe('blue')
    s.setOptions('team', ['green', 'yellow'])
    expect(s.get('team')).toBe('blue') // kept until the host sets another value
    expect(() => s.set('team', 'green')).not.toThrow()
    expect(code(() => s.set('team', 'blue'))).toBe('enum')
  })

  it('rejects options for other parameters and malformed options', () => {
    const s = store()
    expect(code(() => s.setOptions('style', ['a']))).toBe('not-host-options')
    expect(code(() => s.setOptions('size', ['a']))).toBe('not-host-options')
    expect(code(() => s.setOptions('team', ['a', 3 as unknown as string]))).toBe('invalid-options')
    expect(code(() => s.setOptions('team', { a: '' }))).toBe('invalid-options')
    expect(code(() => s.setOptions('team', { '': 'Empty' }))).toBe('invalid-options')
    expect(code(() => s.setOptions('team', null as unknown as string[]))).toBe('invalid-options')
    expect(s.optionsOf('team')).toBeUndefined()
  })
})

// Reload: a fake engine whose "filter instance" is what each frame renders.

const RELOAD_PARAMS: TParams = {
  model: { type: 'select', default: 'a', apply: 'reload', options: { a: 'A', b: 'B', c: 'C' } },
  size: { type: 'number', default: 1, transition: 100 },
}

interface Instance {
  model: string
  disposed: boolean
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function reloadEngine() {
  const loads: { request: ReloadRequest; d: ReturnType<typeof deferred<Instance>> }[] = []
  const discarded: Instance[] = []
  const onError = vi.fn()
  let current: Instance | undefined = { model: 'a', disposed: false }
  const hooks: ReloadHooks<Instance> = {
    preload(request) {
      const d = deferred<Instance>()
      loads.push({ request, d })
      return d.promise
    },
    swap(prepared) {
      if (current) current.disposed = true
      current = prepared
    },
    discard(prepared) {
      prepared.disposed = true
      discarded.push(prepared)
    },
  }
  const s = new ParamStore(RELOAD_PARAMS, { reload: hooks, onError })
  const rendered: (string | undefined)[] = []
  let now = 0
  const frame = () => {
    s.beginFrame((now += 16))
    // The engine renders with the current instance: it must exist and not be disposed on every frame.
    rendered.push(current && !current.disposed ? current.model : undefined)
  }
  const finish = async (k: number, model: string) => {
    loads[k]!.d.resolve({ model, disposed: false })
    await Promise.resolve()
    await Promise.resolve()
  }
  return { s, loads, discarded, onError, rendered, frame, finish, current: () => current }
}

describe('ParamStore: apply "reload"', () => {
  it('preloads in the background and swaps at a frame boundary, never showing an empty frame', async () => {
    const e = reloadEngine()
    const changes: ParamChange[] = []
    e.s.onChange((c) => changes.push(c))
    e.frame()
    e.s.set('model', 'b')
    expect(e.loads).toHaveLength(0) // batched: the request starts with the next frame
    e.frame()
    expect(e.s.reloadState).toBe('loading')
    expect(e.loads).toHaveLength(1)
    expect(e.loads[0]!.request.changed).toEqual(['model'])
    expect(e.loads[0]!.request.values).toEqual({ model: 'b', size: 1 })
    e.frame()
    e.frame()
    expect(e.s.get('model')).toBe('a') // still the old filter while loading
    expect(changes).toEqual([])
    await e.finish(0, 'b')
    expect(e.s.reloadState).toBe('ready')
    expect(e.s.get('model')).toBe('a') // swapped at the next frame, not in between
    e.frame()
    expect(e.s.reloadState).toBe('idle')
    expect(e.s.get('model')).toBe('b')
    expect(changes).toEqual([{ name: 'model', value: 'b', previous: 'a' }])
    expect(e.rendered).toEqual(['a', 'a', 'a', 'a', 'b'])
  })

  it('applies live parameters at once while a reload is loading', () => {
    const e = reloadEngine()
    e.frame()
    e.s.setMany({ model: 'b', size: 2 }, { transition: 0 })
    e.frame()
    expect(e.s.get('size')).toBe(2)
    expect(e.s.get('model')).toBe('a')
    expect(e.s.reloadState).toBe('loading')
  })

  it('supersedes a running preload: aborts it, discards its late result, loads the latest value', async () => {
    const e = reloadEngine()
    e.s.set('model', 'b')
    e.frame()
    e.s.set('model', 'c')
    e.frame()
    expect(e.loads).toHaveLength(2)
    expect(e.loads[0]!.request.signal.aborted).toBe(true)
    expect(e.loads[1]!.request.values.model).toBe('c')
    await e.finish(0, 'b') // late result of the aborted request
    expect(e.discarded.map((i) => i.model)).toEqual(['b'])
    expect(e.s.reloadState).toBe('loading')
    await e.finish(1, 'c')
    e.frame()
    expect(e.s.get('model')).toBe('c')
    expect(e.rendered).toEqual(['a', 'a', 'c'])
  })

  it('discards a prepared result superseded before its swap', async () => {
    const e = reloadEngine()
    e.s.set('model', 'b')
    e.frame()
    await e.finish(0, 'b')
    expect(e.s.reloadState).toBe('ready')
    e.s.set('model', 'c')
    e.frame() // the ready result is swapped first, then the new request starts
    expect(e.s.get('model')).toBe('b')
    expect(e.loads).toHaveLength(2)
    e.s.set('model', 'b')
    e.frame() // back to the value in use: the running preload is cancelled, nothing to load
    expect(e.loads[1]!.request.signal.aborted).toBe(true)
    expect(e.s.reloadState).toBe('idle')
    await e.finish(1, 'c')
    expect(e.discarded.map((i) => i.model)).toEqual(['c'])
    e.frame()
    expect(e.s.get('model')).toBe('b')
  })

  it('keeps the current values when the preload fails, and reports the error', async () => {
    const e = reloadEngine()
    e.s.set('model', 'b')
    e.frame()
    e.loads[0]!.d.reject(new Error('load failed'))
    await Promise.resolve()
    await Promise.resolve()
    expect(e.s.reloadState).toBe('idle')
    expect(e.onError).toHaveBeenCalledWith(new Error('load failed'))
    e.frame()
    expect(e.s.get('model')).toBe('a')
    expect(e.rendered).toEqual(['a', 'a'])
    // The same value can be requested again.
    e.s.set('model', 'b')
    e.frame()
    expect(e.loads).toHaveLength(2)
  })

  it('keeps the current values when the swap throws', async () => {
    const onError = vi.fn()
    const discard = vi.fn()
    const s = new ParamStore(RELOAD_PARAMS, {
      onError,
      reload: {
        preload: async () => 'prepared',
        swap() {
          throw new Error('swap failed')
        },
        discard,
      },
    })
    s.set('model', 'b')
    s.beginFrame(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(s.beginFrame(16)).toBe(false)
    expect(s.get('model')).toBe('a')
    expect(onError).toHaveBeenCalledOnce()
    expect(discard).toHaveBeenCalledWith('prepared')
  })

  it('reports a preload that throws synchronously', async () => {
    const onError = vi.fn()
    const s = new ParamStore(RELOAD_PARAMS, {
      onError,
      reload: {
        preload() {
          throw new Error('sync')
        },
        swap() {},
      },
    })
    s.set('model', 'b')
    s.beginFrame(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(onError).toHaveBeenCalledOnce()
    expect(s.reloadState).toBe('idle')
  })

  it('aborts and discards on dispose', async () => {
    const e = reloadEngine()
    e.s.set('model', 'b')
    e.frame()
    e.s.dispose()
    expect(e.loads[0]!.request.signal.aborted).toBe(true)
    await e.finish(0, 'b')
    expect(e.discarded.map((i) => i.model)).toEqual(['b'])
    expect(e.s.beginFrame(1000)).toBe(false)
  })

  it('applies reload parameters like live ones when the engine provides no hooks', () => {
    const s = new ParamStore(RELOAD_PARAMS)
    s.set('model', 'b')
    s.beginFrame(0)
    expect(s.get('model')).toBe('b')
    expect(s.reloadState).toBe('idle')
  })
})
