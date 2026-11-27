import type { ParamTypeName } from '@ouaf/spec'
import { Matrix4, PerspectiveCamera, Vector3, type Mesh } from 'three'
import { describe, expect, it } from 'vitest'
import { createFaceFrame, type AnchorProvider, type FrameContext, type LayerContext, type LayerDecl, type ParamsReader } from '../src/index.ts'
import { layoutBox, wrapText, type MeasureEm } from '../src/layers/text/layout.ts'
import { TextRaster, splitAlpha, type TextContext, type TextStyle, type TextSurface } from '../src/layers/text/raster.ts'
import { createTextLayer } from '../src/layers/text/text-layer.ts'
import { HOLD, MAX_PX, MIN_PX, pxLevel, Resolution, SETTLE, SettledScale } from '../src/layers/text/resolution.ts'
import { builtinPlugins } from '../src/engine/builtin.ts'
import { bindingParams } from '../src/engine/filter.ts'
import { ParamStore } from '../src/params/index.ts'
import { ScriptOverrides } from '../src/script/overrides.ts'

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
    drawImage: (_image, ...rect) => void calls.push(`drawImage ${rect.join(' ')}`),
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

function params(defs: Record<string, [ParamTypeName, unknown]>): ParamsReader & { set(name: string, v: unknown): void } {
  const values = new Map(Object.entries(defs).map(([k, [, v]]) => [k, v]))
  return { type: (name) => defs[name]?.[0], get: (name) => values.get(name), set: (name, v) => values.set(name, v) }
}

/**
 * A layer context and frames with `count` faces, each anchored at x = 10·slot cm, `distance` cm away (50 by default),
 * 6 cm per unit. With `camera`, a 60° camera over the 640×480 frames (the layer then sizes its raster on screen).
 */
function harness(decl: Omit<LayerDecl, 'type'>, p = params({}), maxFaces = 2, camera = false) {
  const surfaces: ReturnType<typeof fakeSurface>[] = []
  const ctx = {
    filterId: 'test',
    assets: { get: () => ({ family: 'Test', weight: '700', style: 'normal' }), has: () => true },
    bindings: { data: { resolve: () => undefined }, params: p },
    maxFaces,
    warn: () => {},
    ...(camera ? { view: { camera: new PerspectiveCamera(60, 640 / 480, 1, 1000) } } : {}),
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
  const distance = [50, 50, 50, 50]
  const anchors: AnchorProvider = {
    face(i, _anchor, _follow, out) {
      if (i >= faces.count) return false
      out.makeRotationZ(0).copy(anchorRoll).scale(new Vector3(6, 6, 6)).setPosition(10 * i, 0, -distance[i]!)
      return true
    },
    screen(out) {
      out.makeScale(20, 20, 20).setPosition(0, 0, -10)
    },
    id: (i) => i + 1,
  }
  const frame = (count: number, time = 0) => {
    faces.count = count
    layer.update({ time, now: time * 1000, dt: 16, faces, anchors, width: 640, height: 480, mirrored: false } as FrameContext)
  }
  const meshes = layer.object.children as Mesh[]
  /** Font size in pixels of each texture's last draw. */
  const px = () => surfaces.map((s) => Number(/(\d+(?:\.\d+)?)px/.exec(s.ctx.font)?.[1]))
  return { layer, frame, meshes, surfaces, anchorRoll, distance, px, draws: () => surfaces.reduce((n, s) => n + s.calls.filter((c) => c.startsWith('fill ')).length, 0) }
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

  it('font follows a select param, then the script; the default font without a map entry (#140)', () => {
    const font = (family: string) => ({ family, weight: '400', style: 'normal', face: {} })
    const fonts: Record<string, ReturnType<typeof font>> = { 'builtin:font/sans-bold': font('Default'), 'builtin:font/mono': font('Mono'), serif: font('Serif') }
    const store = new ParamStore({ look: { type: 'select', default: 'mono', options: { mono: 'Mono', serif: 'Serif', none: 'None' } } })
    const overrides = new ScriptOverrides()
    const families: string[] = []
    const ctx = {
      filterId: 'test',
      assets: { get: (ref: string) => fonts[ref], has: (ref: string) => ref in fonts },
      params: store,
      bindings: { data: { resolve: () => undefined }, params: bindingParams(store), overrides: overrides.forLayer(0) },
      maxFaces: 1,
      warn: () => {},
    } as unknown as LayerContext
    const layer = createTextLayer({ type: 'text', text: 'Hi', anchor: 'screen', font: { param: 'look', map: { mono: 'builtin:font/mono', serif: 'serif' } } }, ctx, {
      surface: () => {
        // The family of the CSS font each glyph run is filled with.
        const s = fakeSurface()
        let family = ''
        const font = Object.getOwnPropertyDescriptor(s.ctx, 'font')!
        Object.defineProperty(s.ctx, 'font', {
          get: font.get,
          set: (f: string) => {
            family = /"([^"]+)"/.exec(f)?.[1] ?? ''
            font.set!.call(s.ctx, f)
          },
        })
        const fill = s.ctx.fillText
        s.ctx.fillText = (t, x, y) => {
          families.push(family)
          fill(t, x, y)
        }
        return s
      },
    })
    const faces = createFaceFrame(1)
    const anchors: AnchorProvider = { face: () => false, screen: (out) => void out.makeScale(20, 20, 20).setPosition(0, 0, -10), id: () => 0 }
    const frame = () => layer.update({ time: 0, now: 0, dt: 16, faces, anchors, width: 640, height: 480, mirrored: false } as FrameContext)
    frame()
    expect(families).toEqual(['Mono'])
    frame()
    expect(families).toEqual(['Mono']) // no redraw while nothing changes
    store.set('look', 'serif')
    store.beginFrame(16)
    frame()
    expect(families).toEqual(['Mono', 'Serif'])
    store.set('look', 'none') // no map entry: the default font
    store.beginFrame(32)
    frame()
    expect(families).toEqual(['Mono', 'Serif', 'Default'])
    const prop = overrides.property(0, 'font')!
    expect(prop.problem('serif')).toBeUndefined()
    expect(prop.problem('builtin:font/mono')).toBe('no asset named "builtin:font/mono" is declared in "assets" as a font')
    prop.set(undefined, 'serif')
    frame()
    expect(families).toEqual(['Mono', 'Serif', 'Default', 'Serif'])
    prop.set(undefined, null)
    frame()
    expect(families).toEqual(['Mono', 'Serif', 'Default', 'Serif', 'Default'])
    layer.dispose()
  })
})

