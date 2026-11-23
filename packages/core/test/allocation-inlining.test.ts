/**
 * The engine's per-frame math, measured as when V8's inlining budget is spent (`limitInlining`): only small functions
 * are inlined, so a helper that takes or returns a fractional number boxes it on every call, whatever the order in
 * which V8 compiles the code (#149, #159). The same functions are measured with the default inlining in their own test
 * files. Times are whole numbers here: a fractional time passed by the test itself would be boxed at its call.
 */
import { Matrix4, PerspectiveCamera } from 'three'
import { describe, expect, it } from 'vitest'
import { FaceAnchors, type AnchorProvider } from '../src/engine/anchor-provider.ts'
import { writeFaceMask, MASK_VERTICES } from '../src/layers/color/face-mask.ts'
import { AMOUNT_COUNT, writeGradeUniforms } from '../src/layers/color/grade.ts'
import { OCCLUDER_VERTICES, writeHeadOccluder } from '../src/layers/model/occluder.ts'
import { ShaderFaceInputs } from '../src/layers/shader/inputs.ts'
import { WarpPacker } from '../src/layers/warp/warp-math.ts'
import {
  BLENDSHAPES_STRIDE,
  ExpressionEventDetector,
  FaceBindingData,
  FaceIdentityTracker,
  FaceSmoother,
  OneEuroBank,
  TRACKER_FOV_Y,
  blendshapeIndex,
  compileNumberBinding,
  computeAnchorMatrix,
  computeVideoToClip,
  createFaceFrame,
  createSignals,
  createVideoToClip,
  estimateFacePose,
  estimateFacePoses,
  readExpressionSignals,
  type BindingEnv,
} from '../src/index.ts'
import { bytesPerCall, limitInlining } from './allocation.ts'
import { writeSyntheticFace } from './synthetic-face.ts'

limitInlining()

/** The objects camera as the compositor sets it up (tracker perspective, cover crop). */
function objectsCamera(vw: number, vh: number, tw: number, th: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(TRACKER_FOV_Y, vw / vh, 1, 10000)
  const m = computeVideoToClip(vw, vh, tw, th, 'cover', false, createVideoToClip())
  camera.projectionMatrix.premultiply(new Matrix4().makeScale(Math.abs(m.ax) / 2, Math.abs(m.ay) / 2, 1))
  return camera
}

function twoFaces() {
  const faces = createFaceFrame(2)
  faces.count = 2
  writeSyntheticFace(faces, 0, { yaw: 10, t: [-15, 0, -60] })
  writeSyntheticFace(faces, 1, { yaw: -20, pitch: 10, t: [15, 0, -55] })
  estimateFacePoses(faces)
  return faces
}

