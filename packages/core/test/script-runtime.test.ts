import { describe, expect, it } from 'vitest'
import { workerSource } from '../src/script/runtime.ts'
import { FakeCanvas, ask, fakeImage, frame, init, runtime } from './script-helpers.ts'

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
  const draws = (done: { bitmaps?: Array<[number, unknown]> }) => (done.bitmaps ?? []).map(([layer, image]) => [layer, ...fakeImage(image)])

  it('draws at the first frame, then at most fps times per second of media time, from a transparent canvas', async () => {
    const conn = runtime()
    const code = `export default {
      draw: { dot(ctx, f, frame) { ctx.setTransform(2, 0, 0, 2, 0, 0); ctx.fillRect(frame.time, frame.faces.length, 1, 1) } },
    }`
    const first = await ask(conn, init(code, { canvases: canvases(10) }))
    expect(first.bitmaps).toBeUndefined() // setup draws nothing: draw needs a frame
    const canvas = FakeCanvas.all.at(-1)!
    expect([canvas.width, canvas.height]).toEqual([64, 32])
    const at = async (seq: number, time: number) => draws(await ask(conn, frame(seq, { time })))
    expect(await at(1, 1)).toEqual([[2, 1, 64, 32]])
    expect(canvas.log).toEqual(['save', 'setTransform 1,0,0,1,0,0', 'clearRect 0,0,64,32', 'restore', 'setTransform 2,0,0,2,0,0', 'fillRect 1,0,1,1'])
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
