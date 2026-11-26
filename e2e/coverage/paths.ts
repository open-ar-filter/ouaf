import { resolve } from 'node:path'

/** Repository root (this file is `e2e/coverage/paths.ts`). */
export const ROOT = resolve(import.meta.dirname, '../..')

/** Reports of `npm run test:browser:coverage` (gitignored); apart from `coverage/`, which the unit run empties. */
export const REPORTS_DIR = resolve(ROOT, 'coverage-browser')

/** What the tests record: one JSON file per test, and the scripts' sources in `sources/`. */
export const RAW_DIR = resolve(REPORTS_DIR, 'raw')
export const SOURCES_DIR = resolve(RAW_DIR, 'sources')

/** V8 coverage of one function (`Profiler.FunctionCoverage` of the DevTools protocol). */
export interface FunctionCoverage {
  functionName: string
  isBlockCoverage: boolean
  ranges: Array<{ startOffset: number; endOffset: number; count: number }>
}

/** One script as run by one test, in the page or in a worker. `source` names its file in `SOURCES_DIR`. */
export interface RawScript {
  url: string
  source: string
  functions: FunctionCoverage[]
}

/** A script as the dev server sent it: the code V8 ran (the offsets refer to it), with its inline source map. */
export interface RawSource {
  url: string
  code: string
}
