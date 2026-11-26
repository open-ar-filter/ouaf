import { expect, test, type Page } from './fixtures.ts'

/**
 * The refusals of the code that only runs in a browser, through the public API on `/engine.html`: engine options and
 * plugins, sources that cannot be read, video files that cannot be opened. Each one is an explicit error, and the
 * engine keeps running after it.
 */

const PROBE = '/filters/fixtures/probe/'
const CLIP = '/test-media/pesquet-closeup-360.mp4'

async function open(page: Page): Promise<void> {
  await page.goto('/engine.html')
  await page.waitForFunction(() => !!window.ouaf)
}

/** In the page: `name:code:message` of what `fn` throws or rejects with, `ok` otherwise. */
const ATTEMPT = `async (fn) => {
  try {
    await fn()
    return 'ok'
  } catch (e) {
    return e.name + ':' + e.code + ':' + e.message
  }
}`
type Attempt = (fn: () => unknown) => Promise<string>

test('engine options and plugins are checked when they are given', async ({ page }) => {
  await open(page)
  const result = await page.evaluate(async (attemptSource) => {
    const attempt = (0, eval)(`(${attemptSource})`) as Attempt
    const { core } = window.ouaf!
    const make = (options: object = {}) => new core.Engine({ canvas: document.createElement('canvas'), assetsBaseUrl: '/builtins', ...options })
    // No built-in plugin, no device adaptation, a fixed size: a bare engine still renders a pushed frame.
    const bare = make({ builtins: false, adaptation: false, width: 64, height: 48 })
    const frame = new OffscreenCanvas(32, 32)
    frame.getContext('2d')!.fillRect(0, 0, 32, 32)
    await bare.pushFrame(frame, 0)
    const size = [bare.canvas.width, bare.canvas.height]
    const plugin = { name: 'edge-case', version: '1.0.0' }
    bare.use(plugin)
    const out = {
      baseUrl: bare.assetsBaseUrl,
      size,
      maxFacesZero: await attempt(() => make({ maxFaces: 0 })),
      maxFacesMany: await attempt(() => make({ maxFaces: 17 })),
      maxFacesHalf: await attempt(() => make({ maxFaces: 1.5 })),
      scale: await attempt(() => make({ scale: 0 })),
      widthOnly: await attempt(() => make({ width: 64 })),
      pluginName: await attempt(() => bare.use({ name: 'Not A Name', version: '1.0.0' })),
      pluginTwice: await attempt(() => bare.use(plugin)),
      // A third-party plugin prefixes what it adds to the vocabulary with its name.
      pluginVocabulary: await attempt(() => bare.use({ name: 'edge-vocabulary', version: '1.0.0', vocabulary: { layers: [{ type: 'unprefixed' } as never] } })),
      layerTwice: await attempt(() =>
        bare.use({
          name: 'edge-twice',
          version: '1.0.0',
          vocabulary: { layers: [{ type: 'edge-twice:thing' } as never] },
          setup: (api) => {
            api.registerLayerType({ type: 'edge-twice:thing' } as never)
            api.registerLayerType({ type: 'edge-twice:thing' } as never)
          },
        }),
      ),
      undeclaredLayer: await attempt(() => bare.use({ name: 'edge-layer', version: '1.0.0', setup: (api) => api.registerLayerType({ type: 'edge:none' } as never) })),
      lateTracker: await attempt(() => bare.use({ name: 'edge-tracker', version: '1.0.0', setup: (api) => api.registerTracker({} as never) })),
      tuned: await attempt(() => make({ adaptation: { floorHz: 10 }, plugins: [plugin] }).dispose()),
    }
    bare.dispose()
    return out
  }, ATTEMPT)
  expect(result.baseUrl).toMatch(/\/builtins\/$/)
  expect(result.size).toEqual([64, 48])
  expect(result.maxFacesZero).toMatch(/^RangeError:.*maxFaces/)
  expect(result.maxFacesMany).toMatch(/^RangeError:.*maxFaces/)
  expect(result.maxFacesHalf).toMatch(/^RangeError:.*maxFaces/)
  expect(result.scale).toMatch(/^RangeError:.*scale must be positive/)
  expect(result.widthOnly).toMatch(/^RangeError:.*both width and height/)
  expect(result.pluginName).toMatch(/^OuafError:plugin-conflict:Invalid plugin name/)
  expect(result.pluginTwice).toMatch(/^OuafError:plugin-conflict:.*already installed/)
  expect(result.pluginVocabulary).toMatch(/^OuafError:plugin-conflict:.*must prefix/)
  expect(result.layerTwice).toMatch(/^OuafError:plugin-conflict:.*already registered/)
  expect(result.undeclaredLayer).toMatch(/^OuafError:plugin-conflict:.*without declaring it/)
  expect(result.lateTracker).toMatch(/^OuafError:plugin-conflict:.*when the engine is created/)
  expect(result.tuned).toBe('ok')
})

