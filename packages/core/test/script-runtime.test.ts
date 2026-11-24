import { describe, expect, it } from 'vitest'
import { scriptRuntime, workerSource } from '../src/script/runtime.ts'
import type { WireDone } from '../src/script/runtime.ts'
import { FakeCanvas, STRAIGHT, ask, fakeImage, fakeScope, frame, init, load, runtime, type TestConnection } from './script-helpers.ts'

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

describe('script runtime: canvas layers', () => {
  // Layers of `init`: 0 'label', 1 '', 2 'dot'. 'dot' is the canvas here.
  const canvases = (fps: number) => [{ layer: 2, width: 64, height: 32, fps }]
  const draws = (done: WireDone) => (done.images ?? []).map(([layer, image]) => [layer, ...fakeImage(image)])

  it('draws at the first frame, then at most fps times per second of media time, from a transparent canvas', async () => {
    const conn = runtime()
    const code = `export default {
      draw: { dot(ctx, f, frame) { ctx.setTransform(2, 0, 0, 2, 0, 0); ctx.fillRect(frame.time, frame.faces.length, 1, 1) } },
    }`
    const first = await ask(conn, init(code, { canvases: canvases(10) }))
    expect(first.images).toBeUndefined() // setup draws nothing: draw needs a frame
    const canvas = FakeCanvas.all.at(-1)!
    expect([canvas.width, canvas.height]).toEqual([64, 32])
    // CPU-backed, and used once at init (its slow first use is not counted by the watchdog, #158).
    expect(canvas.options).toEqual({ willReadFrequently: true })
    expect(canvas.log).toEqual(['clearRect 0,0,1,1', 'getImageData 0,0,1,1'])
    canvas.log.length = 0
    const at = async (seq: number, time: number) => draws(await ask(conn, frame(seq, { time })))
    expect(await at(1, 1)).toEqual([[2, 1, 64, 32]])
    expect(canvas.log).toEqual(['save', 'setTransform 1,0,0,1,0,0', 'clearRect 0,0,64,32', 'restore', 'setTransform 2,0,0,2,0,0', 'fillRect 1,0,1,1', 'getImageData 0,0,64,32'])
    expect(await at(2, 1.05)).toEqual([]) // 10 fps: not before 1.1
    expect(await at(3, 1.1)).toEqual([[2, 2, 64, 32]])
    expect(await at(4, 1.15)).toEqual([])
    expect(await at(5, 0.2)).toEqual([[2, 3, 64, 32]]) // the media time went back (a loop): drawn again
  })

  it('with fps 0, draws once, then only after invalidate(); invalidate on another layer warns', async () => {
    const conn = runtime()
    const code = `export default {
      on: { 'message:redraw'(f) { f.layer('dot').invalidate() } },
      update(f, frame) { if (frame.time > 1) f.layer('label').invalidate() },
      draw: { dot(ctx) { ctx.fillRect(0, 0, 1, 1) } },
    }`
    await ask(conn, init(code, { canvases: canvases(0) }))
    expect(draws(await ask(conn, frame(1)))).toEqual([[2, 1, 64, 32]])
    expect(draws(await ask(conn, frame(2)))).toEqual([])
    expect(draws(await ask(conn, frame(3, { events: [{ name: 'message:redraw', payload: {} }] })))).toEqual([[2, 2, 64, 32]])
    expect(draws(await ask(conn, frame(4)))).toEqual([])
    const done = await ask(conn, frame(40, { time: 2 }))
    expect(done.warnings).toEqual(['f.layer("label").invalidate(): only canvas layers drawn by the script (draw.label) are redrawn; ignored.'])
  })

  it('redraws at the next frame after an invalidate() from a draw function, whichever canvas it names', async () => {
    const conn = runtime()
    const code = `export default {
      state: { n: 0 },
      draw: {
        dot(ctx, f) { if (++f.state.n === 1) f.layer('label').invalidate() },
        label(ctx, f) { if (f.state.n === 1) f.layer('dot').invalidate() },
      },
    }`
    // 'label' (layer 0) comes after 'dot' (layer 2) in draw order here.
    await ask(conn, init(code, { canvases: [...canvases(0), { layer: 0, width: 16, height: 16, fps: 0 }] }))
    expect(draws(await ask(conn, frame(1))).map(([layer]) => layer)).toEqual([2, 0])
    expect(draws(await ask(conn, frame(2))).map(([layer]) => layer)).toEqual([2, 0])
    expect(draws(await ask(conn, frame(3)))).toEqual([])
  })

  it('keeps the previous image when draw throws, and the declared size when draw resizes the canvas', async () => {
    const conn = runtime()
    const code = `export default {
      state: { n: 0 },
      draw: { dot(ctx, f) { f.state.n++; if (f.state.n === 2) throw new Error('oops'); if (f.state.n === 3) ctx.canvas.width = 4000 } },
    }`
    await ask(conn, init(code, { canvases: canvases(30) }))
    expect(draws(await ask(conn, frame(1)))).toHaveLength(1)
    let done = await ask(conn, frame(2))
    expect(draws(done)).toEqual([])
    expect(done.warnings).toEqual(["draw.dot threw Error: oops; the layer keeps its previous image"])
    done = await ask(conn, frame(3))
    expect(draws(done)).toEqual([])
    expect(done.warnings).toEqual(['draw.dot resized its canvas to 4000×32; it keeps its declared 64×32 px'])
    expect(FakeCanvas.all.at(-1)!.width).toBe(64)
    expect(draws(await ask(conn, frame(4)))).toEqual([[2, 2, 64, 32]])
  })

  it('sends premultiplied pixels of the declared size, transferred', async () => {
    const conn = runtime()
    await ask(conn, init(`export default { draw: { dot() {} } }`, { canvases: canvases(0) }))
    const [layer, pixels] = (await ask(conn, frame(1))).images![0]!
    expect(layer).toBe(2)
    expect(pixels).toBeInstanceOf(Uint8ClampedArray)
    expect(pixels.length).toBe(64 * 32 * 4)
    // Opaque pixels are kept; straight alpha is premultiplied, rounded to the nearest; transparent stays 0.
    const [r, g, b, a] = STRAIGHT as [number, number, number, number]
    expect([...pixels.subarray(0, 12)]).toEqual([1, 64, 32, 255, Math.round((r * a) / 255), Math.round((g * a) / 255), Math.round((b * a) / 255), a, 0, 0, 0, 0])
    expect([...pixels.subarray(4, 8)]).toEqual([100, 50, 26, 128])
  })

  it('tells the engine when the script starts: after the canvases and fonts are ready, before script.js runs', async () => {
    const conn = runtime()
    const seen: string[] = []
    const answered = new Promise<void>((resolve) => {
      conn.port.onmessage = (e) => {
        const m = e.data as { t: string; emits?: Array<[string, unknown]> }
        seen.push(m.t === 'done' ? `done ${m.emits!.map(([n]) => n).join(',')}` : m.t)
        if (m.t !== 'started') resolve()
      }
    })
    conn.port.postMessage(init(`export default { setup(f) { f.emit('setup') }, draw: { dot() {} } }`, { canvases: canvases(0) }))
    await answered
    expect(FakeCanvas.all.at(-1)!.log).toEqual(['clearRect 0,0,1,1', 'getImageData 0,0,1,1'])
    expect(seen).toEqual(['started', 'done setup'])
    // A script.js that cannot be loaded: started, then fatal.
    const broken = runtime()
    const order: string[] = []
    await new Promise<void>((resolve) => {
      broken.port.onmessage = (e) => {
        order.push((e.data as { t: string }).t)
        if ((e.data as { t: string }).t === 'fatal') resolve()
      }
      broken.port.postMessage(init(`export default 3`))
    })
    expect(order).toEqual(['started', 'fatal'])
  })

  it('still sends the canvas images when a message of the script cannot be cloned', async () => {
    const conn = runtime()
    await ask(conn, init(`export default { update(f) { f.emit('bad', () => 1) }, draw: { dot() {} } }`, { canvases: canvases(0) }))
    const done = await ask(conn, frame(1))
    expect(done.emits).toEqual([])
    expect(done.warnings[0]).toMatch(/cannot be sent/)
    expect(draws(done)).toEqual([[2, 1, 64, 32]])
  })

  it('gives the image assets to f.asset by name', async () => {
    const conn = runtime()
    const code = `export default {
      setup(f) {
        f.emit('asset', f.asset('star'))
        try { f.asset('nope') } catch (e) { f.emit('error', e.message) }
      },
    }`
    const done = await ask(conn, init(code, { canvases: canvases(0), assets: { star: 'a bitmap' } }))
    expect(done.emits).toEqual([['asset', 'a bitmap'], ['error', 'f.asset("nope"): no image asset (image, spritesheet, SVG or emoji) of the manifest has this name.']])
    const none = await ask(runtime(), init(`export default { setup(f) { try { f.asset('star') } catch (e) { f.emit('error', e.message) } } }`))
    expect(none.emits).toEqual([['error', 'f.asset("star"): image assets are given to scripts that draw canvas layers only.']])
  })

  it('registers the font assets in the Worker under their asset name before setup (spec §12.6)', async () => {
    const added: string[] = []
    class FakeFace {
      family: string
      descriptors: unknown
      bytes: number
      constructor(family: string, data: ArrayBuffer, descriptors: unknown) {
        this.family = family
        this.descriptors = descriptors
        this.bytes = data.byteLength
      }
      async load() {
        await new Promise((r) => setTimeout(r, 5))
        if (this.bytes === 0) throw new Error('not a font')
        return this
      }
    }
    const fonts = { FontFace: FakeFace, set: { add: (face: unknown) => void added.push(JSON.stringify(face)) } }
    const list = [
      { name: 'title', data: new ArrayBuffer(8), weight: '700', style: 'normal' },
      { name: 'broken', data: new ArrayBuffer(0), weight: 'normal', style: 'normal' },
    ]
    const done = await ask(runtime({ fonts }), init(`export default { setup(f) { f.emit('setup') }, draw: { dot() {} } }`, { canvases: canvases(0), fonts: list }))
    // Registered under the asset name, and done before setup ran.
    expect(added).toEqual([JSON.stringify({ family: 'title', descriptors: { weight: '700', style: 'normal' }, bytes: 8 })])
    expect(done.emits).toEqual([['setup', undefined]])
    expect(done.warnings).toEqual(['font "broken" cannot be used in canvases: Error: not a font'])
  })

  it('without FontFace in the Worker, draws with the platform fonts and warns once', async () => {
    const list = [
      { name: 'title', data: new ArrayBuffer(8), weight: '700', style: 'normal' },
      { name: 'body', data: new ArrayBuffer(8), weight: 'normal', style: 'normal' },
    ]
    const conn = runtime({ fonts: { FontFace: undefined, set: undefined } })
    const done = await ask(conn, init(`export default { setup(f) { f.emit('setup') }, draw: { dot() {} } }`, { canvases: canvases(0), fonts: list }))
    expect(done.emits).toEqual([['setup', undefined]])
    expect(done.warnings).toEqual([`this browser has no FontFace in workers: canvas text is drawn with the platform's fonts instead of the filter's ("title", "body")`])
    expect((await ask(conn, frame(1))).warnings).toEqual([])
  })
})

