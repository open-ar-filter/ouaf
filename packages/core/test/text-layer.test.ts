import type { ParamTypeName } from '@ouaf/spec'
import { Matrix4, Vector3, type Mesh } from 'three'
import { describe, expect, it } from 'vitest'
import { createFaceFrame, type AnchorProvider, type FrameContext, type LayerContext, type LayerDecl, type ParamsReader } from '../src/index.ts'
import { selectFaces } from '../src/layers/text/faces.ts'
import { layoutBox, wrapText, type MeasureEm } from '../src/layers/text/layout.ts'
import { TextRaster, splitAlpha, type TextContext, type TextStyle, type TextSurface } from '../src/layers/text/raster.ts'
import { createTextLayer } from '../src/layers/text/text-layer.ts'
import { builtinPlugins } from '../src/engine/builtin.ts'

/** Every character is half an em wide. */
const half: MeasureEm = (s) => [...s].length * 0.5

describe('wrapText', () => {
  it('splits at newlines and collapses spaces', () => {
    expect(wrapText('  Hello   world \nagain', half).lines).toEqual(['Hello world', 'again'])
    expect(wrapText('a\r\n\nb', half).lines).toEqual(['a', '', 'b'])
  })

  it('wraps between words at maxWidth', () => {
    const r = wrapText('one two three four', half, 4)
    expect(r.lines).toEqual(['one two', 'three', 'four'])
    expect(r.widths).toEqual([3.5, 2.5, 2])
    expect(r.width).toBe(3.5)
  })

  it('breaks a word wider than maxWidth between graphemes, never inside an emoji sequence', () => {
    expect(wrapText('abcdefg', half, 1.5).lines).toEqual(['abc', 'def', 'g'])
    // Family emoji (ZWJ sequence, 7 code units… one grapheme) and a flag: each stays whole.
    const family = '👨‍👩‍👧'
    const lines = wrapText(`${family}🇫🇷`, (s) => (s ? 1 : 0) * Array.from(new Intl.Segmenter().segment(s)).length, 1).lines
    expect(lines).toEqual([family, '🇫🇷'])
  })

  it('keeps one grapheme per line when even that does not fit', () => {
    expect(wrapText('ab', half, 0.1).lines).toEqual(['a', 'b'])
  })
})

describe('layoutBox', () => {
  const metrics = { ascent: 0.8, descent: 0.2, outline: 0 }
  const lines = wrapText('ab\nabcd', half)

  it('aligns lines in the block and puts the anchor on the alignment edge', () => {
    const center = layoutBox(lines, { ...metrics, align: 'center', lineHeight: 1.2 })
    expect(center.width).toBe(2)
    expect(center.height).toBeCloseTo(2.4)
    expect(center.x).toEqual([0.5, 0])
    expect(center.originX).toBe(1)
    expect(center.originY).toBeCloseTo(1.2)
    // Baselines: half-leading 0.1 + ascent 0.8, then one lineHeight further.
    expect(center.y[0]).toBeCloseTo(0.9)
    expect(center.y[1]).toBeCloseTo(2.1)
    const left = layoutBox(lines, { ...metrics, align: 'left', lineHeight: 1.2 })
    expect(left.x).toEqual([0, 0])
    expect(left.originX).toBe(0)
    const right = layoutBox(lines, { ...metrics, align: 'right', lineHeight: 1.2 })
    expect(right.x).toEqual([1, 0])
    expect(right.originX).toBe(2)
  })

  it('leaves room for the outline and the shadow', () => {
    const box = layoutBox(wrapText('ab', half), {
      ...metrics,
      outline: 0.1,
      align: 'left',
      lineHeight: 1,
      shadow: { blur: 0.2, offsetX: 0.3, offsetY: -0.3 },
    })
    // Left: outline only (the shadow goes right); right: outline + blur + offset.
    expect(box.x[0]).toBeCloseTo(0.1)
    expect(box.width).toBeCloseTo(0.1 + 1 + 0.6)
    // Shadow down (+y up in the layer, +y down in the image): more room at the bottom.
    expect(box.height).toBeCloseTo(0.1 + 1 + 0.6)
    expect(box.originY).toBeCloseTo(0.1 + 0.5)
  })

  it('keeps tall glyphs in the image when lineHeight is small', () => {
    const box = layoutBox(wrapText('a', half), { ...metrics, align: 'center', lineHeight: 0.6 })
    expect(box.height).toBeCloseTo(1)
    expect(box.y[0]! - 0.8).toBeGreaterThanOrEqual(-1e-9)
  })
})

