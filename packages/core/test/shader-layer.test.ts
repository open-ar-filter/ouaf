import {
  BufferGeometry,
  DoubleSide,
  Matrix4,
  Mesh,
  NoColorSpace,
  PerspectiveCamera,
  RawShaderMaterial,
  RepeatWrapping,
  Scene,
  Texture,
  VideoTexture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SHADER_INTERNALS as I, wrapShader } from '@ouaf/spec'
import { checkProgram, type CompileContext } from '../src/layers/shader/compile.ts'
import { ShaderFaceInputs, projectToUv, projectedUnit } from '../src/layers/shader/inputs.ts'
import { createShaderLayer } from '../src/layers/shader/layer.ts'
import { createStickerAsset, type StickerAsset } from '../src/layers/sticker/assets.ts'
import { OuafError } from '../src/engine/errors.ts'
import { ShaderUniforms, UniformTypeError, resolveUniformType } from '../src/layers/shader/uniforms.ts'
import { FaceAnchors } from '../src/engine/anchor-provider.ts'
import {
  NO_FACE,
  ShaderCompileError,
  TRACKER_FOV_Y,
  computeVideoToClip,
  createFaceFrame,
  createVideoToClip,
  estimateFacePoses,
  liveAnchorPosition,
  type AnchorProvider,
  type BindingEnv,
  type FaceFrame,
  type FrameContext,
  type LayerContext,
  type LayerDecl,
  type PassLayer,
} from '../src/index.ts'
import { bytesPerCall } from './allocation.ts'
import { writeSyntheticFace } from './synthetic-face.ts'

/** The objects camera exactly as the compositor sets it up (tracker perspective, cover crop, never mirrored). */
function objectsCamera(vw: number, vh: number, tw: number, th: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(TRACKER_FOV_Y, vw / vh, 1, 10000)
  const m = computeVideoToClip(vw, vh, tw, th, 'cover', false, createVideoToClip())
  camera.projectionMatrix.premultiply(new Matrix4().makeScale(Math.abs(m.ax) / 2, Math.abs(m.ay) / 2, 1))
  return camera
}

/** Bindings: number / color / vec2 / boolean params, and `face.slot` (face slot + 1, missing without a face). */
function bindingEnv(params: Record<string, unknown>, types: Record<string, string>, faces: FaceFrame): BindingEnv {
  return {
    data: {
      resolve: (path) =>
        path === 'face.slot'
          ? { type: 'number', perFace: true, read: (face, out, i) => void (out[i] = face >= 0 && face < faces.count ? face + 1 : NaN) }
          : path === 'face.name'
            ? { type: 'string', perFace: true, read: () => 'x' }
            : undefined,
    },
    params: { type: (n) => types[n] as never, get: (n) => params[n] },
  }
}

