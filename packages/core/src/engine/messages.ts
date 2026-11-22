/**
 * Host → script messages (spec §12.4, §13): `engine.send(name, data)` and `handle.send(name, data)`, received by the
 * script as the `message:<name>` event.
 */
import { OuafError } from './errors.ts'

/** What a message name may be: a letter, then letters, digits, `_` or `-` (it becomes the `message:<name>` event). */
export const MESSAGE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/

/**
 * The payload of a host message: checks the name and copies `data` now, so that data which cannot cross to the
 * sandbox throws at the caller instead of stopping the script when its next frame is sent, and so that changing
 * `data` after the call changes nothing (as with `postMessage`). Throws `OuafError('invalid-message')`.
 */
export function messagePayload(name: string, data: unknown): { data: unknown } {
  if (typeof name !== 'string' || !MESSAGE_NAME.test(name)) {
    const shown = JSON.stringify(name)
    throw new OuafError('invalid-message', `Invalid message name ${shown}: a letter, then letters, digits, "_" or "-".`)
  }
  try {
    return { data: data === undefined ? undefined : structuredClone(data) }
  } catch (cause) {
    throw new OuafError(
      'invalid-message',
      `send("${name}"): the data cannot be sent to a script, it must be structured-cloneable (${String(cause)}).`,
      { cause },
    )
  }
}
