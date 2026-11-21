import v8 from 'node:v8'
import type { ParamTypeName } from '@ouaf/spec'
import { describe, expect, it } from 'vitest'
import {
  BindingError,
  BLENDSHAPES_STRIDE,
  blendshapeIndex,
  compileBinding,
  compileNumberBinding,
  computeHeadPose,
  createFaceFrame,
  POSE_PITCH,
  POSE_ROLL,
  POSE_YAW,
  FaceBindingData,
  isBinding,
  NO_FACE,
  type BindingDataSource,
  type BindingEnv,
  type FaceFrame,
  type NumberBinding,
  type ParamsReader,
} from '../src/index.ts'

const JAW = blendshapeIndex('jawOpen')

function params(defs: Record<string, [ParamTypeName, unknown]>): ParamsReader & { set(name: string, v: unknown): void } {
  const values = new Map(Object.entries(defs).map(([k, [, v]]) => [k, v]))
  return {
    type: (name) => defs[name]?.[0],
    get: (name) => values.get(name),
    set: (name, v) => values.set(name, v),
  }
}

function setup(maxFaces = 2) {
  const faces = createFaceFrame(maxFaces)
  const data = new FaceBindingData(faces)
  const p = params({
    size: ['number', 1.5],
    label: ['string', 'hi'],
    tint: ['color', '#ff0000'],
    offset: ['vec3', [0, 1, 0]],
    style: ['select', 'gold'],
    on: ['boolean', true],
  })
  const env: BindingEnv = { data, params: p }
  return { faces, data, params: p, env }
}

function setJaw(faces: FaceFrame, face: number, value: number) {
  faces.blendshapes[face * BLENDSHAPES_STRIDE + JAW] = value
}

describe('compileBinding: fixed values and { param }', () => {
  it('returns fixed values as they are', () => {
    const { env } = setup()
    const b = compileBinding(0.4, { type: 'number', fallback: 1 }, env)
    expect(b.kind).toBe('constant')
    expect(b.perFace).toBe(false)
    expect(b.evaluate(0)).toBe(0.4)
    const v = [1, 2, 3] as const
    expect(compileBinding(v, { type: ['number', 'vec3'], fallback: 1 }, env).evaluate(0)).toBe(v)
  })

  it('rejects a fixed value of the wrong type', () => {
    const { env } = setup()
    expect(() => compileBinding('big', { type: 'number', fallback: 1, path: '/layers/0/size' }, env)).toThrow(
      /\/layers\/0\/size: expected a number/,
    )
    expect(() => compileBinding('red', { type: 'color', fallback: '#fff' }, env)).toThrow(BindingError)
  })

  it('reads the current value of a parameter on every evaluation', () => {
    const { env, params } = setup()
    const b = compileBinding({ param: 'size' }, { type: 'number', fallback: 1 }, env)
    expect(b.kind).toBe('param')
    expect(b.perFace).toBe(false)
    expect(b.evaluate(0)).toBe(1.5)
    params.set('size', 0.7)
    expect(b.evaluate(NO_FACE)).toBe(0.7)
  })

  it('accepts compatible parameter types only', () => {
    const { env } = setup()
    expect(compileBinding({ param: 'style' }, { type: 'string', fallback: '' }, env).evaluate(0)).toBe('gold')
    expect(compileBinding({ param: 'tint' }, { type: 'color', fallback: '#fff' }, env).evaluate(0)).toBe('#ff0000')
    expect(compileBinding({ param: 'offset' }, { type: 'vec3', fallback: [0, 0, 0] }, env).evaluate(0)).toEqual([0, 1, 0])
    expect(compileBinding({ param: 'on' }, { type: 'boolean', fallback: true }, env).evaluate(0)).toBe(true)
    expect(() => compileBinding({ param: 'label' }, { type: 'number', fallback: 1 }, env)).toThrow(/type "string"/)
    expect(() => compileBinding({ param: 'label' }, { type: 'color', fallback: '#fff' }, env)).toThrow(BindingError)
    expect(() => compileBinding({ param: 'nope' }, { type: 'number', fallback: 1 }, env)).toThrow(/unknown parameter "nope"/)
  })

  it('uses the fallback when a parameter has no value', () => {
    const { env, params } = setup()
    const b = compileBinding({ param: 'label' }, { type: 'string', fallback: 'none' }, env)
    params.set('label', undefined)
    expect(b.evaluate(0)).toBe('none')
  })
})

