/**
 * The script runtime (spec §12): the code that runs in the sandbox Worker, around the filter's `script.js`.
 *
 * `scriptRuntime` is **self-contained**: it references nothing outside its own body, so that the engine can turn it
 * into the Worker's source with `Function.prototype.toString` (`workerSource()`); there is no build step and no
 * bundler-specific worker import. The unit tests call it directly, in Node, with a fake global scope.
 *
 * In the Worker it:
 * 1. waits for the `MessagePort` of the engine (the only way out), then removes the network and storage globals and
 *    the Worker's own `postMessage` (defense in depth: the sandbox CSP already blocks the network, spec §15);
 * 2. imports `script.js` (an ES module whose default export holds `state`, `setup`, `update`, `on`, `draw`);
 * 3. answers every message of the engine with the commands the script produced (spec §12.1): `init` runs `setup`,
 *    each `frame` runs the due timers, then the queued events in order, then `update`, then the `draw` functions of
 *    the canvas layers that are due (spec §12.6).
 *
 * Canvas layers (spec §12.6): one `OffscreenCanvas` per drawn canvas layer, in the Worker. A canvas is drawn at the
 * first frame, then when `fps` allows it (in media time: at most `fps` draws per second of `frame.time`) or after
 * `.invalidate()`. Each draw starts from a transparent canvas; its image goes to the engine as an `ImageBitmap`
 * (transferred, not copied), which the layer uploads to the GPU.
 *
 * Messages (structured clone over the port):
 * - engine → runtime: `{ t: 'init', code, layers, canvases, params, seed, clock, assets }`, `{ t: 'frame', seq,
 *   time, dt, clock, faces, pairs?, params?, events }`.
 * - runtime → engine: `{ t: 'done', seq, commands, emits, warnings, bitmaps? }` (`seq` 0 answers `init`),
 *   `{ t: 'fatal', message }` when `script.js` cannot be loaded.
 */

/** A face as sent by the engine; the runtime adds `state`. */
export interface WireFace {
  id: number
  index: number
  pose?: { yaw: number; pitch: number; roll: number }
  size?: number
  blendshapes?: Record<string, number>
  anchors?: Record<string, [number, number]>
  landmarks?: Float32Array
}

/** A queued event: face events carry the face id; `paramChange` and messages their payload. */
export interface WireEvent {
  name: string
  face?: number
  faces?: [number, number]
  side?: 'left' | 'right'
  payload?: unknown
}

export interface WireInit {
  t: 'init'
  /** Source of `script.js`. */
  code: string
  /** Layer ids by layer index (`''` for a layer without id). */
  layers: string[]
  params: Record<string, unknown>
  seed: number
  /** Script clock (s) and media time (s) at activation. */
  clock: number
  time: number
  /** Image assets by name, for `f.asset()` (`ImageBitmap`s, transferred). */
  assets: Record<string, unknown>
  /** The canvas layers drawn by the script (`script.draw`). */
  canvases: WireCanvas[]
}

/** A canvas layer drawn by the script (spec §12.6). */
export interface WireCanvas {
  /** Layer index. */
  layer: number
  width: number
  height: number
  /** Maximum draws per second of media time; 0: only at the first frame and after `.invalidate()`. */
  fps: number
}

export interface WireFrame {
  t: 'frame'
  seq: number
  time: number
  /** Seconds since the previous frame sent to the script. */
  dt: number
  clock: number
  faces: WireFace[]
  pairs?: Array<{ a: number; b: number; distance: number; contact: boolean }>
  /** Present when a parameter changed since the previous frame sent. */
  params?: Record<string, unknown>
  /** Present when the filter was reseeded (a new source run, spec §12.5): `f.random()` restarts from it. */
  seed?: number
  events: WireEvent[]
}

/** `[op, layer index, face id or null, …]`. */
export type WireCommand =
  | ['set', number, number | null, Record<string, unknown>]
  | ['animate', number, number | null, Record<string, unknown>, Record<string, unknown>]
  | ['play', number, number | null, string]

export interface WireDone {
  t: 'done'
  seq: number
  commands: WireCommand[]
  /** `f.emit()` calls: `[name, data]`. */
  emits: Array<[string, unknown]>
  warnings: string[]
  /** Canvas images drawn for this answer: `[layer index, image]` (transferred). */
  bitmaps?: Array<[number, ImageBitmap]>
}

