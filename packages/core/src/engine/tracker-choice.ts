/**
 * A face tracker that chooses among several implementations by measuring them (spec §16.4): the built-in one picks
 * between our LiteRT.js pipeline in a worker and MediaPipe's CPU and GPU delegates on the main thread
 * (docs/decisions/device-adaptation.md, face-runtime.md).
 *
 * Start: the backend forced by the host (`EngineOptions.trackerBackend`), else the one measured before on this device
 * and browser (local cache), else the first candidate that opens. On the first frames of a live source, the other
 * candidates are opened and the backends take turns on successive frames (`BackendBenchmark`); the fastest median
 * time per result wins, the others are closed and the choice is cached. A candidate that fails to open is skipped
 * with a warning; one that breaks while running (its worker died) is replaced by the next one.
 */
import { BackendBenchmark, currentUserAgent, readStoredBackend, type BenchmarkOptions, type StoredBackend } from './backend-choice.ts'
import type { FaceFrame, TrackerInput } from '../face.ts'
import type { BackendInfo, FaceTrackerImpl, FrameTracker, TrackerConfig, TrackerEnv } from './plugin.ts'
import type { Capability } from './governor.ts'

export interface TrackerCandidate {
  /** Backend name, as `EngineOptions.trackerBackend` forces it (compared without case) and as it is cached. */
  readonly name: string
  open(config: TrackerConfig, env: TrackerEnv): Promise<FrameTracker>
  /** What it is, for stats (default: the tracker's own description). */
  label?(tracker: FrameTracker): string
  /** The tracker cannot run any more (default: never): the chooser moves on to the next candidate. */
  broken?(tracker: FrameTracker): boolean
  /**
   * Multiplies its measured time when the candidates are compared (default 1). A tracker on the main thread takes
   * its time from rendering too, so it is given `MAIN_THREAD_WEIGHT`: it must be clearly faster to beat one in a
   * worker. The times cached and shown are the measured ones.
   */
  readonly weight?: number
}

/** `TrackerCandidate.weight` of a tracker that runs on the main thread: it wins over a worker only if > 15 % faster. */
export const MAIN_THREAD_WEIGHT = 1.15

export interface ChoosingTrackerOptions {
  /** `FaceTrackerImpl.id`: also the key of the cached choice. */
  readonly id: string
  readonly cost?: FaceTrackerImpl['cost']
  /** The candidates for this configuration, in order of preference when nothing is measured yet. */
  candidates(config: TrackerConfig): TrackerCandidate[]
  benchmark?: BenchmarkOptions
}

/** A `FaceTrackerImpl` over several candidates, chosen by measuring (see above). */
export function choosingFaceTracker(options: ChoosingTrackerOptions): FaceTrackerImpl {
  return {
    id: options.id,
    ...(options.cost ? { cost: options.cost } : {}),
    async create(config, env) {
      const candidates = options.candidates(config)
      if (candidates.length === 0) throw new Error('No face tracker is available in this browser.')
      const names = candidates.map((c) => c.name)
      const wanted = env.backend?.toLowerCase()
      const forced = wanted === undefined ? undefined : candidates.find((c) => c.name.toLowerCase() === wanted)
      if (env.backend !== undefined && !forced) env.warn(`Unknown or unavailable face tracker backend "${env.backend}" (here: ${names.join(', ')}); choosing it by measuring.`)
      const stored = forced ? undefined : readStoredBackend(env.store?.get(), names)
      const first = forced ?? candidates.find((c) => c.name === stored?.backend)
      const order = first ? [first, ...candidates.filter((c) => c !== first)] : candidates

      const failed = new Set<string>()
      let lastError: unknown
      for (const candidate of order) {
        let tracker: FrameTracker
        try {
          tracker = await candidate.open(config, env)
        } catch (error) {
          failed.add(candidate.name)
          lastError = error
          const next = order.find((c) => !failed.has(c.name))
          env.warn(`The ${candidate.name} face tracker could not start${next ? `; trying ${next.name}` : ''}: ${errorText(error)}`, error)
          continue
        }
        const rest = candidates.filter((c) => c !== candidate && !failed.has(c.name))
        let backend: BackendInfo
        let measure: TrackerCandidate[] | undefined
        if (forced) backend = { name: candidate.name, source: candidate === forced ? 'forced' : 'only' }
        else if (stored && candidate.name === stored.backend) backend = { name: candidate.name, source: 'cached', ...(stored.measuredMs ? { measuredMs: stored.measuredMs } : {}) }
        else if (rest.length === 0) backend = { name: candidate.name, source: 'only' }
        else {
          backend = { name: candidate.name, source: 'pending' }
          measure = rest
        }
        return new ChoosingFrameTracker({ candidate, tracker }, candidates, failed, config, env, backend, measure, options.benchmark)
      }
      throw new Error(`No face tracker could start (${names.join(', ')}).`, { cause: lastError })
    },
  }
}

interface Running {
  readonly candidate: TrackerCandidate
  readonly tracker: FrameTracker
}

