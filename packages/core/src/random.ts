/**
 * Seeded random numbers (spec §12.5). Every filter activation draws from its own generators, seeded from the engine
 * seed: a fixed value with a file source (image, offline video, `pushFrame`) so that every run gives the same result,
 * a random one with a live source, or the host's `createEngine({ seed })`.
 *
 * The generator is mulberry32: 32 bits of state, fast, and good enough for picking assets and script choices (it is
 * not a cryptographic generator).
 */

/** Seed used for file sources when the host sets none. Any constant works; this one spells "ouaf". */
export const FILE_SOURCE_SEED = 0x6f756166

/** A seedable generator of numbers in [0, 1). `next` is bound, so it can be passed around as a function. */
export class SeededRandom {
  #state: number

  constructor(seed: number) {
    this.#state = seed >>> 0
  }

  /** Restarts the sequence from `seed`. */
  reseed(seed: number): void {
    this.#state = seed >>> 0
  }

  /** Next number in [0, 1). Does not allocate. */
  readonly next = (): number => {
    let t = (this.#state = (this.#state + 0x6d2b79f5) >>> 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Derives an independent 32-bit seed from `seed` and `keys` (a filter id, a layer index…), so that each filter and
 * layer gets its own sequence and adding a filter does not change the draws of another.
 */
export function deriveSeed(seed: number, ...keys: ReadonlyArray<string | number>): number {
  let h = (seed >>> 0) ^ 0x811c9dc5
  for (const key of keys) {
    const text = typeof key === 'number' ? `#${key}` : key
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
    h = Math.imul(h ^ 0xff, 0x01000193) // separator: ("ab", "c") and ("a", "bc") differ
  }
  // Final avalanche (murmur3 fmix32).
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** A random 32-bit seed (live sources), from `crypto.getRandomValues` when available. */
export function randomSeed(): number {
  const c = globalThis.crypto
  if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0]!
  return Math.floor(Math.random() * 4294967296) >>> 0
}

/** Checks a host-provided seed: an integer from 0 to 2³² − 1. */
export function checkSeed(seed: number): number {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError(`seed must be an integer from 0 to 4294967295, got ${seed}`)
  return seed
}
