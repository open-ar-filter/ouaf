/**
 * The stack editor of the engine page (#36): one row per filter, the top of the stack (drawn last) first, as layer
 * panels show it. A row turns its filter on or off, moves it up or down, removes it, and selects it: the params panel
 * shows the selected filter. It reads the engine's stack, so a filter added from the console shows too.
 */
import type { Engine, FilterHandle } from '@ouaf/core'
import { text } from './demos.ts'
import { renderParams } from './params-panel.ts'

/** A filter of the URL not loaded yet: the camera page loads its filters on Start, below those added before. */
export interface Pending {
  src: string
  enabled: boolean
}

export interface StackPanelOptions {
  engine: Engine
  /** Where each filter was loaded from; a filter missing here was added outside the page. Removing one deletes it. */
  sources: Map<FilterHandle, string | File>
  /** The filters of the URL that load on Start, bottom first (`main.ts`). */
  pending: Pending[]
  /** Runs a change of the stack after those in progress (`main.ts`, `serial`). */
  run(task: () => void): Promise<void>
  /** After a change made in the panel: the page writes the URL. */
  changed(): void
  onError(message: string): void
}

export interface StackPanel {
  /** Draws the rows again; the params panel too when the selected filter changed. */
  render(): void
  /** Draws again if the stack changed elsewhere: the console, the engine suspending or disabling a filter. */
  poll(): void
  /** The filter whose params show; by default the top one. */
  selected: FilterHandle | undefined
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...children)
  return e
}

const button = (label: string, className: string, title: string, onClick: () => void, disabled = false) => {
  const b = el('button', { type: 'button', className, title, disabled, textContent: label })
  b.setAttribute('aria-label', title)
  b.addEventListener('click', onClick)
  return b
}

export function createStackPanel(list: HTMLOListElement, paramsBox: HTMLElement, o: StackPanelOptions): StackPanel {
  let selected: FilterHandle | undefined
  let paramsFor: FilterHandle | undefined | null = null
  let stopParams = () => {}
  let signature = ''

  const signatureOf = () => [
    ...o.engine.filters.map((h) => `${h.key}:${+h.enabled}:${+h.suspended}:${+o.sources.has(h)}`),
    ...o.pending.map((p) => `${p.src}:${+p.enabled}`),
  ].join(',')

  const act = (task: () => void) => {
    void o.run(task).then(() => {
      panel.render()
      o.changed()
    }, (error: unknown) => o.onError(error instanceof Error ? error.message : String(error)))
  }

  const sourceLabel = (h: FilterHandle) => {
    const src = o.sources.get(h)
    if (src === undefined) return 'added outside the page (not in the URL, not reloaded)'
    return typeof src === 'string' ? src : `${src.name} (a file: not kept in the URL)`
  }

  const row = (h: FilterHandle, top: number) => {
    const enabled = el('input', { type: 'checkbox', className: 'enabled', checked: h.enabled, title: 'Enabled' })
    enabled.setAttribute('aria-label', `Enable ${h.id}`)
    enabled.addEventListener('change', () => act(() => (h.enabled = enabled.checked)))
    const name = text(h.manifest.name as Parameters<typeof text>[0])
    const pick = el('button', { type: 'button', className: 'name' }, el('b', {}, h.id), name && name !== h.id ? ` ${name}` : '', el('small', {}, sourceLabel(h)))
    pick.setAttribute('aria-pressed', String(h === selected))
    pick.addEventListener('click', () => {
      selected = h
      panel.render()
    })
    const badges: Node[] = []
    if (h.suspended) badges.push(el('span', { className: 'badge', title: 'Hidden by the engine: the device is too slow (spec §16.3)' }, 'suspended'))
    // On a line of its own, under the row.
    const warnings = h.warnings.length > 0
      ? [el('details', { className: 'warnings' }, el('summary', {}, `⚠ ${h.warnings.length} warning${h.warnings.length > 1 ? 's' : ''}`), el('ul', {}, ...h.warnings.map((w) => el('li', {}, w))))]
      : []
    return el(
      'li',
      { className: `filter${h === selected ? ' selected' : ''}${h.enabled ? '' : ' off'}` },
      button('▲', 'up', `Move ${h.id} up (drawn later)`, () => act(() => h.moveTo(h.index + 1)), h.index === top),
      button('▼', 'down', `Move ${h.id} down (drawn earlier)`, () => act(() => h.moveTo(h.index - 1)), h.index === 0),
      enabled,
      pick,
      ...badges,
      button('✕', 'remove', `Remove ${h.id}`, () =>
        act(() => {
          h.remove()
          o.sources.delete(h)
        }),
      ),
      ...warnings,
    )
  }

  const pendingRow = (p: Pending) =>
    el(
      'li',
      { className: 'pending' },
      el('span', { className: 'name' }, el('b', {}, p.src), el('small', {}, `loads on Start${p.enabled ? '' : ', disabled'}`)),
      button('✕', 'remove', `Remove ${p.src}`, () =>
        act(() => {
          const i = o.pending.indexOf(p)
          if (i >= 0) o.pending.splice(i, 1)
        }),
      ),
    )

  const panel: StackPanel = {
    get selected() {
      return selected
    },
    set selected(h) {
      selected = h
      panel.render()
    },
    render() {
      const stack = o.engine.filters
      if (!selected || !stack.includes(selected)) selected = stack.at(-1)
      const top = stack.length - 1
      const rows = [...stack].reverse().map((h) => row(h, top))
      rows.push(...[...o.pending].reverse().map(pendingRow))
      list.replaceChildren(...(rows.length > 0 ? rows : [el('li', { className: 'empty' }, 'No filter: add one above.')]))
      signature = signatureOf()
      if (selected !== paramsFor) {
        stopParams()
        paramsFor = selected
        stopParams = renderParams(paramsBox, selected ? [selected] : [], o.onError)
        if (selected && !paramsBox.hasChildNodes()) paramsBox.append(el('p', {}, `${selected.id} has no parameters.`))
      }
    },
    poll() {
      if (signatureOf() !== signature) panel.render()
    },
  }
  return panel
}
