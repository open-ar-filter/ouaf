# Engine architecture (phase 1 skeleton)

Status: **accepted** (2026-11-21), issues #11 (public API), #12 (plugins), #17 (stages and stack). Code:
`packages/core/src/engine/`. This note is the contract the layer types, sources, outputs and tools of phase 1 build
on; read it before adding a layer type.

## Public API

```ts
const engine = createEngine({ canvas, assetsBaseUrl: '/ouaf/', maxFaces: 1, plugins: [myPlugin] })
await engine.setSource(await CameraSource.open({ facingMode: 'user' }))   // or VideoFileSource, a <video>
const crown = await engine.addFilter('/filters/crown/', { size: 1.2 })     // folder URL, or memorySource({...})
crown.setParam('size', 1.5)          // validated now, applied at the start of the next frame (spec §9)
crown.on('paramChange', (c) => …)
crown.moveTo(0); crown.enabled = false; crown.remove()
await engine.setFilters(['/filters/a/', { src: '/filters/b/', params: {…} }])  // atomic swap, no empty frame
engine.on('stats' | 'warning' | 'error' | 'performance' | 'filter:<name>', …)
engine.dispose()
```

Errors are typed and carry a stable `code` (`OuafError` and subclasses: `InvalidManifestError` with the validator
issues, `IncompatibleEngineError`, `MissingPluginError`, `IncompatibleSourceError`, `AssetError`, `InvalidParamError`).
A failed `addFilter`/`setFilters` leaves the stack unchanged. Compatibility (spec §17) is checked against
`ENGINE_VERSION` (`1.0.0`, the format level implemented), not the package version.

## One frame

```
camera frame (FrameScheduler, requestVideoFrameCallback)
 → tracking.submit(video)        eager, one frame in flight, shared by the stack (spec §7)
 → params.beginFrame(mediaTime)   per filter: transitions advance, queued changes commit, paramChange fires
 → anchors.setFrame(latest result, mirrored)
 → layer.update(frame)           every layer of every enabled filter, then plugin render passes
 → compositor.render(stages)
```

Tracking results are double-buffered (`TrackingHub`): an asynchronous tracker (worker) writes into the back buffer;
layers read the latest completed result. The tracking rate (spec §16.1) is measured there.

## Plugins (spec §14)

A plugin is `{ name, version, official?, vocabulary?, setup(api) }`. `vocabulary` (layer types with their TypeBox
schemas, anchors, events, data paths) is merged into the engine's validation registry (`engine.registry`, used by
`validateManifest`); third-party names are prefixed (`acme:glow`). `setup` registers implementations:
`registerLayerType`, `registerTracker`, `registerAssetLoader`, `registerSource`, `registerLandmarkModifier`,
`registerRenderPass`, `registerEventSource`. The engine's own features are plugins (`builtinPlugins()`): today the face
tracker; each v1 layer type is added there as its own plugin. Built-in plugins are official and declare no vocabulary
(the v1 vocabulary is in `createRegistry()`).

## Layer types

`LayerTypeImpl { type, assets?(decl), create(decl, ctx) }` → a `LayerInstance`, one per layer declaration:

- **pass** (`background`, `face`, `warp`, `color` stages): `{ kind: 'pass', stage, active, update(frame),
  render(pass) }`. `render` reads `pass.input` (texture of the image so far) and draws into `pass.output` with
  `pass.drawFullscreen(material)` (vertex shader: `FULLSCREEN_VERTEX`, `vUv` in [0, 1]). `active = false` skips the
  pass (and its full-screen copy) for the frame.
- **object** (`objects`, `overlay` stages): `{ kind: 'object', stage, object, update(frame) }`. `object` is a three.js
  root added to the shared scene; the layer positions its children in `update` (one per face when `faces` selects
  several) and toggles their visibility. Depth sorting is three.js's.