describe('script runtime: the f API checks its arguments (spec §12.4)', () => {
  /** Runs `body` in setup (with layers 'label', '' and 'dot'), and gives the warnings: one per failed call. */
  async function errors(...calls: string[]): Promise<string[]> {
    const body = calls.map((c) => `try { ${c} } catch (e) { f.emit('error', e.name + ': ' + e.message) }`).join('\n')
    const done = await ask(runtime(), init(`export default { setup(f) {\n${body}\n} }`))
    return done.emits.map(([, message]) => message as string)
  }

  it('refuses layer ids and faces that name no layer or face', async () => {
    expect(await errors(`f.layer(3)`, `f.layer('')`, `f.layer('label', { id: '3' })`, `f.layer('label', 7)`)).toEqual([
      'TypeError: f.layer(id): id must be a string.',
      'Error: f.layer(""): no layer has this id.',
      'TypeError: f.layer(id, face): face must be a face of frame.faces or of an event.',
      'TypeError: f.layer(id, face): face must be a face of frame.faces or of an event.',
    ])
  })

  it('refuses set, animate and play calls without their arguments', async () => {
    const l = `f.layer('label')`
    expect(await errors(`${l}.set()`, `${l}.set(1)`, `${l}.animate(null, { duration: 1 })`, `${l}.animate({ opacity: 0 })`, `${l}.animate({ opacity: 0 }, { duration: -5 })`, `${l}.play(3)`)).toEqual([
      'TypeError: .set(props): props must be an object.',
      'TypeError: .set(props): props must be an object.',
      'TypeError: .animate(props, options): props must be an object.',
      'TypeError: .animate(props, options): options.duration (ms) is required.',
      'TypeError: .animate(props, options): options.duration (ms) is required.',
      'TypeError: .play(name): name must be a string.',
    ])
  })

  it('refuses timers without a delay ≥ 0 (≥ 1 for every) or a function, and messages with an invalid name', async () => {
    expect(await errors(`f.after(-1, () => {})`, `f.after(Infinity, () => {})`, `f.after('5', () => {})`, `f.after(5, 'x')`, `f.every(0.5, () => {})`, `f.emit('1st')`, `f.emit(3)`, `f.emit('a b')`)).toEqual([
      'TypeError: f.after / f.every: ms must be a number ≥ 0.',
      'TypeError: f.after / f.every: ms must be a number ≥ 0.',
      'TypeError: f.after / f.every: ms must be a number ≥ 0.',
      'TypeError: f.after / f.every: fn must be a function.',
      'TypeError: f.every: ms must be at least 1.',
      'TypeError: f.emit(name): invalid name "1st".',
      'TypeError: f.emit(name): invalid name 3.',
      'TypeError: f.emit(name): invalid name "a b".',
    ])
  })

  it('gives one handle per layer and face, and lets the script replace f.state', async () => {
    const conn = runtime()
    await ask(conn, init(`export default {
      setup(f) { f.state = { replaced: true } },
      update(f, frame) {
        const face = frame.faces[0]
        f.emit('same', f.layer('label', face) === f.layer('label', face) && f.layer('label') === f.layer('label', null))
        f.emit('other', f.layer('label', face) !== f.layer('label'))
        f.emit('state', f.state)
        f.layer('label', face).play('wave')
      },
    }`))
    const done = await ask(conn, frame(1, { faces: [{ id: 4, index: 0 }] }))
    expect(done.emits).toEqual([['same', true], ['other', true], ['state', { replaced: true }]])
    expect(done.commands).toEqual([['play', 0, 4, 'wave']])
  })

  it('keeps at most 20 warnings per answer, and describes what a script throws', async () => {
    const conn = runtime()
    await ask(conn, init(`export default { update(f) { for (let i = 0; i < 30; i++) f.after(0, () => { throw 'plain ' + i }) } }`))
    await ask(conn, frame(1))
    const done = await ask(conn, frame(2))
    expect(done.warnings).toHaveLength(20)
    expect(done.warnings[0]).toBe('f.after threw plain 0')
  })
})

