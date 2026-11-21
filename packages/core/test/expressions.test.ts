import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { createRegistry } from '@ouaf/spec'
import { describe, expect, it } from 'vitest'
import {
  BLENDSHAPES_STRIDE,
  DEFAULT_EVENT_MIN_DURATION_MS,
  DEFAULT_EVENT_THRESHOLDS,
  EXPRESSION_EVENTS,
  ExpressionEventDetector,
  SIGNAL,
  SIGNALS_STRIDE,
  blendshapeIndex,
  blendshapeSignals,
  createFaceFrame,
  createSignals,
  readExpressionSignals,
  type EventTuning,
  type ExpressionEventDetectorOptions,
} from '../src/index.ts'
import { loadExpressionFixture, replayFixture, type RecordedEvent } from './expression-fixture.ts'

const DEG = Math.PI / 180

/** Deterministic noise (mulberry32), uniform in [-1, 1]. */
function noise(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
  }
}

interface Face {
  eyeL: number
  eyeR: number
  jaw: number
  smile: number
  brow: number
  pucker: number
  /** Degrees. */
  pitch: number
  yaw: number
}

const NEUTRAL: Face = { eyeL: 0.1, eyeR: 0.1, jaw: 0.02, smile: 0.03, brow: 0.05, pucker: 0.02, pitch: 0, yaw: 0 }

interface Sim {
  /** Duration (ms). */
  ms: number
  /** Tracking rate (default 30 Hz). */
  hz?: number
  /** Face at time t (ms); unspecified signals are neutral. */
  face?: (t: number) => Partial<Face>
  /** Uniform noise amplitude on the 0–1 signals (default 0.03) and on the angles in degrees (default 0.5). */
  noise?: number
  angleNoise?: number
  seed?: number
  options?: Omit<ExpressionEventDetectorOptions, 'maxFaces'>
}

/** Runs one face through a detector and returns the events (copied). */
function simulate(s: Sim): RecordedEvent[] {
  const detector = new ExpressionEventDetector({ maxFaces: 1, ...s.options })
  const signals = createSignals(1)
  const rnd = noise(s.seed ?? 1)
  const amp = s.noise ?? 0.03
  const angleAmp = s.angleNoise ?? 0.5
  const clamp = (v: number) => Math.min(1, Math.max(0, v + amp * rnd()))
  const events: RecordedEvent[] = []
  const step = 1000 / (s.hz ?? 30)
  for (let t = 0; t <= s.ms; t += step) {
    const f = { ...NEUTRAL, ...s.face?.(t) }
    signals[SIGNAL.eyeClosedLeft] = clamp(f.eyeL)
    signals[SIGNAL.eyeClosedRight] = clamp(f.eyeR)
    signals[SIGNAL.jawOpen] = clamp(f.jaw)
    signals[SIGNAL.smile] = clamp(f.smile)
    signals[SIGNAL.browRaise] = clamp(f.brow)
    signals[SIGNAL.pucker] = clamp(f.pucker)
    signals[SIGNAL.pitch] = (f.pitch + angleAmp * rnd()) * DEG
    signals[SIGNAL.yaw] = (f.yaw + angleAmp * rnd()) * DEG
    const out = detector.update(Math.round(t), 1, [7], signals)
    for (let i = 0; i < out.count; i++) events.push({ ...out.items[i]! })
  }
  return events
}

const names = (events: RecordedEvent[]) => events.filter((e) => e.name !== 'faceEnter' && e.name !== 'faceLeave').map((e) => e.name)
const during = (from: number, to: number, v: Partial<Face>) => (t: number) => (t >= from && t < to ? v : {})

