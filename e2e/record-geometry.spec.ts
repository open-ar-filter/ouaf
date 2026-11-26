import { mkdirSync, writeFileSync } from 'node:fs'
import { test } from './fixtures.ts'
import { BLENDSHAPE_NAMES } from '../packages/core/src/face.ts'
import { GEOMETRY_LANDMARK_INDICES } from '../packages/core/src/expressions/geometry.ts'
import { EXPRESSION_FIXTURE_BLENDSHAPES } from '../packages/core/test/expression-fixture.ts'
import type { GeometryFixture } from '../packages/core/test/geometry-fixture.ts'

// Records the fixtures of the geometric expression signals (#90, `test/geometry-signals.test.ts`) from the test
// clips: face 0, frame by frame (deterministic step-by-step run), with the blendshapes the signals are calibrated
// against and only the landmarks the geometric source reads. Not a test: skipped unless OUAF_RECORD_GEOMETRY=1.
// `OUAF_RECORD_GEOMETRY=1 npx playwright test record-geometry`
const RECORD = process.env.OUAF_RECORD_GEOMETRY === '1'
const OUT = new URL('../packages/core/test/fixtures/geometry/', import.meta.url)
const CLIPS = ['pesquet-talk', 'pesquet-walk', 'pesquet-turn', 'two-faces-stacked']
const STEP = 1 / 30
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits

for (const clip of CLIPS) {
  test(`record ${clip}`, async ({ page }) => {
    test.skip(!RECORD, 'set OUAF_RECORD_GEOMETRY=1 to record')
    await page.goto(`/?source=${clip}&loop=0&autostart&test&maxFaces=1`)
    await page.waitForFunction(() => (window.ouafTest?.frames ?? 0) > 0 || window.ouafTest?.error, undefined, { timeout: 60_000 })
    const { rec, width, height } = await page.evaluate(async (step) => {
      const t = window.ouafTest!
      t.recording = []
      await t.runStepwise(step)
      const video = document.querySelector('video')!
      return { rec: t.recording, width: video.videoWidth, height: video.videoHeight }
    }, STEP)
    // Frames already in flight when a seek starts are processed twice: keep one result per media time.
    const byTime = new Map<number, GeometryFixture['frames'][number]>()
    const indices = EXPRESSION_FIXTURE_BLENDSHAPES.map((name) => BLENDSHAPE_NAMES.indexOf(name))
    for (const r of rec) {
      const t = Math.round(r.time * 1000)
      if ('face' in r) byTime.set(t, [t])
      else {
        byTime.set(t, [
          t,
          ...indices.map((i) => round(r.blendshapes[i]!, 3)),
          ...r.matrix.slice(8, 11).map((v) => round(v, 3)),
          ...GEOMETRY_LANDMARK_INDICES.flatMap((i) => r.landmarks.slice(i * 3, i * 3 + 3).map((v) => round(v, 5))),
        ])
      }
    }
    const fixture: GeometryFixture = {
      clip: `test-media/${clip}.mp4`,
      credits: 'Derived from "Thomas Pesquet plonge dans le Nautile", Ifremer (Theo Tanguy, Stéphane Lesbats, Olivier Dugornay), CC BY 4.0; see test-media/README.md',
      recorded: `MediaPipe FaceLandmarker (tasks-vision), playground step-by-step run every ${round(STEP, 3)} s, face 0`,
      width,
      height,
      landmarks: GEOMETRY_LANDMARK_INDICES,
      columns: ['timeMs', ...EXPRESSION_FIXTURE_BLENDSHAPES, 'matrix8', 'matrix9', 'matrix10', '…landmarks (x, y, z each)'],
      frames: [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, f]) => f),
    }
    mkdirSync(OUT, { recursive: true })
    writeFileSync(new URL(`${clip}.json`, OUT), JSON.stringify(fixture).replaceAll('],[', '],\n[') + '\n')
  })
}
