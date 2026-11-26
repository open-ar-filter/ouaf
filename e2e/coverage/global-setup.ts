import { rmSync } from 'node:fs'
import { RAW_DIR } from './paths.ts'

/** A run with `OUAF_COVERAGE=1` starts from no record: the report adds up whatever it finds. */
export default function globalSetup(): void {
  if (process.env.OUAF_COVERAGE) rmSync(RAW_DIR, { recursive: true, force: true })
}