describe('expression signals', () => {
  it('reads the blendshapes and the head pose', () => {
    const faces = createFaceFrame(2)
    faces.count = 2
    const o = BLENDSHAPES_STRIDE // face 1
    faces.blendshapes[o + blendshapeIndex('eyeBlinkLeft')] = 0.9
    faces.blendshapes[o + blendshapeIndex('eyeBlinkRight')] = 0.2
    faces.blendshapes[o + blendshapeIndex('jawOpen')] = 0.4
    faces.blendshapes[o + blendshapeIndex('mouthSmileLeft')] = 0.6
    faces.blendshapes[o + blendshapeIndex('mouthSmileRight')] = 0.8
    faces.blendshapes[o + blendshapeIndex('browInnerUp')] = 0.3
    faces.blendshapes[o + blendshapeIndex('mouthPucker')] = 0.7
    // Face 0: frontal. Face 1: turned by 30° of yaw, then 10° of pitch (the matrix may carry a scale).
    faces.matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -50, 1], 0)
    const y = 30 * DEG
    const p = 10 * DEG
    faces.matrices.set([2 * Math.sin(y) * Math.cos(p), 2 * Math.sin(p), 2 * Math.cos(y) * Math.cos(p)], 16 + 8)
    const signals = createSignals(2)
    readExpressionSignals(faces, signals)
    expect(signals[SIGNAL.pitch]).toBeCloseTo(0)
    expect(signals[SIGNAL.yaw]).toBeCloseTo(0)
    const f1 = Array.from(signals.subarray(SIGNALS_STRIDE, 2 * SIGNALS_STRIDE))
    expect(f1[SIGNAL.eyeClosedLeft]).toBeCloseTo(0.9)
    expect(f1[SIGNAL.eyeClosedRight]).toBeCloseTo(0.2)
    expect(f1[SIGNAL.jawOpen]).toBeCloseTo(0.4)
    expect(f1[SIGNAL.smile]).toBeCloseTo(0.7)
    expect(f1[SIGNAL.browRaise]).toBeCloseTo(0.3)
    expect(f1[SIGNAL.pucker]).toBeCloseTo(0.7)
    expect(f1[SIGNAL.yaw]).toBeCloseTo(y, 5)
    expect(f1[SIGNAL.pitch]).toBeCloseTo(p, 5)
  })

  it('writes NaN for the pose of an empty matrix', () => {
    const faces = createFaceFrame(1)
    const signals = createSignals(1)
    blendshapeSignals(faces, 0, signals, 0)
    expect(signals[SIGNAL.pitch]).toBeNaN()
  })
})

describe('expression events: defaults', () => {
  it('match the spec registry', () => {
    const reg = createRegistry()
    for (const [name, threshold] of Object.entries(DEFAULT_EVENT_THRESHOLDS)) expect(reg.events.get(name)?.threshold, name).toBe(threshold)
    for (const name of EXPRESSION_EVENTS) expect(reg.events.get(name)?.face, name).toBe(true)
    const face = [...reg.events.values()].filter((e) => e.face).map((e) => e.name)
    expect([...EXPRESSION_EVENTS].sort()).toEqual(face.sort())
    expect(Object.keys(DEFAULT_EVENT_MIN_DURATION_MS).sort()).toEqual(EXPRESSION_EVENTS.filter((n) => !n.startsWith('face')).sort())
  })

  it('validates its options', () => {
    expect(() => new ExpressionEventDetector({ maxFaces: 0 })).toThrow(RangeError)
  })
})

describe('expression events: eyes', () => {
  it('a blink fires once, without a wink', () => {
    const ev = simulate({ ms: 2000, face: during(1000, 130 + 1000, { eyeL: 0.85, eyeR: 0.85 }) })
    expect(names(ev)).toEqual(['blink'])
  })

  it('a blink whose eyelids close one frame apart is still a blink only', () => {
    const ev = simulate({
      ms: 2000,
      face: (t) => (t >= 1000 && t < 1033 ? { eyeL: 0.8, eyeR: 0.2 } : t >= 1033 && t < 1150 ? { eyeL: 0.85, eyeR: 0.85 } : {}),
    })
    expect(names(ev)).toEqual(['blink'])
  })

  it('fires at 15 Hz on a single closed frame', () => {
    expect(names(simulate({ ms: 2000, hz: 15, face: during(1000, 1067, { eyeL: 0.8, eyeR: 0.8 }) }))).toEqual(['blink'])
  })

  it('a wink reports the side of the closed eye', () => {
    const left = simulate({ ms: 2000, face: during(1000, 1400, { eyeL: 0.8, eyeR: 0.15 }) })
    expect(left.filter((e) => e.name === 'wink')).toEqual([{ name: 'wink', faceId: 7, side: 'left', timeMs: expect.any(Number) }])
    expect(names(left)).toEqual(['wink'])
    const right = simulate({ ms: 2000, face: during(1000, 1400, { eyeL: 0.1, eyeR: 0.9 }) })
    expect(right.map((e) => e.side).filter(Boolean)).toEqual(['right'])
  })

  it('no wink in a three-quarter view, where the far eye looks closed', () => {
    expect(names(simulate({ ms: 2000, face: (t) => ({ yaw: 40, ...(t > 500 ? { eyeL: 0.6, eyeR: 0.15 } : {}) }) }))).toEqual([])
  })

  it('no wink while both eyes are half closed (looking down)', () => {
    expect(names(simulate({ ms: 3000, face: () => ({ eyeL: 0.55, eyeR: 0.3 }) }))).toEqual([])
  })

  it('a value hovering around the threshold fires once', () => {
    // ±0.045 of noise around 0.5: the release level (0.4) is never reached again.
    const ev = simulate({ ms: 5000, noise: 0.045, face: () => ({ eyeL: 0.5, eyeR: 0.5 }) })
    expect(names(ev)).toEqual(['blink'])
  })

  it('noise below the threshold fires nothing', () => {
    for (let seed = 1; seed <= 20; seed++) expect(names(simulate({ ms: 3000, seed, noise: 0.08 }))).toEqual([])
  })
})