describe('TextRaster.setFont', () => {
  it('draws with the new face from the next update, and only redraws for a different one', () => {
    const surface = fakeSurface()
    const raster = new TextRaster(STYLE, () => surface)
    raster.update('Hi', '#fff', Infinity)
    expect(raster.font).toContain('"Test"')
    raster.setFont({ family: 'Test', weight: '700', style: 'normal' })
    expect(raster.update('Hi', '#fff', Infinity)).toBe(false)
    raster.setFont({ family: 'Other', weight: '400', style: 'normal' })
    expect(raster.font).toBe('normal 400 96px "Other", sans-serif')
    expect(raster.update('Hi', '#fff', Infinity)).toBe(true)
    expect(raster.draws).toBe(2)
  })
})

describe('text resolution (#147)', () => {
  it('levels by √2 from MIN_PX to MAX_PX', () => {
    expect([0, -1, Number.NaN, 10, 32].map(pxLevel)).toEqual([MIN_PX, MIN_PX, MIN_PX, MIN_PX, MIN_PX])
    expect([33, 45, 46, 64, 65, 100, 128, 500, 5000].map(pxLevel)).toEqual([45, 45, 64, 64, 91, 128, 128, 512, MAX_PX])
  })

  it('chooses at once, then changes after HOLD seconds, up past 1.25× and down below half', () => {
    const r = new Resolution()
    expect(r.update(0, 0)).toBeUndefined()
    expect(r.update(60, 0)).toBe(64)
    // Within the band: 64 px drawn up to 80 px, down to 46 px.
    for (const need of [80, 46, 70]) expect(r.update(need, 0.1)).toBe(64)
    // Larger: wanted for HOLD seconds first.
    expect(r.update(100, 1)).toBe(64)
    expect(r.update(100, 1 + HOLD / 2)).toBe(64)
    expect(r.update(100, 1 + HOLD)).toBe(128)
    // A short dip below half does not count; a lasting one does.
    expect(r.update(40, 2)).toBe(128)
    expect(r.update(100, 2.1)).toBe(128)
    expect(r.update(40, 3)).toBe(128)
    expect(r.update(0, 3.1)).toBe(128) // nothing drawn: no change
    expect(r.update(40, 3 + HOLD)).toBe(45)
    // Growing through several levels (a face coming closer): changes HOLD seconds after it started.
    expect(r.update(120, 4)).toBe(45)
    expect(r.update(200, 4 + HOLD / 2)).toBe(45)
    expect(r.update(300, 4 + HOLD)).toBe(362)
    // A new run (time going back) chooses at once again.
    expect(r.update(300, 0)).toBe(362)
  })

  it('counts a scale once it stays put for SETTLE seconds', () => {
    const s = new SettledScale()
    expect(s.update(1, 0)).toBe(1)
    // An animation: never settled.
    for (let t = 0.05; t < 1; t += 0.05) expect(s.update(1 + Math.sin(t * 10), t)).toBe(1)
    expect(s.update(2, 1)).toBe(1)
    expect(s.update(2.01, 1 + SETTLE / 2)).toBe(1)
    expect(s.update(2.01, 1 + SETTLE)).toBe(2)
    expect(s.update(3, 0)).toBe(3) // a new run
  })

  it('rasterizes a large size at more pixels per em, and a face moving a little does not redraw', () => {
    const small = harness({ text: 'Hi', size: 0.2 }, params({}), 2, true)
    const large = harness({ text: 'Hi', size: 2 }, params({}), 2, true)
    small.frame(1)
    large.frame(1)
    // 60° over 480 px: 416 px of focal length; an em is 6 × size cm at 50 cm.
    expect(small.px()).toEqual([pxLevel(((6 * 0.2) / 50) * 416)])
    expect(large.px()).toEqual([pxLevel(((6 * 2) / 50) * 416)])
    expect(large.px()[0]).toBeGreaterThan(small.px()[0]! * 3)
    for (let i = 1; i <= 20; i++) {
      large.distance[0] = 50 + Math.sin(i) * 3
      large.frame(1, i / 30)
    }
    expect(large.draws()).toBe(1)
  })

  it('follows the face towards the camera after HOLD, and shares the largest need between faces', () => {
    const h = harness({ text: 'Hi', size: 0.5 }, params({}), 2, true)
    h.frame(2, 0)
    const far = h.px()[0]!
    h.distance[1] = 10 // the second face, five times closer
    h.frame(2, 0.1)
    expect(h.px()[0]).toBe(far)
    h.frame(2, 0.1 + HOLD)
    expect(h.px()[0]).toBe(pxLevel(((6 * 0.5) / 10) * 416))
    expect(h.surfaces).toHaveLength(1)
    expect(h.draws()).toBe(2)
  })

  it('a scale animation does not redraw; a lasting scale redraws once', () => {
    const p = params({ pop: ['number', 1] })
    const h = harness({ text: 'Hi', size: 0.5, scale: { param: 'pop' } }, p, 2, true)
    h.frame(1, 0)
    const first = h.px()[0]!
    for (let i = 1; i < 30; i++) {
      p.set('pop', 1 + 2 * Math.abs(Math.sin(i / 5)))
      h.frame(1, i / 60)
    }
    expect(h.draws()).toBe(1)
    p.set('pop', 4)
    for (let i = 0; i < 40; i++) h.frame(1, 1 + i / 60)
    expect(h.draws()).toBe(2)
    expect(first).toBe(pxLevel(((6 * 0.5) / 50) * 416))
    expect(h.px()[0]).toBe(pxLevel(4 * ((6 * 0.5) / 50) * 416))
  })
})