test('sources that cannot be read are refused, and the engine goes on with the next one', async ({ page }) => {
  await open(page)
  const result = await page.evaluate(
    async ({ attemptSource, probe, clip }) => {
      const attempt = (0, eval)(`(${attemptSource})`) as Attempt
      const { core, engine } = window.ouaf!
      const handle = await engine.addFilter(probe)
      const offline = await core.OfflineVideoSource.open(clip)
      offline.dispose()
      const file = await core.VideoFileSource.open(clip)
      file.dispose()
      const broken = new Image()
      broken.src = '/test-media/no-such-image.png'
      const frame = new OffscreenCanvas(32, 32)
      frame.getContext('2d')!.fillRect(0, 0, 32, 32)
      const out = {
        unsupported: await attempt(() => engine.setSource({} as never)),
        number: await attempt(() => engine.setSource(42 as never)),
        nothing: await attempt(() => engine.setSource(null as never)),
        disposedOffline: await attempt(() => engine.setSource(offline)),
        disposedFile: await attempt(() => engine.setSource(file)),
        brokenImage: await attempt(() => engine.setSource(broken)),
        notAFrame: await attempt(() => engine.pushFrame({} as never, 0)),
        infiniteTime: await attempt(() => engine.pushFrame(frame, Number.POSITIVE_INFINITY)),
        // A removed filter's handle does nothing more, without an error.
        removed: await attempt(() => {
          handle.remove()
          handle.remove()
          handle.moveTo(0)
        }),
        filters: engine.filters.length,
        // After all the refusals, a frame still renders.
        next: await attempt(() => engine.pushFrame(frame, 0)),
      }
      return out
    },
    { attemptSource: ATTEMPT, probe: PROBE, clip: CLIP },
  )
  expect(result.unsupported).toMatch(/^IncompatibleSourceError:incompatible-source:Unsupported source/)
  expect(result.number).toMatch(/^IncompatibleSourceError:incompatible-source:Unsupported source/)
  expect(result.nothing).toMatch(/^IncompatibleSourceError:incompatible-source:Unsupported source: null/)
  expect(result.disposedOffline).toMatch(/^IncompatibleSourceError:incompatible-source:.*offline video source has been disposed/)
  expect(result.disposedFile).toMatch(/^IncompatibleSourceError:incompatible-source:.*has been disposed/)
  expect(result.brokenImage).toMatch(/^IncompatibleSourceError:incompatible-source:.*could not be loaded or decoded/)
  expect(result.notAFrame).toMatch(/^IncompatibleSourceError:incompatible-source:pushFrame needs/)
  expect(result.infiniteTime).toMatch(/^RangeError:.*finite/)
  expect(result.removed).toBe('ok')
  expect(result.filters).toBe(0)
  expect(result.next).toBe('ok')
})

test('an offline video opens from a URL, bytes, a buffer or a file, and says why it cannot', async ({ page }) => {
  await open(page)
  const result = await page.evaluate(
    async ({ attemptSource, clip }) => {
      const attempt = (0, eval)(`(${attemptSource})`) as Attempt
      const { OfflineVideoSource } = window.ouaf!.core
      const buffer = await (await fetch(clip)).arrayBuffer()
      const bytes = new Uint8Array(buffer)
      /** Opens, reads the first frame, and reports the size and the frame's time. */
      const first = async (input: Parameters<typeof OfflineVideoSource.open>[0]) => {
        const source = await OfflineVideoSource.open(input, { rate: Infinity })
        const frame = await source.read()
        const out = { label: source.label, width: source.width, height: source.height, time: frame?.time }
        frame?.close()
        source.dispose()
        source.dispose()
        return { ...out, afterDispose: await source.read() }
      }
      const source = await OfflineVideoSource.open(bytes)
      const rate = await attempt(() => {
        source.rate = 0
      })
      source.rate = 2
      const out = {
        url: await first(new URL(clip, location.href)),
        bytes: await first(bytes),
        buffer: await first(buffer.slice(0)),
        file: await first(new File([buffer], 'clip.mp4')),
        rate,
        newRate: source.rate,
        garbage: await attempt(() => OfflineVideoSource.open(new Uint8Array([1, 2, 3, 4]))),
        garbageFile: await attempt(() => OfflineVideoSource.open(new File([new Uint8Array(16)], 'empty.mp4'))),
        missing: await attempt(() => OfflineVideoSource.open('/test-media/no-such-clip.mp4')),
        html: await attempt(() => OfflineVideoSource.open('/no-such-page.mp4')),
        offline: await attempt(() => OfflineVideoSource.open(clip, { fetch: () => Promise.reject(new TypeError('offline')) })),
      }
      source.dispose()
      return out
    },
    { attemptSource: ATTEMPT, clip: CLIP },
  )
  for (const opened of [result.url, result.bytes, result.buffer, result.file]) {
    expect(opened).toMatchObject({ width: 360, height: 640, time: 0, afterDispose: null })
  }
  expect(result.url.label).toMatch(/pesquet-closeup-360\.mp4$/)
  expect(result.file.label).toBe('clip.mp4')
  expect(result.rate).toMatch(/^RangeError:.*rate must be positive/)
  expect(result.newRate).toBe(2)
  expect(result.garbage).toMatch(/^VideoFileError:.*Cannot read/)
  expect(result.garbageFile).toMatch(/^VideoFileError:.*Cannot read empty\.mp4/)
  expect(result.missing).toMatch(/^VideoFileError:.*HTTP 404/)
  expect(result.html).toMatch(/^VideoFileError:.*HTML page/)
  expect(result.offline).toMatch(/^VideoFileError:.*Cannot load .*offline/)
})