describe('expression events: mouth, smile, eyebrows, kiss', () => {
  it('mouthOpen then mouthClose, once each', () => {
    const ev = simulate({ ms: 3000, face: during(1000, 2000, { jaw: 0.6 }) })
    expect(names(ev)).toEqual(['mouthOpen', 'mouthClose'])
    const [open, close] = ev.filter((e) => e.name.startsWith('mouth'))
    expect(open!.timeMs).toBeGreaterThanOrEqual(1000 + DEFAULT_EVENT_MIN_DURATION_MS.mouthOpen)
    expect(close!.timeMs).toBeGreaterThanOrEqual(2000 + DEFAULT_EVENT_MIN_DURATION_MS.mouthClose)
  })

  it('talking just below the threshold fires nothing', () => {
    const ev = simulate({ ms: 4000, noise: 0.04, face: (t) => ({ jaw: 0.15 + 0.12 * Math.sin(t / 60) }) })
    expect(names(ev)).toEqual([])
  })

  it('smile then smileEnd; a short twitch is ignored', () => {
    expect(names(simulate({ ms: 3000, face: during(1000, 2000, { smile: 0.8 }) }))).toEqual(['smile', 'smileEnd'])
    expect(names(simulate({ ms: 3000, face: during(1000, 1060, { smile: 0.8 }) }))).toEqual([])
  })

  it('a brief dip below the release level does not end the smile', () => {
    const face = (t: number) => (t >= 1000 && t < 3000 ? { smile: t >= 2000 && t < 2050 ? 0.2 : 0.8 } : {})
    expect(names(simulate({ ms: 4000, face }))).toEqual(['smile', 'smileEnd'])
  })

  it('eyebrowRaise and kiss', () => {
    expect(names(simulate({ ms: 3000, face: during(1000, 1500, { brow: 0.8 }) }))).toEqual(['eyebrowRaise'])
    expect(names(simulate({ ms: 3000, face: during(1000, 1500, { pucker: 0.5 }) }))).toEqual([]) // below 0.6
    expect(names(simulate({ ms: 3000, face: during(1000, 1500, { pucker: 0.75 }) }))).toEqual(['kiss'])
  })

  it('two separate gestures fire twice', () => {
    const face = (t: number) => ((t >= 500 && t < 1000) || (t >= 2000 && t < 2500) ? { brow: 0.8 } : {})
    expect(names(simulate({ ms: 3000, face }))).toEqual(['eyebrowRaise', 'eyebrowRaise'])
  })
})

describe('expression events: tuning via events.<name>', () => {
  it('threshold', () => {
    const face = during(1000, 2000, { jaw: 0.5 })
    expect(names(simulate({ ms: 3000, face }))).toEqual(['mouthOpen', 'mouthClose'])
    const events: EventTuning = { mouthOpen: { threshold: 0.7 } }
    expect(names(simulate({ ms: 3000, face, options: { events } }))).toEqual([])
  })

  it('minDurationMs, for the start and for the end event', () => {
    const twitch = during(1000, 1060, { smile: 0.8 })
    expect(names(simulate({ ms: 3000, face: twitch, options: { events: { smile: { minDurationMs: 0 } } } }))).toEqual(['smile', 'smileEnd'])
    const blink = during(1000, 1130, { eyeL: 0.85, eyeR: 0.85 })
    expect(names(simulate({ ms: 2000, face: blink, options: { events: { blink: { minDurationMs: 300 } } } }))).toEqual([])
    // A long smileEnd delay keeps the smile through a 300 ms pause.
    const pause = (t: number) => (t >= 1000 && t < 3000 && !(t >= 2000 && t < 2300) ? { smile: 0.8 } : {})
    expect(names(simulate({ ms: 4000, face: pause }))).toEqual(['smile', 'smileEnd', 'smile', 'smileEnd'])
    expect(names(simulate({ ms: 4000, face: pause, options: { events: { smileEnd: { minDurationMs: 500 } } } }))).toEqual(['smile', 'smileEnd'])
  })

  it('configure() retunes a running detector', () => {
    const d = new ExpressionEventDetector({ maxFaces: 1 })
    d.configure({ kiss: { threshold: 0.3 } })
    const s = createSignals(1)
    s[SIGNAL.pucker] = 0.4
    let fired = 0
    for (let t = 0; t <= 500; t += 33) {
      const out = d.update(t, 1, [1], s)
      for (let i = 0; i < out.count; i++) if (out.items[i]!.name === 'kiss') fired++
    }
    expect(fired).toBe(1)
  })

  it('nod / shake amplitude', () => {
    const nod = (t: number) => ({ pitch: t >= 1000 && t < 1300 ? -8 : 0 })
    expect(names(simulate({ ms: 2500, face: nod }))).toEqual([]) // 8° < 10°
    expect(names(simulate({ ms: 2500, face: nod, options: { events: { nod: { threshold: 0.3 } } } }))).toEqual(['nod'])
  })
})