describe('shader uniforms (spec §11)', () => {
  const faces = createFaceFrame(1)

  it('types fixed values, params, maps and data', () => {
    const env = bindingEnv({}, { n: 'number', c: 'color', v: 'vec3', b: 'boolean', s: 'string' }, faces)
    const type = (value: unknown) => resolveUniformType('u', value, env)
    expect([0.5, false, [1, 2], [1, 2, 3], '#ff000080'].map(type)).toEqual(['float', 'bool', 'vec2', 'vec3', 'vec4'])
    expect(['n', 'c', 'v', 'b'].map((p) => type({ param: p }))).toEqual(['float', 'vec4', 'vec3', 'bool'])
    expect(type({ bind: 'face.slot' })).toBe('float')
    expect(type({ bind: 'face.slot', range: [0, 1], to: [2, 3] })).toBe('float')
    expect(type({ bind: 'face.name', map: { x: '#ff0000', y: '#00ff00' } })).toBe('vec4')
    for (const bad of ['red', { param: 's' }, { param: 'nope' }, { bind: 'face.name' }, { bind: 'face.name', map: { x: 1, y: true } }]) {
      expect(() => type(bad), JSON.stringify(bad)).toThrow(UniformTypeError)
    }
  })

  it('writes the current values into the uniform objects, for the first face', () => {
    const params: Record<string, unknown> = { c: '#ff0000', v: [1, 2] }
    const env = bindingEnv(params, { c: 'color', v: 'vec2' }, faces)
    const u = new ShaderUniforms({ f: 0.25, b: true, c: { param: 'c' }, v: { param: 'v' }, d: { bind: 'face.slot', default: -1 } }, env)
    expect(u.declarations).toEqual([['f', 'float'], ['b', 'bool'], ['c', 'vec4'], ['v', 'vec2'], ['d', 'float']])
    u.update(NO_FACE)
    expect(u.uniforms.f!.value).toBe(0.25)
    expect(u.uniforms.b!.value).toBe(true)
    expect([...(u.uniforms.c!.value as Float32Array)]).toEqual([1, 0, 0, 1])
    expect([...(u.uniforms.v!.value as Float32Array)]).toEqual([1, 2])
    expect(u.uniforms.d!.value).toBe(-1)
    faces.count = 1
    params.c = '#00ff0080'
    params.v = [3, 4]
    u.update(0)
    expect([...(u.uniforms.c!.value as Float32Array)].map((x) => Math.round(x * 255))).toEqual([0, 255, 0, 128])
    expect([...(u.uniforms.v!.value as Float32Array)]).toEqual([3, 4])
    expect(u.uniforms.d!.value).toBe(1)
    faces.count = 0
  })

  it('does not allocate per frame', () => {
    const local = createFaceFrame(1)
    local.count = 1
    const VEC = [0.1, 0.2, 0.3]
    const x = new Float64Array(1) // a changing value, without allocating in the test itself
    const env: BindingEnv = {
      data: { resolve: () => ({ type: 'number', perFace: true, read: (_f, out, i) => void (out[i] = x[0] = (x[0]! + 0.37) % 1) }) },
      params: { type: () => 'vec3', get: () => VEC },
    }
    const u = new ShaderUniforms({ a: { bind: 'face.x' }, b: { param: 'p' }, c: '#123456', d: true }, env)
    expect(bytesPerCall(() => u.update(0))).toBeLessThan(1)
  })
})

describe('shader face inputs (spec §11.1)', () => {
  it('projects camera-space points to uv, origin at the bottom left', () => {
    const camera = objectsCamera(1280, 720, 1280, 720)
    const p = camera.projectionMatrix.elements
    const out = new Float32Array(2)
    expect(projectToUv(p, [0, 0, -60], 0, out, 0)).toBe(true)
    expect([...out]).toEqual([0.5, 0.5])
    projectToUv(p, [10, 5, -60], 0, out, 0)
    expect(out[0]).toBeGreaterThan(0.5)
    expect(out[1]).toBeGreaterThan(0.5)
    expect(projectToUv(p, [0, 0, 60], 0, out, 0)).toBe(false)
    const m = new Matrix4().makeScale(6.3, 6.3, 6.3).setPosition(0, 0, -60).elements
    const size = new Float32Array(1)
    projectedUnit(p, m, size, 0)
    expect(size[0]).toBeCloseTo((6.3 * p[5]!) / (2 * 60), 6)
  })

  it('places the anchors where the video shows them, mirrored or not, and sizes the faces', () => {
    for (const mirrored of [false, true]) {
      for (const [tw, th] of [[1280, 720], [720, 1280]] as const) {
        const faces = createFaceFrame(2)
        faces.count = 1
        writeSyntheticFace(faces, 0, { yaw: 20, roll: -10, t: [6, 3, -50] })
        estimateFacePoses(faces)
        const camera = objectsCamera(faces.width, faces.height, tw, th)
        const anchors = new FaceAnchors(faces, camera)
        anchors.setFrame(faces, [1], mirrored)
        const inputs = new ShaderFaceInputs(2, ['noseTip', 'leftEye'], true)
        inputs.update(anchors, faces.count, camera.projectionMatrix.elements)
        expect(inputs.count).toBe(1)
        const v = computeVideoToClip(faces.width, faces.height, tw, th, 'cover', mirrored, createVideoToClip())
        ;(['noseTip', 'leftEye'] as const).forEach((anchor, a) => {
          const live = { x: 0, y: 0, z: 0 }
          liveAnchorPosition(faces, 0, anchor, live)
          const u = (v.ax * live.x + v.bx) / 2 + 0.5
          const w = (v.ay * live.y + v.by) / 2 + 0.5
          const label = `${anchor} ${tw}×${th} mirrored=${mirrored}`
          expect(Math.abs(inputs.positions[a]![0]! - u) * tw, label).toBeLessThan(2) // pixels
          expect(Math.abs(inputs.positions[a]![1]! - w) * th, label).toBeLessThan(2)
        })
        // Face size: the projected eye distance, in image heights (≈ the eye centres' distance on screen).
        const l = { x: 0, y: 0, z: 0 }
        const r = { x: 0, y: 0, z: 0 }
        liveAnchorPosition(faces, 0, 'leftEye', l)
        liveAnchorPosition(faces, 0, 'rightEye', r)
        const dx = ((v.ax * (l.x - r.x)) / 2) * tw
        const dy = ((v.ay * (l.y - r.y)) / 2) * th
        const eyes = Math.hypot(dx, dy) / th
        // The head is turned (yaw 20°): the eyes look closer than one unit seen from the front.
        expect(inputs.sizes[0]! * Math.cos((20 * Math.PI) / 180)).toBeCloseTo(eyes, 1)
      }
    }
  })

  it('does not allocate per frame', () => {
    const faces = createFaceFrame(2)
    faces.count = 2
    writeSyntheticFace(faces, 0, { t: [-8, 0, -60] })
    writeSyntheticFace(faces, 1, { t: [8, 0, -60] })
    estimateFacePoses(faces)
    const camera = objectsCamera(faces.width, faces.height, 1280, 720)
    const anchors = new FaceAnchors(faces, camera)
    anchors.setFrame(faces, [1, 2], false)
    const inputs = new ShaderFaceInputs(2, ['noseTip', 'mouth'], true)
    expect(bytesPerCall(() => inputs.update(anchors, 2, camera.projectionMatrix.elements))).toBeLessThan(1)
  })
})