test('a script sandbox ignores messages that are not its own; one that cannot start stops its script only', async ({ page }) => {
  await open(page)
  const SCRIPTED = '/filters/fixtures/script-grade/'
  const sandboxes = () => page.evaluate(() => document.querySelectorAll('iframe[title="ouaf script sandbox"]').length)
  // Messages of the sandbox protocol sent by the page itself while the sandbox starts: not from the iframe, ignored.
  await page.evaluate(async (url) => {
    const forge = setInterval(() => {
      window.postMessage({ t: 'ouaf:failed', message: 'forged' }, '*')
      window.postMessage({ t: 'ouaf:started' }, '*')
      window.postMessage(null, '*')
    }, 1)
    ;(window as unknown as { stopForging: () => void }).stopForging = () => clearInterval(forge)
    await window.ouaf!.engine.addFilter(url)
  }, SCRIPTED)
  await expect.poll(sandboxes, { timeout: 30_000 }).toBe(1)
  await page.evaluate(() => (window as unknown as { stopForging: () => void }).stopForging())
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])

  // A page policy that forbids workers: the `srcdoc` sandbox inherits it and never gets its own. The script is given
  // up after 10 s, with an error; the filter itself is added and the first sandbox is untouched.
  await page.evaluate(async (url) => {
    const meta = document.createElement('meta')
    meta.httpEquiv = 'Content-Security-Policy'
    meta.content = "worker-src 'none'"
    document.head.append(meta)
    await window.ouaf!.engine.addFilter(url)
  }, SCRIPTED)
  await expect.poll(() => page.evaluate(() => window.ouaf!.errors.join('\n')), { timeout: 30_000 }).toMatch(/script-grade.*the script was stopped: its sandbox was not ready/)
  expect(await sandboxes()).toBe(1)
  expect(await page.evaluate(() => window.ouaf!.engine.filters.length)).toBe(2)
})

test('a <video> element is a live source; a looping offline video starts again from its first frame', async ({ page }) => {
  await open(page)
  const result = await page.evaluate(
    async ({ probe, clip }) => {
      const { core, engine } = window.ouaf!
      await engine.addFilter(probe)
      const drawn = async (count: number) => {
        const from = window.ouafProbe?.length ?? 0
        while ((window.ouafProbe?.length ?? 0) < from + count) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const video = document.createElement('video')
      video.src = clip
      video.muted = true
      video.loop = true
      await video.play()
      await engine.setSource(video)
      await drawn(3)
      const live = engine.regime

      // The engine reads a looping source for ever: the frames it is given are noted here, until the second round.
      engine.filters[0]!.remove()
      const source = await core.OfflineVideoSource.open(clip, { loop: true, rate: Infinity })
      const read = source.read.bind(source)
      const times: Array<number | null> = []
      let ended = 0
      engine.on('sourceEnd', () => ended++)
      const secondRound = new Promise<void>((resolve) => {
        source.read = async () => {
          const frame = await read()
          times.push(frame ? frame.time : null)
          if (frame && times.includes(null)) resolve()
          return frame
        }
      })
      await engine.setSource(source)
      await secondRound
      engine.clearSource()
      const end = times.indexOf(null)
      return { live, file: engine.regime, videoPlaying: !video.paused, frames: end, restart: times[end + 1], ended, errors: window.ouaf!.errors }
    },
    { probe: PROBE, clip: CLIP },
  )
  // The <video> is the host's: the engine leaves it playing when it stops being the source.
  expect(result).toEqual({ live: 'live', file: 'file', videoPlaying: true, frames: 93, restart: 0, ended: 0, errors: [] })
})
