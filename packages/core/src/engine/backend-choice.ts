/**
 * Choosing a tracker's inference backend by measuring it (spec §16.4): a short benchmark on the first frames of a live
 * source, and its result cached on the device, per engine version and tracker, never transmitted (§15).
 *
 * Why measure: on the Redmi Note 11S (#83), MediaPipe's GPU delegate takes ≈ 134 ms per frame against ≈ 67 ms on the
 * CPU, the opposite of what the GPU's name would suggest; headless browsers with a software GPU show the same.
 */

/** `localStorage` key prefix of the stored choices: `<prefix><engine version>:<tracker id>`. */
export const BACKEND_STORE_PREFIX = 'ouaf:tracker-backend:'

/** What is stored per tracker and engine version. */
export interface StoredBackend {
  backend: string
  /** Median time per result of each backend measured (ms). */
  measuredMs?: Record<string, number>
  /** The browser it was measured with: a browser update can change the GPU path, so a new one measures again. */
  userAgent: string
  /** When (ISO date), for people inspecting their storage. */
  at: string
}

/** A `TrackerEnv.store` over `localStorage` (JSON), silent when storage is unavailable (sandboxed frame, private mode). */
export function localBackendStore(key: string): { get(): unknown; set(value: unknown): void } {
  const storage = (): Storage | undefined => {
    try {
      return typeof localStorage === 'undefined' ? undefined : localStorage
    } catch {
      return undefined // a sandboxed frame throws on access
    }
  }
  return {
    get() {
      try {
        const text = storage()?.getItem(key)
        return text ? JSON.parse(text) : undefined
      } catch {
        return undefined
      }
    },
    set(value) {
      try {
        storage()?.setItem(key, JSON.stringify(value))
      } catch {
        // Full or unavailable: the benchmark runs again next time.
      }
    },
  }
}

/** The stored choice, if it names one of `candidates` and was measured with this browser. */
export function readStoredBackend(value: unknown, candidates: readonly string[], userAgent = currentUserAgent()): StoredBackend | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Partial<StoredBackend>
  if (typeof v.backend !== 'string' || !candidates.includes(v.backend) || v.userAgent !== userAgent) return undefined
  return v as StoredBackend
}

export function currentUserAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent
}

export interface BenchmarkOptions {
  /** Results of each backend left out first (compilation, caches). Default 3. */
  warmup?: number
  /** Results measured per backend after the warm-up. Default 12. */
  samples?: number
}

/**
 * The measuring part: backends take turns on successive frames; each result's time is added with `add`. Once every
 * backend has `samples` results after its warm-up, `winner` is the one with the lowest median, on the frames with a
 * face when each backend has enough of them (a frame without a face skips the landmark model), else on all frames.
 */
export class BackendBenchmark {
  readonly candidates: readonly string[]
  readonly #warmup: number
  readonly #samples: number
  readonly #all = new Map<string, number[]>()
  readonly #faces = new Map<string, number[]>()
  readonly #seen = new Map<string, number>()
  #turn = 0

  constructor(candidates: readonly string[], options: BenchmarkOptions = {}) {
    if (candidates.length === 0) throw new RangeError('BackendBenchmark needs at least one candidate')
    this.candidates = candidates
    this.#warmup = options.warmup ?? 3
    this.#samples = options.samples ?? 12
    for (const c of candidates) {
      this.#all.set(c, [])
      this.#faces.set(c, [])
      this.#seen.set(c, 0)
    }
  }

  /** The backend whose turn it is (round robin over the candidates still short of samples). */
  get next(): string {
    const open = this.candidates.filter((c) => this.#all.get(c)!.length < this.#samples)
    const list = open.length > 0 ? open : this.candidates
    return list[this.#turn++ % list.length]!
  }

  get done(): boolean {
    return this.candidates.every((c) => this.#all.get(c)!.length >= this.#samples)
  }

  /** Records one result of `backend` that took `ms`; `face`: it found a face. */
  add(backend: string, ms: number, face: boolean): void {
    const seen = this.#seen.get(backend)
    if (seen === undefined || !Number.isFinite(ms)) return
    this.#seen.set(backend, seen + 1)
    if (seen < this.#warmup) return
    const all = this.#all.get(backend)!
    if (all.length >= this.#samples) return
    all.push(ms)
    if (face) this.#faces.get(backend)!.push(ms)
  }

  /** Median time per backend (ms), on the frames used for the decision. */
  get medians(): Record<string, number> {
    const enoughFaces = this.candidates.every((c) => this.#faces.get(c)!.length >= Math.ceil(this.#samples / 2))
    const source = enoughFaces ? this.#faces : this.#all
    return Object.fromEntries(this.candidates.map((c) => [c, median(source.get(c)!)]))
  }

  /** The fastest backend, once `done`. */
  get winner(): string | undefined {
    if (!this.done) return undefined
    const m = this.medians
    return this.candidates.reduce((best, c) => (m[c]! < m[best]! ? c : best))
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}
