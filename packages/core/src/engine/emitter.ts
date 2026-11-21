/**
 * Minimal typed event emitter for the public API (engine and filter handles). Listeners are called synchronously in
 * subscription order; a throwing listener does not stop the others (its error goes to `onListenerError`).
 */

export type Listener<T> = (payload: T) => void

export class Emitter<Events extends Record<string, unknown>> {
  #listeners = new Map<string, Array<Listener<never>>>()
  #onListenerError: (error: unknown, event: string) => void

  constructor(onListenerError: (error: unknown, event: string) => void = (error) => console.error(error)) {
    this.#onListenerError = onListenerError
  }

  /** Subscribes; returns a function that unsubscribes. */
  on<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): () => void {
    let list = this.#listeners.get(event)
    if (!list) this.#listeners.set(event, (list = []))
    list.push(listener as Listener<never>)
    return () => this.off(event, listener)
  }

  off<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): void {
    const list = this.#listeners.get(event)
    if (!list) return
    const i = list.indexOf(listener as Listener<never>)
    if (i < 0) return
    // Copy on write: an emit in progress keeps iterating over the array it started with.
    const next = list.slice(0, i).concat(list.slice(i + 1))
    if (next.length === 0) this.#listeners.delete(event)
    else this.#listeners.set(event, next)
  }

  /** True when at least one listener is subscribed (lets callers skip building a payload). */
  has(event: keyof Events & string): boolean {
    return this.#listeners.has(event)
  }

  emit<K extends keyof Events & string>(event: K, payload: Events[K]): void {
    const list = this.#listeners.get(event)
    if (!list) return
    // `on` appends to this array: listeners added during the emit are not called until the next one.
    const n = list.length
    for (let i = 0; i < n; i++) {
      try {
        ;(list[i] as Listener<Events[K]>)(payload)
      } catch (error) {
        this.#onListenerError(error, event)
      }
    }
  }

  clear(): void {
    this.#listeners.clear()
  }
}