/** What the runtime needs from its global scope (the Worker's `self`, or a test double). */
export interface RuntimeScope {
  addEventListener(type: 'message', listener: (event: { data: unknown; ports?: readonly unknown[] }) => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown; ports?: readonly unknown[] }) => void): void
}

export interface RuntimeOptions {
  /** Removes the dangerous globals (default true; the Node tests turn it off). */
  harden?: boolean
  /**
   * Imports the module source `code`. In the Worker, `workerSource()` passes one that imports it from a `blob:` URL;
   * it lives in the Worker source text rather than in this function because bundlers rewrite `import()` calls in
   * code (Vite wraps them with a helper of its own, which does not exist in the Worker).
   */
  load: (code: string) => Promise<{ default?: unknown }>
  /** Creates a canvas of canvas layers (default: `new OffscreenCanvas`; the Node tests pass a fake one). */
  canvas?: (width: number, height: number) => RuntimeCanvas
}

/** What the runtime uses of an `OffscreenCanvas`. */
export interface RuntimeCanvas {
  width: number
  height: number
  getContext(type: '2d'): unknown
  transferToImageBitmap(): unknown
}

/**
 * Starts the runtime on `scope`. The first message on `scope` must carry the engine's port (`{ t: 'port' }` with the
 * port in `ports[0]`, or in `data.port`); every other message goes through that port.
 */
