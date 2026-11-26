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
 * `.invalidate()`. Each draw starts from a transparent canvas; its image goes to the engine as premultiplied RGBA
 * pixels (a transferred `Uint8ClampedArray`, not copied), which the layer uploads to the GPU.
 *
 * The canvases are CPU-backed (`willReadFrequently`) and read with `getImageData`: drawing and reading them never wait
 * on the browser's GPU process. A GPU-backed canvas would hand over an `ImageBitmap` (`transferToImageBitmap`), but
 * each transfer waits for the GPU process, which is busy with the engine's own rendering: under load (software WebGL,
 * 2 CPU cores) it took about 1 s per draw, and the watchdog stopped scripts that never looped (#158). Canvases are
 * small (spec §12.6), so reading them back is cheap (0.5 ms for 192 × 192 px). The first use of a canvas is slow (a
 * few hundred ms under load): `init` draws and reads each canvas once before it tells the engine that the script
 * starts (`started`), so that this cost is not counted by the watchdog (spec §12.7).
 *
 * The filter's font assets are registered in the Worker's font set (`self.fonts`) under their asset name before
 * `setup`, from the bytes the engine sends: a `draw` function writes `ctx.font = '24px title'`. Without `FontFace` in
 * the Worker, canvas text falls back to the platform's fonts, with one warning.
 *
 * Messages (structured clone over the port):
 * - engine → runtime: `{ t: 'init', code, layers, canvases, params, seed, clock, assets, fonts, blendshapes? }`,
 *   `{ t: 'frame', seq, time, dt, aspect, clock, faces, blendshapes?, pairs?, params?, seed?, events }`.
 * - runtime → engine: `{ t: 'started' }` once the runtime has prepared the canvases and fonts and starts the script
 *   (`script.js` and `setup`), `{ t: 'done', seq, commands, emits, warnings, images?, idle? }` (`seq` 0 answers
 *   `init`), `{ t: 'fatal', message }` when `script.js` cannot be loaded, `{ t: 'wake' }` when an idle script needs a
 *   frame after all (below).
 *
 * **Idle scripts** (#129): a script without `update` has nothing to do at a frame that brings no event, no due timer
 * and no due canvas draw. Its answers then carry `idle`: when its next timer is due (script clock, ms) and when its
 * next canvas draw is (media time, s). The engine sends it no frame until one of them is due or an event is queued,
 * which spares the rendering thread the cost of a frame (structured clone, `postMessage`, the answer): what the script
 * sees does not change, since only `update` and `draw` read `frame`, and `frame.dt` covers the frames not sent. What
 * a script does between frames (after an `await`: commands, messages, timers, `invalidate()`) goes with the next
 * answer, as before: an idle script then says `wake`, once, and the engine sends it a frame.
 */

/** A face as sent by the engine; the runtime adds `state`, and `blendshapes` from `WireFrame.blendshapes`. */
export interface WireFace {
  id: number
  index: number
  pose?: { yaw: number; pitch: number; roll: number }
  size?: number
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
  /** Font assets registered in the Worker for the canvases, by asset name (copied). */
  fonts?: WireFont[]
  /**
   * Names of the scores of `WireFrame.blendshapes`, in order (`face.blendshapes`, spec §12.4); the first one
   * (`_neutral`) is not given to the script.
   */
  blendshapes?: string[]
}

/** A font asset for the script's canvases (spec §12.6). */
export interface WireFont {
  /** Asset name: the family a `draw` function writes in `ctx.font`. */
  name: string
  /** The font file (WOFF2, WOFF, TTF, OTF). */
  data: ArrayBuffer
  /** CSS `font-weight` and `font-style` of the face (a built-in font's own; `normal` for a package font). */
  weight: string
  style: string
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
  /** Displayed width / height (spec §12.4). */
  aspect: number
  clock: number
  faces: WireFace[]
  /**
   * The blendshape scores of `faces` (`uses: ["face.blendshapes"]`): `blendshapes.length` (of `WireInit`) per face, in
   * the order of `faces`. Absent while the engine has dropped them (spec §16.2). One typed array rather than an object
   * per face: the engine reuses it and the structured clone copies it, so it allocates nothing per frame (#129).
   */
  blendshapes?: Float32Array
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
  /**
   * Canvas images drawn for this answer: `[layer index, pixels]`, premultiplied RGBA, top row first, `width` ×
   * `height` of the canvas (transferred).
   */
  images?: Array<[number, Uint8ClampedArray]>
  /**
   * Present when the script has nothing to do at a frame without events (no `update`, no canvas to draw at the next
   * frame): the engine may send no frame until `timer` (script clock, ms: the next `f.after` / `f.every`) or `draw`
   * (media time, s: the next canvas draw allowed by `fps`) is due, the media time goes back, or an event is queued.
   */
  idle?: WireIdle
}

/** When an idle script needs its next frame (`WireDone.idle`); a missing field never does. */
export interface WireIdle {
  timer?: number
  draw?: number
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
  /** Where the filter's fonts are registered (default: the global `FontFace` and `fonts`; the Node tests pass fakes). */
  fonts?: RuntimeFonts
}

/** What the runtime uses of the CSS Font Loading API in its Worker (either may be missing in a browser). */
export interface RuntimeFonts {
  FontFace: (new (family: string, source: ArrayBuffer, descriptors: { weight: string; style: string }) => { load(): Promise<unknown> }) | undefined
  set: { add(face: unknown): unknown } | undefined
}

/** What the runtime uses of an `OffscreenCanvas`. */
export interface RuntimeCanvas {
  width: number
  height: number
  /** The context must have `getImageData` too. */
  getContext(type: '2d', options: { willReadFrequently: boolean }): unknown
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
    getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray }
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
    'onmessage', 'Request', 'Response', 'Headers', 'Notification', 'RTCPeerConnection', 'webkitRTCPeerConnection',
    'RTCDataChannel', 'ServiceWorker',
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
  type Face = { load(): Promise<unknown> }
  const FF = options.fonts !== undefined ? options.fonts.FontFace : (globalThis as unknown as { FontFace?: RuntimeFonts['FontFace'] }).FontFace
  const fontSet = options.fonts !== undefined ? options.fonts.set : (globalThis as unknown as { fonts?: RuntimeFonts['set'] }).fonts
  const makeCanvas = options.canvas ?? ((w: number, h: number): RuntimeCanvas => {
    if (!OC) throw new Error('OffscreenCanvas is not available in this browser, so canvas layers cannot be drawn.')
    return new OC(w, h)
  })

  let port: Port | undefined
  let def: Def = {}
  let layerIds: string[] = []
  let blendshapeNames: string[] = []
  let params: Obj = {}
  let assets: Obj = {}
  let canvases: Canvas[] = []
  let images: Array<[number, Uint8ClampedArray]> = []
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
  /** The last answer said `idle` and no frame came since: what the script does now needs one (`wake`). */
  let sleeping = false

  /** The script did something between frames that goes with the next answer: an idle script asks for a frame. */
  function wake(): void {
    if (!sleeping) return
    sleeping = false
    port!.postMessage({ t: 'wake' })
  }

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
    wake()
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
          wake()
          commands.push(['set', index, key, props])
        },
        animate(props: unknown, opts: unknown) {
          if (!props || typeof props !== 'object') throw new TypeError('.animate(props, options): props must be an object.')
          const o = (opts ?? {}) as Obj
          if (typeof o.duration !== 'number' || !(o.duration >= 0)) throw new TypeError('.animate(props, options): options.duration (ms) is required.')
          wake()
          commands.push(['animate', index, key, props, o])
        },
        play(name: unknown) {
          if (typeof name !== 'string') throw new TypeError('.play(name): name must be a string.')
          wake()
          commands.push(['play', index, key, name])
        },
        invalidate() {
          const c = canvases.find((c) => c.layer === index)
          if (c) {
            wake()
            c.invalid = true
          }
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
    wake()
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
      wake()
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
      if (ok) images.push([c.layer, pixels(c)])
    }
  }

  /** The canvas image, premultiplied (as the engine's textures are): `getImageData` gives straight alpha. */
  function pixels(c: Canvas): Uint8ClampedArray {
    const data = c.ctx.getImageData(0, 0, c.width, c.height).data
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3]!
      if (a === 255) continue
      // Rounded to the nearest (a Uint8ClampedArray rounds): this gives back the canvas's own premultiplied values.
      data[i] = (data[i]! * a) / 255
      data[i + 1] = (data[i + 1]! * a) / 255
      data[i + 2] = (data[i + 2]! * a) / 255
    }
    return data
  }

  /** `WireDone.idle`: undefined when the script needs the next frame whatever happens (spec §12.7, #129). */
  function idle(): WireIdle | undefined {
    if (typeof def.update === 'function') return undefined
    const out: WireIdle = {}
    for (const t of timers) if (!t.cancelled && t.due < (out.timer ?? Infinity)) out.timer = t.due
    for (const c of canvases) {
      if (typeof def.draw?.[c.id] !== 'function') continue
      // Drawn at the next frame: never drawn yet, or invalidated by a draw function.
      if (c.last < 0 || c.invalid) return undefined
      // The test of `draw()`, solved for the time.
      if (c.fps > 0) out.draw = Math.min(out.draw ?? Infinity, c.last + 1 / c.fps - 1e-6)
    }
    return out
  }

  function answer(seq: number): void {
    const message: Obj = { t: 'done', seq, commands, emits, warnings }
    const drawn = images
    if (drawn.length > 0) message.images = drawn
    const next = idle()
    if (next) message.idle = next
    sleeping = next !== undefined
    commands = []
    emits = []
    warnings = []
    images = []
    const transfer = drawn.map(([, data]) => data.buffer)
    try {
      port!.postMessage(message, transfer)
    } catch (error) {
      // A value the script passed cannot be cloned (a function, a DOM object…): report it without the payload. The
      // canvas images were not transferred (cloning failed first): they still go.
      const fallback: Obj = { t: 'done', seq, commands: [], emits: [], warnings: [`The script's commands or messages cannot be sent: ${describe(error)}`] }
      if (drawn.length > 0) fallback.images = drawn
      port!.postMessage(fallback, transfer)
    }
  }

  /**
   * Registers the filter's fonts in the Worker's font set under their asset name (spec §12.6). `FontFace` takes the
   * family as a plain name: a draw function writes `'24px title'`, and quotes a name that is a CSS keyword
   * (`'24px "serif"'`, or `serif` is the generic family).
   */
  async function registerFonts(fonts: WireFont[]): Promise<void> {
    if (fonts.length === 0) return
    if (!FF || !fontSet) {
      warn(`this browser has no FontFace in workers: canvas text is drawn with the platform's fonts instead of the filter's (${fonts.map((f) => `"${f.name}"`).join(', ')})`)
      return
    }
    await Promise.all(
      fonts.map(async (font) => {
        try {
          const face: Face = new FF(font.name, font.data, { weight: font.weight, style: font.style })
          await face.load()
          fontSet.add(face)
        } catch (error) {
          warn(`font "${font.name}" cannot be used in canvases: ${describe(error)}`)
        }
      }),
    )
  }

  async function init(m: Obj): Promise<void> {
    layerIds = m.layers as string[]
    blendshapeNames = (m.blendshapes as string[] | undefined) ?? []
    params = Object.freeze({ ...(m.params as Obj) })
    assets = (m.assets as Obj) ?? {}
    canvases = []
    for (const w of (m.canvases as WireCanvas[] | undefined) ?? []) {
      const id = layerIds[w.layer] ?? ''
      try {
        const canvas = makeCanvas(w.width, w.height)
        // CPU-backed: drawing and reading never wait on the GPU process (see the top of this file).
        const ctx = canvas.getContext('2d', { willReadFrequently: true }) as Context2D | null
        if (!ctx) throw new Error('no 2D context')
        // Its first use is slow (setting up the canvas's memory and raster): paid now, before the script starts.
        ctx.clearRect(0, 0, 1, 1)
        ctx.getImageData(0, 0, 1, 1)
        canvases.push({ layer: w.layer, id, width: w.width, height: w.height, fps: w.fps, canvas, ctx, last: -1, invalid: false })
      } catch (error) {
        warn(`canvas layer "${id}" cannot be drawn: ${describe(error)}`)
      }
    }
    clock = m.clock as number
    seedRandom(m.seed as number)
    // The fonts are ready before `setup` (spec §12.6), as the page's are before the filter is activated (spec §10.4).
    await registerFonts((m.fonts as WireFont[] | undefined) ?? [])
    // From now on the script runs (its module, then `setup`): the engine's watchdog starts counting (spec §12.7).
    port!.postMessage({ t: 'started' })
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
    sleeping = false
    clock = m.clock as number
    if (m.params) params = Object.freeze({ ...(m.params as Obj) })
    if (typeof m.seed === 'number') seedRandom(m.seed)
    byId.clear()
    const scores = m.blendshapes as Float32Array | undefined
    const n = blendshapeNames.length
    faces = (m.faces as Obj[]).map((w, k) => {
      const face = faceObject(w)
      if (scores && n > 0 && scores.length >= (k + 1) * n) {
        const b: Record<string, number> = {}
        for (let i = 1; i < n; i++) b[blendshapeNames[i]!] = scores[k * n + i]!
        face.blendshapes = b
      }
      byId.set(face.id as number, face)
      return face
    })
    const frameData: Obj = { time: m.time, dt: m.dt, aspect: m.aspect, faces }
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
