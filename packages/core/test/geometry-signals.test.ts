import { describe, expect, it } from 'vitest'
import { createFaceFrame, LANDMARKS_STRIDE } from '../src/face.ts'
import { blendshapeSignals, createSignals, SIGNAL, SIGNALS_STRIDE } from '../src/expressions/signals.ts'
import { geometryMeasures, geometrySignals } from '../src/expressions/geometry.ts'
import { bytesPerCall } from './allocation.ts'
import type { RecordedEvent } from './expression-fixture.ts'
import { GEOMETRY_CLIPS, loadFrame, loadGeometryFixture, replayGeometryFixture } from './geometry-fixture.ts'

/**
 * Geometric expression signals (#90, spec §13, §16.2) against MediaPipe's blendshapes on the test clips (fixtures
 * recorded by `e2e/record-geometry.spec.ts`). The figures below are the calibration of `GEOMETRY_CALIBRATION`:
 *
 * | signal | Pearson r | mean abs error | blendshape max on the frames used |
 * |---|---|---|---|
 * | eyeClosedLeft / Right | 0.83 / 0.79 | 0.12 / 0.11 | 0.85 / 0.81 |
 * | jawOpen | 0.55 | 0.02 | 0.28 |
 * | smile | 0.85 | 0.11 | 0.93 |
 * | browRaise | 0.65 | 0.01 | 0.27 |
 * | pucker | 0.67 | 0.04 | 0.78 |
 *
 * Frames used: face 0 with |yaw| < 35° (177 frames of the four clips). Events (detector defaults): 8 of the 10
 * blendshape blinks and 3 of the 4 smiles fire from the geometry within 250 ms, with 5 extra blinks (smiles
 * narrow the eyes) and extra smile / smileEnd pairs around the threshold.
 */

const fixtures = GEOMETRY_CLIPS.map((clip) => loadGeometryFixture(clip))
const MAX_YAW = (35 * Math.PI) / 180

function pairs(): Record<'eyeClosedLeft' | 'eyeClosedRight' | 'jawOpen' | 'smile' | 'browRaise' | 'pucker', [number[], number[]]> {
  const names = ['eyeClosedLeft', 'eyeClosedRight', 'jawOpen', 'smile', 'browRaise', 'pucker'] as const
  const out = Object.fromEntries(names.map((n) => [n, [[], []]])) as unknown as ReturnType<typeof pairs>
  const faces = createFaceFrame(1)
  const bs = createSignals(1)
  const geo = createSignals(1)
  for (const fixture of fixtures) {
    for (const f of fixture.frames) {
      if (f.length === 1) continue
      loadFrame(fixture, f, faces)
      blendshapeSignals(faces, 0, bs, 0)
      geometrySignals(faces, 0, geo, 0)
      if (Math.abs(bs[SIGNAL.yaw]!) > MAX_YAW) continue
      for (const n of names) {
        out[n][0].push(bs[SIGNAL[n]]!)
        out[n][1].push(geo[SIGNAL[n]]!)
      }
    }
  }
  return out
}

function pearson(x: readonly number[], y: readonly number[]): number {
  const mean = (v: readonly number[]) => v.reduce((s, a) => s + a, 0) / v.length
  const mx = mean(x)
  const my = mean(y)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my)
    sxx += (x[i]! - mx) ** 2
    syy += (y[i]! - my) ** 2
  }
  return sxy / Math.sqrt(sxx * syy)
}

/** Geometry events matched to blendshape events of the same name within `windowMs`. */
function match(reference: RecordedEvent[], geometry: RecordedEvent[], names: readonly string[], windowMs = 250) {
  const ref = reference.filter((e) => names.includes(e.name))
  const geo = geometry.filter((e) => names.includes(e.name))
  const used = new Set<number>()
  for (const e of geo) {
    const j = ref.findIndex((r, k) => !used.has(k) && r.name === e.name && Math.abs(r.timeMs - e.timeMs) <= windowMs)
    if (j >= 0) used.add(j)
  }
  return { reference: ref.length, matched: used.size, extra: geo.length - used.size }
}

