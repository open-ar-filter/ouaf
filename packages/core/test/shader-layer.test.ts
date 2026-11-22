import { Matrix4, PerspectiveCamera } from 'three'
import { describe, expect, it } from 'vitest'
import { wrapShader } from '@ouaf/spec'
import { checkProgram, type CompileContext } from '../src/layers/shader/compile.ts'
import { ShaderFaceInputs, projectToUv, projectedUnit } from '../src/layers/shader/inputs.ts'
import { createShaderLayer } from '../src/layers/shader/layer.ts'
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
import { heapGrowth, writeSyntheticFace } from './synthetic-face.ts'

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
    expect(heapGrowth(() => u.update(0))).toBeLessThan(64 * 1024)
  })
})

describe('shader face inputs (spec §11.1)', () => {
  it('projects camera-space points to uv, origin at the bottom left', () => {
    const camera = objectsCamera(1280, 720, 1280, 720)
    const p = camera.projectionMatrix.elements
    const out = new Float32Array(2)
    expect(projectToUv(p, 0, 0, -60, out, 0)).toBe(true)
    expect([...out]).toEqual([0.5, 0.5])
    projectToUv(p, 10, 5, -60, out, 0)
    expect(out[0]).toBeGreaterThan(0.5)
    expect(out[1]).toBeGreaterThan(0.5)
    expect(projectToUv(p, 0, 0, 60, out, 0)).toBe(false)
    const m = new Matrix4().makeScale(6.3, 6.3, 6.3).setPosition(0, 0, -60).elements
    expect(projectedUnit(p, m)).toBeCloseTo((6.3 * p[5]!) / (2 * 60), 6)
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
    expect(heapGrowth(() => inputs.update(anchors, 2, camera.projectionMatrix.elements))).toBeLessThan(64 * 1024)
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

  async function setup(decl: Record<string, unknown>, options: { source?: string; log?: string; params?: Record<string, unknown>; types?: Record<string, string> } = {}) {
    const faces: FaceFrame = createFaceFrame(2)
    const anchors: AnchorProvider = {
      face: (face, _anchor, _follow, m) => (face < faces.count ? (m.makeScale(6.3, 6.3, 6.3).setPosition(face * 10, 0, -60), true) : false),
      screen: (m) => void m.identity(),
      id: (face) => (face < faces.count ? face + 1 : 0),
    }
    const { gl } = stubGl(options.log)
    const ctx = {
      filterId: 'test',
      renderer: { getContext: () => gl } as unknown as LayerContext['renderer'],
      view: { camera: objectsCamera(1280, 720, 1280, 720) },
      assets: { get: <T,>() => (options.source ?? EFFECT) as T, has: () => true },
      params: {} as LayerContext['params'],
      bindings: bindingEnv(options.params ?? {}, options.types ?? {}, faces),
      maxFaces: 2,
      warn: () => {},
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

  it('does not allocate per frame', async () => {
    const { layer, frame, faces } = await setup(
      { stage: 'face', anchors: ['noseTip'], uniforms: { a: { bind: 'face.slot' }, b: [1, 2] } },
      { source: 'vec4 effect(vec2 uv) { return vec4(ouaf_faceSize[0] + ouaf_anchor_noseTip[0].x); }' },
    )
    faces.count = 2
    expect(heapGrowth(() => layer.update(frame))).toBeLessThan(64 * 1024)
  })
})