describe('script runtime: events and frames', () => {
  it('gives face events their face, the side of a side event, and both faces of a pair event', async () => {
    const conn = runtime()
    const code = `export default {
      on: {
        wink(f, { face, side }) { f.emit('wink', [face.id, face.index, side, face.state.n]) },
        touch(f, { faces }) { f.emit('touch', faces.map((x) => [x.id, x.index])) },
        faceEnter(f, { face }) { face.state.n = 1; f.emit('enter', face.id) },
        smile: 'not a function',
      },
      update(f, frame) { f.emit('pairs', frame.pairs.map((p) => [p.a.id, p.a.index, p.b.id, p.b.index, p.distance, p.contact])) },
    }`
    await ask(conn, init(code))
    const done = await ask(conn, frame(1, {
      faces: [{ id: 2, index: 0 }],
      pairs: [{ a: 2, b: 9, distance: 0.1, contact: true }],
      events: [{ name: 'faceEnter', face: 2 }, { name: 'wink', face: 2, side: 'left' }, { name: 'touch', faces: [2, 9] }, { name: 'smile', face: 2 }],
    }))
    expect(done.emits).toEqual([
      ['enter', 2],
      ['wink', [2, 0, 'left', 1]],
      ['touch', [[2, 0], [9, -1]]], // face 9 is not in this frame
      ['pairs', [[2, 0, 9, -1, 0.1, true]]],
    ])
    expect(done.warnings).toEqual([])
    // The face keeps its state from frame to frame.
    const next = await ask(conn, frame(2, { faces: [{ id: 2, index: 1 }], events: [{ name: 'wink', face: 2, side: 'right' }] }))
    expect(next.emits[0]).toEqual(['wink', [2, 1, 'right', 1]])
  })

  it('skips the canvases without a draw function, and still sends a fallback answer without images', async () => {
    const conn = runtime()
    await ask(conn, init(`export default { update(f) { f.emit('bad', () => 1) } }`, { canvases: [{ layer: 2, width: 8, height: 8, fps: 0 }] }))
    const done = await ask(conn, frame(1))
    expect(done.images).toBeUndefined()
    expect(done.warnings[0]).toMatch(/^The script's commands or messages cannot be sent: DataCloneError/)
  })

  it('ignores port messages that are not init or frame', async () => {
    const conn = runtime()
    let answers = 0
    conn.port.onmessage = () => void answers++
    for (const m of [null, 'frame', { t: 'other' }]) conn.port.postMessage(m)
    await new Promise((r) => setTimeout(r, 20))
    expect(answers).toBe(0)
    expect((await ask(conn, init(`export default {}`))).t).toBe('done')
  })
})

describe('script runtime: start-up', () => {
  it('takes the port from data.port too, and only the first one', async () => {
    const scope = fakeScope()
    scriptRuntime(scope, { harden: false, load })
    scope.send({ t: 'nothing' }) // no port: still waiting
    const a = new MessageChannel()
    const b = new MessageChannel()
    scope.send({ t: 'port', port: a.port2 })
    scope.send({ t: 'port', port: b.port2 }) // after the first: not listened to any more
    const done = await ask({ port: a.port1 as unknown as TestConnection['port'] }, init(`export default { setup(f) { f.emit('hi') } }`))
    expect(done.emits).toEqual([['hi', undefined]])
    a.port1.close()
    b.port1.close()
  })

  it('reports a script.js that cannot be loaded, and init without assets or canvases', async () => {
    const conn = runtime({ load: () => Promise.reject(new SyntaxError('Unexpected token')) })
    const fatal = await ask(conn, { ...init(''), assets: undefined, canvases: undefined })
    expect(fatal).toEqual({ t: 'fatal', message: 'script.js could not be loaded: SyntaxError: Unexpected token' })
  })

  it('warns about a canvas that cannot be made, and draws the others', async () => {
    const conn = runtime({ canvas: (w, h) => (w === 1 ? { width: w, height: h, getContext: () => null } : new FakeCanvas(w, h)) })
    const done = await ask(conn, init(`export default { draw: { dot() {}, label() {} } }`, { canvases: [{ layer: 0, width: 1, height: 1, fps: 0 }, { layer: 2, width: 8, height: 8, fps: 0 }, { layer: 7, width: 1, height: 1, fps: 0 }] }))
    expect(done.warnings).toEqual(['canvas layer "label" cannot be drawn: Error: no 2D context', 'canvas layer "" cannot be drawn: Error: no 2D context'])
    expect((await ask(conn, frame(1))).images!.map(([layer]) => layer)).toEqual([2])
  })

  it('uses OffscreenCanvas and the global font set by default, and says when they are missing', async () => {
    // Node has neither OffscreenCanvas nor FontFace.
    const conn = runtime({ canvas: undefined })
    const done = await ask(conn, init(`export default { draw: { dot() {} } }`, { canvases: [{ layer: 2, width: 8, height: 8, fps: 0 }], fonts: [{ name: 'title', data: new ArrayBuffer(4), weight: '700', style: 'normal' }] }))
    expect(done.warnings).toEqual([
      'canvas layer "dot" cannot be drawn: Error: OffscreenCanvas is not available in this browser, so canvas layers cannot be drawn.',
      `this browser has no FontFace in workers: canvas text is drawn with the platform's fonts instead of the filter's ("title")`,
    ])
  })
})