describe('expression events: nod and shake', () => {
  /** Smooth out-and-back of `deg` degrees over `ms`, starting at `start`. */
  const bump = (start: number, ms: number, deg: number) => (t: number) => (t < start || t > start + ms ? 0 : deg * Math.sin((Math.PI * (t - start)) / ms))

  it('a nod (down and back up) fires once, without a shake', () => {
    const pitch = bump(1000, 500, -15)
    for (const hz of [15, 30, 60]) expect(names(simulate({ ms: 3000, hz, face: (t) => ({ pitch: pitch(t) }) })), `${hz} Hz`).toEqual(['nod'])
  })

  it('a nod starting upwards', () => {
    const pitch = bump(1000, 400, 12)
    expect(names(simulate({ ms: 3000, face: (t) => ({ pitch: pitch(t) }) }))).toEqual(['nod'])
  })

  it('continued shaking is one shake; a second one later fires again', () => {
    const shake = (t: number) => ({ yaw: (t >= 500 && t < 2000) || (t >= 4000 && t < 4800) ? 18 * Math.sin((2 * Math.PI * (t - 500)) / 500) : 0 })
    expect(names(simulate({ ms: 6000, face: shake }))).toEqual(['shake', 'shake'])
  })

  it('a slow head turn and back is neither', () => {
    const yaw = bump(500, 3000, 40)
    expect(names(simulate({ ms: 4000, face: (t) => ({ yaw: yaw(t) }) }))).toEqual([])
  })

  it('a diagonal movement is neither', () => {
    const v = bump(1000, 500, 15)
    expect(names(simulate({ ms: 3000, face: (t) => ({ pitch: v(t), yaw: v(t) }) }))).toEqual([])
  })

  it('one-frame pose glitches are ignored', () => {
    for (const hz of [15, 30]) {
      const ev = simulate({ ms: 3000, hz, face: (t) => ({ yaw: Math.abs(t - 1000) < 500 / hz ? 25 : 0, pitch: Math.abs(t - 2000) < 500 / hz ? 25 : 0 }) })
      expect(names(ev), `${hz} Hz`).toEqual([])
    }
  })

  it('pose jitter alone is ignored', () => {
    for (let seed = 1; seed <= 10; seed++) expect(names(simulate({ ms: 5000, seed, angleNoise: 3 }))).toEqual([])
  })
})

