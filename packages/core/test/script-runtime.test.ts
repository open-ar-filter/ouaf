import { describe, expect, it } from 'vitest'
import { workerSource } from '../src/script/runtime.ts'
import { ask, frame, init, runtime } from './script-helpers.ts'

describe('script runtime', () => {
  it('is self-contained, so it can become the Worker source', () => {
    const src = workerSource()
    expect(src).toMatch(/^\(function scriptRuntime\(/)
    expect(src).toMatch(/\)\(self, \{ load: async \(code\) => \{/)
    expect(src).toContain('await import(url)')
    // It must not reference module-level helpers: evaluating it alone defines a working function.
    expect(typeof new Function(`return ${src.slice(1, src.lastIndexOf(')(self'))}`)()).toBe('function')
  })

  it('runs setup with a copy of the initial state, and answers with its commands and messages', async () => {
    const done = await ask(runtime(), init(`export default {
      state: { n: 1 },
      setup(f) { f.state.n++; f.layer('label').set({ text: 'hi ' + f.state.n + ' ' + f.params.size }); f.emit('ready', { n: f.state.n }) },
    }`))
    expect(done.t).toBe('done')
    expect(done.seq).toBe(0)
    expect(done.commands).toEqual([['set', 0, null, { text: 'hi 2 1' }]])
    expect(done.emits).toEqual([['ready', { n: 2 }]])
  })

  it('delivers timers, then events in order, then update, each frame', async () => {
    const conn = runtime()
    const code = `export default {
      setup(f) { f.after(50, () => f.emit('log', 'after')); f.every(40, () => f.emit('log', 'every')) },
      on: {
        smile(f, { face }) { f.emit('log', 'smile ' + face.id + ' ' + face.index); face.state.smiles = (face.state.smiles || 0) + 1 },
        faceLeave(f, { face }) { f.emit('log', 'leave ' + face.id + ' ' + face.state.smiles) },
        'message:hello'(f, { data }) { f.emit('log', 'hello ' + data) },
        paramChange(f, c) { f.emit('log', c.name + '=' + f.params.size) },
      },
      update(f, frame) { f.emit('log', 'update ' + frame.faces.length) },
    }`
    await ask(conn, init(code))
    const face = { id: 3, index: 0, pose: { yaw: 1, pitch: 2, roll: 3 }, size: 0.2 }
    let done = await ask(conn, frame(1, { faces: [face], events: [{ name: 'smile', face: 3 }, { name: 'message:hello', payload: { data: 'you' } }] }))
    // Clock 33 ms: no timer is due yet.
    expect(done.emits.map((e) => e[1])).toEqual(['smile 3 0', 'hello you', 'update 1'])
    done = await ask(conn, frame(2, { params: { size: 2 }, events: [{ name: 'paramChange', payload: { name: 'size', value: 2, previous: 1 } }, { name: 'faceLeave', face: 3 }] }))
    expect(done.emits.map((e) => e[1])).toEqual(['after', 'every', 'size=2', 'leave 3 1', 'update 0'])
    // The per-face state is reset when the face leaves.
    done = await ask(conn, frame(3, { faces: [face], events: [{ name: 'smile', face: 3 }] }))
    expect(done.emits.map((e) => e[1])).toEqual(['every', 'smile 3 0', 'update 1'])
  })

  it('seeds f.random: the same seed gives the same sequence', async () => {
    const code = `export default { setup(f) { f.emit('r', [f.random(), f.random(), f.random()]) } }`
    const a = await ask(runtime(), init(code))
    const b = await ask(runtime(), init(code))
    const c = await ask(runtime(), init(code, { seed: 43 }))
    expect(a.emits[0]).toEqual(b.emits[0])
    expect(a.emits[0]).not.toEqual(c.emits[0])
    for (const x of a.emits[0]![1] as number[]) expect(x >= 0 && x < 1).toBe(true)
  })

  it('restarts f.random from the seed a frame carries (a new source run)', async () => {
    const conn = runtime()
    const code = `export default { setup(f) { f.emit('r', [f.random(), f.random()]) }, update(f) { f.emit('r', [f.random(), f.random()]) } }`
    const first = await ask(conn, init(code))
    const reseeded = await ask(conn, frame(1, { seed: 42 }))
    const next = await ask(conn, frame(2))
    expect(reseeded.emits[0]).toEqual(first.emits[0]) // same seed, same draws
    expect(next.emits[0]).not.toEqual(first.emits[0])
  })

  it('reports exceptions as warnings and keeps running; unknown layer ids throw in the script', async () => {
    const conn = runtime()
    const first = await ask(conn, init(`export default {
      setup(f) { f.layer('nope').set({ opacity: 0 }) },
      update(f, frame) { f.layer('dot', frame.faces[0]).animate({ opacity: 0 }, { duration: 100 }) },
    }`))
    expect(first.warnings[0]).toMatch(/setup threw Error: f.layer\("nope"\): no layer has this id/)
    const done = await ask(conn, frame(1, { faces: [{ id: 5, index: 0 }] }))
    expect(done.commands).toEqual([['animate', 2, 5, { opacity: 0 }, { duration: 100 }]])
    expect(done.warnings).toEqual([])
  })

  it('reports a script.js without a default export', async () => {
    const answer = await ask(runtime(), init(`export default 3`))
    expect(answer).toMatchObject({ t: 'fatal' })
  })
})
