import { expect, test, type Page } from './fixtures.ts'

/**
 * The stack editor of the playground (#36): the "Add a filter" menu, the rows (top of the stack first) that move,
 * turn on and off and remove filters, the params of the selected filter, and the stack kept in the URL.
 */

const ids = (page: Page) => page.evaluate(() => window.ouaf!.engine.filters.map((f) => `${f.id}${f.enabled ? '' : ' (off)'}`))
const rows = (page: Page) => page.locator('#stack-list li.filter .name b').allTextContents()
const query = (page: Page) => new URL(page.url()).search
const row = (page: Page, id: string) => page.locator('#stack-list li.filter', { has: page.locator('.name b', { hasText: new RegExp(`^${id}$`) }) })

async function add(page: Page, url: string): Promise<void> {
  await page.locator('#add > summary').click()
  await page.locator(`#add button[data-url="${url}"]`).click()
}

test('the stack editor adds, moves, turns off and removes filters, and the URL keeps the stack', async ({ page }) => {
  await page.goto('/engine.html?source=pesquet-talk&autostart&filter=/filters/glasses/&filter=/filters/vintage/&off=1')
  await expect.poll(() => ids(page), { timeout: 60_000 }).toEqual(['glasses', 'vintage (off)'])
  expect(await rows(page)).toEqual(['vintage', 'glasses'])
  await expect(row(page, 'vintage').locator('input.enabled')).not.toBeChecked()

  // The menu: the demos, the fixtures in a closed group, no malicious filter.
  await page.locator('#add > summary').click()
  await expect(page.locator('#add button[data-url="/filters/fixtures/dot-tint/"]')).toBeAttached()
  await expect(page.locator('#add .groups > details', { hasText: 'Test fixtures' })).not.toHaveAttribute('open')
  expect(await page.locator('#add button[data-url^="/filters/evil/"]').count()).toBe(0)
  await page.locator('#add > summary').click()

  // Added on top, selected: its params show.
  await add(page, '/filters/text-bubble/')
  await expect.poll(() => ids(page), { timeout: 30_000 }).toEqual(['glasses', 'vintage (off)', 'text-bubble'])
  await expect(row(page, 'text-bubble')).toHaveClass(/selected/)
  await expect(page.locator('#params legend')).toHaveText(['text-bubble'])
  await expect.poll(() => query(page)).toBe('?source=pesquet-talk&autostart&filter=/filters/glasses/&filter=/filters/vintage/&filter=/filters/text-bubble/&off=1')

  await row(page, 'text-bubble').locator('button.down').click()
  await expect.poll(() => ids(page)).toEqual(['glasses', 'text-bubble', 'vintage (off)'])
  expect(await rows(page)).toEqual(['vintage', 'text-bubble', 'glasses'])
  await expect(row(page, 'vintage').locator('button.up')).toBeDisabled()

  await row(page, 'vintage').locator('input.enabled').check()
  await expect.poll(() => ids(page)).toEqual(['glasses', 'text-bubble', 'vintage'])
  await row(page, 'glasses').locator('button.name').click()
  await expect(page.locator('#params legend')).toHaveText(['glasses'])
  await row(page, 'glasses').locator('button.remove').click()
  await expect.poll(() => ids(page)).toEqual(['text-bubble', 'vintage'])
  // The selected filter removed: the top one is selected.
  await expect(row(page, 'vintage')).toHaveClass(/selected/)
  await expect.poll(() => query(page)).toBe('?source=pesquet-talk&autostart&filter=/filters/text-bubble/&filter=/filters/vintage/')

  await row(page, 'text-bubble').locator('input.enabled').uncheck()
  await expect.poll(() => query(page)).toBe('?source=pesquet-talk&autostart&filter=/filters/text-bubble/&filter=/filters/vintage/&off=0')
  await page.reload()
  await expect.poll(() => ids(page), { timeout: 60_000 }).toEqual(['text-bubble (off)', 'vintage'])
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})

test('before Start, the filters of the URL wait in the stack and load below those added meanwhile', async ({ page }) => {
  await page.goto('/engine.html?source=pesquet-talk&filter=/filters/glasses/')
  await expect(page.locator('#stack-list li.pending')).toContainText('loads on Start')
  await add(page, '/filters/text-bubble/')
  await expect.poll(() => ids(page), { timeout: 60_000 }).toEqual(['text-bubble'])
  await expect.poll(() => query(page)).toBe('?source=pesquet-talk&filter=/filters/glasses/&filter=/filters/text-bubble/')
  await page.locator('#start').click()
  await expect.poll(() => ids(page), { timeout: 60_000 }).toEqual(['glasses', 'text-bubble'])
  await expect(page.locator('#stack-list li.pending')).toHaveCount(0)
  expect(await rows(page)).toEqual(['text-bubble', 'glasses'])
  expect(query(page)).toBe('?source=pesquet-talk&filter=/filters/glasses/&filter=/filters/text-bubble/')
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})
