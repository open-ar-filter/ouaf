import { describe, expect, it } from 'vitest'
import { CAPABILITIES, DeviceGovernor, type Capability, type GovernorChange } from '../src/engine/governor.ts'

/** A device: the tracking rate for the current configuration (the measured rate settles at once here). */
type Device = (dropped: readonly Capability[], hidden: boolean, t: number) => number

const ALL = new Set<Capability>(CAPABILITIES)

/**
 * Runs the governor every 100 ms for `seconds`; returns the changes with their time (s). `pipeline`: the time per
 * result (ms) for the current configuration, when the test gives it.
 */
function run(
  device: Device,
  seconds: number,
  options: { droppable?: (t: number) => ReadonlySet<Capability>; pipeline?: Device; faces?: (t: number) => number; offMainThread?: boolean; frameMs?: Device } = {},
) {
  const g = new DeviceGovernor()
  const changes: Array<{ t: number; change: GovernorChange }> = []
  for (let ms = 0; ms <= seconds * 1000; ms += 100) {
    const t = ms / 1000
    const rate = device(g.dropped, g.hidden, t)
    const pipelineMs = options.pipeline?.(g.dropped, g.hidden, t)
    const faces = options.faces?.(t)
    const frameMs = options.frameMs?.(g.dropped, g.hidden, t)
    // As the engine: showing and restoring see only the results with the faces of the decision (none: no data).
    const recovery = faces === undefined || faces >= g.referenceFaces ? rate : Number.NaN
    const change = g.update(ms, rate, options.droppable?.(t) ?? ALL, {
      ...(pipelineMs === undefined ? {} : { pipelineMs }),
      ...(faces === undefined ? {} : { faces }),
      ...(options.offMainThread === undefined ? {} : { offMainThread: options.offMainThread }),
      ...(frameMs === undefined ? {} : { frameMs }),
      recoveryHz: recovery,
      ...(pipelineMs === undefined ? {} : { recoveryPipelineMs: Number.isNaN(recovery) ? Number.NaN : pipelineMs }),
    })
    if (change) changes.push({ t: ms / 1000, change })
  }
  return { g, changes, kinds: changes.map(({ change: c }) => ('capability' in c ? `${c.kind} ${c.capability}` : c.kind)) }
}

/** Rate from a base cost (ms per result) and what each capability costs. */
const costs = (base: number, saved: Partial<Record<Capability, number>>, hiddenSaves = 0): Device => (dropped, hidden) => {
  let ms = base
  for (const c of dropped) ms -= saved[c] ?? 0
  if (hidden) ms -= hiddenSaves
  return 1000 / ms
}

