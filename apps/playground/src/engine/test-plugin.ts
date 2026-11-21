/**
 * A third-party plugin for the engine page and the browser tests: it exercises both kinds of layer instances
 * (spec §6, §7) before the real v1 layer types land, and shows how a non-official plugin prefixes its vocabulary.
 *
 * - `playground:tint` (pass, `color` stage): multiplies the image by a color, mixed by `amount` (a param or a number).
 * - `playground:dot` (object): a flat colored disc at a face anchor (or the screen centre), `size` in anchor units.
 */
import type { LayerContext, LayerDecl, ObjectLayer, OuafPlugin, PassLayer } from '@ouaf/core'
import { FULLSCREEN_VERTEX } from '@ouaf/core'
import { Type } from 'typebox'
import { CircleGeometry, Color, GLSL3, Group, Matrix4, Mesh, MeshBasicMaterial, RawShaderMaterial, Vector4 } from 'three'

const Bindable = (schema: ReturnType<typeof Type.Number>) => Type.Union([schema, Type.Object({ param: Type.String() }, { additionalProperties: false })])

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

function readAmount(decl: LayerDecl, ctx: LayerContext): () => number {
  const amount = decl.amount
  if (typeof amount === 'number') return () => amount
  if (amount && typeof amount === 'object' && 'param' in amount) {
    // Resolved once; read by index every frame: the animated value, so `transition` is visible.
    const index = ctx.params.indexOf(String((amount as { param: string }).param))
    return () => ctx.params.numberAt(index)
  }
  return () => 1
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

export const playgroundPlugin: OuafPlugin = {
  name: 'playground',
  version: '1.0.0',
  vocabulary: {
    layers: [
      { type: 'playground:tint', schema: TintSchema, stage: 'color', since: '1.0', anchored: false },
      { type: 'playground:dot', schema: DotSchema, stage: 'objects', since: '1.0', anchored: true },
    ],
  },
  setup(api) {
    api.registerLayerType({ type: 'playground:tint', create: createTint })
    api.registerLayerType({ type: 'playground:dot', create: createDot })
  },
}
