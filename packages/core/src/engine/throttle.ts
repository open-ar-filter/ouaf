/**
 * Simulated slow tracking (#90): a tracker wrapper that delivers each result no sooner than a set time after the
 * frame was submitted, so that the device governor (spec §16) can be exercised on a fast desktop. The real tracker
 * still runs; its result is held back. The simulated time shrinks as the governor drops capabilities, by the share
 * each one is given, so that the drops have an effect to measure. Debugging and testing only.
 *
 * ```ts
 * const throttle = { ms: 80 } // ≈ 12 Hz with everything on
 * const engine = createEngine({ canvas, assetsBaseUrl, plugins: [throttlePlugin(throttle)] })
 * throttle.ms = 40 // changes apply from the next frame
 * ```
 */
import type { FaceTrackerImpl, FrameTracker, OuafPlugin, TrackerConfig } from './plugin.ts'
import { defaultFaceTracker } from './builtin.ts'

export interface TrackingThrottle {
  /** Simulated time per result (ms) with every capability on; 0 or less: no throttling. Read on every frame. */
  ms: number
  /**
   * Share of `ms` that each optional capability costs (spec §16.2), saved while the governor has dropped it.
   * Default: blendshapes 0.15, extra faces 0.2 (whatever their number), analysis resolution 0.25.
   */
  shares?: { blendshapes?: number; extraFaces?: number; resolution?: number }
}

export const DEFAULT_THROTTLE_SHARES = { blendshapes: 0.15, extraFaces: 0.2, resolution: 0.25 } as const

/** Simulated time (ms) of one result for `config`, `capacity` being the faces the tracker was created for. */
export function throttledMs(throttle: Readonly<TrackingThrottle>, config: Readonly<TrackerConfig>, capacity: number): number {
  if (!(throttle.ms > 0)) return 0
  const shares = { ...DEFAULT_THROTTLE_SHARES, ...throttle.shares }
  let factor = 1
  if (!config.blendshapes) factor -= shares.blendshapes
  if (capacity > 1 && config.maxFaces < capacity) factor -= shares.extraFaces
  if (config.analysisScale < 1) factor -= shares.resolution
  return throttle.ms * Math.max(0, factor)
}

/** Wraps a tracker so that its results come no sooner than `throttledMs` after each call. */
export function throttleTracker(impl: FaceTrackerImpl, throttle: TrackingThrottle): FaceTrackerImpl {
  return {
    // Same id: the same tracker underneath, so it shares the cached backend choice (spec §16.4).
    id: impl.id,
    ...(impl.cost ? { cost: impl.cost } : {}),
    async create(config, env) {
      const inner = await impl.create(config, env)
      const capacity = config.maxFaces
      let current: TrackerConfig = { ...config }
      const tracker: FrameTracker = {
        get description() {
          return throttle.ms > 0 ? `${inner.description}, throttled to ${Math.round(throttledMs(throttle, current, capacity))} ms` : inner.description
        },
        track(input, timestampMs, mediaTime, out) {
          const start = performance.now()
          const result = inner.track(input, timestampMs, mediaTime, out)
          const ms = throttledMs(throttle, current, capacity)
          if (ms <= 0) return result
          return Promise.resolve(result).then(() => {
            const left = start + ms - performance.now()
            return left > 0 ? new Promise<void>((resolve) => setTimeout(resolve, left)) : undefined
          })
        },
        ...(inner.trackImage ? { trackImage: inner.trackImage.bind(inner) } : {}),
        ...(inner.reset ? { reset: inner.reset.bind(inner) } : {}),
        ...(inner.benchmark ? { benchmark: inner.benchmark.bind(inner) } : {}),
        get backend() {
          return inner.backend
        },
        get measuring() {
          return inner.measuring
        },
        // Throttled results come at the simulated pace, on frame ticks (as a main-thread tracker's would).
        get eager() {
          return !(throttle.ms > 0) && (inner.eager ?? false)
        },
        offer(input, timestampMs, mediaTime) {
          if (!(throttle.ms > 0)) inner.offer?.(input, timestampMs, mediaTime)
        },
        get timings() {
          return inner.timings
        },
        // Throttled, every capability has a simulated cost.
        get sheds() {
          return throttle.ms > 0 ? undefined : inner.sheds
        },
        configure(next) {
          current = { ...next }
          inner.configure(next)
        },
        dispose: () => inner.dispose(),
      }
      return tracker
    },
  }
}

/** A plugin that replaces the built-in face tracker with its throttled version (install it at engine creation). */
export function throttlePlugin(throttle: TrackingThrottle, impl: FaceTrackerImpl = defaultFaceTracker): OuafPlugin {
  return {
    name: 'tracking-throttle',
    version: '1.0.0',
    setup(api) {
      api.registerTracker(throttleTracker(impl, throttle))
    },
  }
}