describe('DeviceGovernor', () => {
  it('leaves a fast device alone', () => {
    const { g, changes } = run(() => 30, 60)
    expect(changes).toEqual([])
    expect(g.state).toBe('ok')
  })

  it('drops blendshapes first when that is enough, and keeps them dropped (12 → 14 Hz)', () => {
    const { g, kinds, changes } = run(costs(1000 / 12, { blendshapes: 1000 / 12 - 1000 / 14 }), 120)
    expect(kinds).toEqual(['drop blendshapes'])
    expect(changes[0]!.t).toBe(1)
    expect(g.state).toBe('degraded')
    expect(g.dropped).toEqual(['blendshapes'])
  })

  it('drops every optional capability one per second, then hides the filters 3 s after going below the floor', () => {
    const { g, kinds, changes } = run(() => 8, 30)
    expect(kinds).toEqual(['drop blendshapes', 'drop extraFaces', 'drop resolution', 'hide'])
    expect(changes.map((c) => c.t)).toEqual([1, 2, 3, 4])
    expect(g.state).toBe('unsupported')
    expect(g.dropped).toEqual(['blendshapes', 'extraFaces', 'resolution'])
  })

  it('only drops what the stack can do without (requires.blendshapes, a single face)', () => {
    const { kinds } = run(() => 8, 30, { droppable: () => new Set(['resolution']) })
    expect(kinds).toEqual(['drop resolution', 'hide'])
  })

  it('restores a capability at once when it becomes required', () => {
    const { kinds, changes } = run(costs(1000 / 11, { blendshapes: 20 }), 10, { droppable: (t) => (t < 5 ? ALL : new Set(['extraFaces', 'resolution'])) })
    expect(kinds.slice(0, 2)).toEqual(['drop blendshapes', 'restore blendshapes'])
    expect(changes[1]!.t).toBe(5)
  })

  it('shows the filters again above 14 Hz, then restores the capabilities one at a time, last dropped first', () => {
    // Slow for 10 s (e.g. heat), then fast.
    const { g, kinds, changes } = run((_, __, t) => (t < 10 ? 8 : 40), 60)
    expect(kinds).toEqual(['drop blendshapes', 'drop extraFaces', 'drop resolution', 'hide', 'show', 'restore resolution', 'restore extraFaces', 'restore blendshapes'])
    const t = Object.fromEntries(changes.map((c) => [('capability' in c.change ? `${c.change.kind} ${c.change.capability}` : c.change.kind), c.t]))
    expect(t.show).toBeGreaterThanOrEqual(11) // settled rate above 14 Hz for 1 s
    expect(t['restore resolution']! - t.show!).toBeGreaterThanOrEqual(6) // settle + 5 s above the restore level
    expect(t['restore extraFaces']! - t['restore resolution']!).toBeGreaterThanOrEqual(6)
    expect(g.state).toBe('ok')
  })

  it('restores everything once a device that was heavily loaded frees up (gains measured as shares)', () => {
    // As `throttleTracker`: 250 ms per result with everything on, each capability a share of it; 20 ms from 20 s on.
    const shares = { blendshapes: 0.15, extraFaces: 0.2, resolution: 0.25 }
    // The camera (30 fps) caps the rate: only the pipeline time tells what restoring a capability would cost.
    const pipeline: Device = (dropped, _, t) => (t < 20 ? 250 : 20) * (1 - dropped.reduce((s, c) => s + shares[c], 0))
    const device: Device = (dropped, hidden, t) => Math.min(30, 1000 / pipeline(dropped, hidden, t))
    const { g, kinds } = run(device, 90, { pipeline })
    expect(kinds).toEqual(['drop blendshapes', 'drop extraFaces', 'drop resolution', 'hide', 'show', 'restore resolution', 'restore extraFaces', 'restore blendshapes'])
    expect(g.state).toBe('ok')
  })

  it('does not restore a capability whose cost would bring the rate back down', () => {
    // 11 Hz with blendshapes, 16 without: restoring them would predict 11 Hz.
    const { kinds } = run(costs(1000 / 11, { blendshapes: 1000 / 11 - 1000 / 16 }), 120)
    expect(kinds).toEqual(['drop blendshapes'])
  })

  it('does not flicker when hiding the filters is what frees the device: rare probes, further and further apart', () => {
    // Everything dropped: 10 Hz while the filters are drawn, 16 Hz while they are hidden: showing them predicts 10 Hz.
    // The measured rate (16 Hz) is above 14 Hz, so the show is probed after 30 s, then 60 s, 120 s…
    const { kinds, changes } = run(costs(1000 / 10, {}, 1000 / 10 - 1000 / 16), 600)
    expect(kinds.slice(0, 4)).toEqual(['drop blendshapes', 'drop extraFaces', 'drop resolution', 'hide'])
    const shows = changes.filter((c) => c.change.kind === 'show').map((c) => c.t)
    expect(shows.length).toBeLessThanOrEqual(4)
    expect(shows[0]!).toBeGreaterThanOrEqual(34)
    const gaps = shows.slice(1).map((t, i) => t - shows[i]!)
    for (let i = 0; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThanOrEqual(60 * 2 ** i)
    // Each probe shows the filters for 3 s (the floor delay) before hiding them again.
    expect(kinds.slice(4).every((k, i) => k === (i % 2 ? 'hide' : 'show'))).toBe(true)
  })

  it('shows the filters again once the device seems to have room for them, and learns when it was wrong', () => {
    // Hidden at 10 Hz (16 Hz hidden); at 60 s the hidden rate rises to 50 Hz (predicted shown: 10 × 50 / 16 = 31 Hz),
    // but drawing still brings it to 10 Hz: shown, hidden 3 s later, and what that hide gained (50 Hz hidden) leaves
    // only slow probes.
    const device: Device = (_, hidden, t) => (hidden ? (t < 60 ? 16 : 50) : 10)
    const { kinds, changes } = run(device, 300)
    // A probe at 35 s (16 Hz measured while hidden, 10 Hz predicted shown), then the real show at 60 s.
    expect(kinds.slice(0, 8)).toEqual(['drop blendshapes', 'drop extraFaces', 'drop resolution', 'hide', 'show', 'hide', 'show', 'hide'])
    expect(changes.map((c) => c.t).slice(3, 8)).toEqual([4, 35, 38, 60, 63])
    // Next show: a probe again, 120 s later (30 s doubled twice: hidden again soon after each show).
    expect(changes[8]!.t).toBeGreaterThanOrEqual(183)
  })

  it('Redmi Note 11S pattern: hiding frees the main thread (11 → 20 Hz), no re-show before the slow probe', () => {
    // Main-thread tracker: 11 Hz with the filter drawn. Once hidden the rate climbs over a few seconds (the window still
    // holds slow results) to 20 Hz. Seen live (13.2 → 23.5 Hz with the 15 Hz floor of the time): hidden, re-shown 9 s
    // later, hidden again 6 s later.
    let hiddenAt = Number.NaN
    const device: Device = (_, hidden, t) => {
      if (!hidden) {
        hiddenAt = Number.NaN
        return 11
      }
      if (Number.isNaN(hiddenAt)) hiddenAt = t
      return Math.min(20, 12 + (t - hiddenAt) * 3)
    }
    const { kinds, changes } = run(device, 120, { droppable: () => new Set<Capability>(['blendshapes', 'resolution']) })
    expect(kinds.slice(0, 3)).toEqual(['drop blendshapes', 'drop resolution', 'hide'])
    const hide = changes[2]!.t
    const shows = changes.filter((c) => c.change.kind === 'show').map((c) => c.t)
    // Only the probe (30 s) shows them again, then each probe waits twice as long.
    expect(shows[0]!).toBeGreaterThanOrEqual(hide + 30)
    expect(shows.length).toBeLessThanOrEqual(2)
  })

  it('Redmi Note 11S: the rate without a face (detector only) is not a recovery', () => {
    // MediaPipe on the main thread: 11 Hz with a face (hidden or shown); with no face in view (20-40 s) it only runs its
    // detector: 23 Hz. Seen live: hidden at 13.1 Hz, shown again 8 s later at 23.1 Hz with no face.
    const faces = (t: number) => (t >= 20 && t < 40 ? 0 : 1)
    const { kinds, changes } = run((_, __, t) => (faces(t) ? 11 : 23), 80, { faces, droppable: () => new Set<Capability>(['blendshapes', 'resolution']) })
    expect(kinds.slice(0, 3)).toEqual(['drop blendshapes', 'drop resolution', 'hide'])
    // Nothing while the face is away, nor once it is back (11 Hz again): the filters stay hidden.
    expect(changes.filter((c) => c.t >= 20 && c.t < 80)).toEqual([])
  })

  it('a capability dropped with a face is not restored on the rate without it, but is once the face is back', () => {
    // 12 Hz with a face and blendshapes, 14 Hz without them (kept dropped); 30 Hz with no face (10-30 s); from 50 s the
    // device is fast with the face too (30 Hz).
    const faces = (t: number) => (t >= 10 && t < 30 ? 0 : 1)
    const device: Device = (dropped, _, t) => (!faces(t) || t >= 50 ? 30 : dropped.includes('blendshapes') ? 14 : 12)
    const { kinds, changes } = run(device, 70, { faces, droppable: () => new Set<Capability>(['blendshapes']) })
    expect(kinds).toEqual(['drop blendshapes', 'restore blendshapes'])
    // Restored only after 50 s (+ 3 s with the face back, + 5 s above the restore level), not while no face was seen.
    expect(changes[1]!.t).toBeGreaterThanOrEqual(55)
  })

  it('a face lost for a moment (every 8 s, like the test clip) does not hold the recovery back for ever', () => {
    // Slow until 20 s (8 Hz), then fast (40 Hz); no face for 1 s of every 8 s (60 Hz then: detector only).
    const faces = (t: number) => (t % 8 < 1 ? 0 : 1)
    const { g, kinds } = run((_, __, t) => (!faces(t) ? 60 : t < 20 ? 8 : 40), 120, { faces })
    expect(kinds).toEqual(['drop blendshapes', 'drop extraFaces', 'drop resolution', 'hide', 'show', 'restore resolution', 'restore extraFaces', 'restore blendshapes'])
    expect(g.state).toBe('ok')
  })

  it('shows hidden filters soon when tracking really gets faster after the hide', () => {
    // Hidden at 10 Hz (12 Hz hidden); at 20 s another load stops: 30 Hz hidden, i.e. 2.5× faster, 25 Hz shown.
    const device: Device = (_, hidden, t) => (t < 20 ? (hidden ? 12 : 10) : hidden ? 30 : 25)
    const { kinds, changes } = run(device, 60)
    expect(kinds.slice(0, 5)).toEqual(['drop blendshapes', 'drop extraFaces', 'drop resolution', 'hide', 'show'])
    expect(changes[4]!.t).toBeLessThan(23)
    expect(kinds.at(-1)).toBe('restore blendshapes') // then everything comes back
  })

  it('worker tracker: shows the filters again within seconds after a short dip, even one ending during the baseline', () => {
    // #180. Tracking in a worker: hiding the filters frees the main thread, not the tracker (same rate hidden or shown).
    // 19 Hz, a dip to 8 Hz from 10 s to 16 s (hidden at 14 s), 19 Hz again: back within the first 6 s hidden.
    const device: Device = (_, __, t) => (t >= 10 && t < 16 ? 8 : 19)
    const { kinds, changes } = run(device, 120, { offMainThread: true })
    expect(kinds.slice(0, 5)).toEqual(['drop blendshapes', 'drop extraFaces', 'drop resolution', 'hide', 'show'])
    const t = (kind: string) => changes[kinds.indexOf(kind)]!.t
    expect(t('hide')).toBeLessThan(16)
    expect(t('show') - 16).toBeLessThanOrEqual(5)
    // Then the capabilities come back (19 Hz, each one costing nothing here), and nothing is hidden again.
    expect(kinds.filter((k) => k === 'hide')).toHaveLength(1)
    expect(kinds.at(-1)).toBe('restore blendshapes')
    // A main-thread tracker on the same rates waits for the slow probe: the hidden rate could be what hiding gained.
    const main = run(device, 120)
    expect(main.changes[main.kinds.indexOf('show')]!.t).toBeGreaterThanOrEqual(t('hide') + 30)
  })

  it('worker tracker: a filter that keeps the main thread busy is not shown again before the slow probe', () => {
    // The tracker runs in a worker, but its results are handled on the main thread, which the filter blocks 85 ms per
    // frame (the `busy` fixture): 11 Hz shown, 20 Hz hidden. The cap (1000 / 85 ≈ 12 Hz) says showing would not hold.
    const device: Device = (_, hidden) => (hidden ? 20 : 11)
    const frameMs: Device = (_, hidden) => (hidden ? 1 : 85)
    const { kinds, changes } = run(device, 120, { offMainThread: true, frameMs, droppable: () => new Set<Capability>(['blendshapes', 'resolution']) })
    expect(kinds.slice(0, 3)).toEqual(['drop blendshapes', 'drop resolution', 'hide'])
    const shows = changes.filter((c) => c.change.kind === 'show').map((c) => c.t)
    expect(shows[0]!).toBeGreaterThanOrEqual(changes[2]!.t + 30)
    // A light filter (5 ms per frame) on the same rates: shown again at once (then hidden again, and probes).
    const light = run(device, 120, { offMainThread: true, frameMs: () => 5, droppable: () => new Set<Capability>(['blendshapes', 'resolution']) })
    expect(light.changes.find((c) => c.change.kind === 'show')!.t - light.changes[2]!.t).toBeLessThanOrEqual(3)
  })

  it('worker tracker: no flicker between the floor and the show level', () => {
    // Hidden at 8 Hz, then 13 Hz hidden or shown: below the 14 Hz show level, the filters stay hidden.
    const { kinds } = run((_, __, t) => (t < 10 ? 8 : 13), 300, { offMainThread: true })
    expect(kinds).toEqual(['drop blendshapes', 'drop extraFaces', 'drop resolution', 'hide'])
    // Hovering around 14 Hz (13.5–14.5) after the hide: shown at most once, never hidden again (the floor is 12 Hz).
    const hover = run((_, __, t) => (t < 10 ? 8 : 14 + 0.5 * Math.sin(t)), 300, { offMainThread: true })
    expect(hover.kinds.filter((k) => k === 'show').length).toBeLessThanOrEqual(1)
    expect(hover.kinds.filter((k) => k === 'hide')).toHaveLength(1)
  })

  it('worker tracker: if showing the filters does slow tracking, falls back to the prediction and the slow probes', () => {
    // The tracker runs in a worker but competes with the rendering: 16 Hz hidden, 10 Hz shown. One quick show, hidden
    // again 4 s later; from then on as a main-thread tracker (shows 30 s, 60 s, 120 s… apart).
    const { kinds, changes } = run(costs(1000 / 10, {}, 1000 / 10 - 1000 / 16), 600, { offMainThread: true })
    expect(kinds.slice(0, 6)).toEqual(['drop blendshapes', 'drop extraFaces', 'drop resolution', 'hide', 'show', 'hide'])
    const shows = changes.filter((c) => c.change.kind === 'show').map((c) => c.t)
    expect(shows[0]! - changes[3]!.t).toBeLessThanOrEqual(3)
    expect(shows.length).toBeLessThanOrEqual(5)
    const gaps = shows.slice(1).map((t, i) => t - shows[i]!)
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThanOrEqual(60 * 2 ** (i - 1))
  })

  it('backs off restoring a capability that had to be dropped again soon after', () => {
    const g = new DeviceGovernor()
    const restores: number[] = []
    // 10 Hz with blendshapes. Just after each drop the rate is still low (12 Hz: the drop seems to gain little),
    // then it is fast (100 Hz): the restore predicts enough room, and blendshapes are dropped again.
    let droppedAt = Number.NaN
    for (let ms = 0; ms <= 120_000; ms += 100) {
      const rate = !g.isDropped('blendshapes') ? 10 : ms - droppedAt <= 1000 ? 12 : 100
      const change = g.update(ms, rate, new Set(['blendshapes']))
      if (change?.kind === 'drop') droppedAt = ms
      if (change?.kind === 'restore') restores.push(ms / 1000)
    }
    expect(restores.length).toBeGreaterThanOrEqual(3)
    const gaps = restores.slice(1).map((t, i) => t - restores[i]!)
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThan(gaps[i - 1]!)
  })

  it('never hides nor restores on a rate between the floor and the drop level', () => {
    const { kinds } = run((_, __, t) => 16.5 + Math.sin(t * 3), 120)
    expect(kinds.every((k) => k.startsWith('drop'))).toBe(true)
  })

  it('judges nothing until the rate settles after a change or a restart', () => {
    const g = new DeviceGovernor()
    expect(g.update(0, 5, ALL)).toBeUndefined()
    expect(g.update(900, 5, ALL)).toBeUndefined()
    expect(g.update(1000, 5, ALL)).toEqual({ kind: 'drop', capability: 'blendshapes' })
    expect(g.update(1500, 5, ALL)).toBeUndefined()
    g.restart(1600)
    expect(g.update(2500, 5, ALL)).toBeUndefined()
    expect(g.update(2600, 5, ALL)).toEqual({ kind: 'drop', capability: 'extraFaces' })
    g.reset(3000)
    expect(g.dropped).toEqual([])
    expect(g.state).toBe('ok')
  })
})
