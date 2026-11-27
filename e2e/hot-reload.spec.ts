import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures.ts'

/**
 * Hot reload of filters in the playground (#36): the dev server packs a `filter.ts` folder in memory and, when one of
 * its files changes, the engine page reloads it in place (`apps/playground/vite.config.ts`, `devFilters`).
 */

const filterTs = (o: { id?: string; name: string; label: string }) => `import { defineFilter } from '@ouaf/spec'

export default defineFilter({
  id: '${o.id ?? 'hot-reload'}',
  name: '${o.name}',
  version: '1.0.0',
  license: 'CC0-1.0',
  requires: { face: true },
  params: {
    label: { type: 'string', default: '${o.label}' },
    size: { type: 'number', default: 0.7, min: 0.2, max: 1.5 },
  },
  layers: [{ type: 'text', id: 'label', text: { param: 'label' }, anchor: 'forehead', offset: [0, 0.9, 0], size: { param: 'size' }, color: '#00ff00' }],
})
`

test('a filter.ts folder loads, reloads in place when it changes, and a broken version shows its report', async ({ page }, info) => {
  const name = `hmr-${info.workerIndex}-${Date.now()}`
  const dir = join('filters', 'tmp', name)
  await mkdir(dir, { recursive: true })
  const write = (o: Parameters<typeof filterTs>[0]) => writeFile(join(dir, 'filter.ts'), filterTs(o))
  try {
    await write({ name: 'First', label: 'ONE' })
    await page.goto(`/engine.html?source=pesquet-talk&autostart&filter=/filters/tmp/${name}/`)
    await page.waitForFunction(() => window.ouaf?.engine.filters.length === 1)
    const state = () => page.evaluate(() => {
      const f = window.ouaf!.engine.filters[0]!
      return { name: f.manifest.name, params: f.params, reloads: window.ouaf!.reloads }
    })
    expect(await state()).toMatchObject({ name: 'First', params: { label: 'ONE', size: 0.7 }, reloads: 0 })
    // A value set in the page survives the reload; a default the author changes shows.
    await page.evaluate(() => window.ouaf!.engine.filters[0]!.setParam('size', 1.2, { transition: 0 }))

    await write({ name: 'Second', label: 'TWO' })
    await page.waitForFunction(() => window.ouaf!.reloads === 1)
    // The kept values are set on the new version, applied at the start of its first frame (spec §9).
    await page.waitForFunction(() => window.ouaf!.engine.filters[0]!.params.size === 1.2)
    expect(await state()).toMatchObject({ name: 'Second', params: { label: 'TWO', size: 1.2 } })
    await expect(page.locator('#banner')).toBeHidden()

    await write({ id: 'Bad Id', name: 'Broken', label: 'TWO' })
    await expect(page.locator('#banner')).toBeVisible()
    await expect(page.locator('#banner')).toContainText('did not load; the previous version stays on screen')
    await expect(page.locator('#banner')).toContainText('error [format] Invalid format: "Bad Id"')
    expect(await state()).toMatchObject({ name: 'Second', reloads: 1 })

    await write({ name: 'Third', label: 'TWO' })
    await page.waitForFunction(() => window.ouaf!.reloads === 2)
    await page.waitForFunction(() => window.ouaf!.engine.filters[0]!.params.size === 1.2)
    await expect(page.locator('#banner')).toBeHidden()
    expect(await state()).toMatchObject({ name: 'Third', params: { size: 1.2 } })
    expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