describe('TextRaster shadow', () => {
  it('draws a large blur smaller on its own canvas, then enlarges it', () => {
    const surfaces: ReturnType<typeof fakeSurface>[] = []
    const factory = () => {
      const s = fakeSurface()
      surfaces.push(s)
      return s
    }
    const shadow = { color: '#00000080', blur: 0.15, offset: [0.05, -0.05] as [number, number] }
    // 0.15 em at 64 px: 9.6 px of blur, drawn as is.
    const small = new TextRaster({ ...STYLE, shadow }, factory, { basePx: 64 })
    small.update('Hi', '#fff', Infinity)
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]!.calls.some((c) => c.startsWith('drawImage'))).toBe(false)
    // At 256 px: 38 px of blur, drawn 4 times smaller (the most), faded there, enlarged ×4 into the raster.
    const large = new TextRaster({ ...STYLE, shadow }, factory, { basePx: 256 })
    large.update('Hi', '#fff', Infinity)
    expect(surfaces).toHaveLength(3)
    const [main, reduced] = [surfaces[1]!, surfaces[2]!]
    expect(reduced.calls).toEqual(['fill Hi', 'fillRect'])
    expect(reduced.ctx.shadowBlur).toBe(0)
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = main.calls[0]!.split(' ').map(Number)
    expect([sx, sy, dx, dy]).toEqual([0, 0, 0, 0])
    expect([dw! / sw!, dh! / sh!]).toEqual([4, 4])
    expect(sw).toBe(Math.ceil((large.width * 256) / 4) + 1)
    expect(reduced.canvas.width).toBeGreaterThanOrEqual(sw!)
    expect(main.calls.slice(1)).toEqual(['fill Hi'])
    // Redrawn: the reduced canvas is reused.
    large.update('Ho', '#fff', Infinity)
    expect(surfaces).toHaveLength(3)
  })
})

describe('TextRaster.setPixelsPerEm', () => {
  it('redraws at the new size on the next update, and shrinks a canvas twice too large', () => {
    const surface = fakeSurface()
    const raster = new TextRaster(STYLE, () => surface, { basePx: 200 })
    raster.update('abcd', '#fff', Infinity)
    expect(surface.canvas).toEqual({ width: 448, height: 256 })
    raster.setPixelsPerEm(200)
    expect(raster.update('abcd', '#fff', Infinity)).toBe(false)
    raster.setPixelsPerEm(50)
    raster.setPixelsPerEm(-1)
    expect(raster.pixelsPerEm).toBe(50)
    expect(raster.update('abcd', '#fff', Infinity)).toBe(true)
    expect(raster.resized).toBe(true)
    expect(surface.canvas).toEqual({ width: 128, height: 64 })
    expect(raster.width).toBeCloseTo(2.04)
    expect(raster.draws).toBe(2)
  })
})
