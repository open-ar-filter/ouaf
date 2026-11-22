/**
 * Built-in plugins, installed by default (`EngineOptions.builtins`): the face tracker and the v1 layer types, each as
 * its own plugin.
 *
 * Built-in plugins are official and declare no vocabulary: the v1 vocabulary is already in `createRegistry()`.
 */
import { createFaceTracker } from '../face-tracker.ts'
import type { FaceTracker } from '../face.ts'
import type { FaceTrackerImpl, FrameTracker, OuafPlugin } from './plugin.ts'
import { canvasPlugin } from '../layers/canvas/index.ts'
import { colorPlugin } from '../layers/color/index.ts'
import { shaderPlugin } from '../layers/shader/index.ts'
import { modelPlugin } from '../layers/model/index.ts'
import { stickerPlugin } from '../layers/sticker/index.ts'
import { textPlugin } from '../layers/text/index.ts'
import { warpPlugin } from '../layers/warp/index.ts'

/**
 * Face tracker on MediaPipe tasks-vision, on the main thread (phase 0 tracker). PROVISIONAL: the default tracker
 * becomes our LiteRT.js pipeline in a worker (docs/decisions/face-runtime.md, tracking-worker.md); this one stays as
 * the fallback where the worker cannot run.
 *
 * Files, under `assetsBaseUrl`: `mediapipe/wasm/vision_wasm_internal.{js,wasm}` and `models/face_landmarker.task`.
 */
export const mediaPipeFaceTracker: FaceTrackerImpl = {
  id: 'mediapipe',
  cost: { typicalMs: 20 },
  async create(config, env) {
    // Blendshapes are computed from the start whatever the config: MediaPipe cannot toggle them without
    // re-creating the landmarker. The LiteRT.js tracker honours `configure`.
    const tracker: FaceTracker = await createFaceTracker({
      maxFaces: config.maxFaces,
      wasmBaseUrl: new URL('mediapipe/wasm/', env.assetsBaseUrl).href,
      modelUrl: new URL('models/face_landmarker.task', env.assetsBaseUrl).href,
      blendshapes: true,
      onWarning: env.warn,
    })
    const frameTracker: FrameTracker = {
      description: `MediaPipe ${tracker.delegate}, main thread`,
      // After a still image the landmarker is in IMAGE mode: switch back once (asynchronous), then track.
      track: (input, timestampMs, mediaTime, out) =>
        tracker.runningMode === 'VIDEO'
          ? tracker.detect(input, timestampMs, mediaTime, out)
          : tracker.setRunningMode('VIDEO').then(() => tracker.detect(input, timestampMs, mediaTime, out)),
      trackImage: (input, mediaTime, out) => tracker.detectImage(input, mediaTime, out),
      reset: () => tracker.resetState(),
      configure: () => {},
      dispose: () => tracker.dispose(),
    }
    return frameTracker
  },
}

export const facePlugin: OuafPlugin = {
  name: 'face',
  version: '1.0.0',
  official: true,
  setup(api) {
    api.registerTracker(mediaPipeFaceTracker)
  },
}

/** The plugins `createEngine` installs by default, in order. */
export function builtinPlugins(): OuafPlugin[] {
  return [
    facePlugin,
    textPlugin,
    stickerPlugin,
    modelPlugin,
    warpPlugin,
    colorPlugin,
    shaderPlugin,
    canvasPlugin,
  ]
}
