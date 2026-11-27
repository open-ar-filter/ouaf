import { expect, test, type Page } from './fixtures.ts'

/**
 * Frame-exact export (#137): `engine.export()` of the `no-face` clip (72 frames, 2.4 s) with
 * `filters/fixtures/capture/` (a yellow overlay square on the left, a magenta one on the right marked
 * `excludeFromCapture`). The MP4 has one frame per clip frame at the clip's times and its duration, whatever the
 * speed of the run; the browser plays and seeks it; the excluded overlay is left out. `cancel()` stops it. The audio
 * of `pesquet-closeup-sound` (AAC) is copied byte for byte, and the browser decodes it.
 */

const CLIP = '/test-media/no-face.mp4'
const FRAMES = 72

type RGB = [number, number, number]
const YELLOW: RGB = [255, 255, 0]
const MAGENTA: RGB = [255, 0, 255]
const near = (c: RGB, expected: RGB, tolerance: number) => c.every((v, i) => Math.abs(v - expected[i]!) <= tolerance)

async function open(page: Page): Promise<void> {
  await page.goto('/engine.html?source=no-face&autostart&filter=/filters/fixtures/capture/')
  await page.waitForFunction(() => ((window.ouaf?.engine.filters.length ?? 0) > 0 && (window.ouaf?.frames ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, { timeout: 60_000 })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
}

interface Exported {
  type: string
  progress: number[]
  sourceEnd: { frames: number; time: number } | undefined
  codec: string
  size: [number, number]
  canvas: [number, number]
  times: number[]
  duration: number
  decoded: number
}

/** Exports the clip (`slowMs`: a busy wait after each frame, a slower device) and reads the file back. */
async function exportClip(page: Page, slowMs: number): Promise<Exported> {
  return page.evaluate(
    async ([clipUrl, slow]) => {
      const { engine, core } = window.ouaf!
      const clip = await core.OfflineVideoSource.open(clipUrl!)
      const progress: number[] = []
      let sourceEnd: { frames: number; time: number } | undefined
      const off = engine.on('sourceEnd', (e) => (sourceEnd = e))
      const job = engine.export(clip, {
        onProgress: (p) => {
          progress.push(p.frame)
          const until = performance.now() + slow!
          while (performance.now() < until) {
            // a slow device
          }
        },
      })
      const blob = await job.done
      off()
      const canvas = engine.canvas
      clip.dispose()
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const track = core.demuxMp4(bytes)
      // Decoded back, frame by frame.
      const back = await core.OfflineVideoSource.open(bytes)
      let decoded = 0
      for (let f = await back.read(); f; f = await back.read()) {
        decoded++
        f.close()
      }
      back.dispose()
      return {
        type: blob.type,
        progress,
        sourceEnd,
        codec: track.codec,
        size: [track.codedWidth, track.codedHeight] as [number, number],
        canvas: [canvas.width, canvas.height] as [number, number],
        times: track.samples.map((s) => s.time).sort((a, b) => a - b),
        duration: track.duration,
        decoded,
      }
    },
    [CLIP, slowMs] as const,
  )
}

test('export gives one frame per clip frame, at the clip times and duration, at any speed', async ({ page }) => {
  await open(page)
  for (const slow of [0, 25]) {
    const e = await exportClip(page, slow)
    expect(e.type, `slow ${slow}`).toBe('video/mp4')
    expect(e.codec).toMatch(/^(avc1|vp09)\./)
    if (slow === 0) test.info().annotations.push({ type: 'codec', description: e.codec })
    expect(e.size).toEqual([e.canvas[0] & ~1, e.canvas[1] & ~1])
    expect(e.progress).toEqual(Array.from({ length: FRAMES }, (_, i) => i + 1))
    expect(e.sourceEnd).toEqual({ frames: FRAMES, time: expect.closeTo((FRAMES - 1) / 30, 6) })
    expect(e.times).toHaveLength(FRAMES)
    e.times.forEach((t, i) => expect(t, `frame ${i}`).toBeCloseTo(i / 30, 4))
    expect(e.duration).toBeCloseTo(FRAMES / 30, 4)
    expect(e.decoded).toBe(FRAMES)
  }
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})

test('the exported MP4 plays and seeks in a <video>, without the excluded overlay', async ({ page }) => {
  await open(page)
  const played = await page.evaluate(async ([clipUrl]) => {
    const { engine, core } = window.ouaf!
    const clip = await core.OfflineVideoSource.open(clipUrl!)
    const blob = await engine.export(clip).done
    clip.dispose()
    const video = document.createElement('video')
    video.muted = true
    video.src = URL.createObjectURL(blob)
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve
      video.onerror = () => reject(new Error(`cannot load the export (${blob.type})`))
    })
    const duration = video.duration
    const seekable = video.seekable.length > 0 ? video.seekable.end(0) : 0
    video.currentTime = 1.2
    await new Promise((resolve, reject) => {
      video.onseeked = resolve
      setTimeout(() => reject(new Error('no seeked event')), 10_000)
    })
    // The frame shown after the seek.
    await new Promise((resolve) => {
      if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(resolve)
      setTimeout(resolve, 500)
    })
    const width = video.videoWidth
    const height = video.videoHeight
    const c = new OffscreenCanvas(width, height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(video, 0, 0)
    const at = (x: number, y: number) => Array.from(ctx.getImageData(Math.round(width / 2 + x * height), Math.round(height / 2 - y * height), 1, 1).data.slice(0, 3))
    URL.revokeObjectURL(video.src)
    return { duration, seekable, currentTime: video.currentTime, left: at(-0.2, 0), right: at(0.2, 0) }
  }, [CLIP] as const)
  expect(played.duration).toBeCloseTo(FRAMES / 30, 1)
  expect(played.seekable).toBeCloseTo(FRAMES / 30, 1)
  expect(played.currentTime).toBeCloseTo(1.2, 1)
  expect(near(played.left as RGB, YELLOW, 50), `left: ${played.left}`).toBe(true)
  expect(near(played.right as RGB, MAGENTA, 80), `right: ${played.right}`).toBe(false)
})

test('cancel stops the export, and another source stops it too', async ({ page }) => {
  await open(page)
  const result = await page.evaluate(async ([clipUrl]) => {
    const { engine, core } = window.ouaf!
    const clip = await core.OfflineVideoSource.open(clipUrl!)
    const reason = (job: { done: Promise<Blob> }) => job.done.then(() => 'resolved', (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`)
    let job = engine.export(clip, { onProgress: (p) => p.frame === 5 && job.cancel() })
    const cancelled = await reason(job)
    job = engine.export(clip, { onProgress: (p) => p.frame === 5 && engine.clearSource() })
    const replaced = await reason(job)
    let invalid = ''
    try {
      engine.export(clip, { keyFrameInterval: 0 })
    } catch (e) {
      invalid = (e as Error).name
    }
    // The clip exports in full after the stopped runs; a cancel after the end does nothing.
    const last = engine.export(clip)
    const blob = await last.done
    last.cancel()
    clip.dispose()
    return { cancelled, replaced, invalid, frames: core.demuxMp4(new Uint8Array(await blob.arrayBuffer())).samples.length }
  }, [CLIP] as const)
  expect(result.cancelled).toBe('aborted: The export was cancelled.')
  expect(result.replaced).toBe('aborted: The export stopped: another source was set.')
  expect(result.invalid).toBe('RangeError')
  expect(result.frames).toBe(FRAMES)
})

test('the playground exports the clip it plays, then plays it again', async ({ page }) => {
  await open(page)
  await page.locator('#export').click()
  await expect(page.locator('#output')).toHaveText(/^export\.mp4 \(video\/mp4, \d+ KB\)$/, { timeout: 60_000 })
  await expect(page.locator('#log')).toContainText(new RegExp(`export: ${FRAMES} frames in [\\d.]+ s, no audio`))
  await expect(page.locator('#export')).toHaveText('Export')
  // Back on the playing clip (live regime).
  await expect.poll(() => page.evaluate(() => window.ouaf!.engine.regime)).toBe('live')
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})

test('the clip audio is copied as is, and the browser decodes it; audio: false leaves it out', async ({ page }) => {
  await open(page)
  const result = await page.evaluate(async () => {
    const { engine, core } = window.ouaf!
    const response = await fetch('/test-media/pesquet-closeup-sound.mp4')
    const source = new Uint8Array(await response.arrayBuffer())
    const clip = await core.OfflineVideoSource.open(source)
    const blob = await engine.export(clip).done
    const silent = await engine.export(clip, { audio: false }).done
    clip.dispose()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const before = core.demuxMp4Audio(source)!
    const after = core.demuxMp4Audio(bytes)!
    const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])
    const sameSamples = before.samples.length === after.samples.length && before.samples.every((s, i) => {
      const t = after.samples[i]!
      return Math.abs(s.time - t.time) < 1e-4 && same(source.subarray(s.offset, s.offset + s.size), bytes.subarray(t.offset, t.offset + t.size))
    })
    // Decoded back: the sound lasts as long as the video.
    let decoded = 0
    let decodeError = ''
    try {
      const context = new OfflineAudioContext(2, 48000, 48000)
      decoded = (await context.decodeAudioData(await blob.arrayBuffer())).duration
    } catch (error) {
      decodeError = String(error)
    }
    return {
      info: clip.audio,
      samples: [before.samples.length, after.samples.length],
      sameEntry: same(before.sampleEntry, after.sampleEntry),
      sameSamples,
      frames: core.demuxMp4(bytes).samples.length,
      duration: core.demuxMp4(bytes).duration,
      decoded,
      decodeError,
      silent: core.demuxMp4Audio(new Uint8Array(await silent.arrayBuffer())),
    }
  })
  expect(result.info).toEqual({ format: 'mp4a', channels: 2, sampleRate: 48000, duration: expect.closeTo(3.1, 2) })
  expect(result.samples[1]).toBe(result.samples[0])
  expect(result.sameEntry).toBe(true)
  expect(result.sameSamples).toBe(true)
  expect(result.frames).toBe(93)
  expect(result.duration).toBeCloseTo(3.1, 4)
  expect(result.decodeError).toBe('')
  expect(result.decoded).toBeCloseTo(3.1, 1)
  expect(result.silent).toBeUndefined()
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})

test('an audio track that cannot be copied is left out with a warning', async ({ page }) => {
  await open(page)
  const result = await page.evaluate(async () => {
    const { engine, core } = window.ouaf!
    const source = new Uint8Array(await (await fetch('/test-media/pesquet-closeup-sound.mp4')).arrayBuffer())
    // The AAC sample description renamed to a codec the export does not copy.
    const at = new TextDecoder('latin1').decode(source).indexOf('mp4a')
    source.set([0x74, 0x77, 0x6f, 0x73], at) // "twos"
    const clip = await core.OfflineVideoSource.open(source)
    const warnings: string[] = []
    const off = engine.on('warning', (w) => warnings.push(w.message))
    const blob = await engine.export(clip).done
    off()
    clip.dispose()
    return { audio: clip.audio, audioError: clip.audioError, warnings, copied: core.demuxMp4Audio(new Uint8Array(await blob.arrayBuffer())) }
  })
  expect(result.audio).toBeUndefined()
  expect(result.audioError).toBe('Unsupported audio codec "twos" (supported: AAC, Opus, FLAC).')
  // Only the audio warning: a slow CI machine may add a performance one.
  expect(result.warnings.filter((w) => w.includes('audio'))).toEqual([expect.stringContaining('the audio track cannot be copied (Unsupported audio codec "twos"')])
  expect(result.copied).toBeUndefined()
})
