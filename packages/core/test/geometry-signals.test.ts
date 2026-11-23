import { describe, expect, it } from 'vitest'
import { createFaceFrame, LANDMARKS_STRIDE } from '../src/face.ts'
import { blendshapeSignals, createSignals, SIGNAL, SIGNALS_STRIDE } from '../src/expressions/signals.ts'
import { GeometrySignals, geometryMeasures, geometrySignals } from '../src/expressions/geometry.ts'
import { bytesPerCall } from './allocation.ts'
import type { RecordedEvent } from './expression-fixture.ts'
import { GEOMETRY_CLIPS, loadFrame, loadGeometryFixture, replayGeometryFixture } from './geometry-fixture.ts'

/**
 * Geometric expression signals (#90, spec §13, §16.2) against MediaPipe's blendshapes on the test clips (fixtures
 * recorded by `e2e/record-geometry.spec.ts`). The figures below are the calibration of `GEOMETRY_CALIBRATION`:
 *
 * | signal | Pearson r | mean abs error | blendshape max on the frames used |
 * |---|---|---|---|
 * | eyeClosedLeft / Right | 0.82 / 0.77 | 0.11 / 0.14 | 0.85 / 0.81 |
 * | jawOpen | 0.54 | 0.02 | 0.28 |
 * | smile | 0.85 | 0.11 | 0.93 |
 * | browRaise | 0.66 | 0.01 | 0.27 |
 * | pucker | 0.67 | 0.04 | 0.78 |
 *
 * Frames used: face 0 with |yaw| < 35° (177 frames of the four clips). Smiles (detector defaults): 3 of the 4
 * blendshape smiles fire from the geometry within 250 ms, with extra smile / smileEnd pairs around the threshold.
 *
 * Blinks come from `GeometrySignals` (what the engine uses): the eyes against each face's adaptive open-eye
 * baseline (`EYE_BASELINE`). Against the blendshapes its values are further off (r 0.77 / 0.84, MAE 0.24 / 0.18:
 * blendshapes also rise when someone looks down, which the baseline removes on purpose), but blinks are cleaner. At
 * 30 and 15 Hz pooled: 13 of the 19 blendshape blinks and 3 extra blinks, against 15 of 19 and 8 extra with the
 * absolute mapping of `geometrySignals`; the blinks it misses are blendshape crossings of 0.5 while the person looks
 * down (pitch -30 to -40°, `pesquet-walk` 3.5-6.3 s), where the blendshape score itself stays at 0.5-0.8 for seconds.
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
    ['eyeClosedRight', 0.75, 0.15],
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
      const geo = replayGeometryFixture(fixture, new GeometrySignals(1), { stepMs })
      const b = match(ref, geo, ['blink'])
      const s = match(ref, geo, ['smile'])
      blinks = { reference: blinks.reference + b.reference, matched: blinks.matched + b.matched, extra: blinks.extra + b.extra }
      smiles = { reference: smiles.reference + s.reference, matched: smiles.matched + s.matched, extra: smiles.extra + s.extra }
    }
    expect(blinks.reference).toBeGreaterThanOrEqual(5)
    expect(blinks.matched / blinks.reference).toBeGreaterThanOrEqual(0.6)
    expect(blinks.extra).toBeLessThanOrEqual(2)
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
    const g = new GeometrySignals(2)
    const ids = new Int32Array([1, 2])
    const time = new Float64Array(1)
    expect(
      bytesPerCall(() => {
        time[0]! += 33
        g.begin(ids, time[0]!)
        g.source(faces, 1, s, SIGNALS_STRIDE)
      }),
    ).toBeLessThan(1)
  })
})

describe('GeometrySignals: eyes against an adaptive open-eye baseline', () => {
  const fixture = fixtures[0]!
  const frame = fixture.frames.find((f) => f.length > 1)!

  /** Face 0 of `frame` with the eyelids at `opening` × their recorded distance from the eye's centre line. */
  function eyes(opening: number) {
    const faces = createFaceFrame(1)
    loadFrame(fixture, frame, faces)
    for (const [upper, lower] of [
      [[386, 385, 387, 384, 388], [374, 380, 373, 381, 390]],
      [[159, 158, 160, 157, 161], [145, 153, 144, 154, 163]],
    ] as const) {
      for (let i = 0; i < upper.length; i++) {
        for (let c = 0; c < 3; c++) {
          const u = faces.landmarks[upper[i]! * 3 + c]!
          const l = faces.landmarks[lower[i]! * 3 + c]!
          const mid = (u + l) / 2
          faces.landmarks[upper[i]! * 3 + c] = mid + (u - mid) * opening
          faces.landmarks[lower[i]! * 3 + c] = mid + (l - mid) * opening
        }
      }
    }
    return faces
  }

  it('reads a blink as closed whatever the opening of the open eyes, and starts over for a new face', () => {
    const g = new GeometrySignals(1)
    const s = createSignals(1)
    const read = (faces: ReturnType<typeof eyes>, id: number, t: number) => {
      g.begin([id], t)
      g.source(faces, 0, s, 0)
      return [s[SIGNAL.eyeClosedLeft]!, s[SIGNAL.eyeClosedRight]!]
    }
    // Narrow eyes (60 % of the recorded opening) for 2 s: they are this face's open eyes.
    for (let t = 0; t <= 2000; t += 33) expect(read(eyes(0.6), 1, t)[0]).toBeLessThan(0.1)
    // A blink from there: closed.
    for (const v of read(eyes(0.1), 1, 2033)) expect(v).toBeGreaterThan(0.9)
    // Another face with wide eyes: a new baseline at once, open.
    for (const v of read(eyes(1.3), 2, 2066)) expect(v).toBe(0)
    // Lids at half the wide opening: closed enough to blink.
    for (const v of read(eyes(0.65), 2, 2100)) expect(v).toBeGreaterThan(0.5)
  })
})