describe('compileBinding: { bind }', () => {
  it('reads tracking data per face', () => {
    const { env, faces } = setup()
    faces.count = 2
    setJaw(faces, 0, 0.25)
    setJaw(faces, 1, 0.75)
    const b = compileBinding({ bind: 'face.blendshapes.jawOpen' }, { type: 'number', fallback: 0 }, env)
    expect(b.kind).toBe('data')
    expect(b.perFace).toBe(true)
    expect(b.evaluate(0)).toBe(0.25)
    expect(b.evaluate(1)).toBe(0.75)
  })

  it('clamps to range then maps linearly to to (Appendix A)', () => {
    const { env, faces } = setup()
    faces.count = 1
    const b = compileBinding(
      { bind: 'face.blendshapes.jawOpen', range: [0.2, 0.6], to: [0, 1] },
      { type: 'number', fallback: 1 },
      env,
    )
    const at = (x: number) => (setJaw(faces, 0, x), b.evaluate(0))
    // Blendshapes are float32: 0.2 and 0.6 are not exact.
    expect(at(0)).toBe(0)
    expect(at(0.2)).toBeCloseTo(0, 6)
    expect(at(0.4)).toBeCloseTo(0.5, 6)
    expect(at(0.6)).toBeCloseTo(1, 6)
    expect(at(1)).toBe(1)
  })

  it('hits both ends of to exactly, and supports decreasing ranges', () => {
    const { env, data } = setup()
    const b = compileBinding({ bind: 'time', range: [0, 3], to: [0.1, 0.7] }, { type: 'number', fallback: 0 }, env)
    expect(b.perFace).toBe(false)
    data.time = 0
    expect(b.evaluate(NO_FACE)).toBe(0.1)
    data.time = 3
    expect(b.evaluate(NO_FACE)).toBe(0.7)
    const inverted = compileBinding({ bind: 'time', range: [1, 0], to: [0, 10] }, { type: 'number', fallback: 0 }, env)
    data.time = 0.25
    expect(inverted.evaluate(0)).toBeCloseTo(7.5, 9)
    data.time = 5
    expect(inverted.evaluate(0)).toBe(0)
  })

  it('looks values up in map, matching numeric data by value', () => {
    const { env, faces } = setup()
    faces.count = 2
    const b = compileBinding(
      { bind: 'face.index', map: { 0: '👑', 1: '🎩' }, default: '' },
      { type: 'string', fallback: '?' },
      env,
    )
    expect(b.evaluate(0)).toBe('👑')
    expect(b.evaluate(1)).toBe('🎩')
    expect(b.evaluate(2)).toBe('') // no face in slot 2
    faces.count = 3
    const count = compileBinding({ bind: 'faces.count', map: { 1: 0.5 } }, { type: 'number', fallback: 1 }, env)
    expect(count.evaluate(0)).toBe(1) // 3 is not in the table: fallback
  })

  it('maps string and boolean data from other sources', () => {
    const { params } = setup()
    let mood: string | undefined = 'happy'
    let flag: boolean | undefined = true
    const plugin: BindingDataSource = {
      resolve: (path) =>
        path === 'face.mood'
          ? { type: 'string', perFace: true, read: () => mood }
          : path === 'ext.demo.flag'
            ? { type: 'boolean', perFace: false, read: () => flag }
            : undefined,
    }
    const env: BindingEnv = { data: plugin, params }
    const b = compileBinding({ bind: 'face.mood', map: { happy: '😄', sad: '😢' }, default: '😐' }, { type: 'string', fallback: '' }, env)
    expect(b.evaluate(0)).toBe('😄')
    mood = 'surprised'
    expect(b.evaluate(0)).toBe('😐')
    mood = undefined
    expect(b.evaluate(0)).toBe('😐')
    expect(compileBinding({ bind: 'face.mood' }, { type: 'string', fallback: '' }, env).evaluate(0)).toBe('')
    const visible = compileBinding({ bind: 'ext.demo.flag', map: { true: false, false: true } }, { type: 'boolean', fallback: true }, env)
    expect(visible.evaluate(0)).toBe(false)
    flag = undefined
    expect(compileBinding({ bind: 'ext.demo.flag' }, { type: 'boolean', fallback: true }, env).evaluate(0)).toBe(true)
  })

  it('shows numbers in text properties', () => {
    const { env, faces } = setup()
    const b = compileBinding({ bind: 'faces.count' }, { type: 'string', fallback: '' }, env)
    faces.count = 2
    expect(b.evaluate(0)).toBe('2')
    faces.count = 0
    expect(b.evaluate(0)).toBe('0')
  })
})

