import { describe, expect, it } from 'vitest'
import { GPU_STALL_FRAMES, GPU_STALL_MS, GpuWatchdog, type GpuFences } from '../src/engine/gpu-watchdog.ts'

// The GPU watchdog (#27, spec §11): fences of the frames that draw author shaders, polled on a timer.

interface Fence {
  done: boolean
  deleted: boolean
}

function setup(options: { hidden?: () => boolean } = {}) {
  let now = 0
  let timer: (() => void) | undefined
  let lost = false
  const fences: Fence[] = []
  const stalled: Array<[string[], number]> = []
  const gl: GpuFences = {
    SYNC_GPU_COMMANDS_COMPLETE: 1,
    SYNC_STATUS: 2,
    SIGNALED: 3,
    fenceSync: () => {
      const f = { done: false, deleted: false }
      fences.push(f)
      return f
    },
    getSyncParameter: (sync: never) => ((sync as Fence).done ? 3 : 4),
    deleteSync: (sync: never) => void ((sync as Fence).deleted = true),
    flush: () => {},
    isContextLost: () => lost,
  }
  const watchdog = new GpuWatchdog<string>({
    gl,
    stalled: (filters, ms) => void stalled.push([[...filters], ms]),
    now: () => now,
    setTimeout: (fn) => ((timer = fn), 1),
    clearTimeout: () => (timer = undefined),
    ...options,
  })
  /** Advances the clock by `ms`, then runs the pending poll, if any. */
  const advance = (ms: number) => {
    now += ms
    const fn = timer
    timer = undefined
    fn?.()
  }
  /** A frame drawing `filters`, which the GPU finishes after `ms`. */
  const frame = (filters: string[], ms: number) => {
    watchdog.submitted(filters)
    const f = fences.at(-1)!
    now += ms
    f.done = true
    advance(0)
  }
  return { watchdog, fences, stalled, advance, frame, lose: () => (lost = true), hasTimer: () => timer !== undefined }
}

describe('GPU watchdog', () => {
  it('measures nothing for frames without author shaders', () => {
    const s = setup()
    s.watchdog.submitted([])
    expect(s.fences).toHaveLength(0)
    expect(s.hasTimer()).toBe(false)
  })

  it('lets fast frames go, and deletes their fences', () => {
    const s = setup()
    for (let i = 0; i < 10; i++) s.frame(['a'], 30)
    expect(s.stalled).toEqual([])
    expect(s.watchdog.pending).toBe(0)
    expect(s.fences.every((f) => f.deleted)).toBe(true)
  })

  it(`blames the filters drawn in ${GPU_STALL_FRAMES} slow frames in a row`, () => {
    const s = setup()
    s.frame(['a', 'b'], GPU_STALL_MS + 500)
    expect(s.stalled).toEqual([])
    s.frame(['a'], GPU_STALL_MS + 100)
    expect(s.stalled).toEqual([[['a'], GPU_STALL_MS + 100]])
    // A new count starts.
    s.frame(['a'], GPU_STALL_MS + 100)
    expect(s.stalled).toHaveLength(1)
  })

  it('does not blame a single slow frame between fast ones', () => {
    const s = setup()
    for (let i = 0; i < 5; i++) {
      s.frame(['a'], GPU_STALL_MS + 100)
      s.frame(['a'], 20)
    }
    expect(s.stalled).toEqual([])
  })

  it('blames nobody when the slow frames drew different filters', () => {
    const s = setup()
    s.frame(['a'], GPU_STALL_MS + 100)
    s.frame(['b'], GPU_STALL_MS + 100)
    expect(s.stalled).toEqual([])
  })

  it('blames a frame that has not finished after the whole series', () => {
    const s = setup()
    s.watchdog.submitted(['a'])
    s.watchdog.submitted(['a'])
    s.advance(GPU_STALL_MS)
    s.advance(GPU_STALL_MS)
    expect(s.stalled).toEqual([])
    expect(s.hasTimer()).toBe(true)
    s.advance(100)
    expect(s.stalled).toEqual([[['a'], GPU_STALL_FRAMES * GPU_STALL_MS + 100]])
    expect(s.watchdog.pending).toBe(0)
    expect(s.fences.every((f) => f.deleted)).toBe(true)
  })

  it('blames a frame still running after a slow one', () => {
    const s = setup()
    s.frame(['a'], GPU_STALL_MS + 100)
    s.watchdog.submitted(['a'])
    s.advance(GPU_STALL_MS + 50)
    expect(s.stalled).toEqual([[['a'], GPU_STALL_MS + 50]])
  })

  it('does not count frames while the page is hidden', () => {
    let hidden = true
    const s = setup({ hidden: () => hidden })
    s.frame(['a'], 10 * GPU_STALL_MS)
    s.frame(['a'], 10 * GPU_STALL_MS)
    // Submitted while hidden, finished once visible.
    s.watchdog.submitted(['a'])
    hidden = false
    s.advance(10 * GPU_STALL_MS)
    expect(s.stalled).toEqual([])
  })

  it('forgets everything on reset and when the context is lost', () => {
    const s = setup()
    s.frame(['a'], GPU_STALL_MS + 100)
    s.watchdog.submitted(['a'])
    s.watchdog.reset()
    expect(s.watchdog.pending).toBe(0)
    expect(s.hasTimer()).toBe(false)
    s.frame(['a'], GPU_STALL_MS + 100)
    expect(s.stalled).toEqual([])

    s.watchdog.submitted(['a'])
    s.lose()
    s.advance(10 * GPU_STALL_MS)
    expect(s.watchdog.pending).toBe(0)
    // Nothing is measured on a lost context.
    s.watchdog.submitted(['a'])
    expect(s.watchdog.pending).toBe(0)
    expect(s.stalled).toEqual([])
  })
})
