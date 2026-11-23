import { describe, expect, it } from 'vitest'
import { CAPABILITIES, DeviceGovernor, type Capability, type GovernorChange } from '../src/engine/governor.ts'

/** A device: the tracking rate for the current configuration (the measured rate settles at once here). */
type Device = (dropped: readonly Capability[], hidden: boolean, t: number) => number

const ALL = new Set<Capability>(CAPABILITIES)

/**
 * Runs the governor every 100 ms for `seconds`; returns the changes with their time (s). `pipeline`: the time per
 * result (ms) for the current configuration, when the test gives it.
 */
function run(device: Device, seconds: number, options: { droppable?: (t: number) => ReadonlySet<Capability>; pipeline?: Device } = {}) {
  const g = new DeviceGovernor()
  const changes: Array<{ t: number; change: GovernorChange }> = []
  for (let ms = 0; ms <= seconds * 1000; ms += 100) {
    const t = ms / 1000
    const change = g.update(ms, device(g.dropped, g.hidden, t), options.droppable?.(t) ?? ALL, options.pipeline?.(g.dropped, g.hidden, t))
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

  it('drops blendshapes first when that is enough, and keeps them dropped (Redmi Note 11S: 14.6 → 16.6 Hz)', () => {
    const { g, kinds, changes } = run(costs(1000 / 14.6, { blendshapes: 1000 / 14.6 - 1000 / 16.6 }), 120)
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
    const { kinds, changes } = run(costs(1000 / 14, { blendshapes: 10 }), 10, { droppable: (t) => (t < 5 ? ALL : new Set(['extraFaces', 'resolution'])) })
    expect(kinds.slice(0, 2)).toEqual(['drop blendshapes', 'restore blendshapes'])
    expect(changes[1]!.t).toBe(5)
  })

  it('shows the filters again above 18 Hz, then restores the capabilities one at a time, last dropped first', () => {
    // Slow for 10 s (e.g. heat), then fast.
    const { g, kinds, changes } = run((_, __, t) => (t < 10 ? 8 : 40), 60)
    expect(kinds).toEqual(['drop blendshapes', 'drop extraFaces', 'drop resolution', 'hide', 'show', 'restore resolution', 'restore extraFaces', 'restore blendshapes'])
    const t = Object.fromEntries(changes.map((c) => [('capability' in c.change ? `${c.change.kind} ${c.change.capability}` : c.change.kind), c.t]))
    expect(t.show).toBeGreaterThanOrEqual(11) // settled rate above 18 Hz for 1 s
    expect(t['restore resolution']! - t.show!).toBeGreaterThanOrEqual(6) // settle + 5 s above the restore level
    expect(t['restore extraFaces']! - t['restore resolution']!).toBeGreaterThanOrEqual(6)
    expect(g.state).toBe('ok')
  })

  it('restores everything once a device that was heavily loaded frees up (gains measured as shares)', () => {
    // As `throttleTracker`: 200 ms per result with everything on, each capability a share of it; 20 ms from 20 s on.
    const shares = { blendshapes: 0.15, extraFaces: 0.2, resolution: 0.25 }
    // The camera (30 fps) caps the rate: only the pipeline time tells what restoring a capability would cost.
    const pipeline: Device = (dropped, _, t) => (t < 20 ? 200 : 20) * (1 - dropped.reduce((s, c) => s + shares[c], 0))
    const device: Device = (dropped, hidden, t) => Math.min(30, 1000 / pipeline(dropped, hidden, t))
    const { g, kinds } = run(device, 90, { pipeline })
    expect(kinds).toEqual(['drop blendshapes', 'drop extraFaces', 'drop resolution', 'hide', 'show', 'restore resolution', 'restore extraFaces', 'restore blendshapes'])
    expect(g.state).toBe('ok')
  })

  it('does not restore a capability whose cost would bring the rate back down', () => {
    // 14 Hz with blendshapes, 19 without: restoring them would predict 14 Hz.
    const { kinds } = run(costs(1000 / 14, { blendshapes: 1000 / 14 - 1000 / 19 }), 120)
    expect(kinds).toEqual(['drop blendshapes'])
  })

  it('does not flicker when hiding the filters is what frees the device: rare probes, further and further apart', () => {
    // Everything dropped: 12 Hz while the filters are drawn, 20 Hz while they are hidden: showing them predicts 12 Hz.
    // The measured rate (20 Hz) is above 18 Hz, so the show is probed after 30 s, then 60 s, 120 s…
    const { kinds, changes } = run(costs(1000 / 12, {}, 1000 / 12 - 1000 / 20), 600)
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
    // Hidden at 12 Hz (20 Hz hidden: ratio 0.6); at 60 s the hidden rate rises to 50 Hz (predicted shown: 30 Hz), but
    // drawing still brings it to 12 Hz: shown, hidden 3 s later, and the ratio measured at that hide (0.24: 12 Hz
    // predicted) leaves only slow probes.
    const device: Device = (_, hidden, t) => (hidden ? (t < 60 ? 20 : 50) : 12)
    const { kinds, changes } = run(device, 300)
    // A probe at 35 s (20 Hz measured while hidden, 12 Hz predicted shown), then the real show at 60 s.
    expect(kinds.slice(0, 8)).toEqual(['drop blendshapes', 'drop extraFaces', 'drop resolution', 'hide', 'show', 'hide', 'show', 'hide'])
    expect(changes.map((c) => c.t).slice(3, 8)).toEqual([4, 35, 38, 60, 63])
    // Next show: a probe again, 120 s later (30 s doubled twice: hidden again soon after each show).
    expect(changes[8]!.t).toBeGreaterThanOrEqual(183)
  })

  it('Redmi Note 11S pattern: hiding frees the main thread (13 → 23.5 Hz), no re-show before the slow probe', () => {
    // Main-thread tracker: 13.2 Hz with the filter drawn. Once hidden the rate climbs over a few seconds (the window
    // still holds slow results) to 23.5 Hz. Seen live: hidden, re-shown 9 s later at 23.5 Hz, hidden again 6 s later.
    let hiddenAt = Number.NaN
    const device: Device = (_, hidden, t) => {
      if (!hidden) {
        hiddenAt = Number.NaN
        return 13.2
      }
      if (Number.isNaN(hiddenAt)) hiddenAt = t
      return Math.min(23.5, 14 + (t - hiddenAt) * 3)
    }
    const { kinds, changes } = run(device, 120, { droppable: () => new Set<Capability>(['blendshapes', 'resolution']) })
    expect(kinds.slice(0, 3)).toEqual(['drop blendshapes', 'drop resolution', 'hide'])
    const hide = changes[2]!.t
    const shows = changes.filter((c) => c.change.kind === 'show').map((c) => c.t)
    // Only the probe (30 s) shows them again, then each probe waits twice as long.
    expect(shows[0]!).toBeGreaterThanOrEqual(hide + 30)
    expect(shows.length).toBeLessThanOrEqual(2)
  })

  it('shows hidden filters soon when tracking really gets faster after the hide', () => {
    // Hidden at 10 Hz (12 Hz hidden); at 20 s another load stops: 30 Hz hidden, i.e. 2.5× faster, 25 Hz shown.
    const device: Device = (_, hidden, t) => (t < 20 ? (hidden ? 12 : 10) : hidden ? 30 : 25)
    const { kinds, changes } = run(device, 60)
    expect(kinds.slice(0, 5)).toEqual(['drop blendshapes', 'drop extraFaces', 'drop resolution', 'hide', 'show'])
    expect(changes[4]!.t).toBeLessThan(23)
    expect(kinds.at(-1)).toBe('restore blendshapes') // then everything comes back
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
