import { mkdirSync, writeFileSync } from 'node:fs'
import { test } from './fixtures.ts'
import { BLENDSHAPE_NAMES } from '../packages/core/src/face.ts'
import { EXPRESSION_FIXTURE_BLENDSHAPES, type ExpressionFixture } from '../packages/core/test/expression-fixture.ts'

// Records the expression fixtures of the unit tests (#14) from the test clips: face 0, frame by frame (deterministic
// step-by-step run), keeping only what the blendshape signal source reads. Not a test: skipped unless
// OUAF_RECORD_EXPRESSIONS=1. `OUAF_RECORD_EXPRESSIONS=1 npx playwright test record-expressions`
const RECORD = process.env.OUAF_RECORD_EXPRESSIONS === '1'
const OUT = new URL('../packages/core/test/fixtures/expressions/', import.meta.url)
const CLIPS = ['pesquet-talk', 'pesquet-turn', 'pesquet-closeup', 'two-faces-stacked']
const STEP = 1 / 30
const round = (v: number) => Math.round(v * 1000) / 1000

for (const clip of CLIPS) {
  test(`record ${clip}`, async ({ page }) => {
    test.skip(!RECORD, 'set OUAF_RECORD_EXPRESSIONS=1 to record')
    await page.goto(`/?source=${clip}&loop=0&autostart&test&maxFaces=1`)
    await page.waitForFunction(() => (window.ouafTest?.frames ?? 0) > 0 || window.ouafTest?.error, undefined, { timeout: 60_000 })
    const rec = await page.evaluate(async (step) => {
      const t = window.ouafTest!
      t.recording = []
      await t.runStepwise(step)
      return t.recording
    }, STEP)
    // Frames already in flight when a seek starts are processed twice: keep one result per media time.
    const byTime = new Map<number, ExpressionFixture['frames'][number]>()
    const indices = EXPRESSION_FIXTURE_BLENDSHAPES.map((name) => BLENDSHAPE_NAMES.indexOf(name))
    for (const r of rec) {
      const t = Math.round(r.time * 1000)
      if ('face' in r) byTime.set(t, [t])
      else byTime.set(t, [t, ...indices.map((i) => round(r.blendshapes[i]!)), ...r.matrix.slice(8, 11).map(round)])
    }
    const fixture: ExpressionFixture = {
      clip: `test-media/${clip}.mp4`,
      credits: 'Derived from "Thomas Pesquet plonge dans le Nautile", Ifremer (Theo Tanguy, Stéphane Lesbats, Olivier Dugornay), CC BY 4.0; see test-media/README.md',
      recorded: `MediaPipe FaceLandmarker (tasks-vision), playground step-by-step run every ${round(STEP)} s, face 0`,
      columns: ['timeMs', ...EXPRESSION_FIXTURE_BLENDSHAPES, 'matrix8', 'matrix9', 'matrix10'],
      frames: [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, f]) => f),
    }
    mkdirSync(OUT, { recursive: true })
    writeFileSync(new URL(`${clip}.json`, OUT), JSON.stringify(fixture).replaceAll('],[', '],\n[') + '\n')
  })
}
