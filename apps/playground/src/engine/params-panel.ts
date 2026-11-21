/**
 * Minimal params panel for the engine page: one control per parameter of each filter, generated from the manifest
 * (spec §9), preset buttons and a transition override. The full panel belongs to the playground app (#36).
 */
import type { FilterHandle } from '@ouaf/core'

export function renderParams(container: HTMLElement, filters: readonly FilterHandle[], onError: (message: string) => void): void {
  container.replaceChildren()
  for (const filter of filters) {
    const defs = filter.manifest.params ?? {}
    if (Object.keys(defs).length === 0 && filter.presets.length === 0) continue
    const box = el('fieldset')
    box.append(el('legend', filter.id))
    const transition = el('input') as HTMLInputElement
    transition.type = 'number'
    transition.min = '0'
    transition.placeholder = 'default'
    const transitionRow = el('label')
    transitionRow.append(el('span', 'transition (ms)'), transition, el('span'))
    box.append(transitionRow)
    const options = () => (transition.value === '' ? undefined : { transition: Number(transition.value) })
    const set = (name: string, value: unknown) => {
      try {
        filter.setParam(name, value, options())
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error))
      }
    }
    const outputs = new Map<string, HTMLElement>()
    const inputs = new Map<string, HTMLElement>()
    for (const [name, def] of Object.entries(defs)) {
      const row = el('label')
      const output = el('span', String(filter.params[name]))
      outputs.set(name, output)
      let input: HTMLElement
      if (def.type === 'number') {
        const i = el('input') as HTMLInputElement
        i.type = 'range'
        i.min = String(def.min ?? 0)
        i.max = String(def.max ?? 1)
        i.step = String(def.step ?? ((def.max ?? 1) - (def.min ?? 0)) / 100)
        i.value = String(filter.params[name])
        i.addEventListener('input', () => set(name, Number(i.value)))
        input = i
      } else if (def.type === 'boolean') {
        const i = el('input') as HTMLInputElement
        i.type = 'checkbox'
        i.checked = filter.params[name] === true
        i.addEventListener('change', () => set(name, i.checked))
        input = i
      } else if (def.type === 'color') {
        const i = el('input') as HTMLInputElement
        i.type = 'color'
        i.value = String(filter.params[name]).slice(0, 7)
        i.addEventListener('input', () => set(name, i.value))
        input = i
      } else if (def.type === 'select') {
        const s = el('select') as HTMLSelectElement
        for (const key of filter.optionsOf(name)?.keys() ?? []) s.append(new Option(key, key))
        s.value = String(filter.params[name])
        s.addEventListener('change', () => set(name, s.value))
        input = s
      } else {
        const i = el('input') as HTMLInputElement
        i.value = JSON.stringify(filter.params[name])
        i.addEventListener('change', () => {
          try {
            set(name, JSON.parse(i.value))
          } catch {
            set(name, i.value)
          }
        })
        input = i
      }
      inputs.set(name, input)
      row.append(el('span', name), input, output)
      box.append(row)
    }
    filter.on('paramChange', (c) => {
      const output = outputs.get(c.name)
      if (output) output.textContent = JSON.stringify(c.value)
      // Follow changes made elsewhere (presets, the console).
      const input = inputs.get(c.name)
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = c.value === true
      else if (input instanceof HTMLInputElement && input.type === 'color') input.value = String(c.value).slice(0, 7)
      else if (input instanceof HTMLInputElement && input.type !== 'range') input.value = JSON.stringify(c.value)
      else if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) {
        if (document.activeElement !== input) input.value = String(c.value)
      }
    })
    if (filter.presets.length > 0) {
      const presets = el('div')
      presets.className = 'presets'
      for (const preset of filter.presets) {
        const b = el('button', `preset: ${preset}`) as HTMLButtonElement
        b.type = 'button'
        b.addEventListener('click', () => {
          try {
            filter.applyPreset(preset, options())
          } catch (error) {
            onError(error instanceof Error ? error.message : String(error))
          }
        })
        presets.append(b)
      }
      box.append(presets)
    }
    container.append(box)
  }
}

function el(tag: string, text?: string): HTMLElement {
  const e = document.createElement(tag)
  if (text !== undefined) e.textContent = text
  return e
}