describe('expression events: faces', () => {
  it('faceEnter / faceLeave follow the ids, leaves first', () => {
    const d = new ExpressionEventDetector({ maxFaces: 2 })
    const s = createSignals(2)
    const frame = (t: number, ids: number[]) => {
      const out = d.update(t, ids.length, ids, s)
      return out.items.slice(0, out.count).map((e) => `${e.name}:${e.faceId}`)
    }
    expect(frame(0, [5])).toEqual(['faceEnter:5'])
    expect(frame(33, [5])).toEqual([])
    expect(frame(66, [6, 5])).toEqual(['faceEnter:6'])
    expect(frame(99, [6, 8])).toEqual(['faceLeave:5', 'faceEnter:8'])
    expect(frame(132, [6, 8, 9])).toEqual([]) // beyond maxFaces: ignored
    expect(frame(165, []).sort()).toEqual(['faceLeave:6', 'faceLeave:8'])
  })

  it('events carry the id of their face; the state is per face', () => {
    const d = new ExpressionEventDetector({ maxFaces: 2 })
    const s = createSignals(2)
    const got: string[] = []
    for (let t = 0; t < 1000; t += 33) {
      // Face 1 (id 20) keeps its mouth open; face 0 (id 10) opens it from 500 ms. Then the order of the faces swaps.
      const swap = t >= 700
      s[(swap ? 1 : 0) * SIGNALS_STRIDE + SIGNAL.jawOpen] = t >= 500 ? 0.6 : 0
      s[(swap ? 0 : 1) * SIGNALS_STRIDE + SIGNAL.jawOpen] = 0.6
      const out = d.update(t, 2, swap ? [20, 10] : [10, 20], s)
      for (let i = 0; i < out.count; i++) got.push(`${out.items[i]!.name}:${out.items[i]!.faceId}`)
    }
    expect(got).toEqual(['faceEnter:10', 'faceEnter:20', 'mouthOpen:20', 'mouthOpen:10'])
  })

  it('a NaN signal (no data) keeps the state', () => {
    const d = new ExpressionEventDetector({ maxFaces: 1 })
    const s = createSignals(1)
    const got: string[] = []
    for (let t = 0; t < 1000; t += 33) {
      s[SIGNAL.jawOpen] = t < 300 ? 0.6 : t < 600 ? NaN : 0
      s[SIGNAL.pitch] = s[SIGNAL.yaw] = t < 600 && t >= 300 ? NaN : 0
      const out = d.update(t, 1, [1], s)
      for (let i = 0; i < out.count; i++) got.push(out.items[i]!.name)
    }
    expect(got).toEqual(['faceEnter', 'mouthOpen', 'mouthClose'])
  })

  it('time going backwards (seek, loop) restarts the gestures', () => {
    const d = new ExpressionEventDetector({ maxFaces: 1 })
    const s = createSignals(1)
    s[SIGNAL.browRaise] = 0.9
    let raises = 0
    for (const t of [0, 33, 66, 99, 132, 165, 0, 33, 66, 99, 132, 165]) {
      const out = d.update(t, 1, [1], s)
      for (let i = 0; i < out.count; i++) if (out.items[i]!.name === 'eyebrowRaise') raises++
    }
    expect(raises).toBe(2)
  })
})

describe('expression events: calibration', () => {
  // A person whose neutral eyes read 0.52 (above the blink threshold), blinking every second.
  const squint = (t: number) => (t % 1000 > 500 && t % 1000 < 630 ? { eyeL: 0.97, eyeR: 0.97 } : { eyeL: 0.52, eyeR: 0.52 })

  it('removes a high neutral value', () => {
    const raw = names(simulate({ ms: 5000, noise: 0.02, face: squint }))
    expect(raw.length).toBeLessThanOrEqual(1) // stuck "closed"
    expect(names(simulate({ ms: 5000, noise: 0.02, face: squint, options: { calibrate: true } }))).toEqual(Array(5).fill('blink'))
  })

  it('does not absorb a long gesture', () => {
    const ev = simulate({ ms: 9000, face: during(1000, 8000, { smile: 0.8 }), options: { calibrate: true } })
    expect(names(ev)).toEqual(['smile', 'smileEnd'])
    expect(ev.find((e) => e.name === 'smileEnd')!.timeMs).toBeGreaterThanOrEqual(8000)
  })

  it('changes nothing for a neutral face at 0', () => {
    const face = during(1000, 1500, { jaw: 0.5 })
    expect(names(simulate({ ms: 3000, face, options: { calibrate: true } }))).toEqual(['mouthOpen', 'mouthClose'])
  })
})

