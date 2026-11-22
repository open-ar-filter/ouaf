import { describe, expect, it } from 'vitest'
import { PerspectiveCamera } from 'three'
import { compileBinding, compileNumberBinding } from '../src/bindings/index.ts'
import { FaceBindingData } from '../src/bindings/face-data.ts'
import { OuafError } from '../src/engine/errors.ts'
import { createFaceFrame } from '../src/face.ts'
import { FrameDataBuilder, type FrameDataSource } from '../src/script/frame-data.ts'
import { ScriptHost, estimateSize, type ScriptHostOptions } from '../src/script/host.ts'
import { ScriptOverrides } from '../src/script/overrides.ts'
import { env, runtime, tick } from './script-helpers.ts'

/** Waits until the host has the script's answer to its last message (or 2 s at most). */
async function idle(host: ScriptHost): Promise<void> {
  for (let i = 0; i < 200 && host.waiting; i++) await tick()
  if (host.waiting) throw new Error('the script did not answer')
}

function hostSetup(code: string, options: Partial<ScriptHostOptions> = {}) {
  const overrides = new ScriptOverrides()
  overrides.idOf = (slot) => (slot < 0 ? 0 : 3)
  const opacity = compileNumberBinding(1, { fallback: 1, name: 'opacity' }, env(overrides.forLayer(0)))
  compileBinding('', { type: 'string', fallback: '', name: 'text' }, env(overrides.forLayer(0)))
  const warnings: string[] = []
  const errors: OuafError[] = []
  const emits: Array<[string, unknown]> = []
  let conn: ReturnType<typeof runtime> | undefined
  const host = new ScriptHost({
    filterId: 'test',
    code,
    layers: ['label'],
    on: ['message:go'],
    uses: ['face.pose'],
    overrides,
    frameData: new FrameDataBuilder(['face.pose'], []),
    seed: 1,
    connect: async () => (conn = runtime()),
    warn: (m) => void warnings.push(m),
    error: (e) => void errors.push(e),
    emit: (name, data) => void emits.push([name, data]),
    ...options,
  })
  const faces = createFaceFrame(1)
  const source: FrameDataSource = {
    faces,
    anchors: { face: () => false, screen: () => {}, id: () => 0 },
    bindingData: new FaceBindingData(faces),
    camera: new PerspectiveCamera(),
    videoToClip: { ax: 2, bx: -1, ay: -2, by: 1 },
  }
  const out = new Float64Array(1)
  return { host, overrides, opacity: () => (opacity.write(0, out, 0), out[0]!), warnings, errors, emits, source, conn: () => conn! }
}