describe('allocation with small-function inlining only', () => {
  it('anchors: pose, anchor matrices, face mesh', () => {
    const faces = twoFaces()
    const m = new Float32Array(16)
    expect(bytesPerCall(() => estimateFacePose(faces, 1, faces.matrices))).toBeLessThan(1)
    expect(bytesPerCall(() => computeAnchorMatrix(faces, 1, 'mouth', 'expression', true, m))).toBeLessThan(1)
    expect(bytesPerCall(() => computeAnchorMatrix(faces, 1, 'noseTip', 'rigid', false, m))).toBeLessThan(1)
    computeAnchorMatrix(faces, 1, 'head', 'rigid', true, m)
    const occluder = new Float32Array(OCCLUDER_VERTICES * 3)
    expect(bytesPerCall(() => writeHeadOccluder(faces, 1, true, m, occluder))).toBeLessThan(1)
  })

  it('smoothing: one-euro filter, face identity, smoother', () => {
    const bank = new OneEuroBank(1434, { minCutoff: 1, beta: 0.5, dCutoff: 1 })
    const src = new Float32Array(1434).fill(0.5)
    const dst = new Float32Array(1434)
    const scale = new Float64Array([1, 2, 1])
    const t = new Float64Array(1)
    expect(bytesPerCall(() => bank.filter(src, 0, dst, 0, t[0]!++, scale), { calls: 1000 })).toBeLessThan(1)

    const raw = twoFaces()
    const identity = new FaceIdentityTracker({ maxFaces: 2 })
    const smoother = new FaceSmoother(identity)
    const smoothed = createFaceFrame(2)
    const predicted = createFaceFrame(2)
    expect(
      bytesPerCall(
        () => {
          const time = t[0]!++
          identity.update(raw, time)
          smoother.update(raw, time, smoothed)
          smoother.predict(smoothed, time + 1, predicted) // capped at maxPredictionMs: a fractional horizon
        },
        { warmup: 20_000, calls: 300 },
      ),
    ).toBeLessThan(1)
  })

  it('layers: shader face inputs, warp centres, color grade and face mask', () => {
    const faces = twoFaces()
    const camera = objectsCamera(faces.width, faces.height, 1280, 720)
    const projection = camera.projectionMatrix.elements
    const anchors = new FaceAnchors(faces, camera)
    anchors.setFrame(faces, [1, 2], false)
    const inputs = new ShaderFaceInputs(2, ['noseTip', 'mouth'], true)
    expect(bytesPerCall(() => inputs.update(anchors, 2, projection))).toBeLessThan(1)
    // The same with a provider that does nothing: the shader inputs' own math only.
    const fixed = new Matrix4().makeScale(6.3, 6.3, 6.3).setPosition(1.5, 0.5, -60.5)
    const stub: AnchorProvider = { face: (_f, _a, _w, out) => out.copy(fixed) !== null, screen: () => {}, id: () => 1 }
    expect(bytesPerCall(() => inputs.update(stub, 2, projection))).toBeLessThan(1)

    const packer = new WarpPacker(8)
    const props = new Float64Array([1.2, 0.5, 1, 0.3])
    const sizes = new Float64Array(1)
    expect(
      bytesPerCall(() => {
        packer.begin(projection, 1280, 720)
        packer.addFace(fixed.elements, props)
        packer.addScreen(props)
        packer.unitSize(fixed.elements, sizes, 0)
      }),
    ).toBeLessThan(1)

    const amounts = new Float32Array(AMOUNT_COUNT).fill(0.3)
    const tint = new Float32Array([1, 0.8, 0.6, 0.5])
    const uniforms = new Float32Array(16)
    expect(bytesPerCall(() => writeGradeUniforms(amounts, tint, 1.5, uniforms))).toBeLessThan(1)
    const mask = new Float32Array(MASK_VERTICES * 2)
    expect(bytesPerCall(() => writeFaceMask(faces, 1, 0, true, projection, mask))).toBeLessThan(1)
  })

  it('bindings: face data readers', () => {
    const faces = twoFaces()
    const data = new FaceBindingData(faces)
    const env: BindingEnv = { data, params: { type: () => undefined, get: () => undefined } }
    const jaw = blendshapeIndex('jawOpen')
    const bindings = [
      compileNumberBinding({ bind: 'face.blendshapes.jawOpen' }, { fallback: 1 }, env),
      compileNumberBinding({ bind: 'face.blendshapes.jawOpen', range: [0.2, 0.6], to: [0, 1], default: 0 }, { fallback: 1 }, env),
      compileNumberBinding({ bind: 'face.pose.yaw', range: [-30, 30], to: [-1, 1] }, { fallback: 1 }, env),
      compileNumberBinding({ bind: 'face.size' }, { fallback: 1 }, env),
      compileNumberBinding({ bind: 'time' }, { fallback: 1 }, env),
    ]
    const out = new Float32Array(bindings.length * 3)
    const state = new Float64Array(1)
    const frame = () => {
      const i = state[0]!++
      data.time = i / 30
      for (let f = 0; f < 2; f++) faces.blendshapes[f * BLENDSHAPES_STRIDE + jaw] = ((i + 50 * f) % 100) / 100
      // Face slots 0 and 1, then a slot without a face (missing data).
      for (let b = 0; b < bindings.length; b++) for (let f = 0; f < 3; f++) bindings[b]!.write(f, out, b * 3 + f)
    }
    expect(bytesPerCall(frame, { warmup: 20_000 })).toBeLessThan(1)
  })

  it('expression events', () => {
    const d = new ExpressionEventDetector({ maxFaces: 2, calibrate: true })
    const faces = twoFaces()
    const signals = createSignals(2)
    const ids = new Int32Array([1, 2])
    const eyeRight = blendshapeIndex('eyeBlinkRight')
    const state = new Float64Array(2) // frame, events
    const frame = () => {
      const k = state[0]!++
      // Every gesture, then winks of the left eye half of the time (the wink channel takes the eye's fractional value).
      for (let f = 0; f < 2; f++) {
        for (let b = 1; b < BLENDSHAPES_STRIDE; b++) faces.blendshapes[f * BLENDSHAPES_STRIDE + b] = k % 40 < 6 ? 0.85 : 0.15
        if (k % 80 < 40) faces.blendshapes[f * BLENDSHAPES_STRIDE + eyeRight] = 0.05
      }
      readExpressionSignals(faces, signals)
      state[1]! += d.update(k * 33, 2, ids, signals).count
    }
    expect(bytesPerCall(frame, { warmup: 20_000 })).toBeLessThan(1)
    expect(state[1]).toBeGreaterThan(1000)
  })
})
