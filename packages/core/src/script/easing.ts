/**
 * Easings of `.animate()` (spec §12.4): `linear`, and `in` / `out` / `inOut` × `Quad`, `Cubic`, `Back`, `Elastic`,
 * `Bounce`, with the usual definitions of Robert Penner's equations. Each maps t in [0, 1] to the progress, 0 at t = 0
 * and 1 at t = 1 (`Back` and `Elastic` overshoot in between).
 */
import { EASINGS, type Easing } from '@ouaf/spec'

type Ease = (t: number) => number

const BACK = 1.70158
const BACK_IN_OUT = BACK * 1.525
const ELASTIC = (2 * Math.PI) / 3
const ELASTIC_IN_OUT = (2 * Math.PI) / 4.5

function outBounce(t: number): number {
  const n = 7.5625
  const d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}

const inOf: Record<'Quad' | 'Cubic' | 'Back' | 'Elastic' | 'Bounce', Ease> = {
  Quad: (t) => t * t,
  Cubic: (t) => t * t * t,
  Back: (t) => (BACK + 1) * t * t * t - BACK * t * t,
  Elastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * ELASTIC)),
  Bounce: (t) => 1 - outBounce(1 - t),
}

const inOutOf: Record<keyof typeof inOf, Ease> = {
  Quad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  Cubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  Back: (t) =>
    t < 0.5
      ? (Math.pow(2 * t, 2) * ((BACK_IN_OUT + 1) * 2 * t - BACK_IN_OUT)) / 2
      : (Math.pow(2 * t - 2, 2) * ((BACK_IN_OUT + 1) * (t * 2 - 2) + BACK_IN_OUT) + 2) / 2,
  Elastic: (t) =>
    t <= 0
      ? 0
      : t >= 1
        ? 1
        : t < 0.5
          ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * ELASTIC_IN_OUT)) / 2
          : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * ELASTIC_IN_OUT)) / 2 + 1,
  Bounce: (t) => (t < 0.5 ? (1 - outBounce(1 - 2 * t)) / 2 : (1 + outBounce(2 * t - 1)) / 2),
}

const TABLE = new Map<string, Ease>([['linear', (t) => t]])
for (const [name, ease] of Object.entries(inOf)) {
  TABLE.set(`in${name}`, ease)
  TABLE.set(`out${name}`, (t) => 1 - ease(1 - t))
  TABLE.set(`inOut${name}`, inOutOf[name as keyof typeof inOf])
}

/** The easing function of `name` (one of `EASINGS`), or `undefined` for an unknown name. */
export function easingOf(name: string): Ease | undefined {
  return TABLE.get(name)
}

/** Whether `name` is a v1 easing. */
export function isEasing(name: unknown): name is Easing {
  return typeof name === 'string' && (EASINGS as readonly string[]).includes(name)
}