describe('compileBinding: missing data', () => {
  it('gives default when there is no face, unmapped, else the fallback', () => {
    const { env, faces } = setup()
    faces.count = 1
    setJaw(faces, 0, 0.6)
    faces.matrices.set(poseMatrix(0, 0, 0), 0)
    const withDefault = compileBinding(
      { bind: 'face.blendshapes.jawOpen', range: [0.2, 0.6], to: [0, 1], default: 0.25 },
      { type: 'number', fallback: 1 },
      env,
    )
    const noDefault = compileBinding({ bind: 'face.pose.yaw' }, { type: 'number', fallback: 7 }, env)
    expect(withDefault.evaluate(0)).toBe(1)
    expect(withDefault.evaluate(1)).toBe(0.25)
    expect(withDefault.evaluate(NO_FACE)).toBe(0.25)
    expect(noDefault.evaluate(0)).toBe(0)
    expect(noDefault.evaluate(NO_FACE)).toBe(7)
    faces.count = 0
    expect(withDefault.evaluate(0)).toBe(0.25)
  })

  it('gives default while blendshapes are dropped (spec §16.2), other face data still flows', () => {
    const { env, faces, data } = setup()
    faces.count = 1
    setJaw(faces, 0, 0.9)
    const jaw = compileBinding({ bind: 'face.blendshapes.jawOpen', default: 0 }, { type: 'number', fallback: 1 }, env)
    const index = compileBinding({ bind: 'face.index' }, { type: 'number', fallback: -1 }, env)
    data.blendshapes = false
    expect(jaw.evaluate(0)).toBe(0)
    expect(index.evaluate(0)).toBe(0)
    data.blendshapes = true
    expect(jaw.evaluate(0)).toBeCloseTo(0.9, 6)
  })

  it('never treats time and faces.count as missing', () => {
    const { env, data } = setup()
    data.time = 12.5
    expect(compileBinding({ bind: 'time', default: 0 }, { type: 'number', fallback: 0 }, env).evaluate(NO_FACE)).toBe(12.5)
    expect(compileBinding({ bind: 'faces.count', default: 9 }, { type: 'number', fallback: 0 }, env).evaluate(NO_FACE)).toBe(0)
  })
})

describe('compileBinding: errors', () => {
  const { env } = setup()
  const num = { type: 'number', fallback: 0 } as const
  const cases: Array<[string, unknown, RegExp]> = [
    ['unknown path', { bind: 'face.blendshapes.jawOpn' }, /unknown data path/],
    ['_neutral is not exposed', { bind: 'face.blendshapes._neutral' }, /unknown data path/],
    ['range without to', { bind: 'time', range: [0, 1] }, /go together/],
    ['empty range', { bind: 'time', range: [1, 1], to: [0, 1] }, /must not be empty/],
    ['bad range', { bind: 'time', range: [0], to: [0, 1] }, /\[number, number\]/],
    ['map with range', { bind: 'time', range: [0, 1], to: [0, 1], map: { 0: 1 } }, /cannot be combined/],
    ['default of the wrong type', { bind: 'time', default: 'none' }, /"default" must be a number/],
    ['map value of the wrong type', { bind: 'face.index', map: { 0: 'a' } }, /"map" value for "0"/],
    ['extra keys on a param binding', { param: 'size', default: 1 }, /unexpected default/],
  ]
  for (const [name, value, error] of cases) {
    it(name, () => expect(() => compileBinding(value, num, env)).toThrow(error))
  }

  it('rejects range on non-numeric properties and data that does not fit without map', () => {
    expect(() => compileBinding({ bind: 'time', range: [0, 1], to: [0, 1] }, { type: 'vec3', fallback: [0, 0, 0] }, env)).toThrow(
      /give a number/,
    )
    expect(() => compileBinding({ bind: 'face.blendshapes.jawOpen' }, { type: 'boolean', fallback: true }, env)).toThrow(
      /add "map"/,
    )
    expect(() => compileBinding({ bind: 'face.index' }, { type: 'color', fallback: '#fff' }, env)).toThrow(BindingError)
  })
})

