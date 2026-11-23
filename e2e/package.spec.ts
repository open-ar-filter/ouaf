import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { readZipEntries, zipEntryData } from '../packages/spec/src/zip.ts'

/**
 * `.ouaf` packages in the engine (#135): fixtures packed with the real `ouaf pack` command load from a URL, a `File`
 * and bytes, and render the same frames and give the same script events as their source folder, on a file source
 * (every frame, same seed). The playground opens packages from `?filter=` and its file picker, and a broken package
 * fails with a typed error.
 */

const ROOT = join(import.meta.dirname, '..')
const CLIP = '/test-media/pesquet-closeup-360.mp4'
/** Fixtures with images (PNG, WebP, inline SVG, emoji), a packed-alpha video, a GLB, and a script. */
const FIXTURES = ['sticker', 'model', 'script-grade'] as const
type Fixture = (typeof FIXTURES)[number]
const packed = new Map<Fixture, Buffer>()

test.beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ouaf-e2e-pack-'))
  try {
    for (const name of FIXTURES) {
      const out = join(dir, `${name}.ouaf`)
      execFileSync(process.execPath, [join(ROOT, 'packages/cli/src/bin.ts'), 'pack', join(ROOT, 'filters/fixtures', name), '-o', out], { cwd: ROOT, stdio: 'pipe' })
      packed.set(name, readFileSync(out))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Serves the packages at `/packed/<fixture>.ouaf` (and `bytes` at `/packed/broken.ouaf`). */
async function serve(page: Page, broken?: Uint8Array): Promise<void> {
  // A predicate, not a glob: a glob would also match the page URL whose query holds `filter=/packed/….ouaf`.
  await page.route((url) => /^\/packed\/[\w-]+\.ouaf$/.test(url.pathname), (route) => {
    const name = new URL(route.request().url()).pathname.slice('/packed/'.length).replace(/\.ouaf$/, '')
    const body = name === 'broken' ? broken : packed.get(name as Fixture)
    return body ? route.fulfill({ body: Buffer.from(body), contentType: 'application/zip' }) : route.fulfill({ status: 404, body: 'Not found' })
  })
}

async function open(page: Page, query = ''): Promise<void> {
  await serve(page)
  await page.goto(`/engine.html?seed=7${query}`)
  await page.waitForFunction(() => !!window.ouaf)
}

const errors = (page: Page) => page.evaluate(() => window.ouaf!.errors)

/** A filter of a stack: its URL, loaded as is, or fetched and given to the engine as a `File` or bytes. */
interface Item {
  url: string
  as: 'url' | 'file' | 'bytes'
  params?: Record<string, unknown>
}

interface Run {
  ids: string[]
  events: Array<[string, unknown]>
  /** Worst mean absolute difference per channel (0–255) between the frames of this run and of the reference run. */
  diff: number
  /** Mean green level of the last frame. */
  green: number
}

/**
 * Loads each stack of `stacks` in turn and renders the first frames of the clip with `pushFrame`, reading the canvas
 * after each; the frames stay in the page, which compares them with those of the `ref` stack (the first one). With
 * `tint`, the script then gets a `tint` message and a few more frames are rendered once it answered.
 */
async function render(page: Page, stacks: Record<string, Item[]>, tint: boolean): Promise<Record<string, Run>> {
  return page.evaluate(
    async ([clip, stacks, tint]) => {
      const { engine, core } = window.ouaf!
      const W = 90
      const H = 160
      const ctx = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!
      const source = await core.OfflineVideoSource.open(clip)
      const events: Array<[string, unknown]> = []
      for (const name of ['ready', 'tinted']) engine.on(`filter:${name}`, (e) => events.push([name, e.data]))
      const push = async (frames: Uint8ClampedArray[], count: number) => {
        for (let i = 0; i < count; i++) {
          const frame = (await source.read())!
          await engine.pushFrame(frame.image, frame.time)
          frame.close()
          ctx.drawImage(engine.canvas, 0, 0, W, H)
          frames.push(ctx.getImageData(0, 0, W, H).data)
        }
      }
      const worst = (a: Uint8ClampedArray[], b: Uint8ClampedArray[]) => {
        if (a.length !== b.length) return Infinity
        let max = 0
        a.forEach((fa, f) => {
          const fb = b[f]!
          let sum = 0
          for (let i = 0; i < fa.length; i++) sum += Math.abs(fa[i]! - fb[i]!)
          max = Math.max(max, sum / fa.length)
        })
        return max
      }
      const runs: Record<string, Run> = {}
      let ref: Uint8ClampedArray[] | undefined
      for (const [key, inputs] of Object.entries(stacks)) {
        source.restart()
        events.length = 0
        const srcs = await Promise.all(inputs.map(async ({ url, as, params }) => {
          let src: string | File | Uint8Array = url
          if (as !== 'url') {
            const blob = await (await fetch(url)).blob()
            src = as === 'file' ? new File([blob], url.split('/').pop()!) : new Uint8Array(await blob.arrayBuffer())
          }
          return params ? { src, params } : src
        }))
        const handles = await engine.setFilters(srcs)
        const frames: Uint8ClampedArray[] = []
        await push(frames, 12)
        if (tint) {
          handles[0]!.send('tint', '#ff0000')
          const t0 = performance.now()
          while (!events.some(([n]) => n === 'tinted') && performance.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50))
          await push([], 2) // the layer takes the script's values at the next frame
          await push(frames, 4)
        }
        ref ??= frames
        const last = frames.at(-1)!
        let green = 0
        for (let i = 1; i < last.length; i += 4) green += last[i]!
        runs[key] = { ids: handles.map((h) => h.id), events: events.slice(), diff: worst(ref, frames), green: green / (last.length / 4) }
      }
      await engine.setFilters([])
      return runs
    },
    [CLIP, stacks, tint] as const,
  )
}

test('a packed filter renders the same frames as its folder, from a URL, a File and bytes', async ({ page }) => {
  await open(page)
  const stack = (as: 'url' | 'file' | 'bytes', folder = false) =>
    (['sticker', 'model'] as const).map((name): Item => ({
      url: folder ? `/filters/fixtures/${name}/` : `/packed/${name}.ouaf`,
      as,
      // The flame video plays in real time, not in media time: hidden, so that the frames do not depend on timing.
      ...(name === 'sticker' ? { params: { flame: false } } : {}),
    }))
  const runs = await render(page, {
    folder: stack('url', true),
    none: [],
    url: stack('url'),
    file: stack('file'),
    bytes: stack('bytes'),
  }, false)
  expect(await errors(page)).toEqual([])
  const { none, folder, url, file, bytes } = runs as Record<string, Run>
  for (const run of [folder, url, file, bytes]) expect(run!.ids).toEqual(['sticker', 'model'])
  // The filters draw something (stickers, models on the face)…
  expect(none!.diff).toBeGreaterThan(1)
  // …and the packages draw the same: within the bound `sources.spec.ts` sets for two runs of the same filter (two
  // runs of the folder differ by about 0.1 here, as do the packages).
  for (const run of [url, file, bytes]) expect(run!.diff).toBeLessThan(0.5)
})

test('a packed script behaves as its folder: same events, same frames before and after a message', async ({ page }) => {
  await open(page)
  const runs = await render(page, {
    folder: [{ url: '/filters/fixtures/script-grade/', as: 'url' }],
    url: [{ url: '/packed/script-grade.ouaf', as: 'url' }],
    file: [{ url: '/packed/script-grade.ouaf', as: 'file' }],
  }, true)
  expect(await errors(page)).toEqual([])
  const { folder, url, file } = runs as Record<string, Run>
  // `ready` carries f.random(): the same seeded draw (seed 7) whatever the source of the filter.
  expect(folder!.events).toEqual([['ready', { random: expect.any(Number) }], ['tinted', 1]])
  for (const run of [url, file]) {
    expect(run!.events).toEqual(folder!.events)
    expect(run!.diff).toBeLessThan(0.5)
  }
  // The tint is in the frames: red, no green or blue.
  expect(folder!.green).toBeLessThan(3)
})

test('the playground opens a package from ?filter= and from its file picker', async ({ page }) => {
  await open(page, '&source=pesquet-closeup&autostart&filter=/packed/script-grade.ouaf')
  await page.waitForFunction(() => (window.ouaf!.engine.filters.length > 0 && window.ouaf!.frames > 0) || window.ouaf!.errors.length > 0, undefined, { timeout: 60_000 })
  expect(await errors(page)).toEqual([])
  expect(await page.evaluate(() => window.ouaf!.engine.filters.map((f) => f.id))).toEqual(['script-grade'])
  await page.locator('#open').setInputFiles({ name: 'sticker.ouaf', mimeType: 'application/zip', buffer: packed.get('sticker')! })
  await expect.poll(() => page.evaluate(() => window.ouaf!.engine.filters.map((f) => f.id)), { timeout: 30_000 }).toEqual(['script-grade', 'sticker'])
  expect(await errors(page)).toEqual([])
  await expect(page.locator('#log')).toContainText('sticker (sticker.ouaf)')
})

test('a broken package fails with a typed error and leaves the stack unchanged', async ({ page }) => {
  // A byte of an asset's data flipped: the archive opens, the asset fails its CRC check (or does not inflate) when
  // preloaded.
  const archive = new Uint8Array(packed.get('sticker')!)
  const disc = readZipEntries(archive).find((e) => e.name === 'assets/disc.png')!
  const data = zipEntryData(archive, disc)
  data[data.length >> 1]! ^= 0xff
  await serve(page, archive)
  await page.goto('/engine.html')
  await page.waitForFunction(() => !!window.ouaf)
  const result = await page.evaluate(async () => {
    const { engine } = window.ouaf!
    const describe = (e: unknown) => {
      const error = e as Error & { code?: string; reason?: string; cause?: Error & { code?: string; reason?: string } }
      return { name: error.name, code: error.code, reason: error.reason, message: error.message, cause: error.cause && { name: error.cause.name, reason: error.cause.reason } }
    }
    const corrupt = await engine.addFilter('/packed/broken.ouaf').then(() => undefined, describe)
    const notZip = await engine.addFilter(new Blob(['not a zip'])).then(() => undefined, describe)
    return { corrupt, notZip, filters: engine.filters.length }
  })
  expect(result.filters).toBe(0)
  expect(result.corrupt).toMatchObject({ name: 'AssetError', code: 'asset', cause: { name: 'PackageError', reason: 'zip-invalid' } })
  expect(result.corrupt!.message).toContain('assets/disc.png')
  expect(result.notZip).toMatchObject({ name: 'PackageError', code: 'invalid-package', reason: 'zip-invalid' })
})
