/**
 * The demo filters (#37) on the engine page: one row per entry of `filters/demos.json`, with links that open the demo
 * on its test clip or on the camera (with the `maxFaces` it needs). Names and descriptions come from the manifests.
 */

interface DemoEntry {
  id: string
  clip: string
  maxFaces: number
}

type Localized = string | Record<string, string> | undefined

const text = (value: Localized): string => (typeof value === 'string' ? value : (value?.en ?? Object.values(value ?? {})[0] ?? ''))

function link(label: string, query: string): HTMLAnchorElement {
  const a = document.createElement('a')
  a.textContent = label
  a.href = `?${query}`
  return a
}

export async function renderDemos(container: HTMLElement): Promise<void> {
  const response = await fetch(new URL('filters/demos.json', document.baseURI))
  if (!response.ok) throw new Error(`filters/demos.json: HTTP ${response.status}`)
  const { demos } = (await response.json()) as { demos: DemoEntry[] }
  const manifests = await Promise.all(
    demos.map(async (d) => {
      const r = await fetch(new URL(`filters/${d.id}/manifest.json`, document.baseURI))
      return r.ok ? ((await r.json()) as { name?: Localized; description?: Localized }) : {}
    }),
  )
  const list = document.createElement('dl')
  demos.forEach((d, i) => {
    const m = manifests[i]!
    const filter = `filter=/filters/${d.id}/`
    const faces = d.maxFaces > 1 ? `&maxFaces=${d.maxFaces}` : ''
    const dt = document.createElement('dt')
    dt.append(`${text(m.name) || d.id} `, link(`▶ ${d.clip}`, `${filter}&source=${d.clip}&autostart${faces}`), ' · ', link('camera', `${filter}${faces}`))
    const dd = document.createElement('dd')
    dd.textContent = `${d.id}: ${text(m.description)}`
    list.append(dt, dd)
  })
  container.replaceChildren(list)
}