interface Bench {
  readonly run: BackendBenchmark
  readonly running: Map<string, Running>
}

/** The `FrameTracker` of `choosingFaceTracker`: forwards to the chosen tracker, or to each in turn while measuring. */
export class ChoosingFrameTracker implements FrameTracker {
  readonly #candidates: readonly TrackerCandidate[]
  readonly #failed: Set<string>
  readonly #env: TrackerEnv
  readonly #benchOptions: BenchmarkOptions | undefined
  #current: Running
  #config: TrackerConfig
  #backend: BackendInfo
  /** The candidates to measure once a live source starts (`benchmark`); kept to measure again after an abort. */
  readonly #toMeasure: readonly TrackerCandidate[] | undefined
  #armed: boolean
  #bench: Bench | undefined
  /** Incremented when a benchmark starts or is aborted: trackers opened for an older one are closed. */
  #generation = 0
  #measuring = false
  /** The tracker of the last `track` call. */
  #last: Running | undefined
  #disposed = false

  constructor(
    current: Running,
    candidates: readonly TrackerCandidate[],
    failed: Set<string>,
    config: TrackerConfig,
    env: TrackerEnv,
    backend: BackendInfo,
    measure: readonly TrackerCandidate[] | undefined,
    benchOptions?: BenchmarkOptions,
  ) {
    this.#current = current
    this.#candidates = candidates
    this.#failed = failed
    this.#config = config
    this.#env = env
    this.#backend = backend
    this.#toMeasure = measure
    this.#armed = measure !== undefined
    this.#benchOptions = benchOptions
  }

  /** The tracker in use (the first one while measuring). */
  get tracker(): FrameTracker {
    return this.#current.tracker
  }