/** A 2D context that records what is drawn; text is half an em wide. */
function fakeSurface(): TextSurface & { calls: string[] } {
  const calls: string[] = []
  let px = 10
  const ctx: TextContext = {
    get font() {
      return `${px}px`
    },
    set font(f: string) {
      px = Number(/(\d+(?:\.\d+)?)px/.exec(f)?.[1] ?? 10)
    },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    globalCompositeOperation: 'source-over',
    setTransform: () => {},
    clearRect: () => {},
    fillRect: () => void calls.push('fillRect'),
    fillText: (t) => void calls.push(`fill ${t}`),
    strokeText: (t) => void calls.push(`stroke ${t}`),
    measureText: (t) => ({ width: [...t].length * 0.5 * px, fontBoundingBoxAscent: 0.8 * px, fontBoundingBoxDescent: 0.2 * px }),
  }
  return { canvas: { width: 1, height: 1 }, ctx, calls }
}

const STYLE: TextStyle = { family: 'Test', weight: '700', style: 'normal', align: 'center', lineHeight: 1.2 }

describe('TextRaster', () => {
  it('redraws only when the text, color or wrap width change', () => {
    const surface = fakeSurface()
    const raster = new TextRaster(STYLE, () => surface)
    expect(raster.update('Hi', '#fff', Infinity)).toBe(true)
    expect(raster.update('Hi', '#fff', Infinity)).toBe(false)
    expect(raster.update('Hi', '#fff', Infinity)).toBe(false)
    expect(raster.draws).toBe(1)
    expect(raster.update('Ho', '#fff', Infinity)).toBe(true)
    expect(raster.update('Ho', '#000', Infinity)).toBe(true)
    expect(raster.update('Ho', '#000', 3)).toBe(true)
    expect(raster.update('Ho', '#000', 3)).toBe(false)
    expect(raster.draws).toBe(4)
  })

  it('sizes the image in em, grows the canvas by steps and never shrinks it', () => {
    const surface = fakeSurface()
    const raster = new TextRaster(STYLE, () => surface, { basePx: 100 })
    raster.update('abcd', '#fff', Infinity)
    expect(raster.resized).toBe(true)
    // 2 em × 1.2 em at 100 px, plus 1 px of margin on each side.
    expect(raster.width).toBeCloseTo(2.02)
    expect(raster.height).toBeCloseTo(1.22)
    expect(surface.canvas).toEqual({ width: 256, height: 128 })
    expect(raster.uScale).toBeCloseTo(202 / 256)
    expect(raster.originX).toBeCloseTo(1.01)
    raster.update('ab', '#fff', Infinity)
    expect(raster.resized).toBe(false)
    expect(surface.canvas).toEqual({ width: 256, height: 128 })
    expect(raster.uScale).toBeCloseTo(102 / 256)
  })

  it('draws at a smaller pixel size when the text would not fit in maxSize', () => {
    const surface = fakeSurface()
    const raster = new TextRaster(STYLE, () => surface, { basePx: 100, maxSize: 512 })
    raster.update('x'.repeat(40), '#fff', Infinity) // 20 em: 2000 px at 100 px
    expect(surface.canvas.width).toBeLessThanOrEqual(512)
    expect(raster.width).toBeCloseTo(20, 0)
  })

  it('draws the outline under the fill, and the shadow first, faded once', () => {
    const surface = fakeSurface()
    const raster = new TextRaster({ ...STYLE, outline: { width: 0.1, color: '#000' }, shadow: { color: '#00000080', blur: 0.1, offset: [0.1, -0.1] } }, () => surface)
    raster.update('a\nb', '#fff', Infinity)
    expect(surface.calls).toEqual(['stroke a', 'fill a', 'stroke b', 'fill b', 'fillRect', 'stroke a', 'stroke b', 'fill a', 'fill b'])
  })

  it('splits the alpha of hex colors', () => {
    expect(splitAlpha('#00000080')).toEqual({ rgb: '#000000', alpha: 128 / 255 })
    expect(splitAlpha('#f00')).toEqual({ rgb: '#ff0000', alpha: 1 })
    expect(splitAlpha('#f008')).toEqual({ rgb: '#ff0000', alpha: 0x88 / 255 })
  })
})

