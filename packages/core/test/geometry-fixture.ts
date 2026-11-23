import { readFileSync } from 'node:fs'
import { blendshapeIndex, createFaceFrame, type FaceFrame } from '../src/face.ts'
import { ExpressionEventDetector, type ExpressionEventDetectorOptions } from '../src/expressions/detector.ts'
import { blendshapeSignals, createSignals, type ExpressionSignalSource } from '../src/expressions/signals.ts'
import { EXPRESSION_FIXTURE_BLENDSHAPES, type RecordedEvent } from './expression-fixture.ts'

/**
 * Face 0 of a test clip with the landmarks the geometric signals read (#90), recorded by
 * `e2e/record-geometry.spec.ts`. Each frame is `[timeMs]` (no face) or `[timeMs, ...blendshapes
 * (EXPRESSION_FIXTURE_BLENDSHAPES order), matrix[8], matrix[9], matrix[10], ...x, y, z of each of `landmarks`]`.
 */
export interface GeometryFixture {
  clip: string
  credits: string
  recorded: string
  /** Size of the analysed frames (px). */
  width: number
  height: number
  /** Landmark indices stored per frame, in order. */
  landmarks: readonly number[]
  columns: string[]
  frames: number[][]
}

export const GEOMETRY_CLIPS = ['pesquet-talk', 'pesquet-walk', 'pesquet-turn', 'two-faces-stacked'] as const

export function loadGeometryFixture(clip: string): GeometryFixture {
  return JSON.parse(readFileSync(new URL(`fixtures/geometry/${clip}.json`, import.meta.url), 'utf8')) as GeometryFixture
}

const BLENDSHAPES = EXPRESSION_FIXTURE_BLENDSHAPES.map((name) => blendshapeIndex(name))
const LANDMARKS_AT = 1 + BLENDSHAPES.length + 3

/** Writes frame `f` (with a face) of `fixture` into face 0 of `faces`: blendshapes, matrix columns, landmarks. */
export function loadFrame(fixture: GeometryFixture, f: readonly number[], faces: FaceFrame): void {
  faces.count = 1
  faces.width = fixture.width
  faces.height = fixture.height
  BLENDSHAPES.forEach((b, i) => (faces.blendshapes[b] = f[1 + i]!))
  faces.matrices.set([f[8]!, f[9]!, f[10]!], 8)
  fixture.landmarks.forEach((index, i) => faces.landmarks.set(f.slice(LANDMARKS_AT + i * 3, LANDMARKS_AT + i * 3 + 3), index * 3))
}

/** Face ids as a tracker with a 500 ms grace delay would assign them (spec §5.4). */
const GRACE_MS = 500

/**
 * Replays a fixture through a detector with the given signal source (blendshapes or geometry); returns the events.
 * `stepMs`: keep one frame every `stepMs` (e.g. 66 for a 15 Hz tracking rate).
 */
export function replayGeometryFixture(
  fixture: GeometryFixture,
  source: ExpressionSignalSource = blendshapeSignals,
  options: Omit<ExpressionEventDetectorOptions, 'maxFaces'> & { stepMs?: number } = {},
): RecordedEvent[] {
  const faces = createFaceFrame(1)
  const signals = createSignals(1)
  const detector = new ExpressionEventDetector({ ...options, maxFaces: 1 })
  const ids = [0]
  let lastSeen = -Infinity
  let next = -Infinity
  const events: RecordedEvent[] = []
  for (const f of fixture.frames) {
    const t = f[0]!
    if (options.stepMs && t < next) continue
    next = t + (options.stepMs ?? 0) - 1
    faces.count = 0
    if (f.length > 1) {
      if (t - lastSeen > GRACE_MS) ids[0] = (ids[0] ?? 0) + 1
      lastSeen = t
      loadFrame(fixture, f, faces)
      source(faces, 0, signals, 0)
    } else if (t - lastSeen <= GRACE_MS) {
      continue
    }
    const out = detector.update(t, faces.count, ids, signals)
    for (let i = 0; i < out.count; i++) events.push({ ...out.items[i]! })
  }
  return events
}
