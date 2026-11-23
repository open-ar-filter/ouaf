import { Matrix4, PerspectiveCamera } from 'three'
import { describe, expect, it } from 'vitest'
import { createWarpLayer } from '../src/layers/warp/layer.ts'
import { parseFacesSelector, selectFaces } from '../src/layers/warp/select-faces.ts'
import { warpFragment } from '../src/layers/warp/shader.ts'
import { MAX_CENTRES, STRETCH_MAX, WARP_KINDS, WarpPacker, falloff, warpSource, type WarpKind } from '../src/layers/warp/warp-math.ts'
import { FaceAnchors } from '../src/engine/anchor-provider.ts'
import {
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

/** Anchor matrix: `unit` cm per face unit, rotated by `roll` degrees around +z, at `t` (cm). */
function anchorMatrix(t: [number, number, number], unit = 6.3, roll = 0): Float32Array {
  const m = new Matrix4().makeRotationZ((roll * Math.PI) / 180).scale({ x: unit, y: unit, z: unit } as never)
  m.setPosition(t[0], t[1], t[2])
  return new Float32Array(m.elements)
}

const out = [0, 0]
const src = (kind: WarpKind, x: number, y: number, strength: number, radius = 0.2, dir: [number, number] = [0, 1]) => {
  warpSource(kind, x, y, 0, 0, radius, strength, dir[0], dir[1], out)
  return [out[0]!, out[1]!] as const
}

describe('warpSource', () => {
  it('leaves the image unchanged outside the radius and at strength 0', () => {
    for (const kind of WARP_KINDS) {
      expect(src(kind, 0.25, 0, 1)).toEqual([0.25, 0])
      expect(src(kind, 0.1, -0.05, 0)).toEqual([0.1, -0.05])
    }
    expect(falloff(1)).toBe(0)
    expect(falloff(0)).toBe(1)
  })

  it('is seamless at the radius', () => {
    for (const kind of WARP_KINDS) {
      const [x, y] = src(kind, 0.1999 * Math.SQRT1_2, 0.1999 * Math.SQRT1_2, 1)
      expect(Math.hypot(x - 0.1999 * Math.SQRT1_2, y - 0.1999 * Math.SQRT1_2), kind).toBeLessThan(1e-6)
    }
  })

  it('bulge magnifies, pinch shrinks, and pinch(s) = bulge(-s)', () => {
    expect(Math.hypot(...src('bulge', 0.05, 0.02, 0.5))).toBeLessThan(Math.hypot(0.05, 0.02))
    expect(Math.hypot(...src('pinch', 0.05, 0.02, 0.5))).toBeGreaterThan(Math.hypot(0.05, 0.02))
    expect(src('pinch', 0.05, 0.02, 0.7)).toEqual(src('bulge', 0.05, 0.02, -0.7))
  })

  it('swirls counter-clockwise on screen for a positive strength, keeping distances', () => {
    const [x, y] = src('swirl', 0.1, 0, 0.5)
    expect(Math.hypot(x, y)).toBeCloseTo(0.1, 12)
    // The pixel at angle 0 shows content from a negative angle: the content turned counter-clockwise.
    expect(y).toBeLessThan(0)
  })

  it('stretch drags the disc along the direction', () => {
    const [x, y] = src('stretch', 0, 0, 1, 0.2, [0, 1])
    expect(x).toBeCloseTo(0, 12)
    expect(y).toBeCloseTo(-STRETCH_MAX * 0.2, 12) // the centre shows what was below: content moved up
    expect(src('stretch', 0, 0, -1, 0.2, [1, 0])[0]).toBeCloseTo(STRETCH_MAX * 0.2, 12)
  })

  it('never folds the image at full strength (positive Jacobian)', () => {
    const h = 1e-5
    const a = [0, 0]
    const b = [0, 0]
    for (const kind of WARP_KINDS) {
      for (const s of [-1, -0.5, 0.5, 1]) {
        let min = Infinity
        for (let i = -20; i <= 20; i++) {
          for (let j = -20; j <= 20; j++) {
            const x = i * 0.0101
            const y = j * 0.0101
            warpSource(kind, x + h, y, 0, 0, 0.2, s, 0.6, 0.8, a)
            warpSource(kind, x - h, y, 0, 0, 0.2, s, 0.6, 0.8, b)
            const j00 = (a[0]! - b[0]!) / (2 * h)
            const j10 = (a[1]! - b[1]!) / (2 * h)
            warpSource(kind, x, y + h, 0, 0, 0.2, s, 0.6, 0.8, a)
            warpSource(kind, x, y - h, 0, 0, 0.2, s, 0.6, 0.8, b)
            const j01 = (a[0]! - b[0]!) / (2 * h)
            const j11 = (a[1]! - b[1]!) / (2 * h)
            min = Math.min(min, j00 * j11 - j01 * j10)
          }
        }
        expect(min, `${kind} ${s}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('WarpPacker', () => {
  it('places a centre on screen in screen heights and scales the radius with the distance', () => {
    const camera = objectsCamera(1280, 720, 1280, 720)
    const packer = new WarpPacker(4)
    packer.begin(camera.projectionMatrix.elements, 1280, 720)
    expect(packer.addFace(anchorMatrix([0, 0, -60]), [0.5, 0.3, 0, 1])).toBe(true)
    expect(packer.addFace(anchorMatrix([0, 0, -120]), [0.5, 0.3, 0, 1])).toBe(true)
    expect(packer.count).toBe(2)
    const [x, y, invR, k] = packer.a
    expect(x).toBeCloseTo(0, 6)
    expect(y).toBeCloseTo(0, 6)
    expect(k).toBeCloseTo(0.3, 6)
    // Half a face unit (3.15 cm) at 60 cm through a 63° vertical field of view, in screen heights.
    const expected = 3.15 / (2 * 60 * Math.tan((TRACKER_FOV_Y * Math.PI) / 360))
    expect(1 / invR!).toBeCloseTo(expected, 5)
    expect(1 / packer.a[6]!).toBeCloseTo(expected / 2, 5)
  })

  it('keeps circles round and the edges right for a wide frame in a square canvas (cover crop)', () => {
    // A 16:9 video in a square canvas: the sides are cropped, the vertical scale is unchanged.
    const camera = objectsCamera(1280, 720, 720, 720)
    const packer = new WarpPacker(2)
    packer.begin(camera.projectionMatrix.elements, 720, 720)
    const tan = Math.tan((TRACKER_FOV_Y * Math.PI) / 360)
    // At the right edge of the canvas: half a screen height to the right of the centre.
    packer.addFace(anchorMatrix([0.5 * 2 * 60 * tan, 0, -60]), [0.5, 0.3, 0, 1])
    expect(packer.a[0]).toBeCloseTo(0.5, 5)
    expect(1 / packer.a[2]!).toBeCloseTo(3.15 / (2 * 60 * tan), 5)
  })

  it('turns the direction with the head', () => {
    const camera = objectsCamera(1280, 720, 1280, 720)
    const packer = new WarpPacker(2)
    packer.begin(camera.projectionMatrix.elements, 1280, 720)
    packer.addFace(anchorMatrix([0, 0, -60], 6.3, 90), [0.5, 1, 0, 1]) // head rolled 90° counter-clockwise
    expect(packer.b[0]).toBeCloseTo(-1, 3)
    expect(packer.b[1]).toBeCloseTo(0, 3)
    packer.addScreen([0.2, 1, 3, 4])
    expect([...packer.a.subarray(4, 8)]).toEqual([0, 0, 5, 1])
    expect(packer.b[4]).toBeCloseTo(0.6, 6)
    expect(packer.b[5]).toBeCloseTo(0.8, 6)
  })

  it('skips centres without effect or behind the camera, and stops at capacity', () => {
    const camera = objectsCamera(1280, 720, 1280, 720)
    const packer = new WarpPacker(1)
    packer.begin(camera.projectionMatrix.elements, 1280, 720)
    expect(packer.addFace(anchorMatrix([0, 0, -60]), [0.5, 0, 0, 1])).toBe(false)
    expect(packer.addFace(anchorMatrix([0, 0, -60]), [0, 0.5, 0, 1])).toBe(false)
    expect(packer.addFace(anchorMatrix([0, 0, 60]), [0.5, 0.5, 0, 1])).toBe(false)
    expect(packer.addFace(anchorMatrix([0, 0, -60]), [0.5, 2, 0, 1])).toBe(true)
    expect(packer.a[3]).toBe(1) // strength clamped
    expect(packer.addFace(anchorMatrix([0, 0, -60]), [0.5, 0.5, 0, 1])).toBe(false)
    expect(new WarpPacker(1000).capacity).toBe(MAX_CENTRES)
  })

  it('puts face anchors where the video shows their landmarks, mirrored or not', () => {
    for (const mirrored of [false, true]) {
      for (const [tw, th] of [[1280, 720], [720, 1280], [720, 720]] as const) {
        const faces = createFaceFrame(1)
        faces.count = 1
        writeSyntheticFace(faces, 0, { yaw: 20, roll: -10, t: [6, 3, -50] })
        estimateFacePoses(faces)
        const camera = objectsCamera(faces.width, faces.height, tw, th)
        const anchors = new FaceAnchors(faces, camera)
        anchors.setFrame(faces, [1], mirrored)
        const m = new Matrix4()
        const packer = new WarpPacker(1)
        packer.begin(camera.projectionMatrix.elements, tw, th)
        for (const anchor of ['noseTip', 'leftEye', 'mouth'] as const) {
          packer.count = 0
          expect(anchors.face(0, anchor, 'auto', m)).toBe(true)
          packer.addFace(m.elements, [0.5, 0.3, 0, 1])
          const live = { x: 0, y: 0, z: 0 }
          liveAnchorPosition(faces, 0, anchor, live)
          const v = computeVideoToClip(faces.width, faces.height, tw, th, 'cover', mirrored, createVideoToClip())
          const sx = ((v.ax * live.x + v.bx) / 2) * (tw / th)
          const sy = (v.ay * live.y + v.by) / 2
          const label = `${anchor} ${tw}×${th} mirrored=${mirrored}`
          expect(Math.abs(packer.a[0]! - sx) * th, label).toBeLessThan(2) // pixels
          expect(Math.abs(packer.a[1]! - sy) * th, label).toBeLessThan(2)
        }
      }
    }
  })
})

describe('selectFaces', () => {
  const ids = [7, 3, 9, 5]
  const sizes = [0.1, 0.3, 0.2, 0.05]
  const run = (selector: unknown, count = 4) => {
    const slots = new Int32Array(4)
    const n = selectFaces(parseFacesSelector(selector), count, ids, sizes, slots)
    return [...slots.subarray(0, n)]
  }

  it('selects all, the oldest, the largest or the n oldest faces', () => {
    expect(run('all')).toEqual([0, 1, 2, 3])
    expect(run(undefined, 2)).toEqual([0, 1])
    expect(run('first')).toEqual([1])
    expect(run('largest')).toEqual([1])
    expect(run(2)).toEqual([1, 3])
    expect(run(16)).toEqual([1, 3, 0, 2])
    expect(run('first', 0)).toEqual([])
  })
})

describe('warpFragment', () => {
  it('declares the direction array for stretch only', () => {
    expect(warpFragment('stretch', 8)).toContain('uniform vec4 uB[CAPACITY]')
    expect(warpFragment('bulge', 8)).toContain('#define KIND 0')
    expect(warpFragment('swirl', 3)).toContain('#define CAPACITY 3')
    expect(warpFragment('swirl', 3)).toContain('3.141592653589793')
    expect(warpFragment('stretch', 1)).toContain('0.6')
  })
})

describe('warp layer', () => {
  type Placed = { [face: number]: [number, number, number] }

  /** Frame and anchors with fixed anchor positions per face (every anchor of a face at `placed[face]`, offset by name). */
  function setup(decl: Record<string, unknown>, options: { maxFaces?: number; params?: Record<string, number> } = {}) {
    const maxFaces = options.maxFaces ?? 2
    const params = options.params ?? {}
    const placed: Placed = {}
    const faces: FaceFrame = createFaceFrame(maxFaces)
    const anchors: AnchorProvider = {
      face(face, anchor, _follow, m) {
        const t = placed[face]
        if (!t || face >= faces.count) return false
        const dx = anchor === 'leftEye' ? 3 : anchor === 'rightEye' ? -3 : 0
        m.makeScale(6.3, 6.3, 6.3).setPosition(t[0] + dx, t[1], t[2])
        return true
      },
      screen(m) {
        m.identity()
      },
      id: (face) => (face < faces.count ? face + 1 : 0),
    }
    // A face data path whose value is the face slot + 1 (missing without a face).
    const bindings: BindingEnv = {
      data: {
        resolve: (path) =>
          path === 'face.slot'
            ? { type: 'number', perFace: true, read: (face, out, i) => void (out[i] = face >= 0 && face < faces.count ? face + 1 : NaN) }
            : undefined,
      },
      params: { type: (n) => (n in params ? 'number' : undefined), get: (n) => params[n] },
    }
    const camera = objectsCamera(1280, 720, 1280, 720)
    const warnings: string[] = []
    const ctx = {
      filterId: 'test',
      renderer: {} as LayerContext['renderer'],
      view: { camera },
      assets: {} as LayerContext['assets'],
      params: {} as LayerContext['params'],
      bindings,
      maxFaces,
      random: Math.random,
      warn: (m: string) => void warnings.push(m),
    } satisfies LayerContext
    const layer = createWarpLayer({ type: 'warp', ...decl } as LayerDecl, ctx) as PassLayer
    const frame: FrameContext = { time: 0, now: 0, dt: 16, faces, anchors, width: 1280, height: 720, mirrored: false }
    return { layer, frame, faces, placed, params, warnings }
  }

  it('runs in the warp stage and is inactive without a face', () => {
    const { layer, frame } = setup({ kind: 'bulge', anchor: 'noseTip' })
    expect(layer.kind).toBe('pass')
    expect(layer.stage).toBe('warp')
    layer.update(frame)
    expect(layer.active).toBe(false)
    layer.dispose()
  })

  it('packs one centre per selected face and anchor, inactive at strength 0', () => {
    const { layer, frame, faces, placed, params } = setup(
      { kind: 'swirl', anchor: ['leftEye', 'rightEye'], strength: { param: 's' } },
      { params: { s: 0.5 } },
    )
    faces.count = 2
    placed[0] = [-10, 0, -60]
    placed[1] = [10, 0, -60]
    layer.update(frame)
    expect(layer.active).toBe(true)
    expect(countOf(layer)).toBe(4)
    params.s = 0
    layer.update(frame)
    expect(layer.active).toBe(false)
    faces.count = 0
    params.s = 0.5
    layer.update(frame)
    expect(layer.active).toBe(false)
  })

  it('evaluates bindings per face, honours visible, opacity and faces', () => {
    const { layer, frame, faces, placed } = setup({
      kind: 'bulge',
      anchor: 'noseTip',
      faces: 'first',
      opacity: 0.5,
      radius: { bind: 'face.slot' },
    })
    faces.count = 2
    placed[0] = [0, 0, -60]
    placed[1] = [10, 0, -60]
    layer.update(frame)
    expect(countOf(layer)).toBe(1)
    expect(uniformA(layer)[3]).toBeCloseTo(0.15, 6) // default strength 0.3 × opacity 0.5

    const all = setup({ kind: 'bulge', anchor: 'noseTip', radius: { bind: 'face.slot' }, visible: false })
    all.faces.count = 1
    all.placed[0] = [0, 0, -60]
    all.layer.update(all.frame)
    expect(all.layer.active).toBe(false)

    const two = setup({ kind: 'bulge', anchor: 'noseTip', radius: { bind: 'face.slot' } })
    two.faces.count = 2
    two.placed[0] = [0, 0, -60]
    two.placed[1] = [10, 0, -60]
    two.layer.update(two.frame)
    const a = uniformA(two.layer)
    expect(1 / a[6]!).toBeCloseTo(2 / a[2]!, 5) // radius 2 face units for slot 1, 1 for slot 0
  })

  it('applies screen anchors without a face', () => {
    const { layer, frame } = setup({ kind: 'pinch', anchor: 'screen', radius: 0.25 })
    layer.update(frame)
    expect(layer.active).toBe(true)
    expect([...uniformA(layer).subarray(0, 4)]).toEqual([0, 0, 4, expect.closeTo(0.3, 6)])
  })

  it('sizes its uniforms for maxFaces × anchors, warning beyond the shader limit', () => {
    const small = setup({ kind: 'bulge', anchor: ['leftEye', 'rightEye', 'noseTip'] }, { maxFaces: 3 })
    expect(uniformA(small.layer)).toHaveLength(9 * 4)
    expect(small.warnings).toEqual([])
    const big = setup({ kind: 'bulge', anchor: ['leftEye', 'rightEye', 'noseTip', 'mouth', 'chin'] }, { maxFaces: 16 })
    expect(uniformA(big.layer)).toHaveLength(MAX_CENTRES * 4)
    expect(big.warnings).toHaveLength(1)
  })

  it('does not allocate per frame', () => {
    const { layer, frame, faces, placed } = setup(
      { kind: 'stretch', anchor: ['leftEye', 'rightEye'], direction: [1, 0], radius: { bind: 'face.slot' }, faces: 'largest' },
    )
    faces.count = 2
    placed[0] = [-10, 0, -60]
    placed[1] = [10, 0, -50]
    layer.update(frame)
    expect(countOf(layer)).toBe(2) // the largest face (the closer one), two anchors
    expect(bytesPerCall(() => layer.update(frame))).toBeLessThan(1)
  })
})

/** The packed uniform arrays, read back through the material (white-box). */
function material(layer: PassLayer): { uniforms: Record<string, { value: unknown }> } {
  let m: { uniforms: Record<string, { value: unknown }> } | undefined
  layer.render({ renderer: {} as never, input: {} as never, output: null, drawFullscreen: (mat) => void (m = mat as never) })
  return m!
}

function uniformA(layer: PassLayer): Float32Array {
  return material(layer).uniforms.uA!.value as Float32Array
}

function countOf(layer: PassLayer): number {
  return material(layer).uniforms.uCount!.value as number
}