  get description(): string {
    const b = this.#backend
    const label = labelOf(this.#current)
    if (this.#measuring) return `${label} (measuring ${[this.#current.candidate, ...(this.#toMeasure ?? [])].map((c) => c.name).join(', ')})`
    const ms = b.measuredMs ? Object.entries(b.measuredMs).map(([name, v]) => `${name} ${v.toFixed(1)} ms`).join(', ') : ''
    return `${label} (${(b.source === 'measured' || b.source === 'cached') && ms ? `${b.source}: ${ms}` : b.source})`
  }

  get backend(): BackendInfo {
    return this.#backend
  }

  get measuring(): boolean {
    return this.#measuring
  }

  /**
   * That of the tracker of the last call: while measuring, each backend is scheduled as it would run once chosen (a
   * worker eagerly: started on the frame ticks, its crops waited for the page's rendering on the GPU, desktop).
   */
  get eager(): boolean {
    return (this.#last ?? this.#current).tracker.eager ?? false
  }

  offer(input: TrackerInput, timestampMs: number, mediaTime: number): void {
    ;(this.#last ?? this.#current).tracker.offer?.(input, timestampMs, mediaTime)
  }

  get timings(): Readonly<Record<string, number>> | undefined {
    return this.#bench ? undefined : this.#current.tracker.timings
  }

  get sheds(): readonly Capability[] | undefined {
    return this.#current.tracker.sheds
  }

  get offMainThread(): boolean {
    return this.#current.tracker.offMainThread ?? false
  }

  benchmark(): void {
    const list = this.#toMeasure
    if (!list || !this.#armed || this.#disposed) return
    this.#armed = false
    this.#measuring = true
    const generation = ++this.#generation
    void (async () => {
      const running = new Map<string, Running>([[this.#current.candidate.name, this.#current]])
      for (const candidate of list) {
        if (this.#failed.has(candidate.name)) continue
        try {
          const tracker = await candidate.open(this.#config, this.#env)
          if (this.#disposed || generation !== this.#generation) {
            tracker.dispose()
            break
          }
          running.set(candidate.name, { candidate, tracker })
        } catch (error) {
          this.#env.warn(`Could not open the ${candidate.name} face tracker to measure it: ${errorText(error)}`, error)
        }
      }
      if (this.#disposed || generation !== this.#generation) {
        for (const r of running.values()) if (r !== this.#current) r.tracker.dispose()
        return
      }
      if (running.size < 2) {
        this.#measuring = false
        this.#backend = { name: this.#current.candidate.name, source: 'only' }
        return
      }
      for (const r of running.values()) r.tracker.configure(this.#config)
      // One backend after the other, each scheduled as it will run (`eager`): alternating a worker with main-thread
      // trackers breaks the worker's eager scheduling, and MediaPipe's GPU delegate leaves work on the GPU.
      this.#bench = { run: new BackendBenchmark([...running.keys()], { order: 'blocks', ...this.#benchOptions }), running }
    })()
  }

  track(input: TrackerInput, timestampMs: number, mediaTime: number, out: FaceFrame, exact?: boolean): void | Promise<void> {
    const bench = this.#bench
    const r = bench ? bench.running.get(bench.run.next)! : this.#current
    this.#last = r
    const start = bench ? performance.now() : 0
    let pending: void | Promise<void>
    try {
      pending = r.tracker.track(input, timestampMs, mediaTime, out, exact)
    } catch (error) {
      return this.#onFailure(r, error, out)
    }
    if (!bench) return pending ? pending.catch((error: unknown) => this.#onFailure(r, error, out)) : undefined
    const settle = () => {
      if (this.#bench !== bench) return
      bench.run.add(r.candidate.name, performance.now() - start, out.count > 0)
      if (bench.run.done) this.#finishBenchmark()
    }
    if (!pending) return settle()
    return pending.then(settle, (error: unknown) => this.#onFailure(r, error, out))
  }

  trackImage(input: TrackerInput, mediaTime: number, out: FaceFrame): void | Promise<void> {
    this.#abortBenchmark()
    const r = this.#current
    try {
      const pending = r.tracker.trackImage ? r.tracker.trackImage(input, mediaTime, out) : r.tracker.track(input, 0, mediaTime, out)
      return pending ? pending.catch((error: unknown) => this.#onFailure(r, error, out)) : undefined
    } catch (error) {
      return this.#onFailure(r, error, out)
    }
  }

  reset(): void | Promise<void> {
    // A file source starts: its results must not depend on which backend took which frame (spec §12.5).
    this.#abortBenchmark()
    return this.#current.tracker.reset?.()
  }

  configure(config: TrackerConfig): void {
    this.#config = config
    if (this.#bench) for (const r of this.#bench.running.values()) r.tracker.configure(config)
    else this.#current.tracker.configure(config)
  }

  dispose(): void {
    this.#disposed = true
    for (const r of this.#bench?.running.values() ?? []) if (r !== this.#current) r.tracker.dispose()
    this.#bench = undefined
    this.#current.tracker.dispose()
  }

  #finishBenchmark(): void {
    const bench = this.#bench!
    const measuredMs = bench.run.medians
    const score = (name: string) => measuredMs[name]! * (bench.running.get(name)!.candidate.weight ?? 1)
    const winner = [...bench.running.keys()].reduce((best, name) => (score(name) < score(best) ? name : best))
    for (const [name, r] of bench.running) if (name !== winner) r.tracker.dispose()
    this.#current = bench.running.get(winner)!
    this.#last = undefined
    this.#bench = undefined
    this.#measuring = false
    this.#backend = { name: winner, source: 'measured', measuredMs }
    const stored: StoredBackend = { backend: winner, measuredMs, userAgent: currentUserAgent(), at: new Date().toISOString() }
    this.#env.store?.set(stored)
    this.#current.tracker.configure(this.#config)
  }

  /** Stops a benchmark in progress, keeping the tracker it started with; it may run again on a later live source. */
  #abortBenchmark(): void {
    if (!this.#measuring) return
    this.#generation++
    for (const r of this.#bench?.running.values() ?? []) if (r !== this.#current) r.tracker.dispose()
    this.#bench = undefined
    this.#last = undefined
    this.#measuring = false
    this.#armed = true
    this.#current.tracker.configure(this.#config)
  }

  /**
   * A call failed. A broken tracker (its worker died) is replaced by the next candidate that opens, and the frame has
   * no face; any other error is the caller's, as before.
   */
  #onFailure(r: Running, error: unknown, out: FaceFrame): Promise<void> {
    out.count = 0
    if (!(r.candidate.broken?.(r.tracker) ?? false) || this.#disposed) return Promise.reject(error)
    this.#failed.add(r.candidate.name)
    if (this.#bench) {
      // Measure no more: keep the current tracker unless it is the broken one.
      this.#abortBenchmark()
      this.#armed = false
      if (r !== this.#current) {
        this.#env.warn(`The ${r.candidate.name} face tracker failed while it was measured: ${errorText(error)}`, error)
        this.#backend = { name: this.#current.candidate.name, source: 'only' }
        return Promise.resolve()
      }
    }
    r.tracker.dispose()
    const next = this.#candidates.filter((c) => !this.#failed.has(c.name))
    if (next.length === 0) return Promise.reject(error)
    this.#env.warn(`The ${r.candidate.name} face tracker failed (${errorText(error)}); switching to ${next[0]!.name}.`, error)
    return this.#openFirst(next).then((opened) => {
      if (this.#disposed) return opened.tracker.dispose()
      this.#current = opened
      this.#last = undefined
      this.#armed = false
      this.#backend = { name: opened.candidate.name, source: 'only' }
    })
  }

  async #openFirst(list: readonly TrackerCandidate[]): Promise<Running> {
    let lastError: unknown
    for (const candidate of list) {
      try {
        const tracker = await candidate.open(this.#config, this.#env)
        return { candidate, tracker }
      } catch (error) {
        this.#failed.add(candidate.name)
        lastError = error
        this.#env.warn(`The ${candidate.name} face tracker could not start: ${errorText(error)}`, error)
      }
    }
    throw new Error('No face tracker could start.', { cause: lastError })
  }
}

function labelOf(r: Running): string {
  return r.candidate.label ? r.candidate.label(r.tracker) : r.tracker.description
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
