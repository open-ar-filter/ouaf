/**
 * The source picker of the engine page (#36): the front or rear camera, a test clip of `test-media/`
 * (`test-media/clips.json`, served by the playground's Vite config), or a video file opened from the disk (read
 * locally, nothing is uploaded). The page opens the choice on Start, or switches to it right away once started.
 */

export type SourceChoice =
  | { kind: 'camera'; facing: 'user' | 'environment' }
  | { kind: 'clip'; clip: string }
  | { kind: 'file'; file: File }

/** `?source=` values that are cameras, not clips. Without `source`, the front camera. */
export const CAMERAS: Readonly<Record<string, 'user' | 'environment'>> = { camera: 'user', 'camera-back': 'environment' }

/** The choice that `?source=<value>` names. */
export function choiceOf(value: string | null): SourceChoice {
  if (value === null || value in CAMERAS) return { kind: 'camera', facing: CAMERAS[value ?? 'camera']! }
  return { kind: 'clip', clip: value }
}

/** What `?source=` keeps for a choice: `null` for the front camera (no parameter), `undefined` for a file (not kept). */
export function queryOf(choice: SourceChoice): string | null | undefined {
  if (choice.kind === 'clip') return choice.clip
  if (choice.kind === 'file') return undefined
  return choice.facing === 'user' ? null : 'camera-back'
}

export function describe(choice: SourceChoice): string {
  if (choice.kind === 'clip') return `test-media/${choice.clip}.mp4`
  if (choice.kind === 'file') return `${choice.file.name} (a file)`
  return `camera (${choice.facing === 'user' ? 'front' : 'back'})`
}

/**
 * Fills `select` with the sources, `initial` selected, and calls `pick` when another is chosen there or a video is
 * opened in `fileInput`.
 */
export function createSourcePicker(select: HTMLSelectElement, fileInput: HTMLInputElement, initial: SourceChoice, pick: (choice: SourceChoice) => void, onError: (message: string) => void): void {
  let file: File | undefined
  const valueOf = (c: SourceChoice) => (c.kind === 'file' ? 'file' : (queryOf(c) ?? 'camera'))
  const fill = (clips: readonly string[], value: string) => {
    const group = document.createElement('optgroup')
    group.label = 'Test clips (test-media/)'
    // A clip of the URL missing from the list still shows: loading it says what is wrong.
    for (const clip of new Set([...clips, ...(value in CAMERAS || value === 'file' ? [] : [value])])) group.append(new Option(clip, clip))
    const options: Array<HTMLOptionElement | HTMLOptGroupElement> = [new Option('Camera (front)', 'camera'), new Option('Camera (back)', 'camera-back'), group]
    if (file) options.push(new Option(`${file.name} (a file: not kept in the URL)`, 'file'))
    select.replaceChildren(...options)
    select.value = value
  }
  fill([], valueOf(initial))
  fetch(new URL('test-media/clips.json', document.baseURI))
    .then(async (r) => {
      if (!r.ok) throw new Error(`test-media/clips.json: HTTP ${r.status}`)
      const { clips } = (await r.json()) as { clips: string[] }
      fill(clips, select.value)
    })
    .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
  select.addEventListener('change', () => {
    pick(select.value === 'file' && file ? { kind: 'file', file } : choiceOf(select.value === 'camera' ? null : select.value))
  })
  fileInput.addEventListener('change', () => {
    const chosen = fileInput.files?.[0]
    fileInput.value = ''
    if (!chosen) return
    file = chosen
    const clips = [...select.querySelectorAll('optgroup option')].map((o) => (o as HTMLOptionElement).value)
    fill(clips, 'file')
    pick({ kind: 'file', file })
  })
}
