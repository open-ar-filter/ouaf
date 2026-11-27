/**
 * Params panel of the engine page: one control per parameter of each filter given, generated from the manifest
 * (spec §9), preset buttons and a transition override. The stack editor (`stack-panel.ts`) gives it the selected
 * filter.
 */
import type { FilterHandle } from '@ouaf/core'

/** Draws the controls of `filters` in `container`; the function returned stops them following the filters. */
export function renderParams(container: HTMLElement, filters: readonly FilterHandle[], onError: (message: string) => void): () => void {
  container.replaceChildren()
  const stops: Array<() => void> = []
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
      const output = el('span', show(filter.params[name]))
      outputs.set(name, output)
      let input: HTMLElement
      if (def.type === 'asset') {
        // A file read locally, checked by the engine (spec §15); a refused one is reported as an `error`.
        const i = el('input') as HTMLInputElement
        i.type = 'file'
        i.accept = [...def.accept, ...def.accept.flatMap((t) => EXTENSIONS[t] ?? [])].join(',')
        i.addEventListener('change', () => {
          const file = i.files?.[0]
          if (file) set(name, file)
        })
        const box = el('span')
        box.className = 'file'
        box.append(i)
        if (def.optional) {
          const clear = el('button', '×') as HTMLButtonElement
          clear.type = 'button'
          clear.title = 'Remove the file'
          clear.addEventListener('click', (e) => {
            e.preventDefault()
            i.value = ''
            set(name, null)
          })
          box.append(clear)
        }
        input = box
      } else if (def.type === 'number') {
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
    stops.push(filter.on('paramChange', (c) => {
      const output = outputs.get(c.name)
      if (output) output.textContent = show(c.value)
      // Follow changes made elsewhere (presets, the console).
      const input = inputs.get(c.name)
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = c.value === true
      else if (input instanceof HTMLInputElement && input.type === 'color') input.value = String(c.value).slice(0, 7)
      else if (input instanceof HTMLInputElement && input.type !== 'range') input.value = JSON.stringify(c.value)
      else if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) {
        if (document.activeElement !== input) input.value = String(c.value)
      }
    }))
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
  return () => {
    for (const stop of stops) stop()
  }
}

/** File extensions for the file picker, for media types systems do not know (`.cube`). */
const EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'text/x-cube': ['.cube'],
  'model/gltf-binary': ['.glb'],
  'model/gltf+json': ['.gltf'],
  'font/woff2': ['.woff2'],
  'font/woff': ['.woff'],
  'font/ttf': ['.ttf'],
  'font/otf': ['.otf'],
}

/** A parameter value as shown next to its control: a file by its name. */
function show(value: unknown): string {
  if (typeof File !== 'undefined' && value instanceof File) return value.name
  if (typeof Blob !== 'undefined' && value instanceof Blob) return `file (${value.size} B)`
  if (value === null) return 'none'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function el(tag: string, text?: string): HTMLElement {
  const e = document.createElement(tag)
  if (text !== undefined) e.textContent = text
  return e
}
