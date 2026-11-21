import { expect, test, type Page } from '@playwright/test'

/**
 * Spike #83 (`/spikes/runtime.html`): the LiteRT.js face pipeline really runs on several threads when the page is
 * cross-origin isolated, and not without threads.
 *
 * Emscripten preallocates one pthread worker per core whatever the thread count, so counting workers proves nothing.
 * Two checks instead:
 * - started threads: the page's messages that start a pthread in a worker (`{ start_routine, pthread_ptr, … }`,
 *   sent by `pthread_create`) are counted per worker by an init script;
 * - used threads: the landmark model is timed on one paused frame with N threads and with 1 thread; N threads must
 *   be clearly faster.
 */

interface Spike83 {
  runtime: string | null
  threads: number
  frames: number
  bench(runs: number, atSeconds?: number): Promise<{ landmarksMs: number; found: number; runs: number }>
}

declare global {
  interface Window {
    __spike83?: Spike83
    /** Distinct workers that were asked to start a pthread (installed by the init script below). */
    __pthreadWorkers?: Set<Worker>
  }
}

const CLIP = 'pesquet-talk'
const BENCH_RUNS = 30
/** A frontal face in the clip. */
const BENCH_AT_S = 4

async function open(page: Page, query: string) {
  await page.addInitScript(() => {
    const started = new Set<Worker>()
    window.__pthreadWorkers = started
    const post = Worker.prototype.postMessage as (this: Worker, message: unknown, ...rest: unknown[]) => void
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
      if (message && typeof message === 'object' && 'start_routine' in message && 'pthread_ptr' in message) started.add(this)
      post.call(this, message, ...rest)
    } as Worker['postMessage']
  })
  await page.goto(`/spikes/runtime.html?source=${CLIP}&autostart&${query}`)
  await page.waitForFunction(() => (window.__spike83?.frames ?? 0) > 5 || /unavailable|failed/.test(window.__spike83?.runtime ?? ''), undefined, {
    timeout: 60_000,
  })
  expect(await page.evaluate(() => window.__spike83!.runtime)).toMatch(/^ready: LiteRT\.js wasm/)
}

const startedThreads = (page: Page) => page.evaluate(() => window.__pthreadWorkers!.size)

async function bench(page: Page) {
  const result = await page.evaluate(([runs, at]) => window.__spike83!.bench(runs, at), [BENCH_RUNS, BENCH_AT_S] as const)
  // The timings only mean something if the pipeline tracked the face.
  expect(result.found).toBeGreaterThan(BENCH_RUNS * 0.9)
  return result.landmarksMs
}

test('threads=1: single-threaded build, no pthread started', async ({ page }) => {
  await open(page, 'threads=1')
  expect(await page.evaluate(() => window.__spike83!.threads)).toBe(1)
  await bench(page)
  expect(await startedThreads(page)).toBe(0)
})

test('cross-origin isolated page: the face pipeline runs on several threads, and faster', async ({ page, context }) => {
  const cores = await page.evaluate(() => navigator.hardwareConcurrency)
  test.skip(cores < 2, `needs at least 2 cores (${cores})`)
  const threads = Math.min(4, cores)

  await open(page, `threads=${threads}`)
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
  expect(await page.evaluate(() => window.__spike83!.runtime)).toContain(`${threads} threads`)
  const multi = await bench(page)
  // XNNPACK's thread pool: the calling thread plus `threads - 1` pthreads, per compiled model (3 × 3 = 9 seen here).
  const started = await startedThreads(page)
  expect(started).toBeGreaterThanOrEqual(threads - 1)

  const single = await context.newPage()
  try {
    await open(single, 'threads=1')
    const one = await bench(single)
    console.log(`landmark model, median of ${BENCH_RUNS}: ${one.toFixed(1)} ms on 1 thread, ${multi.toFixed(1)} ms on ${threads} (${started} pthreads started)`)
    // Measured 12.9 → 6.6 ms (4 threads) and 8.4 ms (2 threads) on a 4-core machine: a 15 % margin is far from both.
    expect(multi).toBeLessThan(one * 0.85)
  } finally {
    await single.close()
  }
})