describe('expression events: recorded sequences', () => {
  // Face 0 of the licensed test clips (fixtures/expressions/, recorded by e2e/record-expressions.spec.ts), replayed
  // through blendshapeSignals. The events below were checked against the recorded values (both eyes ≥ 0.5 for a
  // blink, etc.); the clips contain no wink, nod or shake, although the head turns a lot.
  const summary = (events: RecordedEvent[]) => events.map((e) => `${e.name}@${e.timeMs}`)

  it('pesquet-talk: blinks, eyebrow raises and smiles while talking and turning the head', () => {
    const ev = replayFixture(loadExpressionFixture('pesquet-talk'))
    expect(summary(ev)).toEqual([
      'faceEnter@1867',
      'blink@1900',
      'eyebrowRaise@2767',
      'blink@3000',
      'smile@5100',
      'faceLeave@6000', // lost for 600 ms: a new id
      'faceEnter@6067',
      'eyebrowRaise@6200',
      'smile@6367',
      'blink@6900',
      'faceLeave@7700',
    ])
  })

  it('pesquet-turn: a fast head turn is not a shake', () => {
    expect(names(replayFixture(loadExpressionFixture('pesquet-turn')))).toEqual(['blink'])
  })

  it('pesquet-closeup: a half blink (0.3–0.45) and an occlusion fire nothing', () => {
    expect(names(replayFixture(loadExpressionFixture('pesquet-closeup')))).toEqual([])
  })

  it('two-faces-stacked: eyes half closed (looking down) are not a wink; puckered lips are a kiss', () => {
    expect(names(replayFixture(loadExpressionFixture('two-faces-stacked')))).toEqual(['kiss'])
  })

  it('calibrated: no event that the raw values do not have', () => {
    for (const clip of ['pesquet-talk', 'pesquet-turn', 'pesquet-closeup', 'two-faces-stacked']) {
      const raw = names(replayFixture(loadExpressionFixture(clip)))
      const calibrated = names(replayFixture(loadExpressionFixture(clip), { calibrate: true }))
      for (const name of new Set(calibrated)) expect(calibrated.filter((n) => n === name).length, `${clip} ${name}`).toBeLessThanOrEqual(raw.filter((n) => n === name).length)
    }
  })
})

describe('expression events: allocation', () => {
  it('allocates nothing per frame', () => {
    setFlagsFromString('--expose-gc')
    const gc = runInNewContext('gc') as () => void
    const maxFaces = 4
    const d = new ExpressionEventDetector({ maxFaces, calibrate: true })
    const faces = createFaceFrame(maxFaces)
    faces.count = maxFaces
    const signals = createSignals(maxFaces)
    const ids = new Int32Array([1, 2, 3, 4])
    // Inputs precomputed, so that the measured loop itself allocates nothing: gestures on every face (events fire),
    // a winking eye, head oscillations, ids changing (enter / leave).
    const PERIOD = 400
    const blendshapes = new Float32Array(PERIOD * BLENDSHAPES_STRIDE)
    const forward = new Float32Array(PERIOD * 3)
    const rnd = noise(3)
    const eyeRight = blendshapeIndex('eyeBlinkRight')
    for (let i = 0; i < PERIOD; i++) {
      for (let b = 1; b < BLENDSHAPES_STRIDE; b++) blendshapes[i * BLENDSHAPES_STRIDE + b] = (i % 40 < 6 ? 0.8 : 0.1) + 0.05 * rnd()
      if (i % 80 < 40) blendshapes[i * BLENDSHAPES_STRIDE + eyeRight] = 0.05
      const a = Math.sin(i / 3) * 0.4
      forward.set([Math.sin(a), 0.1 * rnd(), Math.cos(a)], i * 3)
    }
    const state = new Float64Array(2) // time, events
    const run = (frames: number) => {
      for (let i = 0; i < frames; i++) {
        state[0]! += 33
        const k = i % PERIOD
        for (let f = 0; f < maxFaces; f++) {
          const o = f * BLENDSHAPES_STRIDE
          for (let b = 0; b < BLENDSHAPES_STRIDE; b++) faces.blendshapes[o + b] = blendshapes[k * BLENDSHAPES_STRIDE + b]!
          for (let c = 0; c < 3; c++) faces.matrices[f * 16 + 8 + c] = forward[k * 3 + c]!
        }
        if (k === 0) ids[0]! += 10
        readExpressionSignals(faces, signals)
        state[1]! += d.update(state[0]!, maxFaces, ids, signals).count
      }
    }
    const measure = (frames: number) => {
      gc()
      const before = process.memoryUsage().heapUsed
      run(frames)
      return process.memoryUsage().heapUsed - before
    }
    measure(20_000) // warm up (JIT)
    // The test runner and the JIT allocate a little meanwhile: compare two lengths so that their constant share
    // cancels out, and keep the best of three runs.
    let perFrame = Infinity
    for (let r = 0; r < 3; r++) perFrame = Math.min(perFrame, (measure(60_000) - measure(10_000)) / 50_000)
    expect(state[1]).toBeGreaterThan(1000)
    // Any allocation per face and per frame (≥ 16 bytes each, 4 faces) would be ≥ 64 bytes per frame; the noise
    // measured is 0–10 bytes.
    expect(perFrame).toBeLessThan(16)
  })
})