describe('geometrySignals: calibration against the blendshapes of the test clips', () => {
  const p = pairs()

  it('uses enough frontal frames', () => {
    expect(p.smile[0].length).toBeGreaterThan(150)
  })

  it.each([
    ['eyeClosedLeft', 0.8, 0.14],
    ['eyeClosedRight', 0.75, 0.14],
    ['jawOpen', 0.5, 0.04],
    ['smile', 0.8, 0.14],
    ['browRaise', 0.55, 0.02],
    ['pucker', 0.6, 0.06],
  ] as const)('%s follows the blendshape score (r ≥ %s, mean error ≤ %s)', (name, r, mae) => {
    const [bs, geo] = p[name]
    expect(pearson(bs, geo)).toBeGreaterThanOrEqual(r)
    expect(bs.reduce((s, v, i) => s + Math.abs(v - geo[i]!), 0) / bs.length).toBeLessThanOrEqual(mae)
  })

  it.each([
    ['30 Hz', 0],
    ['15 Hz', 66],
  ])('fires most blinks and smiles of the blendshapes, at %s', (_, stepMs) => {
    let blinks = { reference: 0, matched: 0, extra: 0 }
    let smiles = { reference: 0, matched: 0, extra: 0 }
    for (const fixture of fixtures) {
      const ref = replayGeometryFixture(fixture, blendshapeSignals, { stepMs })
      const geo = replayGeometryFixture(fixture, geometrySignals, { stepMs })
      const b = match(ref, geo, ['blink'])
      const s = match(ref, geo, ['smile'])
      blinks = { reference: blinks.reference + b.reference, matched: blinks.matched + b.matched, extra: blinks.extra + b.extra }
      smiles = { reference: smiles.reference + s.reference, matched: smiles.matched + s.matched, extra: smiles.extra + s.extra }
    }
    expect(blinks.reference).toBeGreaterThanOrEqual(5)
    expect(blinks.matched / blinks.reference).toBeGreaterThanOrEqual(0.7)
    expect(blinks.extra).toBeLessThanOrEqual(blinks.reference)
    expect(smiles.reference).toBeGreaterThanOrEqual(2)
    expect(smiles.matched / smiles.reference).toBeGreaterThanOrEqual(0.6)
  })
})

describe('geometrySignals', () => {
  const fixture = fixtures[0]!
  const frame = fixture.frames.find((f) => f.length > 1)!

  it('does not depend on the face size or position on screen', () => {
    const a = createFaceFrame(1)
    loadFrame(fixture, frame, a)
    const b = createFaceFrame(1)
    loadFrame(fixture, frame, b)
    // Half the size, moved right and down (x, y normalized; z at the scale of x).
    for (let i = 0; i < LANDMARKS_STRIDE; i += 3) {
      b.landmarks[i] = b.landmarks[i]! * 0.5 + 0.3
      b.landmarks[i + 1] = b.landmarks[i + 1]! * 0.5 + 0.2
      b.landmarks[i + 2] = b.landmarks[i + 2]! * 0.5
    }
    const sa = createSignals(1)
    const sb = createSignals(1)
    geometrySignals(a, 0, sa, 0)
    geometrySignals(b, 0, sb, 0)
    for (let k = 0; k < SIGNALS_STRIDE; k++) expect(sb[k]).toBeCloseTo(sa[k]!, 4)
    expect(Number.isFinite(geometryMeasures(a, 0).lipGap)).toBe(true)
  })

  it('writes values from 0 to 1, and NaN for a degenerate face', () => {
    const faces = createFaceFrame(1)
    loadFrame(fixture, frame, faces)
    const s = createSignals(1)
    geometrySignals(faces, 0, s, 0)
    for (let k = SIGNAL.eyeClosedLeft; k <= SIGNAL.pucker; k++) {
      expect(s[k]).toBeGreaterThanOrEqual(0)
      expect(s[k]).toBeLessThanOrEqual(1)
    }
    faces.landmarks.fill(0.5)
    geometrySignals(faces, 0, s, 0)
    for (let k = SIGNAL.eyeClosedLeft; k <= SIGNAL.pucker; k++) expect(s[k]).toBeNaN()
    expect(geometryMeasures(faces, 0).eyeLeft).toBeNaN()
  })

  it('does not allocate', () => {
    const faces = createFaceFrame(2)
    loadFrame(fixture, frame, faces)
    faces.landmarks.copyWithin(LANDMARKS_STRIDE, 0, LANDMARKS_STRIDE)
    faces.count = 2
    const s = createSignals(2)
    expect(bytesPerCall(() => geometrySignals(faces, 1, s, SIGNALS_STRIDE))).toBeLessThan(1)
  })
})