describe('selectFaces', () => {
  const out = new Int32Array(4)
  const ids = [5, 2, 9, 0]
  const id = (i: number) => ids[i]!
  const ok = [1, 1, 0, 1]
  const size = [0.1, 0.3, 0.9, 0.2]

  it('selects all, the first seen, the n first seen or the largest', () => {
    expect([...out.subarray(0, selectFaces('all', 4, ok, id, size, out))]).toEqual([0, 1, 3])
    expect([...out.subarray(0, selectFaces('first', 4, ok, id, size, out))]).toEqual([1])
    // Slot 3 has no id yet: after the identified faces.
    expect([...out.subarray(0, selectFaces(3, 4, ok, id, size, out))]).toEqual([1, 0, 3])
    expect([...out.subarray(0, selectFaces(2, 4, ok, id, size, out))]).toEqual([1, 0])
    // Slot 2 is the largest but its anchor is not available.
    expect([...out.subarray(0, selectFaces('largest', 4, ok, id, size, out))]).toEqual([1])
    expect(selectFaces('all', 0, ok, id, size, out)).toBe(0)
  })
})

function params(defs: Record<string, [ParamTypeName, unknown]>): ParamsReader & { set(name: string, v: unknown): void } {
  const values = new Map(Object.entries(defs).map(([k, [, v]]) => [k, v]))
  return { type: (name) => defs[name]?.[0], get: (name) => values.get(name), set: (name, v) => values.set(name, v) }
}

/** A layer context and frames with `count` faces, each anchored at x = 10·slot cm, 50 cm away, 6 cm per unit. */
function harness(decl: Omit<LayerDecl, 'type'>, p = params({}), maxFaces = 2) {
  const surfaces: ReturnType<typeof fakeSurface>[] = []
  const ctx = {
    filterId: 'test',
    assets: { get: () => ({ family: 'Test', weight: '700', style: 'normal' }), has: () => true },
    bindings: { data: { resolve: () => undefined }, params: p },
    maxFaces,
    warn: () => {},
  } as unknown as LayerContext
  const layer = createTextLayer({ type: 'text', ...decl }, ctx, {
    surface: () => {
      const s = fakeSurface()
      surfaces.push(s)
      return s
    },
  })
  const faces = createFaceFrame(maxFaces)
  const anchorRoll = new Matrix4()
  const anchors: AnchorProvider = {
    face(i, _anchor, _follow, out) {
      if (i >= faces.count) return false
      out.makeRotationZ(0).copy(anchorRoll).scale(new Vector3(6, 6, 6)).setPosition(10 * i, 0, -50)
      return true
    },
    screen(out) {
      out.makeScale(20, 20, 20).setPosition(0, 0, -10)
    },
    id: (i) => i + 1,
  }
  const frame = (count: number) => {
    faces.count = count
    layer.update({ time: 0, now: 0, dt: 16, faces, anchors, width: 640, height: 480, mirrored: false } as FrameContext)
  }
  const meshes = layer.object.children as Mesh[]
  return { layer, frame, meshes, surfaces, anchorRoll, draws: () => surfaces.reduce((n, s) => n + s.calls.filter((c) => c.startsWith('fill ')).length, 0) }
}

const position = (m: Mesh) => new Vector3().setFromMatrixPosition(m.matrix)

