import { readFileSync } from 'node:fs'
import { blendshapeIndex, createFaceFrame, type BlendshapeName } from '../src/face.ts'
import { ExpressionEventDetector, type ExpressionEventDetectorOptions, type ExpressionEventName, type EventSide } from '../src/expressions/detector.ts'
import { blendshapeSignals, createSignals } from '../src/expressions/signals.ts'

/** Blendshapes stored in the fixtures: those `blendshapeSignals` reads. */
export const EXPRESSION_FIXTURE_BLENDSHAPES = [
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'jawOpen',
  'mouthSmileLeft',
  'mouthSmileRight',
  'browInnerUp',
  'mouthPucker',
] as const satisfies readonly BlendshapeName[]

/**
 * Face 0 of a test clip, recorded by `e2e/record-expressions.spec.ts`. Each frame is `[timeMs]` (no face) or
 * `[timeMs, ...blendshapes (EXPRESSION_FIXTURE_BLENDSHAPES order), matrix[8], matrix[9], matrix[10]]`.
 */
export interface ExpressionFixture {
  clip: string
  credits: string
  recorded: string
  columns: string[]
  frames: number[][]
}

export function loadExpressionFixture(clip: string): ExpressionFixture {
  return JSON.parse(readFileSync(new URL(`fixtures/expressions/${clip}.json`, import.meta.url), 'utf8')) as ExpressionFixture
}

export interface RecordedEvent {
  name: ExpressionEventName
  faceId: number
  side: EventSide | null
  timeMs: number
}

/** Face ids as a tracker with a 500 ms grace delay would assign them (spec §5.4). */
const GRACE_MS = 500

/** Replays a fixture through a `FaceFrame`, `blendshapeSignals` and a detector; returns the events. */
export function replayFixture(fixture: ExpressionFixture, options: Omit<ExpressionEventDetectorOptions, 'maxFaces'> = {}): RecordedEvent[] {
  const faces = createFaceFrame(1)
  const signals = createSignals(1)
  const detector = new ExpressionEventDetector({ ...options, maxFaces: 1 })
  const indices = EXPRESSION_FIXTURE_BLENDSHAPES.map((name) => blendshapeIndex(name))
  const ids = [0]
  let lastSeen = -Infinity
  const events: RecordedEvent[] = []
  for (const f of fixture.frames) {
    const t = f[0]!
    faces.count = 0
    if (f.length > 1) {
      if (t - lastSeen > GRACE_MS) ids[0] = (ids[0] ?? 0) + 1
      lastSeen = t
      faces.count = 1
      indices.forEach((b, i) => (faces.blendshapes[b] = f[1 + i]!))
      faces.matrices.set([f[8]!, f[9]!, f[10]!], 8)
      blendshapeSignals(faces, 0, signals, 0)
    } else if (t - lastSeen <= GRACE_MS) {
      continue // within the grace delay: the face keeps its id, no new result
    }
    const out = detector.update(t, faces.count, ids, signals)
    for (let i = 0; i < out.count; i++) events.push({ ...out.items[i]! })
  }
  return events
}