/** A WebGL stub whose fragment shader compiles, or fails with `log`. */
function stubGl(log?: string): { gl: CompileContext; sources: string[] } {
  const sources: string[] = []
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    isContextLost: () => false,
    createShader: (type: number) => ({ type }),
    shaderSource: (_s: unknown, src: string) => void sources.push(src),
    compileShader: () => {},
    getShaderParameter: (s: { type: number }) => !(log && s.type === 2),
    getShaderInfoLog: () => log ?? '',
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: () => {},
  }
  return { gl: gl as unknown as CompileContext, sources }
}

describe('checkProgram', () => {
  it('compiles both shaders with #version 300 es and maps errors to author lines', () => {
    const wrapped = wrapShader('vec4 effect(vec2 uv) {\n  return x;\n}\n', { stage: 'post', maxFaces: 1 })
    const ok = stubGl()
    expect(checkProgram(ok.gl, 'void main() {}', wrapped)).toEqual([])
    expect(ok.sources.every((s) => s.startsWith('#version 300 es\n'))).toBe(true)
    const bad = stubGl("ERROR: 0:2: 'x' : undeclared identifier\nERROR: 1 compilation errors.  No code generated.")
    expect(checkProgram(bad.gl, 'void main() {}', wrapped)).toEqual([
      { severity: 'error', line: 2, message: "'x' : undeclared identifier" },
      { severity: 'error', message: 'ERROR: 1 compilation errors.  No code generated.' },
    ])
  })

  it('checks nothing while the context is lost', () => {
    const { gl } = stubGl()
    ;(gl as { isContextLost: () => boolean }).isContextLost = () => true
    expect(checkProgram(gl, '', wrapShader('vec4 effect(vec2 uv) { return vec4(1.0); }', { stage: 'post', maxFaces: 1 }))).toBeUndefined()
  })
})

