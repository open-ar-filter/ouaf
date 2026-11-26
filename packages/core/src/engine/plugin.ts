/**
 * Plugins (spec §14): trusted code installed by the host with `engine.use(plugin)`. The engine's own features are
 * plugins too: the face tracker and the v1 layer types are installed by default (`builtinPlugins`).
 *
 * A plugin declares its **vocabulary** (layer types with their schemas, anchors, events, data paths), merged into the
 * engine's validation registry, and registers **implementations** through `PluginApi` in `setup`. Third-party
 * plugins prefix their vocabulary (`myplugin:type`, data `ext.myplugin.…`); official plugins use plain names.
 */
import type { SpecContribution } from '@ouaf/spec'
import type { FaceFrame, TrackerInput } from '../face.ts'
import type { VideoSource } from '../video-source.ts'
import type { AssetLoader } from './assets.ts'
import type { FrameContext, LayerContext, LayerInstance, LayerTypeImpl } from './layer-type.ts'
import type { Capability } from './governor.ts'

export interface OuafPlugin {
  /** Plugin name, as filters list it in `requires.plugins` (`mood@^1`). Lowercase letters, digits and dashes. */
  readonly name: string
  /** Semver version, checked against the filters' ranges. */
  readonly version: string
  /** Official plugin of the project: plain vocabulary names allowed. Default: false (names must be prefixed). */
  readonly official?: boolean
  /** Vocabulary merged into validation and documentation. */
  readonly vocabulary?: Omit<SpecContribution, 'plugin' | 'version'>
  /** Registers the implementations. Called once by `engine.use`. */
  setup?(api: PluginApi): void
}

export interface PluginApi {
  /** Version of the engine the plugin is installed on. */
  readonly engineVersion: string
  registerLayerType(impl: LayerTypeImpl): void
  registerTracker(impl: FaceTrackerImpl): void
  registerAssetLoader(loader: AssetLoader): void
  registerSource(impl: SourceImpl): void
  registerLandmarkModifier(modifier: LandmarkModifier): void
  registerRenderPass(impl: RenderPassImpl): void
  registerEventSource(impl: EventSourceImpl): void
}

// ---------------------------------------------------------------------------------------------
// Trackers

/** What the engine tells a tracker it needs (the union of the active filters' `requires`, spec §7). */
export interface TrackerConfig {
  /**
   * Faces to look for: the engine's `maxFaces`, or fewer while the governor has dropped the extra faces (spec §16.2:
   * the number of faces tracked when they were dropped).
   */
  maxFaces: number
  /**
   * Blendshapes are wanted: a face filter is enabled (expression events read them, spec §13) and the governor has not
   * dropped them (§16.2). When false the tracker may skip them; the engine ignores them either way.
   */
  blendshapes: boolean
  /**
   * Resolution of the image to analyse, relative to the frame: 1, or less while the governor has dropped the analysis
   * resolution (spec §16.2). Landmarks stay normalized to the frame, and `FaceFrame.width` / `height` keep the
   * frame's size.
   */
  analysisScale: number
}

/**
 * A running face tracker. The engine calls `track` on the newest camera frame whenever the previous call has
 * completed (eager scheduling, docs/decisions/tracking-worker.md); results may arrive frames later.
 */
