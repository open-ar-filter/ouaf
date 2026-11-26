import { describe, expect, it } from 'vitest'
import { PerspectiveCamera } from 'three'
import { compileBinding, compileNumberBinding } from '../src/bindings/index.ts'
import { FaceBindingData } from '../src/bindings/face-data.ts'
import { OuafError } from '../src/engine/errors.ts'
import { createFaceFrame } from '../src/face.ts'
import { FrameDataBuilder, type FrameDataSource } from '../src/script/frame-data.ts'
import { MAX_ANSWER_WARNINGS, MAX_QUEUED_EVENTS, MAX_SCRIPT_WARNINGS, MAX_WARNING_LENGTH, STARTUP_MS, ScriptHost, estimateSize, type ScriptConnection, type ScriptHostOptions, type ScriptPort } from '../src/script/host.ts'
import { ScriptOverrides } from '../src/script/overrides.ts'
import { ShaderUniforms } from '../src/layers/shader/uniforms.ts'
import { bytesPerCall } from './allocation.ts'
import { env, fakeImage, runtime, tick } from './script-helpers.ts'

/** Waits until the host has the script's answer to its last message (or 2 s at most). */
async function idle(host: ScriptHost): Promise<void> {
  for (let i = 0; i < 200 && host.waiting; i++) await tick()
  if (host.waiting) throw new Error('the script did not answer')
}

