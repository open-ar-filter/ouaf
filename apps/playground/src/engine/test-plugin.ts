/**
 * A third-party plugin for the engine page and the browser tests: it exercises both kinds of layer instances
 * (spec §6, §7) before the real v1 layer types land, and shows how a non-official plugin prefixes its vocabulary.
 *
 * - `playground:tint` (pass, `color` stage): multiplies the image by a color, mixed by `amount` (a param or a number).
 * - `playground:dot` (object): a flat colored disc at a face anchor (or the screen centre), `size` in anchor units.
 * - `playground:probe` (object, draws nothing): records each frame it sees into `window.ouafProbe` (time, faces, the
 *   first landmark, one draw of the layer's seeded generator), for the source tests (#32).
 * - `playground:busy` (object, draws nothing): blocks the main thread `ms` per drawn frame, like a heavy filter, for
 *   the device adaptation tests (#90): drawing it slows a main-thread tracker down, hiding it frees it. Plus
 *   `msPerMegapixel` (bindable) per million pixels of the internal resolution: a cost that follows the resolution, as
 *   a fill-bound GPU's does, to test the adaptive rendering resolution (#34) on any machine.
 */
import type { LayerContext, LayerDecl, ObjectLayer, OuafPlugin, PassLayer } from '@ouaf/core'
import { FULLSCREEN_VERTEX, compileNumberBinding } from '@ouaf/core'
import { Bindable } from '@ouaf/spec'
import { Type } from 'typebox'
import { CircleGeometry, Color, GLSL3, Group, Matrix4, Mesh, MeshBasicMaterial, RawShaderMaterial, Vector4 } from 'three'

const TintSchema = Type.Object(
  {
    type: Type.Literal('playground:tint'),
    id: Type.Optional(Type.String()),
    color: Type.String({ pattern: '^#[0-9a-fA-F]{6}$' }),
    amount: Type.Optional(Bindable(Type.Number({ minimum: 0, maximum: 1 }))),
  },
  { additionalProperties: false },
)

const DotSchema = Type.Object(
  {
    type: Type.Literal('playground:dot'),
    id: Type.Optional(Type.String()),
    anchor: Type.Optional(Type.String()),
    color: Type.String({ pattern: '^#[0-9a-fA-F]{6}$' }),
    size: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  },
  { additionalProperties: false },
)

