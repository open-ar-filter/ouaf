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
  maxFaces: number
  /** Blendshapes are needed by at least one active filter (and not dropped by the governor, spec §16.2). */
  blendshapes: boolean
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
   * `timestampMs` increases strictly between calls.
   */
  track(input: TrackerInput, timestampMs: number, mediaTime: number, out: FaceFrame): void | Promise<void>
  /** Applies a new configuration (blendshapes on/off, fewer faces); takes effect on a later `track`. */
  configure(config: TrackerConfig): void
  dispose(): void
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