describe('shader layer', () => {
  const EFFECT = 'vec4 effect(vec2 uv) {\n  return ouaf_sample(uv);\n}\n'

  async function setup(
    decl: Record<string, unknown>,
    options: {
      source?: string
      log?: string
      params?: Record<string, unknown>
      types?: Record<string, string>
      requiresFace?: boolean
      warnings?: string[]
      /** Loaded assets by reference (textures); any other reference gives the source. */
      assets?: Record<string, unknown>
      /** The GPU context is lost. */
      lost?: boolean
    } = {},
  ) {
    const faces: FaceFrame = createFaceFrame(2)
    const anchors: AnchorProvider = {
      face: (face, _anchor, _follow, m) => (face < faces.count ? (m.makeScale(6.3, 6.3, 6.3).setPosition(face * 10, 0, -60), true) : false),
      screen: (m) => void m.identity(),
      id: (face) => (face < faces.count ? face + 1 : 0),
    }
    const { gl } = stubGl(options.log)
    if (options.lost) (gl as { isContextLost: () => boolean }).isContextLost = () => true
    const assets = options.assets ?? {}
    const ctx = {
      filterId: 'test',
      renderer: { getContext: () => gl } as unknown as LayerContext['renderer'],
      view: { camera: objectsCamera(1280, 720, 1280, 720) },
      assets: { get: <T,>(ref: string) => (ref in assets ? assets[ref] : (options.source ?? EFFECT)) as T, has: () => true },
      params: {} as LayerContext['params'],
      bindings: bindingEnv(options.params ?? {}, options.types ?? {}, faces),
      maxFaces: 2,
      ...(options.requiresFace !== undefined ? { requiresFace: options.requiresFace } : {}),
      random: Math.random,
      warn: (m: string) => void options.warnings?.push(m),
    } satisfies LayerContext
    const layer = (await createShaderLayer({ type: 'shader', src: 'assets/fx.frag', ...decl } as LayerDecl, ctx)) as PassLayer
    const frame: FrameContext = { time: 1.5, now: 0, dt: 20, faces, anchors, width: 1280, height: 720, mirrored: false }
    return { layer, frame, faces }
  }

  it('runs in the stage it declares and is marked as author code', async () => {
    for (const [stage, expected] of [[undefined, 'color'], ['post', 'color'], ['face', 'face'], ['background', 'background']] as const) {
      const { layer } = await setup(stage ? { stage } : {})
      expect(layer.kind).toBe('pass')
      expect(layer.stage).toBe(expected)
      expect(layer.authorShader).toBe(true)
      layer.dispose()
    }
  })

  it('is active unless hidden or transparent; on the face stage, only with a face', async () => {
    const params: Record<string, unknown> = { o: 1, on: true }
    const post = await setup({ opacity: { param: 'o' }, visible: { param: 'on' } }, { params, types: { o: 'number', on: 'boolean' } })
    post.layer.update(post.frame)
    expect(post.layer.active).toBe(true)
    params.o = 0
    post.layer.update(post.frame)
    expect(post.layer.active).toBe(false)
    params.o = 1
    params.on = false
    post.layer.update(post.frame)
    expect(post.layer.active).toBe(false)

    const face = await setup({ stage: 'face' })
    face.layer.update(face.frame)
    expect(face.layer.active).toBe(false)
    face.faces.count = 1
    face.layer.update(face.frame)
    expect(face.layer.active).toBe(true)
  })

  it('rejects a source that breaks the rules of §11 or does not compile, with author lines', async () => {
    const reject = async (options: Parameters<typeof setup>[1], decl: Record<string, unknown> = {}) => {
      try {
        await setup(decl, options)
      } catch (e) {
        return e as ShaderCompileError
      }
      throw new Error('no error')
    }
    const main = await reject({ source: '// no main\nvoid main() {}\n' })
    expect(main).toBeInstanceOf(ShaderCompileError)
    expect(main.details.map((d) => [d.line, d.message.slice(0, 30)])).toEqual([
      [2, 'Shaders must not define main()'],
      [undefined, 'The shader does not define vec'],
    ])
    const compile = await reject({ log: "ERROR: 0:2: 'x' : undeclared identifier" })
    expect(compile.details).toEqual([{ severity: 'error', line: 2, message: "'x' : undeclared identifier" }])
    expect(compile.message).toBe(`Filter "test": shader "assets/fx.frag" does not compile:\n  line 2: 'x' : undeclared identifier`)
    const name = await reject({}, { uniforms: { 'my-amount': 1 } })
    expect(name.details[0]!.message).toContain('"my-amount" is not a GLSL identifier')
    const type = await reject({ types: { s: 'string' } }, { uniforms: { u: { param: 's' } } })
    expect(type.details[0]!.message).toContain('parameter "s" has type "string"')
  })

  it('warns at load when the source uses a face input without requires.face, and loads anyway (spec §11.1)', async () => {
    const source = 'vec4 effect(vec2 uv) { return ouaf_sample(uv) * ouaf_faceMask(uv) * float(ouaf_faceCount); }'
    const warnings: string[] = []
    const { layer } = await setup({ id: 'mask' }, { source, requiresFace: false, warnings })
    expect(warnings).toEqual([
      'shader layer "mask" (assets/fx.frag) uses ouaf_faceMask, ouaf_faceCount, which need "requires": { "face": true }: ' +
        'without it no face is tracked, so they read as no face (empty mask, 0 faces).',
    ])
    expect(layer.kind).toBe('pass')
    layer.dispose()
    // With requires.face, with no face input (comments do not count), or outside a filter: no warning.
    const quiet: string[] = []
    for (const options of [
      { source, requiresFace: true },
      { source: '// ouaf_faceMask(uv)\n' + EFFECT, requiresFace: false },
      { source },
    ]) (await setup({}, { ...options, warnings: quiet })).layer.dispose()
    expect(quiet).toEqual([])
  })

  it('does not allocate per frame', async () => {
    const { layer, frame, faces } = await setup(
      { stage: 'face', anchors: ['noseTip'], uniforms: { a: { bind: 'face.slot' }, b: [1, 2] } },
      { source: 'vec4 effect(vec2 uv) { return vec4(ouaf_faceSize[0] + ouaf_anchor_noseTip[0].x); }' },
    )
    faces.count = 2
    expect(bytesPerCall(() => layer.update(frame))).toBeLessThan(1)
  })

  /** A renderer that records its calls: targets, clears and draws (by material: effect, copy or mask). */
  function recorder() {
    const calls: string[] = []
    const names = new Map<unknown, string>()
    const name = (target: unknown) => {
      if (target === null) return 'canvas'
      if (!names.has(target)) names.set(target, (target as { name?: string }).name || `t${names.size}`)
      return names.get(target)!
    }
    const kind = (scene: Scene) => {
      const m = (scene.children[0] as Mesh<BufferGeometry, RawShaderMaterial>).material
      return 'ouaf_src' in m.uniforms ? 'copy' : I.input in m.uniforms ? 'effect' : 'mask'
    }
    const effects: RawShaderMaterial[] = []
    const copies: RawShaderMaterial[] = []
    let current: WebGLRenderTarget | null = null
    const renderer = {
      setRenderTarget: (t: WebGLRenderTarget | null) => void (current = t),
      clear: () => void calls.push(`clear ${name(current)}${current ? ` ${current.width}×${current.height}` : ''}`),
      render: (scene: Scene) => {
        const k = kind(scene)
        const m = (scene.children[0] as Mesh<BufferGeometry, RawShaderMaterial>).material
        if (k === 'effect' && !effects.includes(m)) effects.push(m)
        if (k === 'copy' && !copies.includes(m)) copies.push(m)
        calls.push(`${k} → ${name(current)}`)
      },
    }
    return { renderer: renderer as unknown as WebGLRenderer, calls, effects, copies }
  }

  const OUTPUT = { name: 'out' } as unknown as WebGLRenderTarget
  const INPUT = new Texture()

  it('renders a full-screen pass into the output, with the engine inputs of the frame (spec §11.1)', async () => {
    const params: Record<string, unknown> = { o: 2 }
    const { layer, frame, faces } = await setup({ opacity: { param: 'o' } }, { params, types: { o: 'number' } })
    faces.count = 1
    layer.update(frame)
    const r = recorder()
    layer.render({ renderer: r.renderer, input: INPUT, output: OUTPUT, drawFullscreen: () => {} })
    expect(r.calls).toEqual(['effect → out'])
    const u = r.effects[0]!.uniforms
    expect(u[I.input]!.value).toBe(INPUT)
    expect([...(u[I.frame]!.value as Float32Array)]).toEqual([1.5, Math.fround(0.02), 1280, 720]) // time (s), dt (s), size (px)
    expect(u[I.opacity]!.value).toBe(1) // clamped to 0–1
    expect(u.ouaf_faceCount!.value).toBe(1)
    params.o = 0.5
    layer.update(frame)
    expect(u[I.opacity]!.value).toBe(0.5)
    params.o = -1
    layer.update(frame)
    expect(layer.active).toBe(false)
    layer.dispose()
  })

  it('on the face stage, copies the image then draws the effect over it on the face mesh', async () => {
    const { layer, frame, faces } = await setup({ stage: 'face' })
    faces.count = 2
    writeSyntheticFace(faces, 0, { t: [-8, 0, -60] })
    writeSyntheticFace(faces, 1, { t: [8, 0, -60] })
    layer.update(frame)
    const r = recorder()
    layer.render({ renderer: r.renderer, input: INPUT, output: null, drawFullscreen: () => {} })
    expect(r.calls).toEqual(['copy → canvas', 'effect → canvas'])
    expect(r.copies[0]!.uniforms.ouaf_src!.value).toBe(INPUT)
    expect(r.effects[0]!.side).toBe(DoubleSide)
    layer.dispose()
  })

  it('keeps the previous output for ouaf_prevFrame: black at the first frame and after a resize, then swapped each frame', async () => {
    const { layer, frame } = await setup({}, { source: 'vec4 effect(vec2 uv) { return mix(ouaf_sample(uv), ouaf_prevFrame(uv), 0.5); }' })
    const r = recorder()
    const pass = { renderer: r.renderer, input: INPUT, output: OUTPUT, drawFullscreen: () => {} }
    layer.update(frame)
    layer.render(pass)
    // Both buffers cleared at the render size, the effect into the first, then copied to the output.
    expect(r.calls).toEqual(['clear t0 1280×720', 'clear t1 1280×720', 'effect → t0', 'copy → out'])
    const u = r.effects[0]!.uniforms
    const copied = r.copies[0]!.uniforms.ouaf_src!.value
    const before = u[I.prev]!.value // the other buffer
    expect(before).toBeInstanceOf(Texture)
    expect(before).not.toBe(copied)
    r.calls.length = 0
    layer.render(pass)
    expect(r.calls).toEqual(['effect → t1', 'copy → out'])
    // Now the previous frame is the one drawn first, and the copy reads the other buffer.
    expect(u[I.prev]!.value).toBe(copied)
    expect(r.copies[0]!.uniforms.ouaf_src!.value).toBe(before)
    r.calls.length = 0
    layer.update({ ...frame, width: 640, height: 360 })
    layer.render(pass)
    expect(r.calls).toEqual(['clear t0 640×360', 'clear t1 640×360', 'effect → t0', 'copy → out'])
    layer.dispose()
  })

  it('draws the face ovals into a half-resolution mask for ouaf_faceMask, only when a face is tracked', async () => {
    const { layer, frame, faces } = await setup({}, { source: 'vec4 effect(vec2 uv) { return ouaf_sample(uv) * ouaf_faceMask(uv); }' })
    const r = recorder()
    const pass = { renderer: r.renderer, input: INPUT, output: OUTPUT, drawFullscreen: () => {} }
    layer.update({ ...frame, width: 1281, height: 721 })
    layer.render(pass)
    expect(r.calls).toEqual(['clear t0 641×361', 'effect → out']) // no face: an empty mask
    faces.count = 1
    writeSyntheticFace(faces, 0, { t: [0, 0, -60] })
    r.calls.length = 0
    layer.update(frame)
    layer.render(pass)
    expect(r.calls).toEqual(['clear t0 640×360', 'mask → t0', 'effect → out'])
    expect(r.effects[0]!.uniforms[I.mask]!.value).toBeInstanceOf(Texture)
    layer.dispose()
  })

  describe('textures', () => {
    afterEach(() => vi.unstubAllGlobals())

    const image = (width: number, height: number) => ({ width, height, close: vi.fn() })
    const asset = (kind: StickerAsset['kind'], source: unknown, video?: HTMLVideoElement): StickerAsset =>
      createStickerAsset({
        kind,
        texture: new Texture(source),
        textureWidth: 8,
        textureHeight: 8,
        width: 8,
        height: 8,
        frames: undefined,
        packed: false,
        video,
        owner: undefined,
      })

    it('samples an image through a flipped, straight-alpha copy, repeated, released with the layer', async () => {
      const copies: Array<[unknown, unknown]> = []
      const copy = image(8, 8)
      vi.stubGlobal('createImageBitmap', async (source: unknown, options: unknown) => (copies.push([source, options]), copy))
      const original = image(8, 8)
      const { layer, frame } = await setup({ textures: { u_logo: 'logo' } }, { source: 'vec4 effect(vec2 uv) { return texture(u_logo, uv); }', assets: { logo: asset('image', original) } })
      expect(copies).toEqual([[original, { imageOrientation: 'flipY', premultiplyAlpha: 'none' }]])
      const r = recorder()
      layer.update(frame)
      layer.render({ renderer: r.renderer, input: INPUT, output: OUTPUT, drawFullscreen: () => {} })
      const t = r.effects[0]!.uniforms.u_logo!.value as Texture
      expect(t.image).toBe(copy)
      expect([t.flipY, t.premultiplyAlpha, t.wrapS, t.wrapT, t.generateMipmaps, t.colorSpace]).toEqual([false, false, RepeatWrapping, RepeatWrapping, true, NoColorSpace])
      layer.dispose()
      expect(copy.close).toHaveBeenCalledOnce()
      expect(original.close).not.toHaveBeenCalled() // the asset's own bitmap stays with the asset
    })

    it('plays a video in a loop, driven by the first layer that uses it, and stops it when that layer goes', async () => {
      const video = { loop: false, play: vi.fn(() => Promise.reject(new Error('not allowed'))), pause: vi.fn() } as unknown as HTMLVideoElement
      const clip = asset('video', video, video)
      const source = 'vec4 effect(vec2 uv) { return texture(u_clip, uv); }'
      const first = await setup({ textures: { u_clip: 'clip' } }, { source, assets: { clip } })
      expect(clip.owner).toBeDefined()
      expect(video.loop).toBe(true)
      expect(video.play).toHaveBeenCalledOnce() // a refused play() is ignored
      const second = await setup({ textures: { u_clip: 'clip' } }, { source, assets: { clip } })
      expect(video.play).toHaveBeenCalledOnce()
      const r = recorder()
      first.layer.update(first.frame)
      first.layer.render({ renderer: r.renderer, input: INPUT, output: OUTPUT, drawFullscreen: () => {} })
      const t = r.effects[0]!.uniforms.u_clip!.value as VideoTexture
      expect(t).toBeInstanceOf(VideoTexture)
      expect(t.image).toBe(video)
      expect([t.flipY, t.wrapS, t.generateMipmaps]).toEqual([true, RepeatWrapping, false])
      second.layer.dispose() // not the owner: the video plays on
      expect(video.pause).not.toHaveBeenCalled()
      first.layer.dispose()
      expect(video.pause).toHaveBeenCalledOnce()
      expect(clip.owner).toBeUndefined()
    })

    it('rejects a texture that is not an image or a video, releasing the ones made before', async () => {
      const copy = image(8, 8)
      vi.stubGlobal('createImageBitmap', async () => copy)
      const error = await setup(
        { textures: { u_a: 'logo', u_b: 'grade' } },
        { source: 'vec4 effect(vec2 uv) { return texture(u_a, uv) + texture(u_b, uv); }', assets: { logo: asset('image', image(8, 8)), grade: { size: 17 } } },
      ).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ShaderCompileError)
      expect((error as ShaderCompileError).details).toEqual([{ severity: 'error', message: 'texture "u_b" ("grade") is not an image or a video.' }])
      expect(copy.close).toHaveBeenCalledOnce()
    })

    it('passes on any other error of a texture as it is', async () => {
      const failure = new OuafError('asset', 'no asset "logo"')
      const assets = {}
      Object.defineProperty(assets, 'logo', { enumerable: true, get: () => { throw failure } })
      const error = await setup({ textures: { u_a: 'logo' } }, { source: 'vec4 effect(vec2 uv) { return texture(u_a, uv); }', assets }).catch((e: unknown) => e)
      expect(error).toBe(failure)
    })
  })

  it('rejects a uniform and a texture of the same name, and a source compiled while the GPU context is lost', async () => {
    const both = await setup({ uniforms: { u: 1 }, textures: { u: 'logo' } }).catch((e: unknown) => e)
    expect(both).toBeInstanceOf(ShaderCompileError)
    expect((both as ShaderCompileError).details).toEqual([{ severity: 'error', message: '"u" is declared both as a uniform and as a texture.' }])
    const lost = await setup({}, { lost: true }).catch((e: unknown) => e)
    expect(lost).toBeInstanceOf(OuafError)
    expect((lost as OuafError).code).toBe('gpu-context-lost')
    expect((lost as OuafError).message).toBe('Filter "test": shader "assets/fx.frag" cannot be compiled while the GPU context is lost.')
  })
})
