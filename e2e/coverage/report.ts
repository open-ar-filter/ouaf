import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { mergeScriptCovs, type ScriptCov } from '@bcoe/v8-coverage'
import * as libCoverage from '@vitest/istanbul-lib-coverage'
import * as libReport from '@vitest/istanbul-lib-report'
import astV8ToIstanbul from 'ast-v8-to-istanbul'
import { parseAstAsync } from 'vitest/node'
import { BROWSER_ONLY, BROWSER_THRESHOLD } from './browser-only.ts'
import { RAW_DIR, REPORTS_DIR, ROOT, SOURCES_DIR, type RawScript, type RawSource } from './paths.ts'

/**
 * `npm run coverage:browser`: turns what the browser tests recorded (`OUAF_COVERAGE=1`, `collect.ts`) into the same
 * reports as the unit run, in `coverage-browser/`. Also merges the records of several shards copied into one folder.
 *
 * The counts of all the tests are added per script, then each script is mapped back to its TypeScript source through
 * the source map the dev server appended to it. Only the files the browser loaded are listed.
 *
 * Fails when the modules that only the browser tests can cover (`BROWSER_ONLY`) are, taken together, below
 * `BROWSER_THRESHOLD`, or when one of them was not loaded at all. The other files are reported, not judged: the unit
 * run answers for them.
 */

const REPORTERS = ['text-summary', 'html', 'lcov', 'json-summary'] as const

/** Files of the report: the package sources, as in the unit run (vitest.config.ts). */
const INCLUDED = /^packages\/[^/]+\/src\/.+\.ts$/

type SourceMap = Extract<Parameters<typeof astV8ToIstanbul>[0]['sourceMap'], { sources: unknown }>

const SOURCE_MAP = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/

if (!existsSync(RAW_DIR)) {
  console.error(`No coverage recorded in ${relative(ROOT, RAW_DIR)}: run the browser tests with OUAF_COVERAGE=1 first.`)
  process.exit(1)
}

// Every run of every script, grouped by the text that ran (a script may differ between the page and a worker).
const runs = new Map<string, ScriptCov[]>()
let tests = 0
for (const name of readdirSync(RAW_DIR).filter((n) => n.endsWith('.json'))) {
  const { scripts } = JSON.parse(readFileSync(join(RAW_DIR, name), 'utf8')) as { scripts: RawScript[] }
  tests++
  for (const { url, source, functions } of scripts) {
    if (!runs.has(source)) runs.set(source, [])
    runs.get(source)!.push({ scriptId: '0', url, functions })
  }
}

const map = libCoverage.createCoverageMap({})
let skipped = 0
for (const [source, covs] of runs) {
  const merged = mergeScriptCovs(covs)
  const { url, code } = JSON.parse(readFileSync(join(SOURCES_DIR, source), 'utf8')) as RawSource
  const encoded = SOURCE_MAP.exec(code)?.[1]
  // `/@fs/<absolute path>` on the machine that ran the tests: only the part from `packages/` on is kept.
  const path = /\/(packages\/[^/]+\/src\/[^?]+)/.exec(new URL(url).pathname)?.[1]
  if (!merged || !encoded || !path) {
    skipped++
    continue
  }
  const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as SourceMap
  // A worker's entry is named with its query (`face.worker.ts?worker_file&type=module`): the file is what counts.
  decoded.sources = decoded.sources.map((s) => s?.split('?')[0] ?? s)
  const converted = await astV8ToIstanbul({
    code,
    ast: await parseAstAsync(code),
    sourceMap: decoded,
    coverage: { url: `file://${join(ROOT, path)}`, functions: merged.functions },
  })
  map.merge(converted)
}
map.filter((file) => INCLUDED.test(relative(ROOT, file).replaceAll('\\', '/')))

console.log(`Browser test coverage: ${tests} tests, ${map.files().length} files${skipped ? `, ${skipped} type-only scripts skipped` : ''}`)
const context = libReport.createContext({ dir: REPORTS_DIR, coverageMap: map })
for (const reporter of REPORTERS) (await libReport.createAsync(reporter, { projectRoot: ROOT })).execute(context)

// The threshold, on the browser-only modules alone.
const METRICS = ['lines', 'statements', 'functions', 'branches'] as const
const summary = libCoverage.createCoverageSummary()
const failures: string[] = []
console.log(`\nBrowser-only modules (threshold ${BROWSER_THRESHOLD} % together):`)
for (const path of BROWSER_ONLY) {
  const file = map.files().find((f) => relative(ROOT, f).replaceAll('\\', '/') === path)
  if (!file) {
    failures.push(`${path} was not loaded by any test`)
    continue
  }
  const s = map.fileCoverageFor(file).toSummary()
  summary.merge(s)
  console.log(`  ${path.padEnd(42)} ${METRICS.map((m) => `${m} ${Number(s[m].pct).toFixed(1).padStart(5)} %`).join('  ')}`)
}
console.log(`  ${'together'.padEnd(42)} ${METRICS.map((m) => `${m} ${Number(summary[m].pct).toFixed(1).padStart(5)} %`).join('  ')}`)
for (const m of METRICS) {
  if (Number(summary[m].pct) < BROWSER_THRESHOLD) failures.push(`${m}: ${summary[m].pct} % (${summary[m].covered} / ${summary[m].total}) is below ${BROWSER_THRESHOLD} %`)
}
writeFileSync(join(REPORTS_DIR, 'browser-only-summary.json'), `${JSON.stringify({ threshold: BROWSER_THRESHOLD, total: summary }, null, 2)}\n`)
if (failures.length) {
  for (const failure of failures) console.error(`ERROR: browser-only coverage: ${failure}`)
  process.exit(1)
}
