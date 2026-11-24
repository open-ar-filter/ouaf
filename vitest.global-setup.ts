import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    /** Whether this run measures coverage (`npm run test:coverage`). */
    coverage: boolean
  }
}

/** Tells the tests whether coverage is on: its instrumentation allocates, which the allocation tests must know. */
export default function setup(project: TestProject): void {
  project.provide('coverage', project.config.coverage.enabled)
}