/** Counts the messages the host sends on `conn` from now on. */
function countSends(conn: { port: ScriptPort }): { n: number } {
  const count = { n: 0 }
  const post = conn.port.postMessage.bind(conn.port)
  conn.port.postMessage = (m, t) => (count.n++, post(m, t))
  return count
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
    aspect: 0.75,
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

  it('sends a script without update a frame only for an event, a due timer or a due canvas draw (#129)', async () => {
    const s = hostSetup(`export default {
      on: { 'message:go'(f, { data }) { f.after(data, () => f.emit('timer', f.params.size)) } },
    }`)
    await s.host.start({ size: 1 }, 0)
    await idle(s.host)
    s.host.beginFrame()
    const sends = countSends(s.conn())
    const sent = () => sends.n
    let k = 0
    const step = async () => {
      const time = ++k / 30
      s.overrides.clock.advance(time)
      s.host.beginFrame()
      s.host.endFrame(time, s.source)
      await idle(s.host)
    }
    for (let i = 0; i < 10; i++) await step()
    expect(sent()).toBe(0)
    s.host.queue({ name: 'message:go', payload: { data: 200 } })
    s.host.paramsChanged({ size: 2 }) // not handled: goes with the next frame sent
    await step()
    expect(sent()).toBe(1)
    // The timer is due 200 ms of script clock later, at the 6th frame (the clock started at frame 1).
    for (let i = 0; i < 5; i++) await step()
    expect([sent(), s.emits]).toEqual([1, []])
    await step()
    s.host.beginFrame()
    expect([sent(), s.emits]).toEqual([2, [['timer', 2]]])
    for (let i = 0; i < 10; i++) await step()
    expect(sent()).toBe(2)

    // What it does after an `await` comes back with the next frame, which it asks for.
    const a = hostSetup(`export default { on: { async 'message:go'(f) { await new Promise((r) => setTimeout(r, 30)); f.emit('late', 1) } } }`)
    await a.host.start({}, 0)
    await idle(a.host)
    const asked = countSends(a.conn())
    a.host.queue({ name: 'message:go', payload: {} })
    a.host.endFrame(0, a.source)
    await idle(a.host)
    a.host.endFrame(0.1, a.source)
    expect(asked.n).toBe(1)
    for (let i = 0; i < 20 && a.emits.length === 0; i++) {
      await tick()
      a.host.beginFrame()
      a.host.endFrame(0.2 + i / 30, a.source)
    }
    expect([asked.n, a.emits]).toEqual([2, [['late', 1]]])

    // A canvas drawn at most twice a second: a frame for its first draw, then every 0.5 s of media time.
    const drawn: number[] = []
    const c = hostSetup(`export default { draw: { label(ctx) {} } }`, {
      canvases: [{ layer: 0, width: 4, height: 4, fps: 2 }],
      images: async () => ({}),
      drawn: (layer) => void drawn.push(layer),
    })
    await c.host.start({}, 0)
    await idle(c.host)
    const frames = countSends(c.conn())
    for (let i = 0; i <= 30; i++) {
      c.host.beginFrame()
      c.host.endFrame(i / 30, c.source)
      await idle(c.host)
    }
    c.host.beginFrame()
    expect([frames.n, drawn]).toEqual([3, [0, 0, 0]])
  })

  it('bounds the queue of a script that gets no frames: the last message of each name, the last change of each parameter', async () => {
    const s = hostSetup(
      `const log = []
      export default {
        on: {
          'message:go'(f, { data }) { log.push(['go', data]) },
          'message:stop'(f, { data }) { log.push(['stop', data]) },
          paramChange(f, c) { log.push(['param', c]) },
        },
        update(f) { if (log.length > 0) f.emit('log', log.splice(0)) },
      }`,
      { on: ['message:go', 'message:stop', 'paramChange'] },
    )
    await s.host.start({}, 0)
    await idle(s.host)
    s.host.beginFrame()
    // The filter is disabled: the host keeps sending, no frame goes to the script.
    s.host.queue({ name: 'message:stop', payload: { data: 'once' } })
    s.host.queue({ name: 'paramChange', payload: { name: 'size', value: 2, previous: 1 } })
    s.host.queue({ name: 'paramChange', payload: { name: 'tint', value: 'red', previous: 'blue' } })
    for (let i = 0; i < 1000; i++) s.host.queue({ name: 'message:go', payload: { data: i } })
    for (let v = 3; v < 600; v++) s.host.queue({ name: 'paramChange', payload: { name: 'size', value: v, previous: v - 1 } })
    expect(s.warnings).toHaveLength(1)
    expect(s.warnings[0]).toMatch(`more than ${MAX_QUEUED_EVENTS} events wait for the script`)
    s.host.endFrame(0, s.source)
    await idle(s.host)
    s.host.beginFrame()
    // Each time the queue is full, the superseded events go: what is left is bounded, in order, ends with the last.
    expect(s.emits).toHaveLength(1)
    const log = s.emits[0]![1] as Array<[string, unknown]>
    expect(log.length).toBeLessThanOrEqual(MAX_QUEUED_EVENTS)
    const go = log.filter(([n]) => n === 'go').map(([, d]) => d as number)
    expect(go.at(-1)).toBe(999)
    expect(go).toEqual([...go].sort((a, b) => a - b))
    expect(log.filter(([n]) => n === 'stop')).toEqual([['stop', 'once']])
    const params = log.filter(([n]) => n === 'param').map(([, c]) => c as { name: string; value: unknown; previous: unknown })
    expect(params[0]).toEqual({ name: 'tint', value: 'red', previous: 'blue' })
    const size = params.filter((c) => c.name === 'size')
    expect(size[0]!.previous).toBe(1) // the value before every change the script missed
    expect(size.at(-1)!.value).toBe(599)
    for (let k = 1; k < size.length; k++) expect(size[k]!.previous).toBe(size[k - 1]!.value)
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

  it('sets content properties to the names they accept, ignores others with a warning, and restores them with null (#140)', async () => {
    const s = hostSetup(`export default {
      on: { 'message:go'(f, { data }) { f.layer('label').set({ src: data }) } },
      setup(f) { f.layer('label').set({ src: 'nope' }); f.layer('label').animate({ src: 'hat' }, { duration: 10 }) },
    }`)
    const src = s.overrides.forLayer(0).content!('src', (name) => (name === 'hat' ? undefined : `no asset named "${name}"`))
    await s.host.start({}, 0)
    await idle(s.host)
    s.host.beginFrame()
    expect(s.warnings).toEqual([
      'Filter "test": .set({ src: "nope" }) on layer "label": no asset named "nope"; ignored.',
      'Filter "test": .animate() on "src" of layer "label": only numbers, colors and vectors can be animated.',
    ])
    expect(src.get(0)).toBeUndefined()
    for (const value of ['hat', null]) {
      s.host.queue({ name: 'message:go', payload: { data: value } })
      s.host.endFrame(0, s.source)
      await idle(s.host)
      s.host.beginFrame()
      expect(src.get(0)).toBe(value ?? undefined)
    }
  })

  it('stops a script that does not answer within 1 s; the layers keep their values', async () => {
    let fire: (() => void) | undefined
    const s = hostSetup(`export default { setup(f) { f.layer('label').set({ opacity: 0.5 }) }, update() {} }`, {
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
    // One timer serves every message (#129): the one armed for setup fires, then waits for what is left of the frame's.
    fire!()
    expect(s.errors).toEqual([])
    fire!()
    expect(s.errors).toHaveLength(1)
    expect(s.errors[0]!.code).toBe('SCRIPT_STOPPED')
    expect(s.conn().terminated).toBe(true)
    expect(s.host.state).toBe('stopped')
    expect(s.opacity()).toBe(0.5) // what the script set stays
    s.host.endFrame(0.033, s.source) // nothing is sent any more
  })

  it('gives the script another period when the watchdog fires late (this thread was busy), not when it fires on time', async () => {
    let fire: (() => void) | undefined
    let clock = 0
    const s = hostSetup(`export default { setup(f) {}, update() {} }`, {
      now: () => clock,
      setTimeout: (fn) => ((fire = fn), 1),
      clearTimeout: () => (fire = undefined),
    })
    await s.host.start({}, 0)
    await idle(s.host)
    s.host.beginFrame()
    s.conn().port.onmessage = null // the frame never gets an answer
    s.host.endFrame(0, s.source)
    // A long task on this thread: the timer fires 2 s after it was armed.
    clock += 2000
    fire!()
    expect(s.errors).toEqual([])
    expect(s.host.state).toBe('running')
    // Re-armed; this time it fires on time: the script is stopped.
    clock += 1000
    fire!()
    expect(s.errors.map((e) => e.code)).toEqual(['SCRIPT_STOPPED'])
    expect(s.host.state).toBe('stopped')
  })

  it('at activation, counts the 1 s from when the runtime starts the script, after its own preparation', async () => {
    const timers: Array<[number, () => void]> = []
    let clock = 0
    const port: ScriptPort = { postMessage: () => {}, onmessage: null }
    const s = hostSetup('', {
      connect: async () => ({ port, terminate: () => {} }),
      now: () => clock,
      setTimeout: (fn, ms) => (timers.push([ms, fn]), timers.length),
      clearTimeout: () => {},
    })
    await s.host.start({}, 0)
    // Canvases and fonts are being prepared: only the startup bound applies.
    expect(timers.map(([ms]) => ms)).toEqual([STARTUP_MS])
    clock += 3000
    port.onmessage!({ data: { t: 'started' } })
    expect(timers.map(([ms]) => ms)).toEqual([STARTUP_MS, 1000])
    // Once only: a second (forged) `started` does not re-arm it.
    port.onmessage!({ data: { t: 'started' } })
    expect(timers).toHaveLength(2)
    // script.js or setup loops: stopped when the 1 s timer fires on time.
    clock += 1000
    timers[1]![1]()
    expect(s.errors.map((e) => e.message)).toEqual([expect.stringMatching(/did not answer setup within 1000 ms/)])
  })

  it('stops a sandbox that never gets ready, after the startup bound', async () => {
    const timers: Array<[number, () => void]> = []
    const port: ScriptPort = { postMessage: () => {}, onmessage: null }
    const s = hostSetup('', { connect: async () => ({ port, terminate: () => {} }), now: () => 0, setTimeout: (fn, ms) => (timers.push([ms, fn]), 1), clearTimeout: () => {} })
    await s.host.start({}, 0)
    timers[0]![1]()
    expect(s.errors.map((e) => [e.code, e.message])).toEqual([['SCRIPT_STOPPED', expect.stringMatching(/its sandbox was not ready within 10 s/)]])
  })

  it('sends a new seed with the next frame only, unfolds uniforms and routes play() to the layer', async () => {
    const played: Array<[number, number | undefined, string]> = []
    const s = hostSetup(`export default { setup(f) { f.layer('label').set({ uniforms: { amount: 0.5 } }); f.layer('label').play('wave') }, update() {} }`, {
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
    port.postMessage = (m: unknown, t?: Transferable[]) => (sent.push(structuredClone(m) as Record<string, unknown>), post(m, t))
    s.host.reseed(7)
    s.host.endFrame(0, s.source)
    await idle(s.host)
    s.host.beginFrame()
    s.host.endFrame(0.033, s.source)
    expect(sent.map((m) => m.seed)).toEqual([7, undefined])
    expect(s.warnings).toEqual([])
  })

  it('sets, animates and restores shader uniforms one by one (spec §12.4)', async () => {
    const s = hostSetup(`export default { on: { 'message:go'(f, { data }) {
      if (data === 'set') f.layer('label').set({ uniforms: { amount: 2, tint: '#00ff00' } })
      if (data === 'reset') f.layer('label').set({ uniforms: { amount: null } })
      if (data === 'animate') f.layer('label').animate({ uniforms: { amount: 4, offset: [1, 1] } }, { duration: 1000, easing: 'linear' })
      if (data === 'bad') f.layer('label').set({ uniforms: { nope: 1, flag: 1 } })
    } } }`)
    const u = new ShaderUniforms({ amount: 0.5, tint: '#ff0000', offset: [0, 0], flag: true }, env(s.overrides.forLayer(0)))
    const values = () => {
      u.update(0)
      const rgb = [...(u.uniforms.tint!.value as Float32Array)].slice(0, 3)
      return { amount: u.uniforms.amount!.value, tint: rgb, offset: [...(u.uniforms.offset!.value as Float32Array)] }
    }
    await s.host.start({}, 0)
    await idle(s.host)
    const step = async (data: string, time: number) => {
      s.host.beginFrame()
      s.host.queue({ name: 'message:go', payload: { data } })
      s.overrides.clock.advance(time)
      s.host.endFrame(time, s.source)
      await idle(s.host)
      s.host.beginFrame()
    }
    await step('set', 0)
    expect(values()).toEqual({ amount: 2, tint: [0, 1, 0], offset: [0, 0] })
    // null restores that uniform only.
    await step('reset', 0.1)
    expect(values()).toEqual({ amount: 0.5, tint: [0, 1, 0], offset: [0, 0] })
    // Numbers and vectors animate (colors too), from the current value: halfway, 0.5 → 4 and [0, 0] → [1, 1].
    await step('animate', 0.2)
    s.overrides.clock.advance(0.7)
    expect(values()).toEqual({ amount: 2.25, tint: [0, 1, 0], offset: [0.5, 0.5] })
    await step('bad', 0.8)
    expect(s.warnings.join('\n')).toMatch(/no property "uniforms.nope" a script can set \(settable: opacity, text, uniforms.amount, uniforms.tint, uniforms.offset, uniforms.flag\)/)
    expect(s.warnings.join('\n')).toMatch(/1 is not a valid "uniforms.flag"/)
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

  it('sends the canvases and image assets with init, and hands each drawn image to its layer at the next frame', async () => {
    const drawn: Array<[number, number[]]> = []
    const star = new Uint16Array([7]).buffer as unknown as ImageBitmap // transferable in Node, like an ImageBitmap
    const s = hostSetup(`export default { draw: { label(ctx, f) { ctx.fillRect(0, 0, 1, 1); f.emit('star', f.asset('star').byteLength) } } }`, {
      canvases: [{ layer: 0, width: 16, height: 8, fps: 0 }],
      images: async () => ({ star }),
      drawn: (layer, image) => void drawn.push([layer, fakeImage(image)]),
    })
    await s.host.start({}, 0)
    expect((star as unknown as ArrayBuffer).byteLength).toBe(0) // transferred to the sandbox, not copied
    await idle(s.host)
    s.host.beginFrame()
    s.host.endFrame(0, s.source)
    await idle(s.host)
    expect(drawn).toEqual([]) // applied with the answer, at the start of the next frame
    s.host.beginFrame()
    expect(drawn).toEqual([[0, [1, 16, 8]]])
    expect(s.emits).toEqual([['star', 2]])
    expect(s.warnings).toEqual([])
  })

  it('gives frame.aspect, the displayed width / height, to update and draw (spec §12.4)', async () => {
    const s = hostSetup(`export default { update(f, frame) { f.emit('update', frame.aspect) }, draw: { label(ctx, f, frame) { f.emit('draw', frame.aspect) } } }`, {
      canvases: [{ layer: 0, width: 16, height: 8, fps: 0 }],
      drawn: () => {},
    })
    await s.host.start({}, 0)
    await idle(s.host)
    s.host.beginFrame()
    s.host.endFrame(0, s.source)
    await idle(s.host)
    s.host.beginFrame()
    expect(s.emits).toEqual([['update', 0.75], ['draw', 0.75]])
  })

  it('sends the font assets with init when the script draws canvases (spec §12.6)', async () => {
    const fonts = () => [{ name: 'title', data: new ArrayBuffer(8), weight: '700', style: 'normal' }]
    // The Node runtime has no FontFace: its warning shows that the fonts arrived.
    const drawing = hostSetup(`export default { draw: { label() {} } }`, { canvases: [{ layer: 0, width: 16, height: 8, fps: 0 }], fonts })
    await drawing.host.start({}, 0)
    await idle(drawing.host)
    drawing.host.beginFrame()
    expect(drawing.warnings.join('\n')).toMatch(/no FontFace in workers.*\("title"\)/)
    const plain = hostSetup(`export default { setup() {} }`, { fonts })
    await plain.host.start({}, 0)
    await idle(plain.host)
    plain.host.beginFrame()
    expect(plain.warnings).toEqual([])
  })

  it('settles once setup and the last frame sent are answered, for the file regime (spec §12.1)', async () => {
    const s = hostSetup(`export default { setup(f) { f.layer('label').set({ opacity: 0.5 }) }, update(f, frame) { f.layer('label').set({ opacity: frame.time }) } }`)
    expect(s.host.settled()).toBeUndefined() // not started: nothing to wait for
    const start = s.host.start({}, 0)
    const setup = s.host.settled()
    expect(setup).toBeInstanceOf(Promise) // the sandbox is starting
    await start
    await setup
    expect(s.host.waiting).toBe(false)
    expect(s.host.settled()).toBeUndefined()
    s.host.beginFrame()
    expect(s.opacity()).toBe(0.5)
    s.host.endFrame(0.25, s.source)
    const frame = s.host.settled()
    expect(frame).toBeInstanceOf(Promise)
    await frame
    s.host.beginFrame()
    expect(s.opacity()).toBe(0.25) // the answer to the frame, applied at the next one
  })

  it('settles when the script is stopped or disposed, or its sandbox does not start', async () => {
    let fire: (() => void) | undefined
    const s = hostSetup(`export default { setup(f) {}, update() {} }`, { now: () => 0, setTimeout: (fn) => ((fire = fn), 1), clearTimeout: () => (fire = undefined) })
    await s.host.start({}, 0)
    await s.host.settled()
    s.conn().port.onmessage = null // the frame never gets an answer
    s.host.endFrame(0, s.source)
    const stopped = s.host.settled()
    fire!() // the watchdog, armed for setup: it waits for the frame's period
    fire!()
    await stopped
    expect(s.host.state).toBe('stopped')
    expect(s.host.settled()).toBeUndefined()

    const d = hostSetup(`export default { setup(f) {} }`)
    const start = d.host.start({}, 0)
    const disposed = d.host.settled()
    d.host.dispose()
    await disposed
    await start

    const failed = hostSetup('', { connect: () => Promise.reject(new OuafError('script', 'no sandbox')) })
    const failing = failed.host.start({}, 0)
    const settled = failed.host.settled()
    await failing
    await settled
    expect(failed.host.state).toBe('stopped')
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

describe('script host: canvas images', () => {
  it('hands over only pixel arrays, for layers that exist; the rest of a forged answer is ignored', async () => {
    const drawn: Array<[number, unknown]> = []
    const port: ScriptPort = { postMessage: () => {}, onmessage: null }
    const s = hostSetup('', { connect: async () => ({ port, terminate: () => {} }), drawn: (layer, image) => void drawn.push([layer, image]) })
    await s.host.start({}, 0)
    const image = new Uint8ClampedArray(4)
    // A script shares its Worker with the runtime, so it can rewrite its answers: the host checks what they hold.
    const forged = [[0, null], 'x', [5, image], ['0', image], [0, {}], [0, new Uint8Array(4)], [0, image]]
    port.onmessage!({ data: { t: 'done', seq: 0, commands: [], emits: [], warnings: [], images: forged } })
    s.host.beginFrame()
    expect(drawn).toEqual([[0, image]])
    s.host.endFrame(0, s.source)
    port.onmessage!({ data: { t: 'done', seq: 1, commands: [], emits: [], warnings: [], images: 'nope' } })
    s.host.beginFrame()
    expect(drawn).toHaveLength(1)
    expect(s.errors).toEqual([])
  })
})

describe('script host: forged answers (#27)', () => {
  /** A host on a fake port that the test answers itself, as a script that took the runtime's port would. */
  async function forged() {
    const port: ScriptPort = { postMessage: () => {}, onmessage: null }
    const s = hostSetup('', { connect: async () => ({ port, terminate: () => {} }) })
    await s.host.start({}, 0)
    let seq = 0
    const answer = (fields: Record<string, unknown>) => {
      port.onmessage!({ data: Object.defineProperties({ t: 'done', seq }, Object.getOwnPropertyDescriptors(fields)) })
      s.host.beginFrame()
      s.host.endFrame(seq / 30, s.source)
      seq++
    }
    return { ...s, answer }
  }

  it('ignores malformed commands and emits, without throwing', async () => {
    const s = await forged()
    s.answer({
      commands: ['x', null, 42, {}, ['set'], ['set', 0, null, null], ['set', 0, null, 'opacity'], ['set', 0, null, [1]], ['set', 0, 'face', { opacity: 0.5 }],
        ['animate', 0, null, { opacity: 0 }, null], ['animate', 0, null, { opacity: 0 }], ['play', 0, null, {}], ['eval', 0]],
      emits: ['x', null, [{}, 1], ['__proto__', 1], ['bad name', 1], ['ok', 1]],
      warnings: 'nope',
    })
    expect(s.errors).toEqual([])
    // The one valid command (a face that is not a number counts as every face) and the one valid emit went through.
    expect(s.opacity()).toBe(0.5)
    expect(s.emits).toEqual([['ok', 1]])
    expect(s.host.state).toBe('running')
  })

  it('bounds the warnings: per answer, in length, each text once, and in all', async () => {
    const s = await forged()
    const long = 'x'.repeat(10 * MAX_WARNING_LENGTH)
    // The first 20 entries only: a text twice and a number count among them.
    s.answer({ warnings: [long, long, 7, ...Array.from({ length: 100 }, (_, i) => `w${i}`)] })
    expect(s.warnings).toHaveLength(MAX_ANSWER_WARNINGS - 2)
    expect(Math.max(...s.warnings.map((w) => w.length))).toBeLessThanOrEqual(MAX_WARNING_LENGTH)
    expect(s.warnings[0]).toMatch(/^Filter "test": script: x+…$/)
    // The same texts again: nothing new.
    s.answer({ warnings: [long, 'w0'] })
    expect(s.warnings).toHaveLength(MAX_ANSWER_WARNINGS - 2)
    for (let i = 0; i < 20; i++) s.answer({ warnings: Array.from({ length: MAX_ANSWER_WARNINGS }, (_, j) => `frame ${i} ${j}`) })
    expect(s.warnings).toHaveLength(MAX_SCRIPT_WARNINGS + 1)
    expect(s.warnings.at(-1)).toMatch(`more than ${MAX_SCRIPT_WARNINGS} different warnings; the next ones are dropped`)
    expect(s.errors).toEqual([])
  })

  it('stops the script when an answer cannot be applied', async () => {
    const s = await forged()
    // A getter that throws, as only a script that rewrites the runtime's answers could send (a structured clone has
    // no getters: this stands for any unexpected failure while applying an answer).
    s.answer({ get commands(): unknown[] { throw new Error('boom') } })
    expect(s.host.state).toBe('stopped')
    expect(s.errors.map((e) => [e.code, e.message])).toEqual([['script', expect.stringMatching(/sent an answer the engine cannot apply \(Error: boom\)/)]])
  })
})

describe('script host: answers, checked and applied (spec §12.4, §12.7)', () => {
  /** A host on a port the test answers itself; `answer(…)` replies to the message in flight. */
  async function manual(options: Partial<ScriptHostOptions> = {}) {
    const sent: Array<{ message: Record<string, unknown>; transfer: Transferable[] | undefined }> = []
    // Copied as by the structured clone: the host reuses its frame message (#129).
    const port: ScriptPort = { postMessage: (m, t) => void sent.push({ message: structuredClone(m) as Record<string, unknown>, transfer: t }), onmessage: null }
    let terminated = 0
    const s = hostSetup('', { connect: async () => ({ port, terminate: () => void terminated++ }), now: () => 0, ...options })
    await s.host.start({}, 0)
    const reply = (data: unknown) => port.onmessage!({ data })
    const answer = (done: Record<string, unknown> = {}) => reply({ t: 'done', seq: sent.at(-1)!.message.seq ?? 0, ...done })
    return { ...s, port, sent, reply, answer, terminated: () => terminated }
  }

  const entry = (s: { overrides: ScriptOverrides }, name = 'opacity', layer = 0) => s.overrides.property(layer, name)!.entryFor(3)

  it('takes answers without warnings, commands or messages, and ignores commands for layers that do not exist', async () => {
    const s = await manual()
    s.answer({ commands: [['set', 5, null, { opacity: 0.1 }], ['set', '0', null, { opacity: 0.2 }]] })
    s.host.beginFrame()
    expect(entry(s)).toBeUndefined()
    expect([s.warnings, s.errors]).toEqual([[], []])
    s.host.beginFrame() // nothing new
  })

  it('animates towards a target with the options it was given, and warns about an unknown easing', async () => {
    const s = await manual()
    s.answer({
      commands: [
        ['animate', 0, null, { opacity: 0 }, { duration: 500, delay: 200, repeat: 2, easing: 'bounce' }],
        ['animate', 0, null, { opacity: 0 }, { duration: 500, easing: 'bounce' }],
      ],
    })
    s.host.beginFrame()
    expect(entry(s)).toMatchObject({ kind: 'tween', target: 0, keyframes: undefined, duration: 0.5, delay: 0, repeat: 0 })
    expect(s.warnings).toEqual(['Filter "test": .animate() on "opacity" of layer "label": unknown easing "bounce", using inOutQuad.']) // once
  })

  it('ignores an animation without a valid duration, and takes only finite delays and repeats', async () => {
    const s = await manual()
    s.answer({
      commands: [
        ['animate', 0, null, { opacity: 0 }, {}],
        ['animate', 0, null, { opacity: 0 }, { duration: -1 }],
        ['animate', 0, null, { opacity: 0 }, { duration: Number.NaN }],
      ],
    })
    s.host.beginFrame()
    expect(entry(s)).toBeUndefined()
    s.host.endFrame(0, s.source)
    s.answer({ commands: [['animate', 0, 3, { opacity: 0.5 }, { duration: 100, delay: Number.POSITIVE_INFINITY, repeat: '2' }]] })
    s.host.beginFrame()
    expect(entry(s)).toMatchObject({ kind: 'tween', target: 0.5, delay: 0, repeat: 0, duration: 0.1 })
    expect(s.warnings).toEqual([])
  })

  it('animates through keyframes of one type, and warns about invalid ones (spec §12.4)', async () => {
    const s = await manual()
    s.overrides.forLayer(0).wrap('scale', ['number', 'vec3'], { kind: 'constant', perFace: false, evaluate: () => 1 } as never)
    s.answer({ commands: [['animate', 0, 3, { opacity: { keyframes: [0, 1, 0.5] } }, { duration: 300 }]] })
    s.host.beginFrame()
    expect(entry(s)).toMatchObject({ kind: 'tween', target: undefined, keyframes: [0, 1, 0.5] })
    const invalid = [{ keyframes: [1] }, { keyframes: 'x' }, { keyframes: [0, 'a'] }]
    for (const value of invalid) {
      s.host.endFrame(0, s.source)
      s.answer({ commands: [['animate', 0, null, { scale: value }, { duration: 300 }]] })
      s.host.beginFrame()
    }
    s.host.endFrame(0, s.source)
    s.answer({ commands: [['animate', 0, null, { opacity: { keyframes: [true, false] } }, { duration: 300 }], ['animate', 0, null, { scale: { keyframes: [1, [1, 2, 3]] } }, { duration: 300 }]] })
    s.host.beginFrame()
    expect(s.overrides.property(0, 'scale')!.entryFor(3)).toBeUndefined()
    expect(s.warnings).toEqual([
      'Filter "test": .animate() on "scale" of layer "label": keyframes must be at least two values of type number or vec3.',
      'Filter "test": .animate() on "opacity" of layer "label": keyframes must be at least two values of type number.',
    ])
    // Mixed types warn under the same key as invalid keyframes: a fresh host shows that message.
    const t = await manual()
    t.overrides.forLayer(0).wrap('scale', ['number', 'vec3'], { kind: 'constant', perFace: false, evaluate: () => 1 } as never)
    t.answer({ commands: [['animate', 0, null, { scale: { keyframes: [1, [1, 2, 3]] } }, { duration: 300 }]] })
    t.host.beginFrame()
    expect(t.warnings).toEqual(['Filter "test": .animate() on "scale" of layer "label": keyframes must all have the same type.'])
  })

  it('warns about an animation target that is not a number, color or vector', async () => {
    const s = await manual()
    s.answer({ commands: [['animate', 0, null, { opacity: true }, { duration: 1 }], ['animate', 0, null, { opacity: [1, 2] }, { duration: 1 }]] })
    s.host.beginFrame()
    expect(entry(s)).toBeUndefined()
    expect(s.warnings).toEqual(['Filter "test": .animate() on "opacity" of layer "label": true is not a valid target (number).'])
  })

  it('freezes the arrays a script sets, so that it cannot change them afterwards', async () => {
    const s = await manual()
    s.overrides.forLayer(0).wrap('offset', ['vec3'], { kind: 'constant', perFace: false, evaluate: () => [0, 0, 0] } as never)
    const value = [1, 2, 3]
    s.answer({ commands: [['set', 0, 3, { offset: value }]] })
    s.host.beginFrame()
    const set = s.overrides.property(0, 'offset')!.entryFor(3) as unknown as { value: number[] }
    expect(set.value).toEqual([1, 2, 3])
    expect(set.value).not.toBe(value)
    expect(Object.isFrozen(set.value)).toBe(true)
  })

  it('names layers without id by index, and lists no settable property when there is none', async () => {
    const s = await manual({ layers: ['label', ''] })
    s.answer({ commands: [['set', 1, null, { opacity: 0 }], ['set', 1, null, { opacity: 1 }]] })
    s.host.beginFrame()
    expect(s.warnings).toEqual(['Filter "test": layer 1 has no property "opacity" a script can set (settable: none).'])
  })

  it('warns once per layer when play() reaches a layer that is not a model, and per animation when it does not exist', async () => {
    const plain = await manual()
    plain.answer({ commands: [['play', 0, null, 'wave'], ['play', 0, null, 'jump']] })
    plain.host.beginFrame()
    expect(plain.warnings).toEqual(['Filter "test": .play() starts model animations: layer "label" is not a model layer; ignored.'])
    const played: Array<[number, number | undefined, string]> = []
    const model = await manual({ play: (layer, face, name) => (played.push([layer, face, name]), 'unknown') })
    model.answer({ commands: [['play', 0, 3, 'wave'], ['play', 0, null, 'wave'], ['play', 0, null, 'jump']] })
    model.host.beginFrame()
    expect(played).toEqual([[0, 3, 'wave'], [0, undefined, 'wave'], [0, undefined, 'jump']])
    expect(model.warnings).toEqual(['Filter "test": .play("wave"): layer "label" has no such animation.', 'Filter "test": .play("jump"): layer "label" has no such animation.'])
  })

  it('counts messages per second of its clock, so a new second allows 60 more', async () => {
    let clock = 0
    const s = await manual({ now: () => clock })
    const emits = (n: number) => Array.from({ length: n }, (_, i): [string, unknown] => ['tick', i])
    s.answer({ emits: emits(65) })
    s.host.beginFrame()
    expect(s.emits).toHaveLength(60)
    clock = 1500
    s.host.endFrame(0, s.source)
    s.answer({ emits: emits(10) })
    s.host.beginFrame()
    expect(s.emits).toHaveLength(70)
  })

  it('warns once when the script answers more slowly than the frame rate', async () => {
    const s = await manual()
    s.answer()
    s.host.endFrame(0, s.source)
    for (let i = 0; i < 29; i++) s.host.endFrame(i / 30, s.source)
    expect(s.warnings).toEqual([])
    s.host.endFrame(1, s.source)
    for (let i = 0; i < 60; i++) s.host.endFrame(1 + i / 30, s.source)
    expect(s.warnings).toEqual(['Filter "test": the script answers more slowly than the frame rate; its commands are late (spec §12.7).'])
    expect(s.sent).toHaveLength(2) // init and one frame
  })

  it('sends frame.dt, pairs for "pairs", the changed parameters once, and copies the landmarks', async () => {
    const landmarks = new Float32Array(6)
    const frameData = { build: () => ({ faces: [{ id: 1, index: 0, landmarks }], blendshapes: undefined }) } as unknown as FrameDataBuilder
    const s = await manual({ uses: ['pairs', 'face.landmarks'], frameData })
    s.answer()
    s.host.paramsChanged({ size: 2 })
    s.host.endFrame(1, s.source)
    s.answer()
    s.host.endFrame(1.25, s.source)
    s.answer()
    s.host.endFrame(1, s.source) // the media time went back (a loop)
    const frames = s.sent.slice(1).map((m) => m.message)
    expect(frames.map((f) => [f.seq, f.dt, f.params, f.pairs])).toEqual([[1, 0, { size: 2 }, []], [2, 0.25, undefined, []], [3, 0, undefined, []]])
    // Reused by the frame data builder: copied by the structured clone, not transferred (#129).
    expect(s.sent[1]!.transfer).toBeUndefined()
    expect(landmarks.byteLength).toBe(24)
  })

  it('stops the script when a frame cannot be sent', async () => {
    const s = await manual()
    s.answer()
    s.port.postMessage = () => {
      throw new DOMException('could not be cloned', 'DataCloneError')
    }
    s.host.endFrame(0, s.source)
    expect(s.host.state).toBe('stopped')
    expect(s.errors.map((e) => e.code)).toEqual(['SCRIPT_STOPPED'])
    expect(s.errors[0]!.message).toMatch(/the script was stopped: its frame data could not be sent \(DataCloneError: could not be cloned\)\. The rest of the filter keeps working/)
    expect(s.terminated()).toBe(1)
  })

  it('stops with a "script" error when script.js cannot be loaded, and ignores what comes after', async () => {
    const s = await manual()
    s.reply({ t: 'fatal', message: 'script.js could not be loaded: SyntaxError: x' })
    expect(s.host.state).toBe('stopped')
    expect(s.errors.map((e) => [e.code, e.message])).toEqual([
      ['script', 'Filter "test": the script was stopped: script.js could not be loaded: SyntaxError: x. The rest of the filter keeps working; the script restarts when the filter is added again.'],
    ])
    expect(s.port.onmessage).toBeNull()
    s.host.queue({ name: 'message:go', payload: {} }) // dropped
    s.host.endFrame(0, s.source)
    expect(s.sent).toHaveLength(1)
  })

  it('ignores messages that are not answers to the message in flight', async () => {
    const timers: Array<() => void> = []
    const s = await manual({ setTimeout: (fn) => (timers.push(fn), timers.length), clearTimeout: () => {} })
    for (const data of [null, 3, 'done', { t: 'done', seq: 7 }, { t: 'other', seq: 0 }]) s.reply(data)
    expect(s.host.waiting).toBe(true)
    s.answer()
    expect(s.host.waiting).toBe(false)
    s.reply({ t: 'started' }) // not while init is in flight: ignored
    s.answer() // already answered
    s.host.beginFrame()
    // The watchdog of an answered message does nothing when it fires anyway.
    timers[0]!()
    expect([s.errors, s.host.state]).toEqual([[], 'running'])
  })

  it('stops, frees the sandbox and drops pending answers on dispose; does nothing once disposed', async () => {
    const s = await manual()
    s.answer({ commands: [['set', 0, null, { opacity: 0.5 }]] })
    s.host.dispose()
    s.host.beginFrame()
    expect(entry(s)).toBeUndefined()
    expect([s.host.state, s.terminated(), s.port.onmessage]).toEqual(['disposed', 1, null])
    s.host.dispose()
    expect(s.terminated()).toBe(1)
    await s.host.start({}, 0)
    s.host.queue({ name: 'message:go', payload: {} })
    s.host.endFrame(0, s.source)
    expect(s.sent).toHaveLength(1)
    expect(s.errors).toEqual([])
  })

  it('handles only the events in script.on, and starts once', async () => {
    const s = await manual()
    expect([s.host.handles('message:go'), s.host.handles('smile')]).toEqual([true, false])
    await s.host.start({}, 0)
    expect(s.sent).toHaveLength(1)
  })

  it('sends an idle script no frame until it is due, and takes only numbers as its idle times (#129, spec §15.1)', async () => {
    const s = await manual()
    const frames = () => s.sent.length - 1
    s.answer({ idle: {} })
    for (let i = 0; i < 10; i++) s.host.endFrame(i / 30, s.source)
    expect(frames()).toBe(0)
    s.host.queue({ name: 'message:go', payload: {} }) // an event: sent with the next frame
    s.host.endFrame(0.4, s.source)
    expect(frames()).toBe(1)
    // A rewritten answer with anything else than numbers gets every frame.
    for (const idle of [{ timer: 'soon' }, { draw: Number.NaN }, 'x', null]) {
      s.answer({ idle })
      s.host.endFrame(0.5, s.source)
    }
    expect(frames()).toBe(5)
    // Due when the script clock reaches the timer (ms), when the media time reaches the next draw…
    s.answer({ idle: { timer: 1000, draw: 2 } })
    s.host.endFrame(1.9, s.source)
    s.overrides.clock.advance(0)
    s.overrides.clock.advance(0.9)
    s.host.endFrame(1.95, s.source)
    expect(frames()).toBe(5)
    s.host.endFrame(2, s.source)
    expect(frames()).toBe(6)
    s.answer({ idle: { timer: 1000 } })
    s.overrides.clock.advance(1)
    s.host.endFrame(2.1, s.source)
    expect(frames()).toBe(7)
    // …or when it goes back (a loop) with a draw to come; frame.dt covers the frames not sent.
    s.answer({ idle: { draw: 5 } })
    s.host.endFrame(4, s.source)
    s.host.endFrame(1, s.source)
    expect(s.sent.slice(-2).map((m) => [m.message.time, m.message.dt])).toEqual([[2.1, expect.closeTo(0.1)], [1, 0]])
  })

  it('allocates nothing at a frame an idle script is not sent (#129)', async () => {
    const s = await manual()
    s.answer({ idle: { timer: 1e9, draw: 1e9 } })
    expect(bytesPerCall(() => s.host.endFrame(0.5, s.source))).toBeLessThan(1)
    expect(s.sent).toHaveLength(1)
  })

  it('serves every message with one watchdog timer, armed again only for what is left (#129)', async () => {
    const timers: Array<[number, () => void]> = []
    let cleared = 0
    let clock = 0
    const s = await manual({ now: () => clock, setTimeout: (fn, ms) => (timers.push([ms, fn]), timers.length), clearTimeout: () => void cleared++ })
    s.reply({ t: 'started' })
    s.answer()
    for (let i = 0; i < 30; i++) {
      clock += 20
      s.host.endFrame(i / 30, s.source)
      s.answer()
    }
    // One timer for setup and 30 frames; only the startup bound was cleared, when the script started.
    expect(timers.map(([ms]) => ms)).toEqual([STARTUP_MS, 1000])
    expect(cleared).toBe(1)
    clock = 1000 // it fires with nothing in flight: no timer until the next message
    timers[1]![1]()
    expect(timers).toHaveLength(2)
    clock = 1200
    s.host.endFrame(1, s.source)
    expect(timers.map(([ms]) => ms)).toEqual([STARTUP_MS, 1000, 1000])
    s.answer()
    clock = 1500
    s.host.endFrame(1.1, s.source)
    // Armed for the previous frame: it waits for what is left of the one in flight, sent at 1500.
    clock = 2200
    timers[2]![1]()
    expect([timers.at(-1)![0], s.host.state]).toEqual([300, 'running'])
    clock = 2500
    timers.at(-1)![1]()
    expect(s.errors.map((e) => e.message)).toEqual([expect.stringMatching(/did not answer a frame within 1000 ms/)])
  })
})

describe('script host: start', () => {
  it('closes the sandbox and the images when disposed while it starts', async () => {
    let open!: (c: ScriptConnection) => void
    let terminated = false
    const closed: string[] = []
    const s = hostSetup('', {
      connect: () => new Promise((resolve) => (open = resolve)),
      canvases: [{ layer: 0, width: 4, height: 4, fps: 0 }],
      images: async () => ({ star: { close: () => void closed.push('star') } as unknown as ImageBitmap }),
    })
    const starting = s.host.start({}, 0)
    expect(s.host.state).toBe('starting')
    s.host.dispose()
    open({ port: { postMessage: () => {}, onmessage: null }, terminate: () => void (terminated = true) })
    await starting
    expect([s.host.state, terminated, closed]).toEqual(['disposed', true, ['star']])
  })

  it('wraps a failure that is not an OuafError, and reports nothing when disposed meanwhile', async () => {
    const s = hostSetup('', { connect: () => Promise.reject(new Error('blocked by the CSP')) })
    await s.host.start({}, 0)
    expect(s.errors.map((e) => [e.code, e.message, (e.cause as Error).message])).toEqual([['script', 'Filter "test": Error: blocked by the CSP', 'blocked by the CSP']])
    let fail!: (e: unknown) => void
    const t = hostSetup('', { connect: () => new Promise((_, reject) => (fail = reject)) })
    const starting = t.host.start({}, 0)
    t.host.dispose()
    fail(new Error('too late'))
    await starting
    expect([t.errors, t.host.state]).toEqual([[], 'disposed'])
  })
})