describe('isBinding', () => {
  it('tells bindings from fixed values', () => {
    expect(isBinding({ param: 'x' })).toBe(true)
    expect(isBinding({ bind: 'time' })).toBe(true)
    expect(isBinding([0, 1, 0])).toBe(false)
    expect(isBinding('#fff')).toBe(false)
    expect(isBinding(null)).toBe(false)
  })
})

/** Column-major 4×4 matrix of R = Ry(yaw)·Rx(pitch)·Rz(roll) (degrees), times `scale`, translated away from the camera. */
function poseMatrix(yaw: number, pitch: number, roll: number, scale = 1): number[] {
  const r = Math.PI / 180
  const [cy, sy] = [Math.cos(yaw * r), Math.sin(yaw * r)]
  const [cx, sx] = [Math.cos(pitch * r), Math.sin(pitch * r)]
  const [cz, sz] = [Math.cos(roll * r), Math.sin(roll * r)]
  const rows = [
    [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx],
    [cx * sz, cx * cz, -sx],
    [-sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx],
  ]
  const m = new Array<number>(16).fill(0)
  for (let c = 0; c < 3; c++) for (let row = 0; row < 3; row++) m[c * 4 + row] = rows[row]![c]! * scale
  m[14] = -40
  m[15] = 1
  return m
}

describe('FaceBindingData', () => {
  const reader = (env: BindingEnv, path: string) => compileNumberBinding({ bind: path }, { fallback: NaN }, env)

  it('derives yaw, pitch and roll from the transformation matrix', () => {
    const { faces, data, env } = setup()
    const [yaw, pitch, roll] = ['face.pose.yaw', 'face.pose.pitch', 'face.pose.roll'].map((p) => reader(env, p)) as [
      NumberBinding,
      NumberBinding,
      NumberBinding,
    ]
    faces.count = 2
    faces.matrices.set(poseMatrix(20, -10, 5), 0)
    faces.matrices.set(poseMatrix(-35, 25, -15, 1.3), 16)
    expect(yaw.evaluate(0)).toBeCloseTo(20, 4)
    expect(pitch.evaluate(0)).toBeCloseTo(-10, 4)
    expect(roll.evaluate(0)).toBeCloseTo(5, 4)
    expect(yaw.evaluate(1)).toBeCloseTo(-35, 4)
    expect(pitch.evaluate(1)).toBeCloseTo(25, 4)
    expect(roll.evaluate(1)).toBeCloseTo(-15, 4)
    data.mirrored = true
    expect(yaw.evaluate(0)).toBeCloseTo(-20, 4)
    expect(pitch.evaluate(0)).toBeCloseTo(-10, 4)
    expect(roll.evaluate(0)).toBeCloseTo(-5, 4)
    expect(yaw.evaluate(2)).toBeNaN()
  })

  it('gives the neutral pose for an identity rotation and NaN for a degenerate matrix', () => {
    const { faces } = setup()
    faces.count = 2
    faces.matrices.set(poseMatrix(0, 0, 0), 0)
    const pose = new Float64Array(6)
    computeHeadPose(faces, 0, false, pose)
    expect([...pose.subarray(0, 3)].map(Math.abs)).toEqual([0, 0, 0])
    computeHeadPose(faces, 1, false, pose, 3) // all-zero matrix
    expect(pose[3 + POSE_YAW]).toBeNaN()
    expect(pose[3 + POSE_PITCH]).toBeNaN()
    expect(pose[3 + POSE_ROLL]).toBeNaN()
  })

  it('measures face.size as the eye distance over the screen height', () => {
    const { faces, data, env } = setup()
    faces.count = 1
    faces.width = 1280
    faces.height = 720
    // Eye corners (Appendix D): left eye 263, 362 → center x 0.58; right eye 33, 133 → center x 0.44.
    const put = (i: number, x: number, y: number) => faces.landmarks.set([x, y, 0], i * 3)
    put(263, 0.6, 0.5)
    put(362, 0.56, 0.5)
    put(33, 0.4, 0.5)
    put(133, 0.48, 0.5)
    const size = compileNumberBinding({ bind: 'face.size' }, { fallback: 0 }, env)
    const expected = (0.14 * 1280) / 720
    expect(size.evaluate(0)).toBeCloseTo(expected, 6)
    // A wide screen showing a cropped band of the frame: the video quad is 1.5 screen heights tall.
    data.videoToClip = { ax: 2, bx: -1, ay: -3, by: 1.5 }
    expect(size.evaluate(0)).toBeCloseTo(expected * 1.5, 6)
    expect(size.evaluate(1)).toBe(0)
  })

  it('follows the FaceFrame it is pointed at', () => {
    const { data, env } = setup()
    const other = createFaceFrame(1)
    other.count = 1
    other.blendshapes[JAW] = 0.5
    const jaw = compileNumberBinding({ bind: 'face.blendshapes.jawOpen' }, { fallback: 0 }, env)
    expect(jaw.evaluate(0)).toBe(0)
    data.faces = other
    expect(jaw.evaluate(0)).toBe(0.5)
  })
})