describe('text layer', () => {
  it('is a built-in plugin', () => {
    expect(builtinPlugins().map((p) => p.name)).toContain('text')
  })

  it('rasterizes once while transforms and opacity change every frame', () => {
    const p = params({ fade: ['number', 1], label: ['string', 'Hi'], dx: ['vec3', [0, 0, 0]] })
    const h = harness({ text: { param: 'label' }, opacity: { param: 'fade' }, offset: { param: 'dx' }, size: 0.5 }, p)
    expect(h.layer.stage).toBe('objects')
    h.frame(1)
    expect(h.draws()).toBe(1)
    for (let i = 0; i < 10; i++) {
      p.set('fade', 0.1 + i / 20)
      p.set('dx', [i, 0, 0])
      h.frame(1)
    }
    expect(h.draws()).toBe(1)
    expect((h.meshes[0]!.material as { opacity: number }).opacity).toBeCloseTo(0.55)
    p.set('label', 'Bye')
    h.frame(1)
    expect(h.draws()).toBe(2)
  })

  it('places one plane per face at the anchor, with offset and size in anchor units', () => {
    const h = harness({ text: 'ab', offset: [0, 1, 0], size: 0.5 })
    h.frame(2)
    expect(h.meshes.map((m) => m.visible)).toEqual([true, true])
    // A single texture: the text does not depend on the face.
    expect(h.surfaces).toHaveLength(1)
    const [a, b] = h.meshes.map(position)
    // Centred text: the plane centre is at the anchor + offset (6 cm per unit), its height is ~ lineHeight × size.
    expect(a!.x).toBeCloseTo(0, 1)
    expect(a!.y).toBeCloseTo(6, 1)
    expect(a!.z).toBeCloseTo(-50)
    expect(b!.x).toBeCloseTo(10, 1)
    const height = new Vector3().setFromMatrixColumn(h.meshes[0]!.matrix, 1).length()
    expect(height).toBeCloseTo(6 * 0.5 * 1.2, 0)
    h.frame(1)
    expect(h.meshes.map((m) => m.visible)).toEqual([true, false])
    h.frame(0)
    expect(h.meshes.map((m) => m.visible)).toEqual([false, false])
  })

  it('gives the place of each plane on its anchor, for the draw order (spec §7)', () => {
    const h = harness({ text: 'ab', anchor: 'chin', offset: [0, 1, 0.05] })
    h.frame(2)
    expect(h.layer.placements!.map((p) => [p.object, p.anchor, p.face, p.z])).toEqual(h.meshes.map((m, i) => [m, 'chin', i + 1, 0.05]))
  })

  it('scale multiplies the drawn block around the anchor point, uniformly or per axis, without redrawing', () => {
    const axis = (m: Mesh, i: number) => new Vector3().setFromMatrixColumn(m.matrix, i).length()
    const base = harness({ text: 'abcd', align: 'left', size: 0.5 })
    base.frame(1)
    const p = params({ s: ['number', 2] })
    const doubled = harness({ text: 'abcd', align: 'left', size: 0.5, scale: { param: 's' } }, p)
    doubled.frame(1)
    expect(axis(doubled.meshes[0]!, 0)).toBeCloseTo(2 * axis(base.meshes[0]!, 0))
    expect(axis(doubled.meshes[0]!, 1)).toBeCloseTo(2 * axis(base.meshes[0]!, 1))
    // The anchor point stays on the left edge: the plane centre moves away from it twice as far.
    expect(position(doubled.meshes[0]!).x).toBeCloseTo(2 * position(base.meshes[0]!).x)
    p.set('s', 3)
    doubled.frame(1)
    expect(axis(doubled.meshes[0]!, 1)).toBeCloseTo(3 * axis(base.meshes[0]!, 1))
    expect(doubled.draws()).toBe(1)
    const stretched = harness({ text: 'abcd', size: 0.5, scale: [1, 1.4, 1] })
    stretched.frame(1)
    expect(axis(stretched.meshes[0]!, 0)).toBeCloseTo(axis(base.meshes[0]!, 0))
    expect(axis(stretched.meshes[0]!, 1)).toBeCloseTo(1.4 * axis(base.meshes[0]!, 1))
    const flat = harness({ text: 'abcd', scale: [1, 0, 1] })
    flat.frame(1)
    expect(flat.meshes[0]!.visible).toBe(false)
  })

  it('puts the anchor on the alignment edge', () => {
    const left = harness({ text: 'abcd', align: 'left' })
    left.frame(1)
    // Plane centre right of the anchor by half the text width (2 em × 0.3 × 6 cm), minus the 1 px margin.
    expect(position(left.meshes[0]!).x).toBeCloseTo(1.8, 1)
    const right = harness({ text: 'abcd', align: 'right' })
    right.frame(1)
    expect(position(right.meshes[0]!).x).toBeCloseTo(-1.8, 1)
  })

  it('orient: screen keeps the plane parallel to the screen and upright', () => {
    const tilted = new Matrix4().makeRotationZ(Math.PI / 4).multiply(new Matrix4().makeRotationY(0.5))
    const face = harness({ text: 'ab', offset: [0, 1, 0] })
    face.anchorRoll.copy(tilted)
    face.frame(1)
    const screen = harness({ text: 'ab', offset: [0, 1, 0], orient: 'screen' })
    screen.anchorRoll.copy(tilted)
    screen.frame(1)
    const xAxis = (m: Mesh) => new Vector3().setFromMatrixColumn(m.matrix, 0).normalize()
    expect(xAxis(face.meshes[0]!).y).toBeGreaterThan(0.3)
    const x = xAxis(screen.meshes[0]!)
    expect(x.x).toBeCloseTo(1)
    expect(x.y).toBeCloseTo(0)
    // Same position (up to the sub-pixel margin of the image, rotated): the offset still follows the anchor frame.
    expect(position(screen.meshes[0]!).distanceTo(position(face.meshes[0]!))).toBeLessThan(0.05)
  })

  it('anchor: screen shows one plane without faces; overlay goes to the overlay stage', () => {
    const h = harness({ text: 'Score', anchor: 'screen', overlay: true, excludeFromCapture: true })
    expect(h.layer.stage).toBe('overlay')
    expect(h.layer.kind === 'object' && h.layer.excludeFromCapture).toBe(true)
    h.frame(0)
    expect(h.meshes).toHaveLength(1)
    expect(h.meshes[0]!.visible).toBe(true)
    expect(position(h.meshes[0]!).z).toBeCloseTo(-10)
  })

  it('hides the plane when invisible, transparent or empty', () => {
    const p = params({ show: ['boolean', false], label: ['string', 'x'] })
    const h = harness({ text: { param: 'label' }, visible: { param: 'show' } }, p)
    h.frame(1)
    expect(h.meshes[0]!.visible).toBe(false)
    p.set('show', true)
    h.frame(1)
    expect(h.meshes[0]!.visible).toBe(true)
    p.set('label', '')
    h.frame(1)
    expect(h.meshes[0]!.visible).toBe(false)
    const clear = harness({ text: 'x', opacity: 0 })
    clear.frame(1)
    expect(clear.meshes[0]!.visible).toBe(false)
  })

  it('faces selects the instances', () => {
    const h = harness({ text: 'x', faces: 'first' }, params({}), 3)
    expect(h.meshes).toHaveLength(1)
    h.frame(3)
    expect(position(h.meshes[0]!).x).toBeCloseTo(0, 1)
  })

  it('re-wraps when maxWidth and size change, not otherwise', () => {
    const p = params({ s: ['number', 0.5] })
    const h = harness({ text: 'aa bb', maxWidth: 1, size: { param: 's' } }, p)
    h.frame(1)
    // 1 unit / 0.5 = 2 em: "aa bb" (2.5 em) wraps on two lines.
    expect(h.surfaces[0]!.calls).toEqual(['fill aa', 'fill bb'])
    p.set('s', 0.25) // 4 em: one line
    h.frame(1)
    expect(h.surfaces[0]!.calls.slice(2)).toEqual(['fill aa bb'])
  })
})
