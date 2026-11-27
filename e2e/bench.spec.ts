import { readFile } from 'node:fs/promises'
import { expect, test } from './fixtures.ts'

/**
 * The benchmark page (#39), on a few short cases: it measures them, its results download as an `ouaf-bench` document,
 * copy as a Markdown table and compare with an earlier document. The numbers themselves are not checked (CI renders in
 * software).
 */
test('the benchmark page measures cases, exports its results and compares with earlier ones', async ({ page }) => {
  await page.goto('/bench.html?case=no%20filter&case=tracking%20only&case=glasses&frames=12&warmup=20&autorun')
  await page.waitForFunction(() => window.ouafBench?.report?.results.length === 3 && !window.ouafBench.running, undefined, { timeout: 120_000 })
  const report = (await page.evaluate(() => window.ouafBench!.report))!
  expect(report).toMatchObject({ format: 'ouaf-bench', version: 1, settings: { warmup: 20, frames: 12, backend: null } })
  expect(report.app.commit).toMatch(/^[0-9a-f]{7,}\+?$|^unknown$/)
  expect(report.device?.userAgent).toBeTruthy()
  expect(report.results.map((r) => [r.name, r.clip, r.frames, r.errors])).toEqual([
    ['no filter', 'pesquet-talk', 12, []],
    ['tracking only', 'pesquet-talk', 12, []],
    ['glasses', 'pesquet-walk', 12, []],
  ])
  for (const r of report.results) {
    expect(r.fps).toBeGreaterThan(0)
    expect(r.frameMs!.p95).toBeGreaterThanOrEqual(r.frameMs!.p50)
    expect(r.frameMs!.max).toBeGreaterThanOrEqual(r.frameMs!.p99)
  }
  // No tracking without a filter; then faces, the warm-up lasting until the tracker finds the first one (it may lose
  // it on a few frames after that: not counted here).
  expect(report.results[0]!.faces).toBe(0)
  expect(report.results[1]!.faces).toBeGreaterThan(0)
  expect(report.results[2]!.faces).toBeGreaterThan(0)
  await expect(page.locator('#results tr')).toHaveCount(4)
  await expect(page.locator('#status')).toHaveText(/^Done: 3 case\(s\)/)

  await page.locator('#copy').click()
  await expect(page.locator('#output')).toBeVisible()
  const md = await page.locator('#output').inputValue()
  expect(md).toContain('| Case | Faces | Mean ms | p95 ms | Max ms | fps |')
  expect(md).toContain('| glasses |')

  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()])
  expect(download.suggestedFilename()).toMatch(/^ouaf-bench-\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.json$/)
  const file = await readFile((await download.path())!, 'utf8')
  expect(JSON.parse(file)).toEqual(report)

  await page.locator('#compare').setInputFiles({ name: 'before.json', mimeType: 'application/json', buffer: Buffer.from(file) })
  await expect(page.locator('#results th')).toContainText(['fps change', 'p95 change'])
  expect(await page.locator('#output').inputValue()).toContain('| fps change | p95 change |')
  // The same results: no change.
  await expect(page.locator('#results tr').nth(3).locator('td').nth(8)).toHaveText('+0.0 %')

  await page.locator('#compare').setInputFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"ouaf-perf-session","version":1}') })
  await expect(page.locator('#status')).toHaveText('other.json: Not an ouaf-bench file (format: "ouaf-perf-session").')
})
