/**
 * GPU watchdog (spec §11, §15.5; #27): measures how long the GPU takes to finish the frames that draw author shader
 * code, and reports a filter whose shader keeps it busy for more than `GPU_STALL_MS` on `GPU_STALL_FRAMES` such frames
 * in a row, or on a single frame that took (or has not finished after) `GPU_STALL_FRAMES` × `GPU_STALL_MS`.
 *
 * A draw call cannot be interrupted from a page: a heavy shader stalls every GPU client of the browser (its
 * compositor included) until the GPU finishes, or until the browser resets the GPU, which the engine handles as a
 * context loss. The watchdog shortens the stall to a couple of frames: the engine disables the filter it blames, as
 * after a context loss.
 *
 * Each such frame gets a fence (`fenceSync`) and is timed from the start of its drawing to the fence. The fence is
 * polled with a timer rather than at the next frame, so that a host that
 * renders rarely (file regime, `pushFrame`) does not make its frames look slow. The measure is an upper bound: it also
 * counts the time this thread could not poll (a long task); two slow frames in a row are needed, and frames
 * submitted or finished while the page is hidden (no timers, no rendering) are not counted. Frames are never skipped:
 * the file regime renders every frame it is given.
 */

/**
 * A frame that kept the GPU busy longer than this is slow (ms): a third of a frame a second is no longer a filter.
 * Generous, because software renderers (CI) under load take over a second for a full-resolution post shader.
 */
export const GPU_STALL_MS = 3000
/** Slow frames in a row before the filters that drew author shaders in them are blamed. */
export const GPU_STALL_FRAMES = 2
/** Polling period of the pending fences (ms). */
const POLL_MS = 20

/** The part of a WebGL2 context the watchdog uses. */
export interface GpuFences {
  readonly SYNC_GPU_COMMANDS_COMPLETE: number
  readonly SYNC_STATUS: number
  readonly SIGNALED: number
  fenceSync(condition: number, flags: number): unknown
  getSyncParameter(sync: never, pname: number): unknown
  deleteSync(sync: never): void
  flush(): void
  isContextLost(): boolean
}

export interface GpuWatchdogOptions<T> {
  gl: GpuFences
  /** Called once frames are slow: `filters` were passed to `submitted` for each of those frames. */
  stalled(filters: readonly T[], ms: number): void
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (id: unknown) => void
  /** True while the page is hidden (default: `document.visibilityState`). */
  hidden?: () => boolean
}

interface Pending<T> {
  sync: unknown
  at: number
  filters: readonly T[]
  /** Submitted while the page was hidden: not measured. */
  hidden: boolean
}

export class GpuWatchdog<T> {
  readonly #o: GpuWatchdogOptions<T>
  #pending: Array<Pending<T>> = []
  #timer: unknown
  /** Slow frames in a row, and the filters drawn in all of them. */
  #slow = 0
  #suspects: T[] = []
  /** Copy of the last list given to `submitted`: the caller reuses its array from one frame to the next. */
  #last: readonly T[] = []
  readonly #now: () => number
  readonly #setTimeout: (fn: () => void, ms: number) => unknown
  readonly #poll = (): void => this.poll()

  constructor(options: GpuWatchdogOptions<T>) {
    this.#o = options
    this.#now = options.now ?? (() => performance.now())
    this.#setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  }

  /** Frames submitted and not finished yet. */
  get pending(): number {
    return this.#pending.length
  }

  /**
   * A frame that drew the author shaders of `filters` was just submitted (nothing to do when `filters` is empty).
   * The list is copied (when it differs from the previous frame's): the caller may reuse the array.
   *
   * `startedAt` (same clock as `now`): when the frame started to be drawn. The time of a frame is counted from there,
   * not from this call, because a GL implementation may do the work inside the draw calls (WebKit's software renderer
   * does): the frame is then finished when it is submitted, after having held this thread for as long as the GPU would
   * have been busy. Counted from this call, such a frame was never slow and its filter never disabled.
   */
  submitted(filters: readonly T[], startedAt = this.#now()): void {
    if (filters.length === 0) return
    if (!sameList(filters, this.#last)) this.#last = [...filters]
    const gl = this.#o.gl
    if (gl.isContextLost()) return
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    if (!sync) return
    gl.flush()
    this.#pending.push({ sync, at: startedAt, filters: this.#last, hidden: this.#hidden() })
    this.#schedule()
  }

  /** Forgets the pending frames (context lost, engine disposed); the next frames start a new count. */
  reset(): void {
    const gl = this.#o.gl
    if (!gl.isContextLost()) for (const p of this.#pending) gl.deleteSync(p.sync as never)
    this.#pending = []
    this.#slow = 0
    this.#suspects = []
    if (this.#timer !== undefined) (this.#o.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)))(this.#timer)
    this.#timer = undefined
  }

  /** Checks the pending fences now (the timer calls it; tests may too). */
  poll(): void {
    this.#timer = undefined
    const gl = this.#o.gl
    if (gl.isContextLost()) {
      this.reset()
      return
    }
    const now = this.#now()
    const hidden = this.#hidden()
    while (this.#pending.length > 0) {
      const p = this.#pending[0]!
      const done = gl.getSyncParameter(p.sync as never, gl.SYNC_STATUS) === gl.SIGNALED
      const ms = now - p.at
      if (!done) {
        // Still running: blamed as the last slow frame of a series, or alone once it has run for the whole series.
        const counted = !hidden && !p.hidden
        if (counted && (ms > GPU_STALL_MS * GPU_STALL_FRAMES || (ms > GPU_STALL_MS && this.#slow + 1 >= GPU_STALL_FRAMES))) this.#count(p.filters, ms, true)
        break
      }
      gl.deleteSync(p.sync as never)
      this.#pending.shift()
      if (hidden || p.hidden) continue
      // A frame that took the whole series is blamed alone, finished or not: on a renderer that does the work inside the
      // draw calls (WebKit's software one), a frame is never seen running, and waiting for a second one held the page
      // for minutes (#201).
      if (ms > GPU_STALL_MS) this.#count(p.filters, ms, ms > GPU_STALL_MS * GPU_STALL_FRAMES)
      else {
        this.#slow = 0
        this.#suspects = []
      }
    }
    if (this.#pending.length > 0) this.#schedule()
  }

  /** One more slow frame (`last`: the one that ends the series, whatever the count). */
  #count(filters: readonly T[], ms: number, last = false): void {
    this.#suspects = this.#slow === 0 ? [...filters] : this.#suspects.filter((f) => filters.includes(f))
    this.#slow++
    if (this.#slow < GPU_STALL_FRAMES && !last) return
    const suspects = this.#suspects
    // Their next frames start a new count (the frames still pending were submitted before the filters were disabled).
    this.reset()
    if (suspects.length > 0) this.#o.stalled(suspects, ms)
  }

  #schedule(): void {
    if (this.#timer !== undefined) return
    this.#timer = this.#setTimeout(this.#poll, POLL_MS)
  }

  #hidden(): boolean {
    return this.#o.hidden ? this.#o.hidden() : typeof document !== 'undefined' && document.visibilityState === 'hidden'
  }
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
