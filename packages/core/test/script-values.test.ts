import { EASINGS } from '@ouaf/spec'
import { describe, expect, it } from 'vitest'
import { compileBinding, compileNumberBinding, type BindingEnv } from '../src/bindings/index.ts'
import { easingOf } from '../src/script/easing.ts'
import { ScriptOverrides } from '../src/script/overrides.ts'

const env = (overrides?: BindingEnv['overrides']): BindingEnv => ({
  data: { resolve: () => undefined },
  params: { type: () => undefined, get: () => undefined },
  ...(overrides ? { overrides } : {}),
})

describe('easings', () => {
  it('go from 0 to 1 for every v1 name', () => {
    for (const name of EASINGS) {
      const ease = easingOf(name)!
      expect(ease(0), name).toBeCloseTo(0, 6)
      expect(ease(1), name).toBeCloseTo(1, 6)
    }
    expect(easingOf('inOutQuad')!(0.5)).toBeCloseTo(0.5)
    expect(easingOf('outBack')!(0.6)).toBeGreaterThan(1) // overshoot
    expect(easingOf('wobble')).toBeUndefined()
  })
})

describe('script overrides', () => {
  const setup = () => {
    const overrides = new ScriptOverrides()
    const ids = [7, 9]
    overrides.idOf = (slot) => (slot < 0 ? 0 : ids[slot]!)
    const layer = overrides.forLayer(0)
    const opacity = compileNumberBinding(0.5, { fallback: 1, name: 'opacity' }, env(layer))
    const offset = compileBinding([0, 0, 0], { type: 'vec3', fallback: [0, 0, 0], name: 'offset' }, env(layer))
    const color = compileBinding('#000000', { type: 'color', fallback: '#ffffff', name: 'color' }, env(layer))
    const out = new Float64Array(1)
    const num = (face: number) => (opacity.write(face, out, 0), out[0]!)
    return { overrides, ids, opacity, offset, color, num, prop: (name: string) => overrides.property(0, name)! }
  }

  it('registers the named properties of each layer; unnamed ones cannot be set', () => {
    const { overrides } = setup()
    compileNumberBinding(1, { fallback: 1 }, env(overrides.forLayer(0)))
    expect(overrides.propertiesOf(0)).toEqual(['opacity', 'offset', 'color'])
    expect(overrides.property(1, 'opacity')).toBeUndefined()
  })

  it('set replaces the manifest value per face or for every instance, until null', () => {
    const { opacity, num, prop } = setup()
    expect(opacity.perFace).toBe(true)
    expect([num(0), num(1)]).toEqual([0.5, 0.5])
    prop('opacity').set(9, 0.2) // the face in slot 1
    expect([num(0), num(1)]).toEqual([0.5, 0.2])
    prop('opacity').set(undefined, 1) // every instance: clears the per-face value
    expect([num(0), num(1), num(-1)]).toEqual([1, 1, 1])
    prop('opacity').set(7, 0)
    prop('opacity').set(7, null)
    expect(num(0)).toBe(1)
    prop('opacity').set(undefined, null)
    expect(num(0)).toBe(0.5)
  })

  it('checks value types', () => {
    const { prop } = setup()
    expect(prop('opacity').typeOf(2)).toBe('number')
    expect(prop('opacity').typeOf('2')).toBeUndefined()
    expect(prop('offset').typeOf([1, 2, 3])).toBe('vec3')
    expect(prop('offset').typeOf([1, 2])).toBeUndefined()
    expect(prop('color').typeOf('#ff0000')).toBe('color')
    expect(prop('color').typeOf('red')).toBeUndefined()
  })

  it('animates from the current value to a target, on the media-time clock, and keeps the final value', () => {
    const { overrides, num, prop } = setup()
    overrides.clock.advance(10)
    prop('opacity').animate(undefined, 1, undefined, { duration: 1000, easing: 'linear' })
    expect(num(0)).toBeCloseTo(0.5)
    overrides.clock.advance(10.5)
    expect(num(0)).toBeCloseTo(0.75)
    overrides.clock.advance(2) // the source looped: no time passes
    expect(num(0)).toBeCloseTo(0.75)
    overrides.clock.advance(2.5)
    expect(num(0)).toBe(1)
    prop('opacity').set(undefined, null)
    expect(num(0)).toBe(0.5)
  })

  it('plays keyframes, with delay and repeat', () => {
    const { overrides, num, prop } = setup()
    overrides.clock.advance(0)
    prop('opacity').animate(7, undefined, [0, 1, 0], { duration: 1000, easing: 'linear', delay: 500, repeat: 1 })
    const at = (t: number) => (overrides.clock.advance(t), num(0))
    expect(at(0.25)).toBe(0) // delayed: the first keyframe
    expect(at(1)).toBeCloseTo(1) // 0.5 s into the run: the middle keyframe
    expect(at(1.25)).toBeCloseTo(0.5)
    expect(at(2)).toBeCloseTo(1) // second run, halfway
    expect(at(2.75)).toBe(0) // done: the last keyframe stays
    expect(num(1)).toBe(0.5) // other faces untouched
  })

  it('interpolates vectors and colors; endless repeat', () => {
    const { overrides, offset, color, prop } = setup()
    overrides.clock.advance(0)
    prop('offset').animate(undefined, [1, 2, 3], undefined, { duration: 1000, easing: 'linear', repeat: -1 })
    prop('color').animate(undefined, '#ff8000', undefined, { duration: 1000, easing: 'linear' })
    overrides.clock.advance(0.5)
    expect(offset.evaluate(0)).toEqual([0.5, 1, 1.5])
    expect(color.evaluate(0)).toBe('#804000ff')
    overrides.clock.advance(0.75)
    overrides.clock.advance(1.25) // 1.25 s: second run of the endless offset animation
    expect(offset.evaluate(0)).toEqual([0.25, 0.5, 0.75])
  })

  it('forgets the values of a face that left', () => {
    const { overrides, num, prop } = setup()
    prop('opacity').set(7, 0)
    overrides.dropFace(7)
    expect(num(0)).toBe(0.5)
  })
})