describe('script host', () => {
  it('applies the answers at the start of the next frame, with one frame in flight', async () => {
    const s = hostSetup(`export default {
      on: { 'message:go'(f, { data }) { f.layer('label').set({ opacity: data }); f.emit('went', data) } },
    }`)
    await s.host.start({}, 0)
    await idle(s.host)
    s.host.beginFrame()
    s.host.queue({ name: 'message:go', payload: { data: 0.25 } })
    s.host.queue({ name: 'smile', face: 1 }) // not in script.on: not sent
    s.host.endFrame(0, s.source)
    s.host.endFrame(0.033, s.source) // still in flight: not sent
    await idle(s.host)
    expect(s.opacity()).toBe(1) // not applied before the next frame starts
    s.host.beginFrame()
    expect(s.opacity()).toBe(0.25)
    expect(s.emits).toEqual([['went', 0.25]])
    expect(s.warnings).toEqual([])
  })

  it('warns about properties the script cannot set and wrong values', async () => {
    const s = hostSetup(`export default {
      setup(f) { f.layer('label').set({ anchor: 'chin', opacity: 'x' }); f.layer('label').animate({ text: 'a' }, { duration: 10 }) },
    }`)
    await s.host.start({}, 0)
    await idle(s.host)
    s.host.beginFrame()
    expect(s.warnings.join('\n')).toMatch(/no property "anchor" a script can set \(settable: opacity, text\)/)
    expect(s.warnings.join('\n')).toMatch(/"x" is not a valid "opacity"/)
    expect(s.warnings.join('\n')).toMatch(/only numbers, colors and vectors can be animated/)
  })

  it('stops a script that does not answer within 1 s; the layers keep their values', async () => {
    let fire: (() => void) | undefined
    const s = hostSetup(`export default { setup(f) { f.layer('label').set({ opacity: 0.5 }) } }`, {
      setTimeout: (fn) => ((fire = fn), 1),
      clearTimeout: () => (fire = undefined),
    })
    await s.host.start({}, 0)
    await idle(s.host)
    s.host.beginFrame()
    expect(s.opacity()).toBe(0.5)
    // The next frame never gets an answer: the port is closed on the runtime side.
    s.conn().port.onmessage = null
    const original = s.conn().port
    s.host.endFrame(0, s.source)
    ;(original as unknown as MessagePort).close()
    expect(fire).toBeDefined()
    fire!()
    expect(s.errors).toHaveLength(1)
    expect(s.errors[0]!.code).toBe('SCRIPT_STOPPED')
    expect(s.conn().terminated).toBe(true)
    expect(s.host.state).toBe('stopped')
    expect(s.opacity()).toBe(0.5) // what the script set stays
    s.host.endFrame(0.033, s.source) // nothing is sent any more
  })

  it('sends a new seed with the next frame only, unfolds uniforms and routes play() to the layer', async () => {
    const played: Array<[number, number | undefined, string]> = []
    const s = hostSetup(`export default { setup(f) { f.layer('label').set({ uniforms: { amount: 0.5 } }); f.layer('label').play('wave') } }`, {
      play: (layer, face, name) => (played.push([layer, face, name]), name === 'wave' ? 'played' : 'unknown'),
    })
    compileNumberBinding(0, { fallback: 0, name: 'uniforms.amount' }, env(s.overrides.forLayer(0)))
    const sent: Array<Record<string, unknown>> = []
    await s.host.start({}, 0)
    await idle(s.host)
    s.host.beginFrame()
    expect(played).toEqual([[0, undefined, 'wave']])
    expect(s.overrides.property(0, 'uniforms.amount')!.entryFor(3)).toEqual({ kind: 'set', value: 0.5 })
    const port = s.conn().port
    const post = port.postMessage.bind(port)
    port.postMessage = (m: unknown, t?: Transferable[]) => (sent.push(m as Record<string, unknown>), post(m, t))
    s.host.reseed(7)
    s.host.endFrame(0, s.source)
    await idle(s.host)
    s.host.beginFrame()
    s.host.endFrame(0.033, s.source)
    expect(sent.map((m) => m.seed)).toEqual([7, undefined])
    expect(s.warnings).toEqual([])
  })

  it('drops messages over 64 KB or beyond 60 per second', async () => {
    const s = hostSetup(`export default { setup(f) { f.emit('big', 'x'.repeat(40000)); for (let i = 0; i < 70; i++) f.emit('n', i) } }`, { now: () => 0 })
    await s.host.start({}, 0)
    await idle(s.host)
    s.host.beginFrame()
    expect(s.emits.filter(([n]) => n === 'big')).toEqual([])
    expect(s.emits.filter(([n]) => n === 'n')).toHaveLength(59) // 60 in the second, the big one included
    expect(s.warnings.join('\n')).toMatch(/larger than 64 KB/)
    expect(s.warnings.join('\n')).toMatch(/more than 60 messages per second/)
  })

  it('reports a sandbox that does not start', async () => {
    const s = hostSetup('', { connect: () => Promise.reject(new OuafError('script', 'no sandbox')) })
    await s.host.start({}, 0)
    expect(s.errors[0]?.code).toBe('script')
    expect(s.host.state).toBe('stopped')
  })

  it('estimates message sizes', () => {
    expect(estimateSize('abc', 1e6)).toBe(6)
    // Keys count too, array indices included.
    expect(estimateSize({ a: [1, 2], b: new Float32Array(10) }, 1e6)).toBe(2 + 2 + (2 + 8) * 2 + 40)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(estimateSize(cyclic, 1e6)).toBe(8)
  })
})