const TINT_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uInput;
uniform vec4 uTint; // rgb, amount
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 c = texture(uInput, vUv);
  fragColor = vec4(mix(c.rgb, c.rgb * uTint.rgb, uTint.a), 1.0);
}
`

/**
 * `amount` is bindable (spec §8): a number, `{ "param": … }` or `{ "bind": … }`, compiled once and evaluated every
 * frame without allocating. A full-screen pass reads the first face.
 */
function readAmount(decl: LayerDecl, ctx: LayerContext): () => number {
  const binding = compileNumberBinding(decl.amount ?? 1, { fallback: 1, path: 'amount' }, ctx.bindings)
  const out = new Float64Array(1)
  return () => {
    binding.write(0, out, 0)
    return out[0]!
  }
}

function createTint(decl: LayerDecl, ctx: LayerContext): PassLayer {
  const color = new Color(String(decl.color))
  const uTint = { value: new Vector4(color.r, color.g, color.b, 1) }
  const uInput = { value: null as unknown }
  const material = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: TINT_FRAGMENT,
    uniforms: { uInput, uTint },
    depthTest: false,
    depthWrite: false,
  })
  const amount = readAmount(decl, ctx)
  return {
    kind: 'pass',
    stage: 'color',
    get active() {
      return uTint.value.w > 0
    },
    update() {
      uTint.value.w = amount()
    },
    render(pass) {
      uInput.value = pass.input
      pass.drawFullscreen(material)
    },
    dispose() {
      material.dispose()
    },
  }
}

function createDot(decl: LayerDecl, ctx: LayerContext): ObjectLayer {
  const anchor = typeof decl.anchor === 'string' ? decl.anchor : 'noseTip'
  const size = typeof decl.size === 'number' ? decl.size : 0.3
  const root = new Group()
  const geometry = new CircleGeometry(0.5, 32)
  const material = new MeshBasicMaterial({ color: new Color(String(decl.color)), depthTest: false })
  const dots: Mesh[] = []
  for (let i = 0; i < ctx.maxFaces; i++) {
    const m = new Mesh(geometry, material)
    m.matrixAutoUpdate = false
    m.frustumCulled = false
    root.add(m)
    dots.push(m)
  }
  const local = new Matrix4().makeScale(size, size, size)
  const anchorMatrix = new Matrix4()
  return {
    kind: 'object',
    stage: 'objects',
    object: root,
    update(frame) {
      for (let i = 0; i < dots.length; i++) {
        const dot = dots[i]!
        let ok: boolean
        if (anchor === 'screen') {
          frame.anchors.screen(anchorMatrix)
          ok = i === 0
        } else {
          ok = frame.anchors.face(i, anchor, 'auto', anchorMatrix)
        }
        dot.visible = ok
        if (ok) dot.matrix.multiplyMatrices(anchorMatrix, local)
      }
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}

const ProbeSchema = Type.Object({ type: Type.Literal('playground:probe'), id: Type.Optional(Type.String()) }, { additionalProperties: false })

/** One frame as a probe layer saw it. */
export interface ProbeSample {
  time: number
  dt: number
  faces: number
  /** x, y of landmark 0 of face 0 (NaN without a face). */
  x: number
  y: number
  /** One draw of the layer's seeded generator (`ctx.random`). */
  random: number
}

declare global {
  interface Window {
    /** Frames seen by `playground:probe` layers, oldest first (capped). */
    ouafProbe?: ProbeSample[]
  }
}

const PROBE_CAPACITY = 5000

function createProbe(_decl: LayerDecl, ctx: LayerContext): ObjectLayer {
  return {
    kind: 'object',
    stage: 'objects',
    object: new Group(),
    update(frame) {
      const samples = (window.ouafProbe ??= [])
      if (samples.length >= PROBE_CAPACITY) samples.shift()
      const has = frame.faces.count > 0
      samples.push({
        time: frame.time,
        dt: frame.dt,
        faces: frame.faces.count,
        x: has ? frame.faces.landmarks[0]! : Number.NaN,
        y: has ? frame.faces.landmarks[1]! : Number.NaN,
        random: ctx.random(),
      })
    },
    dispose() {},
  }
}

const BusySchema = Type.Object(
  {
    type: Type.Literal('playground:busy'),
    id: Type.Optional(Type.String()),
    ms: Type.Number({ minimum: 0, maximum: 500 }),
    msPerMegapixel: Type.Optional(Bindable(Type.Number({ minimum: 0, maximum: 500 }))),
  },
  { additionalProperties: false },
)

function createBusy(decl: LayerDecl, ctx: LayerContext): ObjectLayer {
  const ms = Number(decl.ms)
  const perPixel = compileNumberBinding(decl.msPerMegapixel ?? 0, { fallback: 0, path: 'msPerMegapixel' }, ctx.bindings)
  const out = new Float64Array(1)
  return {
    kind: 'object',
    stage: 'objects',
    object: new Group(),
    update(frame) {
      perPixel.write(0, out, 0)
      const end = performance.now() + ms + (out[0]! * frame.width * frame.height) / 1e6
      while (performance.now() < end) {
        // Busy: the main thread's time, as a heavy filter would take it.
      }
    },
    dispose() {},
  }
}

export const playgroundPlugin: OuafPlugin = {
  name: 'playground',
  version: '1.0.0',
  vocabulary: {
    layers: [
      { type: 'playground:tint', schema: TintSchema, stage: 'color', since: '1.0', anchored: false },
      { type: 'playground:dot', schema: DotSchema, stage: 'objects', since: '1.0', anchored: true },
      { type: 'playground:probe', schema: ProbeSchema, stage: 'objects', since: '1.0', anchored: false },
      { type: 'playground:busy', schema: BusySchema, stage: 'objects', since: '1.0', anchored: false },
    ],
  },
  setup(api) {
    api.registerLayerType({ type: 'playground:tint', create: createTint })
    api.registerLayerType({ type: 'playground:dot', create: createDot })
    api.registerLayerType({ type: 'playground:probe', create: createProbe })
    api.registerLayerType({ type: 'playground:busy', create: createBusy })
  },
}
