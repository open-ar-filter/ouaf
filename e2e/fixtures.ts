import { test as base } from '@playwright/test'
import { startCoverage } from './coverage/collect.ts'

export { expect } from '@playwright/test'
export type { APIRequestContext, Page } from '@playwright/test'

/**
 * The `test` of every spec: Playwright's, and with `OUAF_COVERAGE=1` each test's page also records the engine code it
 * runs (`npm run test:browser:coverage`, see `coverage/collect.ts`).
 */
export const test = process.env.OUAF_COVERAGE
  ? base.extend({
      page: async ({ page, browserName }, use, testInfo) => {
        // V8 coverage is read over the DevTools protocol, which only Chromium speaks.
        const stop = browserName === 'chromium' ? await startCoverage(page) : undefined
        await use(page)
        await stop?.(testInfo)
      },
    })
  : base