export interface FrameTracker {
  /** Human-readable backend, for stats (`LiteRT.js wasm, worker`). */
  readonly description: string
  /**
   * Tracks `input`, writing the result into `out` (which the engine does not read until the call completes).
   * Synchronous trackers write `out` and return `undefined`; asynchronous ones (worker) return a promise.
   * `timestampMs` increases strictly between calls. `exact`: a file source (spec §12.1), whose result must be this
   * frame's; otherwise a tracker may answer with a result of an earlier frame (`FaceFrame.mediaTime` says which), e.g.
   * one frame late to keep its worker busy.
   */
  track(input: TrackerInput, timestampMs: number, mediaTime: number, out: FaceFrame, exact?: boolean): void | Promise<void>
  /**
   * Tracks a still image (image sources, #32): detection from scratch, no state carried over from earlier frames
   * (MediaPipe IMAGE mode). Optional: without it the engine calls `track`.
   */
  trackImage?(input: TrackerInput, mediaTime: number, out: FaceFrame): void | Promise<void>
  /**
   * Forgets the state carried from frame to frame, so that the next `track` works as on a first frame: called at the
   * start of each run of a file source (offline video, `pushFrame`) so that every run gives the same result
   * (spec §12.5). Optional for trackers without temporal state.
   */
  reset?(): void | Promise<void>
  /** Applies a new configuration (blendshapes on/off, fewer faces); takes effect on a later `track`. */
  configure(config: TrackerConfig): void
  /**
   * Inference backend in use (`CPU`, `GPU`…) and how it was chosen (spec §16.4): measured now, read from the local
   * cache, forced by the host, or the only one available. Optional.
   */
  readonly backend?: BackendInfo
  /**
   * Called once, on the first frame of a live source, when the tracker may measure its backends on real frames
   * (spec §16.4: never with file sources, whose results must not depend on timing). Optional.
   */
  benchmark?(): void
  /** A benchmark is running: results come from several backends and the tracking rate is not judged meanwhile. */
  readonly measuring?: boolean
  /**
   * Eager scheduling (docs/decisions/tracking-worker.md): when a frame of a live source came while a call was in
   * flight, the engine calls `track` again as soon as that call completes, on the newest frame, instead of waiting for
   * the next frame. For asynchronous trackers that do not block the main thread (a worker): otherwise a call that
   * spans a frame tick misses it, and the rate snaps to 15 Hz, 10 Hz… Read on every frame. Default: false.
   */
  readonly eager?: boolean
  /**
   * The tracker's work runs off the main thread (a worker): hiding the filters, which frees the main thread, does not
   * make it faster, so the device governor judges a show on the rate measured while they are hidden (spec §16.3,
   * `GovernorMeasures.offMainThread`). Read on every governor step. Default: false.
   */
  readonly offMainThread?: boolean
  /**
   * An eager tracker's chance to start on a live frame that came while its call is in flight (a worker queues it and
   * starts it as soon as its run ends, without waiting for the page). The engine still calls `track` once the call
   * completes, on the newest frame; the tracker may answer it with the result of an offered frame of the same input
   * (`FaceFrame.mediaTime` then says which). Optional.
   */
  offer?(input: TrackerInput, timestampMs: number, mediaTime: number): void
  /**
   * Mean time per result of the tracker's steps (ms), for stats (`EngineStats.trackerTimings`), e.g. the hand-offs to
   * and from a worker and each model. Optional.
   */
  readonly timings?: Readonly<Record<string, number>>
  /**
   * The optional capabilities (spec §16.2) whose drop makes this tracker faster. Default: all. The governor does not
   * drop the others: they would cost it a step for nothing (LiteRT.js crops from the full frame whatever the
   * analysis resolution). Read on every governor step.
   */
  readonly sheds?: readonly Capability[]
  dispose(): void
}

/** The backend of a tracker and why (spec §16.4). */
export interface BackendInfo {
  readonly name: string
  readonly source: 'measured' | 'cached' | 'forced' | 'only' | 'pending'
  /** Median time per result of each backend measured (ms), when measured (now or from the cache). */
  readonly measuredMs?: Readonly<Record<string, number>>
}

export interface FaceTrackerImpl {
  /** Identifier, for stats and errors (`litert`, `mediapipe`). */
  readonly id: string
  /**
   * Typical cost and maximum useful rate, for the scheduler and the governor (spec §16). Informational in this
   * version: tracking always runs eagerly.
   */
  readonly cost?: { readonly typicalMs?: number; readonly maxRateHz?: number }
  /** Starts the tracker (downloads models, warms up). Assets are resolved against the engine's `assetsBaseUrl`. */
  create(config: TrackerConfig, env: TrackerEnv): Promise<FrameTracker>
}

export interface TrackerEnv {
  readonly assetsBaseUrl: string
  warn(message: string, cause?: unknown): void
  /** Backend forced by the host (`EngineOptions.trackerBackend`); undefined: the tracker chooses (spec §16.4). */
  readonly backend?: string
  /**
   * Local storage for the tracker's measured backend choice (spec §16.4): one value per tracker id and engine version,
   * kept on the device (`localStorage` when available), never transmitted (§15). `get` gives undefined when nothing
   * is stored or storage is unavailable.
   */
  readonly store?: { get(): unknown; set(value: unknown): void }
}

/** Modifies landmarks after tracking, before anchors and layers (e.g. caricature). Must not allocate. */
export interface LandmarkModifier {
  readonly id: string
  modify(faces: FaceFrame): void
}

// ---------------------------------------------------------------------------------------------
// Sources, render passes, events

/** Turns something the host passes to `engine.setSource` into a `VideoSource` (#32 adds images, canvases…). */
export interface SourceImpl {
  readonly id: string
  accepts(input: unknown): boolean
  create(input: unknown): VideoSource | Promise<VideoSource>
}

/**
 * A render pass that is not a filter layer: always drawn while the plugin is installed and enabled (debug overlays,
 * watermarks). It is created like a layer, from an empty declaration.
 */
export interface RenderPassImpl {
  readonly id: string
  create(ctx: LayerContext): LayerInstance | Promise<LayerInstance>
}

/** Derived events (spec §13): expression detectors, plugin events. Wired to scripts by #14 and #26. */
export interface EventSourceImpl {
  /** Event names it may emit (declared in the plugin vocabulary). */
  readonly events: readonly string[]
  create(options: { readonly tuning: Readonly<Record<string, { threshold?: number; minDurationMs?: number }>> }): EventSource
}

export interface EventSource {
  update(frame: FrameContext, emit: (name: string, payload?: unknown) => void): void
  dispose(): void
}

/** `name@range` from `requires.plugins`. */
export function parsePluginRequirement(text: string): { name: string; range: string | undefined } {
  const at = text.indexOf('@')
  return at < 0 ? { name: text, range: undefined } : { name: text.slice(0, at), range: text.slice(at + 1) }
}