export function scriptRuntime(scope: RuntimeScope, options: RuntimeOptions): void {
  type Port = { postMessage(message: unknown, transfer?: unknown[]): void; addEventListener?: unknown; start?(): void; onmessage: ((e: { data: unknown }) => void) | null }
  type Obj = Record<string, unknown>
  type Def = {
    state?: unknown
    setup?: (f: unknown) => void
    update?: (f: unknown, frame: unknown) => void
    on?: Record<string, ((f: unknown, payload: unknown) => void) | undefined>
    draw?: Record<string, ((ctx: unknown, f: unknown, frame: unknown) => void) | undefined>
  }
  type Context2D = {
    save(): void
    restore(): void
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
    clearRect(x: number, y: number, w: number, h: number): void
  }
  interface Canvas {
    layer: number
    id: string
    width: number
    height: number
    fps: number
    canvas: RuntimeCanvas
    ctx: Context2D
    /** Media time of the last draw (s), or -1: never drawn. */
    last: number
    invalid: boolean
  }
  interface Timer {
    due: number
    every: number
    fn: (f: unknown) => void
    cancelled: boolean
  }

  const DANGEROUS = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'importScripts', 'Worker',
    'SharedWorker', 'BroadcastChannel', 'indexedDB', 'IDBFactory', 'caches', 'CacheStorage', 'navigator', 'postMessage',
    'onmessage', 'Request', 'Response', 'Headers',
  ]

  function harden(): void {
    const g = globalThis as unknown as Obj
    for (const name of DANGEROUS) {
      // Delete the property wherever it lives on the prototype chain, then shadow it, so that neither `fetch` nor
      // `Object.getPrototypeOf(self).fetch` gives it back.
      for (let o: object | null = g; o; o = Object.getPrototypeOf(o)) {
        const d = Object.getOwnPropertyDescriptor(o, name)
        if (d?.configurable) delete (o as Obj)[name]
      }
      try {
        Object.defineProperty(g, name, { value: undefined, writable: false, configurable: false })
      } catch {
        // Not configurable: left as it is (the CSP still blocks the network).
      }
    }
  }

  const load = options.load
  // Captured before hardening, like everything the runtime itself needs.
  const OC = (globalThis as unknown as { OffscreenCanvas?: new (w: number, h: number) => RuntimeCanvas }).OffscreenCanvas
  const makeCanvas = options.canvas ?? ((w: number, h: number): RuntimeCanvas => {
    if (!OC) throw new Error('OffscreenCanvas is not available in this browser, so canvas layers cannot be drawn.')
    return new OC(w, h)
  })

  let port: Port | undefined
  let def: Def = {}
  let layerIds: string[] = []
  let params: Obj = {}
  let assets: Obj = {}
  let canvases: Canvas[] = []
  let bitmaps: Array<[number, unknown]> = []
  let state: unknown
  let clock = 0
  let commands: unknown[] = []
  let emits: Array<[string, unknown]> = []
  let warnings: string[] = []
  const faceStates = new Map<number, Obj>()
  let faces: Obj[] = []
  const byId = new Map<number, Obj>()
  let timers: Timer[] = []
  const handles = new Map<string, unknown>()

  // sfc32, seeded with the filter seed (spec §12.5).
  let s0 = 0
  let s1 = 0
  let s2 = 0
  let s3 = 0
  function seedRandom(n: number): void {
    s0 = 0x9e3779b9
    s1 = 0x243f6a88
    s2 = 0xb7e15162
    s3 = n | 0
    for (let i = 0; i < 12; i++) random()
  }
  function random(): number {
    s0 |= 0
    s1 |= 0
    s2 |= 0
    s3 |= 0
    const t = (((s0 + s1) | 0) + s3) | 0
    s3 = (s3 + 1) | 0
    s0 = s1 ^ (s1 >>> 9)
    s1 = (s2 + (s2 << 3)) | 0
    s2 = (s2 << 21) | (s2 >>> 11)
    s2 = (s2 + t) | 0
    return (t >>> 0) / 4294967296
  }

  function warn(message: string): void {
    if (warnings.length < 20) warnings.push(message)
  }

  function describe(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }

  /** Runs a script function; an exception is reported and does not stop the script. */
  function run(what: string, fn: () => void): void {
    try {
      fn()
    } catch (error) {
      warn(`${what} threw ${describe(error)}`)
    }
  }

  function faceKey(face: unknown): number | null {
    if (face === undefined || face === null) return null
    const id = (face as { id?: unknown }).id
    if (typeof id !== 'number') throw new TypeError('f.layer(id, face): face must be a face of frame.faces or of an event.')
    return id
  }

  function handle(id: unknown, face: unknown): unknown {
    if (typeof id !== 'string') throw new TypeError('f.layer(id): id must be a string.')
    const index = layerIds.indexOf(id)
    if (index < 0 || id === '') throw new Error(`f.layer("${id}"): no layer has this id.`)
    const key = faceKey(face)
    const cacheKey = `${index}:${key}`
    let h = handles.get(cacheKey)
    if (!h) {
      h = Object.freeze({
        set(props: unknown) {
          if (!props || typeof props !== 'object') throw new TypeError('.set(props): props must be an object.')
          commands.push(['set', index, key, props])
        },
        animate(props: unknown, opts: unknown) {
          if (!props || typeof props !== 'object') throw new TypeError('.animate(props, options): props must be an object.')
          const o = (opts ?? {}) as Obj
          if (typeof o.duration !== 'number' || !(o.duration >= 0)) throw new TypeError('.animate(props, options): options.duration (ms) is required.')
          commands.push(['animate', index, key, props, o])
        },
        play(name: unknown) {
          if (typeof name !== 'string') throw new TypeError('.play(name): name must be a string.')
          commands.push(['play', index, key, name])
        },
        invalidate() {
          const c = canvases.find((c) => c.layer === index)
          if (c) c.invalid = true
          else warn(`f.layer("${id}").invalidate(): only canvas layers drawn by the script (draw.${id}) are redrawn; ignored.`)
        },
      })
      handles.set(cacheKey, h)
    }
    return h
  }

  function timer(ms: unknown, fn: unknown, every: boolean): { cancel(): void } {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new TypeError('f.after / f.every: ms must be a number ≥ 0.')
    if (typeof fn !== 'function') throw new TypeError('f.after / f.every: fn must be a function.')
    if (every && ms < 1) throw new TypeError('f.every: ms must be at least 1.')
    const t: Timer = { due: clock * 1000 + ms, every: every ? ms : 0, fn: fn as (f: unknown) => void, cancelled: false }
    timers.push(t)
    return Object.freeze({ cancel: () => void (t.cancelled = true) })
  }

  const f = Object.freeze({
    layer: handle,
    get state() {
      return state
    },
    set state(value: unknown) {
      state = value
    },
    get params() {
      return params
    },
    emit(name: unknown, data?: unknown) {
      if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new TypeError(`f.emit(name): invalid name ${JSON.stringify(name)}.`)
      emits.push([name, data])
    },
    asset(name: unknown) {
      if (typeof name !== 'string' || !Object.hasOwn(assets, name)) {
        const why = canvases.length > 0 ? 'no image asset (image, spritesheet, SVG or emoji) of the manifest has this name' : 'image assets are given to scripts that draw canvas layers only'
        throw new Error(`f.asset(${JSON.stringify(name)}): ${why}.`)
      }
      return assets[name]
    },
    random,
    after: (ms: unknown, fn: unknown) => timer(ms, fn, false),
    every: (ms: unknown, fn: unknown) => timer(ms, fn, true),
  })

  function faceObject(w: Obj): Obj {
    const id = w.id as number
    let s = faceStates.get(id)
    if (!s) faceStates.set(id, (s = {}))
    const face: Obj = { ...w, state: s }
    return face
  }

  function eventFace(id: number): Obj {
    return byId.get(id) ?? { id, index: -1, state: faceStates.get(id) ?? {} }
  }

  function deliver(e: { name: string; face?: number; faces?: [number, number]; side?: string; payload?: unknown }): void {
    const fn = def.on?.[e.name]
    if (typeof fn === 'function') {
      let payload: unknown
      if (e.name === 'paramChange' || e.name.startsWith('message:')) payload = e.payload
      else if (e.faces) payload = { faces: [eventFace(e.faces[0]), eventFace(e.faces[1])] }
      else payload = e.side ? { face: eventFace(e.face ?? 0), side: e.side } : { face: eventFace(e.face ?? 0) }
      run(`on.${e.name}`, () => fn(f, payload))
    }
    // Per-face state is reset when the face leaves (after its faceLeave handler).
    if (e.name === 'faceLeave' && e.face !== undefined) faceStates.delete(e.face)
  }

  function runTimers(): void {
    const now = clock * 1000
    // Timers created by a timer run at the next frame at the earliest.
    const due = timers.filter((t) => !t.cancelled && t.due <= now)
    for (const t of due) {
      if (t.every > 0) {
        while (t.due <= now) t.due += t.every
      } else t.cancelled = true
      run(t.every > 0 ? 'f.every' : 'f.after', () => t.fn(f))
    }
    timers = timers.filter((t) => !t.cancelled)
  }

  /** Runs the `draw` function of each canvas that is due (spec §12.6). */
  function draw(time: number, frameData: Obj): void {
    // Which canvases are due is settled first: an invalidate() from a draw function redraws at the next frame.
    const due = canvases.filter((c) => c.last < 0 || c.invalid || (c.fps > 0 && (time < c.last || time - c.last >= 1 / c.fps - 1e-6)))
    for (const c of due) {
      c.last = time
      c.invalid = false
    }
    for (const c of due) {
      const fn = def.draw?.[c.id]
      if (typeof fn !== 'function') continue
      // Each draw starts from a transparent canvas, whatever transform the previous one left.
      c.ctx.save()
      c.ctx.setTransform(1, 0, 0, 1, 0, 0)
      c.ctx.clearRect(0, 0, c.width, c.height)
      c.ctx.restore()
      let ok = true
      try {
        fn(c.ctx, f, frameData)
      } catch (error) {
        ok = false
        warn(`draw.${c.id} threw ${describe(error)}; the layer keeps its previous image`)
      }
      if (c.canvas.width !== c.width || c.canvas.height !== c.height) {
        // The script resized `ctx.canvas`: its size is the manifest's (spec §12.6).
        warn(`draw.${c.id} resized its canvas to ${c.canvas.width}×${c.canvas.height}; it keeps its declared ${c.width}×${c.height} px`)
        c.canvas.width = c.width
        c.canvas.height = c.height
        continue
      }
      if (ok) bitmaps.push([c.layer, c.canvas.transferToImageBitmap()])
    }
  }

  function answer(seq: number): void {
    const message: Obj = { t: 'done', seq, commands, emits, warnings }
    const images = bitmaps
    if (images.length > 0) message.bitmaps = images
    commands = []
    emits = []
    warnings = []
    bitmaps = []
    try {
      port!.postMessage(message, images.map(([, b]) => b))
    } catch (error) {
      // A value the script passed cannot be cloned (a function, a DOM object…): report it without the payload. The
      // canvas images were not transferred (cloning failed first): they still go.
      const fallback: Obj = { t: 'done', seq, commands: [], emits: [], warnings: [`The script's commands or messages cannot be sent: ${describe(error)}`] }
      if (images.length > 0) fallback.bitmaps = images
      port!.postMessage(fallback, images.map(([, b]) => b))
    }
  }

  async function init(m: Obj): Promise<void> {
    layerIds = m.layers as string[]
    params = Object.freeze({ ...(m.params as Obj) })
    assets = (m.assets as Obj) ?? {}
    canvases = []
    for (const w of (m.canvases as WireCanvas[] | undefined) ?? []) {
      const id = layerIds[w.layer] ?? ''
      try {
        const canvas = makeCanvas(w.width, w.height)
        const ctx = canvas.getContext('2d') as Context2D | null
        if (!ctx) throw new Error('no 2D context')
        canvases.push({ layer: w.layer, id, width: w.width, height: w.height, fps: w.fps, canvas, ctx, last: -1, invalid: false })
      } catch (error) {
        warn(`canvas layer "${id}" cannot be drawn: ${describe(error)}`)
      }
    }
    clock = m.clock as number
    seedRandom(m.seed as number)
    let mod: { default?: unknown }
    try {
      mod = await load(m.code as string)
    } catch (error) {
      port!.postMessage({ t: 'fatal', message: `script.js could not be loaded: ${describe(error)}` })
      return
    }
    const d = mod.default
    if (!d || typeof d !== 'object') {
      port!.postMessage({ t: 'fatal', message: 'script.js has no default export (an object with setup, update, on, draw, state).' })
      return
    }
    def = d as Def
    state = def.state === undefined ? {} : structuredClone(def.state)
    if (typeof def.setup === 'function') run('setup', () => def.setup!(f))
    answer(0)
  }

  function frame(m: Obj): void {
    clock = m.clock as number
    if (m.params) params = Object.freeze({ ...(m.params as Obj) })
    if (typeof m.seed === 'number') seedRandom(m.seed)
    byId.clear()
    faces = (m.faces as Obj[]).map((w) => {
      const face = faceObject(w)
      byId.set(face.id as number, face)
      return face
    })
    const frameData: Obj = { time: m.time, dt: m.dt, faces }
    if (m.pairs) {
      frameData.pairs = (m.pairs as Array<{ a: number; b: number; distance: number; contact: boolean }>).map((p) => ({
        a: eventFace(p.a),
        b: eventFace(p.b),
        distance: p.distance,
        contact: p.contact,
      }))
    }
    runTimers()
    for (const e of m.events as Array<Parameters<typeof deliver>[0]>) deliver(e)
    if (typeof def.update === 'function') run('update', () => def.update!(f, frameData))
    draw(m.time as number, frameData)
    answer(m.seq as number)
  }

  function onPortMessage(e: { data: unknown }): void {
    const m = e.data as Obj | null
    if (!m || typeof m !== 'object') return
    if (m.t === 'init') void init(m)
    else if (m.t === 'frame') frame(m)
  }

  const onFirst = (e: { data: unknown; ports?: readonly unknown[] }): void => {
    const data = e.data as { t?: unknown; port?: unknown } | null
    const p = (e.ports?.[0] ?? data?.port) as Port | undefined
    if (!p || port) return
    port = p
    scope.removeEventListener('message', onFirst)
    if (options.harden !== false) harden()
    p.onmessage = onPortMessage
    p.start?.()
  }
  scope.addEventListener('message', onFirst)
}

/**
 * Source of the sandbox Worker (a classic script): the runtime above, started on the Worker's global scope, with a loader
 * that imports `script.js` from a `blob:` URL (the sandbox CSP allows `blob:` scripts only).
 */
export function workerSource(): string {
  const load = `async (code) => {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  try {
    return await import(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}`
  return `(${scriptRuntime.toString()})(self, { load: ${load} });\n`
}