// `total_allocated_bytes` counts every byte the V8 heap has allocated (Node ≥ 25); skipped where it is missing.
const allocated = () => (v8.getHeapStatistics() as { total_allocated_bytes?: number }).total_allocated_bytes
describe.skipIf(allocated() === undefined)('allocation', () => {
  it('evaluates numeric bindings without allocating', () => {
    const { env, faces, data } = setup(2)
    faces.count = 2
    faces.width = 640
    faces.height = 480
    faces.matrices.set(poseMatrix(10, 5, -3), 0)
    faces.matrices.set(poseMatrix(-10, 2, 4), 16)
    const num = { fallback: 1 }
    // Every form, called through one shared (megamorphic) call site, as a render loop over all layers would.
    const bindings = [
      compileNumberBinding(0.5, num, env),
      compileNumberBinding({ param: 'size' }, num, env),
      compileNumberBinding({ bind: 'face.blendshapes.jawOpen', range: [0.2, 0.6], to: [0, 1], default: 0 }, num, env),
      compileNumberBinding({ bind: 'face.blendshapes.mouthSmileLeft' }, num, env),
      compileNumberBinding({ bind: 'face.pose.yaw', range: [-30, 30], to: [-1, 1] }, num, env),
      compileNumberBinding({ bind: 'face.pose.pitch' }, num, env),
      compileNumberBinding({ bind: 'face.pose.roll' }, num, env),
      compileNumberBinding({ bind: 'face.size' }, num, env),
      compileNumberBinding({ bind: 'face.index', map: { 0: 0.3, 1: 0.6 } }, num, env),
      compileNumberBinding({ bind: 'faces.count' }, num, env),
      compileNumberBinding({ bind: 'time', range: [0, 10], to: [0, 1] }, num, env),
    ]
    const out = new Float32Array(bindings.length * 3)
    const frame = (i: number) => {
      data.time = i / 30
      data.blendshapes = (i & 64) === 0
      setJaw(faces, 0, (i % 100) / 100)
      setJaw(faces, 1, ((i + 50) % 100) / 100)
      for (let b = 0; b < bindings.length; b++) {
        // Face slots 0 and 1, then a slot without a face (missing data).
        for (let f = 0; f < 3; f++) bindings[b]!.write(f, out, b * 3 + f)
      }
    }
    for (let i = 0; i < 200000; i++) frame(i) // warm-up: let the JIT optimize the evaluators
    const frames = 100000
    const before = allocated()!
    for (let i = 0; i < frames; i++) frame(i)
    const perEvaluation = (allocated()! - before) / (frames * bindings.length * 3)
    // A boxed number is at least 12 bytes. The test runner's worker allocates a few bytes per frame by itself
    // (measured with no binding at all), hence a bound per evaluation rather than exactly 0.
    expect(perEvaluation).toBeLessThan(1)
    expect(out.every((v) => Number.isFinite(v))).toBe(true)
  })
})