`assets(decl)` lists the references the layer needs (`src`, `font`, `lut`, `textures`); the engine resolves them
(asset name, `assets/…` path, `builtin:…`; remote URLs refused) and preloads them all with the loader registered for
their kind **before** the filter is activated (spec §10.4). The layer gets them with `ctx.assets.get(ref)`. Loaders
are registered per kind by the plugin that owns the format (images and videos: sticker; glTF: model; `.cube`: color;
fonts: text). The core loads `data` (JSON) and `shader` (text).

`ctx` (`LayerContext`) gives the WebGL renderer, the objects camera, the preloaded assets, the params (read-only:
resolve a parameter once with `ctx.params.indexOf`, read its animated value each frame with `numberAt`) and `maxFaces`. `frame` (`FrameContext`, valid during the call only) gives `time`, `now`, `dt`, the latest `faces`
(`FaceFrame`), `anchors`, the render size and `mirrored`. `update` and `render` must not allocate in the steady state.

## Stages and compositing (spec §7)

`Compositor` (`compositor.ts`): `background → video → face → warp → objects → color → overlay`. Pass stages ping-pong
between two RGBA8 render targets; `objects` and `overlay` render their scenes onto the current image (depth cleared
before each); the result is copied to the canvas. **Fast path**: when no pass is active, the video, objects and
overlay go straight to the canvas, with no render target and no copy (stickers, text, models).

Stack rules: within a stage, stack order then layer order; passes are chained; objects are merged; the background is
exclusive (last enabled filter wins, with a warning). The per-stage lists are rebuilt only when the stack changes.

Image buffers hold **sRGB-encoded bytes**, like the camera texture and the canvas: raw shader passes read and write
them unchanged. Render targets are tagged sRGB with an RGBA8 internal format, so lit three.js materials are encoded the
same way whether they render to a target or to the canvas (to verify with the model layer, #21).

## Spaces and anchors

Objects use a perspective camera matched to the tracker: camera space in cm, +x right, +y up, looking down -z,
vertical field of view 63° over the analysed frame (MediaPipe's face geometry convention), the cover crop applied in
the projection. `frame.anchors.face(i, anchor, follow, outMatrix)` gives the anchor frame of face slot `i` in that
space, scaled so 1 unit = the distance between the eye centres (spec §5.1). Mirroring (front camera) is applied to the
poses (M' = S·M·S, S = diag(-1, 1, 1)), never to the projection, so text and models are not mirrored.
`anchors.screen(out)` places `anchor: "screen"` content on a plane in front of the faces, 1 unit = screen height.

The current `AnchorProvider` is **provisional** (landmark positions at the head's depth, MediaPipe's pose matrix when
present, roll from the eyes otherwise); #13 replaces it with the real anchor math (pose from landmarks, rigid vs
expression anchors, smoothing, stable face ids) behind the same interface.

## Provisional parts, and who replaces them

| Part | Now | Replaced by |
|---|---|---|
| Params `apply: "reload"` | applied at the next frame like `live` | engine `ReloadHooks`: preload a new filter instance, swap it in |
| Anchors (`ProvisionalAnchors`) | landmark positions, MediaPipe pose | #13 |
| Face tracker | MediaPipe tasks-vision, main thread | LiteRT.js pipeline in a worker (face-runtime.md, tracking-worker.md) |
| Bindings | read by each layer by hand | #15 evaluator, compiled per layer |
| Scripts, `send`, `filter:<name>` | warning, no-op | #26 sandbox |
| `performance` events, hiding below the floor | `Compositor.render(passes, showFilters)` ready | #90 governor |
| Built-in resources (`builtin:`) | `<assetsBaseUrl>/builtin/<name>` | #65 layout |

## Testing a layer type

- Unit tests (Node): `loadFilter` with fake layer types (`packages/core/test/engine-filter.test.ts`).
- Browser: `/engine.html?source=<clip>&autostart&filter=/filters/<path>/` (repeatable `filter`), `window.ouaf` exposes
  the engine, `@ouaf/core`, stats, warnings and errors. Fixture filters live in `filters/fixtures/`; the playground's
  test plugin (`playground:tint`, `playground:dot`) shows a minimal pass and object layer. `e2e/engine.spec.ts` checks
  pixels from a canvas screenshot decoded in the page.
