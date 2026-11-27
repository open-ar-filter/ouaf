/**
 * The "Add a filter" menu of the engine page (#36): the demos of `filters/demos.json`, then, with the dev server, the
 * other filters of `filters/` (`GET /__ouaf__/filters`, read each time the menu opens: a folder just created shows):
 * the author's own, and the test fixtures in a closed group. The malicious filters of `filters/evil/` are not
 * listed. A `.ouaf` from the disk is the menu's file input, handled by the page.
 */
import { loadDemos } from './demos.ts'

interface Listed {
  path: string
  kind: 'folder' | 'source' | 'package'
  id?: string
  name?: string
}

const filterUrl = (path: string, kind: Listed['kind']) => `${import.meta.env.BASE_URL}filters/${path}${kind === 'package' ? '' : '/'}`

async function listFilters(): Promise<Listed[]> {
  if (!import.meta.env.DEV) return []
  const response = await fetch(`${import.meta.env.BASE_URL}__ouaf__/filters`)
  if (!response.ok) throw new Error(`/__ouaf__/filters: HTTP ${response.status}`)
  return ((await response.json()) as { filters: Listed[] }).filters
}

function item(label: string, detail: string, url: string, add: (url: string) => void): HTMLLIElement {
  const li = document.createElement('li')
  const b = document.createElement('button')
  b.type = 'button'
  b.dataset.url = url
  const small = document.createElement('small')
  small.textContent = detail
  b.append(label, ' ', small)
  b.addEventListener('click', () => add(url))
  li.append(b)
  return li
}

function group(title: string, items: HTMLLIElement[], open = true): HTMLElement {
  const box = document.createElement('details')
  box.open = open
  const summary = document.createElement('summary')
  summary.textContent = `${title} (${items.length})`
  const list = document.createElement('ul')
  list.append(...items)
  box.append(summary, list)
  return box
}

/** Fills `menu` (its `.groups` element) when it opens; `add` gets the URL of the filter picked. */
export function createAddMenu(menu: HTMLDetailsElement, add: (url: string) => void, onError: (message: string) => void): void {
  const groups = menu.querySelector('.groups') as HTMLElement
  const pick = (url: string) => {
    menu.open = false
    add(url)
  }
  const refresh = async () => {
    const [demos, listed] = await Promise.all([loadDemos(), listFilters()])
    const demoIds = new Set(demos.map((d) => d.id))
    const own = listed.filter((f) => !demoIds.has(f.path) && !f.path.startsWith('fixtures/'))
    const fixtures = listed.filter((f) => f.path.startsWith('fixtures/'))
    const listedItem = (f: Listed) =>
      item(f.name ?? f.path, f.kind === 'source' ? `${f.path} (filter.ts)` : f.path, filterUrl(f.path, f.kind), pick)
    const parts = [group('Demos', demos.map((d) => item(d.name, d.id, filterUrl(d.id, 'folder'), pick)))]
    if (own.length > 0) parts.push(group('Other filters of filters/', own.map(listedItem)))
    if (fixtures.length > 0) parts.push(group('Test fixtures', fixtures.map(listedItem), false))
    groups.replaceChildren(...parts)
  }
  menu.addEventListener('toggle', () => {
    if (menu.open) refresh().catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
  })
}
