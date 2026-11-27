/**
 * The demo filters (#37) on the engine page: one row per entry of `filters/demos.json`, with links that open the demo
 * on its test clip or on the camera (with the `maxFaces` it needs). Names and descriptions come from the manifests.
 */

export interface Demo {
  id: string
  clip: string
  maxFaces: number
  /** From the manifest (English, or its first language); the id when it does not read. */
  name: string
  description: string
}

type Localized = string | Record<string, string> | undefined

export const text = (value: Localized): string => (typeof value === 'string' ? value : (value?.en ?? Object.values(value ?? {})[0] ?? ''))

let demos: Promise<Demo[]> | undefined

/** The demos of `filters/demos.json`, with their manifest's name and description (fetched once). */
export function loadDemos(): Promise<Demo[]> {
  demos ??= (async () => {
    const response = await fetch(new URL('filters/demos.json', document.baseURI))
    if (!response.ok) throw new Error(`filters/demos.json: HTTP ${response.status}`)
    const { demos } = (await response.json()) as { demos: Array<{ id: string; clip: string; maxFaces: number }> }
    return Promise.all(
      demos.map(async (d) => {
        const r = await fetch(new URL(`filters/${d.id}/manifest.json`, document.baseURI))
        const m = r.ok ? ((await r.json()) as { name?: Localized; description?: Localized }) : {}
        return { id: d.id, clip: d.clip, maxFaces: d.maxFaces, name: text(m.name) || d.id, description: text(m.description) }
      }),
    )
  })()
  return demos
}

function link(label: string, query: string): HTMLAnchorElement {
  const a = document.createElement('a')
  a.textContent = label
  a.href = `?${query}`
  return a
}

export async function renderDemos(container: HTMLElement): Promise<void> {
  const list = document.createElement('dl')
  for (const d of await loadDemos()) {
    const filter = `filter=/filters/${d.id}/`
    const faces = d.maxFaces > 1 ? `&maxFaces=${d.maxFaces}` : ''
    const dt = document.createElement('dt')
    dt.append(`${d.name} `, link(`▶ ${d.clip}`, `${filter}&source=${d.clip}&autostart${faces}`), ' · ', link('camera', `${filter}${faces}`))
    const dd = document.createElement('dd')
    dd.textContent = `${d.id}: ${d.description}`
    list.append(dt, dd)
  }
  container.replaceChildren(list)
}
