import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createFaceFrame, type FaceFrame } from '../src/face.ts'
import { demuxMp4, Mp4Error } from '../src/mp4.ts'
import { deriveSeed, FILE_SOURCE_SEED, SeededRandom, checkSeed } from '../src/random.ts'
import { TrackingHub } from '../src/engine/tracking.ts'
import type { FrameTracker } from '../src/engine/plugin.ts'

const clip = (name: string) => new Uint8Array(readFileSync(new URL(`../../../test-media/${name}`, import.meta.url)))

describe('demuxMp4', () => {
  it('lists the frames of an H.264 clip with B-frames, in decoding order, at their presentation times', () => {
    const track = demuxMp4(clip('pesquet-closeup-360.mp4'))
    expect(track.codec).toBe('avc1.4d401e')
    expect(track.description?.[0]).toBe(1) // avcC configurationVersion
    expect([track.codedWidth, track.codedHeight, track.rotation]).toEqual([360, 640, 0])
    expect(track.samples).toHaveLength(93)
    expect(track.duration).toBeCloseTo(3.1, 9)
    // Decoding order differs from presentation order (ffprobe: pts 0, 0.1333, 0.0667, 0.0333, 0.1…).
    expect(track.samples.slice(0, 5).map((s) => Math.round(s.time * 30))).toEqual([0, 4, 2, 1, 3])
    expect(track.samples[0]).toMatchObject({ offset: 1936, size: 12731, sync: true })
    expect(track.samples.filter((s) => s.sync).length).toBeGreaterThan(0)
    const times = track.samples.map((s) => s.time).sort((a, b) => a - b)
    times.forEach((t, i) => expect(t).toBeCloseTo(i / 30, 9))
  })

  it('reads every committed clip', () => {
    for (const name of ['two-faces.mp4', 'pesquet-talk-360.mp4', 'no-face.mp4']) {
      const track = demuxMp4(clip(name))
      expect(track.codec).toMatch(/^avc1\./)
      expect(track.samples.length).toBeGreaterThan(60)
    }
  })

  it('rejects what it cannot read with an explicit error', () => {
    expect(() => demuxMp4(new Uint8Array(64))).toThrow(Mp4Error)
    expect(() => demuxMp4(new TextEncoder().encode('<!doctype html><html></html>'))).toThrow(/not an MP4/)
    const truncated = clip('no-face.mp4').slice(0, 5000)
    expect(() => demuxMp4(truncated)).toThrow(Mp4Error)
  })
})

describe('SeededRandom', () => {
  it('gives the same sequence for the same seed, in [0, 1)', () => {
    const a = new SeededRandom(42)
    const b = new SeededRandom(42)
    const xs = Array.from({ length: 1000 }, () => a.next())
    expect(Array.from({ length: 1000 }, () => b.next())).toEqual(xs)
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length
    expect(mean).toBeGreaterThan(0.45)
    expect(mean).toBeLessThan(0.55)
    a.reseed(42)
    expect(a.next()).toBe(xs[0])
    expect(new SeededRandom(43).next()).not.toBe(xs[0])
  })

  it('derives independent seeds per filter and layer', () => {
    const seeds = new Set([deriveSeed(FILE_SOURCE_SEED, 'a'), deriveSeed(FILE_SOURCE_SEED, 'b'), deriveSeed(FILE_SOURCE_SEED, 'a', 0), deriveSeed(FILE_SOURCE_SEED, 'a', 1), deriveSeed(1, 'a')])
    expect(seeds.size).toBe(5)
    expect(deriveSeed(7, 'ab', 'c')).not.toBe(deriveSeed(7, 'a', 'bc'))
    expect(deriveSeed(7, 'x')).toBe(deriveSeed(7, 'x'))
  })

  it('checks host seeds', () => {
    expect(checkSeed(0)).toBe(0)
    expect(checkSeed(4294967295)).toBe(4294967295)
    expect(() => checkSeed(-1)).toThrow(RangeError)
    expect(() => checkSeed(1.5)).toThrow(RangeError)
  })
})

/** A tracker that writes `count = mediaTime` and resolves when the test says so. */
function asyncTracker() {
  const pending: Array<() => void> = []
  const calls: string[] = []
  const tracker: FrameTracker = {
    description: 'fake',
    track(_input, _ts, mediaTime, out: FaceFrame) {
      calls.push(`track ${mediaTime}`)
      return new Promise<void>((resolve) => {
        pending.push(() => {
          out.count = 1
          out.mediaTime = mediaTime
          resolve()
        })
      })
    },
    trackImage(_input, mediaTime, out) {
      calls.push(`image ${mediaTime}`)
      out.count = 1
      out.mediaTime = mediaTime
    },
    reset: () => void calls.push('reset'),
    configure: () => {},
    dispose: () => {},
  }
  return { tracker, pending, calls }
}

async function hub(tracker: FrameTracker) {
  const onError = vi.fn()
  const h = new TrackingHub({ impl: { id: 'fake', create: async () => tracker }, env: { assetsBaseUrl: '/', warn: () => {} }, maxFaces: 1, modifiers: [], onError })
  await h.setNeeds({ face: true, blendshapes: false })
  return { h, onError }
}

const input = {} as HTMLCanvasElement

describe('TrackingHub (file sources)', () => {
  it('track() waits for the call in flight, then resolves with this frame as the front result', async () => {
    const { tracker, pending, calls } = asyncTracker()
    const { h } = await hub(tracker)
    h.submit(input, 0, 1) // a live submit still in flight
    let done = false
    const tracked = h.track(input, 2000, 2).then(() => (done = true))
    await Promise.resolve()
    expect(calls).toEqual(['track 1'])
    pending.shift()!()
    await vi.waitFor(() => expect(calls).toEqual(['track 1', 'track 2']))
    expect(done).toBe(false)
    pending.shift()!()
    await tracked
    expect(h.faces.mediaTime).toBe(2)
    expect(h.results).toBe(2)
  })

  it('tracks still images with trackImage and resets the tracker on demand', async () => {
    const { tracker, calls } = asyncTracker()
    const { h } = await hub(tracker)
    await h.resetTracker()
    await h.track(input, 0, 0, true)
    expect(calls).toEqual(['reset', 'image 0'])
    expect(h.faces.count).toBe(1)
  })

  it('clear() empties the result and drops a call in flight', async () => {
    const { tracker, pending } = asyncTracker()
    const { h } = await hub(tracker)
    h.submit(input, 0, 1)
    const before = h.results
    h.clear()
    expect(h.faces.count).toBe(0)
    pending.shift()!()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.faces.count).toBe(0) // the old source's result is not shown
    expect(h.results).toBe(before + 1)
  })

  it('reports a failing track() and resolves', async () => {
    const tracker: FrameTracker = { description: 'x', track: () => Promise.reject(new Error('boom')), configure: () => {}, dispose: () => {} }
    const { h, onError } = await hub(tracker)
    await h.track(input, 0, 0)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }))
    await h.track(input, 1, 1) // not stuck busy
    expect(onError).toHaveBeenCalledTimes(2)
  })
})
