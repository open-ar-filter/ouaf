/**
 * Allocation measure of the "does not allocate per frame" tests: bytes allocated on the V8 heap per call of a
 * function, in steady state.
 *
 * Code that does not allocate once optimized by TurboFan still allocates before: Maglev and the interpreter box
 * fractional numbers (16 bytes each), and so does TurboFan code that calls, rather than inlines, a function returning
 * one. With V8's default background compilation, when a function and its callees get their TurboFan code, and so what
 * gets inlined, depends on the machine's load: the measure then depended on the runner (#149). Hence:
 * - the unit tests run with `--no-concurrent-recompilation` (`vitest.config.ts`): V8 compiles on the main thread as
 *   soon as a function is hot, at points set by call counts, so the same test measures the same code on every run;
 * - `fn` is called from a loop V8 never optimizes, so it is compiled on its own, as the engine's frame loop calls a
 *   layer, rather than inlined into the measuring loop;
 * - the windows go on until one is clean (functions called once per frame reach TurboFan after several thousand
 *   calls), and the minimum is kept: a real allocation happens in every window, while compiling allocates in one
 *   (compiled code and its metadata live on the heap too).
 *
 * Each window starts after a full garbage collection and counts the growth of the heap spaces plus what collections
 * inside the window freed (`v8.GCProfiler`), so that a function allocating a lot is not hidden by a collection. The
 * sweeper, which frees the memory of a collection after it, can also make a space shrink inside a window: the tests run
 * with `--no-concurrent-sweeping`, which makes it rare, and such a window does not count. In a window with collections
 * that shrinking cannot be told apart, so a function allocating several MB per window can read up to about 10 % low.
 */
import { GCProfiler, getHeapSpaceStatistics, setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void
// TypeScript cannot hold `%` intrinsics: compiled from a string, once the flag allows them.
setFlagsFromString('--allow-natives-syntax')
const neverOptimize = new Function('f', '%NeverOptimizeFunction(f)') as (f: unknown) => void

const FLAGS = ['--no-concurrent-recompilation', '--no-concurrent-sweeping']

/** A fractional number boxed on the heap (no pointer compression in Node): what a call passing one allocates. */
export const BOXED_NUMBER = 16

export interface AllocationOptions {
  /** Calls before the first window. */
  warmup?: number
  /** Calls per window. */
  calls?: number
  /** Maximum number of windows. */
  windows?: number
}

function repeat(fn: () => void, n: number): void {
  for (let i = 0; i < n; i++) fn()
}
neverOptimize(repeat)

/** Used bytes of each heap space (`heapUsed` can drop by hundreds of KB inside a window while no space shrinks). */
const spaces = () => getHeapSpaceStatistics().map((s) => s.space_used_size)
const sum = (sizes: readonly number[]) => sizes.reduce((a, b) => a + b, 0)

/** Bytes allocated by `calls` calls of `fn` and by `spaces()`; undefined if the sweeper freed memory meanwhile. */
function measure(fn: () => void, calls: number): number | undefined {
  gc()
  const profiler = new GCProfiler()
  profiler.start()
  const before = spaces()
  repeat(fn, calls)
  const after = spaces()
  const collections = profiler.stop()?.statistics ?? []
  if (collections.length === 0 && after.some((size, i) => size < before[i]!)) return undefined
  let freed = 0
  for (const c of collections) {
    freed += sum(c.beforeGC.heapSpaceStatistics.map((s) => s.spaceUsedSize))
    freed -= sum(c.afterGC.heapSpaceStatistics.map((s) => s.spaceUsedSize))
  }
  return sum(after) - sum(before) + freed
}

/**
 * Bytes allocated per call of `fn`: below 1 for a function that does not allocate, at least `BOXED_NUMBER` for one
 * that boxes a number or allocates an object per call. Keep `fn` free of allocations of its own: state in typed
 * arrays rather than captured variables (Node 24 boxes a fractional number stored in a closure's context).
 */
export function bytesPerCall(fn: () => void, options: AllocationOptions = {}): number {
  const { warmup = 10_000, calls = 5_000, windows = 20 } = options
  const missing = FLAGS.filter((f) => !process.execArgv.includes(f))
  if (missing.length > 0) throw new Error(`allocation tests need Node's ${missing.join(' ')} (see vitest.config.ts)`)
  repeat(fn, warmup)
  // The least of the windows, less the least of what the measure allocates itself (it decreases as V8 optimizes the
  // measure): both can only be overestimated, by a compilation inside a window.
  let best = Infinity
  let own = Infinity
  for (let w = 0, tries = 0; w < windows && !(best - own < calls); tries++) {
    if (tries > 2 * windows) throw new Error('allocation measure: the heap kept shrinking without a collection')
    const bytes = measure(fn, calls)
    const self = measure(fn, 0)
    if (bytes === undefined || self === undefined) continue
    best = Math.min(best, bytes)
    own = Math.min(own, self)
    w++
  }
  return (best - own) / calls
}
