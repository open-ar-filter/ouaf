# Engine architecture (phase 1 skeleton)

Status: **accepted** (2026-11-21), issues #11 (public API), #12 (plugins), #17 (stages and stack). Code:
`packages/core/src/engine/`. This note is the contract the layer types, sources, outputs and tools of phase 1 build
on; read it before adding a layer type.

## Public API

```ts
const engine = createEngine({ canvas, assetsBaseUrl: '/ouaf/', maxFaces: 1, plugins: [myPlugin] })
await engine.setSource(await CameraSource.open({ facingMode: 'user' }))   // or a video, canvas, image, OfflineVideoSource
const crown = await engine.addFilter('/filters/crown/', { size: 1.2 })     // folder URL, or memorySource({...})
await engine.addFilter('/filters/crown.ouaf'); await engine.addFilter(file)  // a .ouaf: URL, Blob/File, bytes
crown.setParam('size', 1.5)          // validated now, applied at the start of the next frame (spec §9)
crown.on('paramChange', (c) => …)
crown.moveTo(0); crown.enabled = false; crown.remove()
await engine.setFilters(['/filters/a/', { src: '/filters/b/', params: {…} }])  // atomic swap, no empty frame
engine.on('stats' | 'warning' | 'error' | 'performance' | 'sourceEnd' | 'filter:<name>', …)
engine.send('tint', '#f00'); crown.send('tint', '#f00')          // to every script / to one (`message:tint`)
const photo = await engine.snapshot({ type: 'image/jpeg' })      // Blob of the next frame (#33)
const rec = engine.record({ audio: micStream }); const video = await rec.stop()
const stream = engine.outputStream()                             // MediaStream, e.g. for WebRTC
engine.dispose()
```

Errors are typed and carry a stable `code` (`OuafError` and subclasses: `InvalidManifestError` with the validator
issues, `IncompatibleEngineError`, `MissingPluginError`, `IncompatibleSourceError`, `AssetError`, `InvalidParamError`,
`PackageError`).
A failed `addFilter`/`setFilters` leaves the stack unchanged. Compatibility (spec §17) is checked against
`ENGINE_VERSION` (`1.0.0`, the format level implemented), not the package version.

- **Filter inputs** (`FilterInput`): a URL whose path ends with `.ouaf` (query and hash aside) is a package, any
  other URL a filter folder or its `manifest.json` (development); a `Blob`/`File`, `ArrayBuffer` or `Uint8Array` is a
  package; anything else must be a `FilterSource` (`memorySource`, `urlSource`, `packageSource`, the host's own). A
  package served under another name is loaded with `fetchPackage(url)` or as a `Blob`.
- **Packages** (`package.ts`, spec §3, §15.4): the archive is checked when opened, with the rules of `ouaf validate`
  shared through `@ouaf/spec` (`readZipEntries`, `checkPackageEntries`, `checkPackageSize`): stored and deflated
  entries only, no links or special entries, no absolute path or `..`, no duplicate, at most 1000 entries, at most
  50 MB for its files unpacked (declared sizes), a root `manifest.json`; files outside the layout are ignored. The
  archive itself is only bounded by that limit plus the zip structure (`PACKAGE_MAX_ARCHIVE_BYTES`, 51.14 MB), so that
  a valid package is never refused for its headers. Entries are inflated lazily (`DecompressionStream('deflate-raw')`) when the loader reads them, one at
  a time, stopping as soon as one goes past its declared size (zip bomb); size and CRC-32 are checked. The engine
  preloads every asset before a filter goes live, so a corrupt entry still fails `addFilter`. A broken package
  throws `PackageError` (code `invalid-package`, `reason` = the `ouaf validate` issue code, `path` = the entry); a
  corrupt asset entry arrives as the `cause` of an `AssetError`. A URL package is the only request made: it is
  refused past that archive bound from `Content-Length` or while it downloads.
- **Events**: listeners run synchronously, in subscription order. A throwing listener does not stop the others; its
  error becomes a `warning` (a throwing `warning` listener goes to `console.error`, so it cannot loop). `stats`
  (`fps`, `trackingHz`, `faces`, `frameMs`, `tracker`, `width`, `height`) comes about once per second while frames
  are rendered, over a window that restarts with each source.
- **Messages** (spec §12.4, §13): `send(name, data)` checks the name (a letter, then letters, digits, `_`, `-`) and
  copies `data` at the call (`structuredClone`), so data that cannot reach the sandbox throws
  `OuafError('invalid-message')` at the caller and later changes to `data` change nothing. Data over 64 KB throws the
  same error, the limit of `f.emit` in the other direction, measured the same way (`script/size.ts`: a walk of the
  copy, strings at 2 bytes a character, typed arrays at their byte length; it stops at the limit, so it costs little
  even for large data, and needs no serialization). Messages are delivered with
  the next frame sent to each script that lists `message:<name>` in `script.on`; a disabled filter keeps them until it
  is re-enabled; a removed filter ignores them.
- **Ownership**: a source the host passes stays the host's: the engine never stops it, not even in `dispose()` (stop a
  `CameraSource` yourself). A source a source plugin creates is the engine's and is disposed when replaced.
- **`dispose()`** frees everything the engine holds: the feed, every filter (layers, assets, GPU resources, script
  sandboxes and Workers), the render passes, the tracker, the outputs (recordings stop, output streams end, pending
  snapshots reject) and the listeners. It also loses the canvas's WebGL context for good (`forceContextLoss`), so that
  GPU memory is freed at once and the browser's cap on live contexts is not reached: **a new engine needs a new
  canvas**. Pending and later calls reject or throw `OuafError('disposed')`; `dispose()` itself is idempotent.

## One frame

```
camera frame (FrameScheduler, requestVideoFrameCallback)
 → tracking.submit(video)        eager, one frame in flight, shared by the stack (spec §7)
 → params.beginFrame(mediaTime)   per filter: transitions advance, queued changes commit, paramChange fires
 → identity + smoothing        on each new tracking result (time of the analysed frame)
 → expression detectors        per face filter, with its `events` tuning → handle.on('expression') (spec §13)
 → prediction to the displayed frame, anchors.setFrame(predicted faces, ids, mirrored)
 → layer.update(frame)           every layer of every enabled filter, then plugin render passes
 → compositor.render(stages)
```

Tracking results are double-buffered (`TrackingHub`): an asynchronous tracker (worker) writes into the back buffer;
layers read the latest completed result. The tracking rate (spec §16.1) is measured there.

## Sources (#32, spec §12.1, §12.5)

`engine.setSource(input)` takes, by regime:

| Input | Regime | Frames | Time | Tracking |
|---|---|---|---|---|
| `CameraSource`, `VideoFileSource`, a playing `<video>`, plugin sources | live | each new video frame (`FrameScheduler`) | clock (camera) or media time (file) | eager, latest result |
| `HTMLCanvasElement`, `OffscreenCanvas` | live | every animation frame, read directly | clock | eager, latest result |
| `HTMLImageElement`, `ImageBitmap`, `VideoFrame` (still) | file | every animation frame | time since shown | once, MediaPipe IMAGE mode (again if the tracking config changes) |
| `OfflineVideoSource` (WebCodecs) | file | every frame of the file, paced by `rate` (`Infinity`: as fast as possible) | media time | each frame waits for its own result |
| `engine.pushFrame(frame, time)` | file | each pushed frame; resolves once drawn | `time` | each frame waits for its own result |

- **File regime**: a frame is rendered only once its own tracking result is in (`TrackingHub.track`), `frame.time`,
  `frame.now` and `frame.dt` follow the media time, and every run starts afresh: a new source, a loop or a time going
  back resets face identity, the tracker's temporal state (`FrameTracker.reset`: MediaPipe rebuilds its graph) and the
  seeds. Two runs of the same input give the same images (`e2e/sources.spec.ts`).
- **Seeds**: every layer gets `ctx.random()`, its own `SeededRandom` (mulberry32), seeded from
  `deriveSeed(base, filterId, 'layer', index)`; the filter keeps one more for its script (#26). `base` is
  `createEngine({ seed })` when set, else a fixed constant for file sources, else random per activation. Filters are
  reseeded at activation and on every new source run.
- **Offline video**: `OfflineVideoSource.open(url | Blob | bytes)` reads the whole file, demuxes it with the built-in
  MP4 / MOV demuxer (`mp4.ts`: H.264, H.265, VP9, AV1; edit list and rotation applied; no fragmented MP4) and decodes it
  with `VideoDecoder`, a few frames ahead. `engine.on('sourceEnd')` fires after the last frame (without `loop`).
- **Errors** (`IncompatibleSourceError`): the engine's own canvas, an image without pixels, a tainted image or canvas
  (checked by reading one pixel back; a live canvas is checked again once a second, since it can become tainted).
- **Compositor**: the `video` stage draws any of these images. While a paused `<video>` seeks it has no frame to upload;
  the last uploaded one is drawn instead of nothing (the black frames noted in #116).

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
  several) and toggles their visibility. It may list its instances' `placements` (object, anchor, face id, offset
  z) for the draw order below.

`assets(decl)` lists the references the layer needs (`src`, `font`, `lut`, `textures`); the engine resolves them
(asset name, `assets/…` path, `builtin:…`; remote URLs refused) and preloads them all with the loader registered for
their kind **before** the filter is activated (spec §10.4). The layer gets them with `ctx.assets.get(ref)`. Loaders
are registered per kind by the plugin that owns the format (images and videos: sticker; glTF: model; `.cube`: color;
fonts: text). The core loads `data` (JSON) and `shader` (text). Built-in resources (`builtin:lut/noir`) are fetched
from `<assetsBaseUrl>builtins/`, where the host serves the `assets/` folder of `@ouaf/builtins` (`resolveBuiltin`).

**Content properties** (spec §8.1: `sticker.src`, `model.src`, `text.font`, `color.lut`, marked `x-content` in their
schema) may be bound to a param. The engine preloads their `map` values and, in a filter with a script, every
declared asset of a kind they show (a script may set any of them; `contentRefs`). A layer compiles each with
`compileContent` and evaluates it per face: the script's asset, the param's (a `map` value, or the host's file from
`ctx.hostAssets`), or `undefined` for its own fixed asset or pick. Host files of `asset` params go through
`HostAssets`: the declared type and size are checked by `setParam`; the content (`sniff` against `accept` and the
property's kind, `hostFileProblem`) and the loader's checks run when the file is loaded, in the background
(`ParamStore` asset hooks); the file is swapped in at the start of a frame once ready, and the one it replaces is
released after that frame. A refused file emits an `InvalidParamError` (reason `content`) on `engine.on('error')`
and changes nothing; an initial file (`addFilter(src, { params })`) that fails rejects `addFilter`.

`ctx` (`LayerContext`) gives the WebGL renderer, the objects camera, the preloaded assets, the params (read-only:
resolve a parameter once with `ctx.params.indexOf`, read its animated value each frame with `numberAt`) and `maxFaces`. `frame` (`FrameContext`, valid during the call only) gives `time`, `now`, `dt`, the latest `faces`
(`FaceFrame`), `anchors`, the render size and `mirrored`. `update` and `render` must not allocate in the steady state.

Fractional numbers are the usual trap (#149, #159): V8 boxes one (a 16-byte heap number) when it passes it to, or
returns it from, a call it does not inline, which depends on the caller's size and on compilation order; when a
builtin such as `Array.prototype.sort` calls the function; and when a conditional merges it with the global `NaN` or
`Infinity` (`ok ? x : NaN`). Per-frame helpers therefore take arrays and offsets and write their results into arrays
(`projectToUv`, `WarpPacker`, `videoToCameraInPlace`), and merge with `NaN` through two stores. The unit tests measure
the per-frame paths with V8's default inlining (`bytesPerCall`, in each component's tests) and with only small
functions inlined (`allocation-inlining.test.ts`), which catches a boxing call whatever V8 decides to inline.

## Stages and compositing (spec §7)

`Compositor` (`compositor.ts`): `background → video → face → warp → objects → color → overlay`. Pass stages ping-pong
between two RGBA8 render targets; `objects` and `overlay` render their scenes onto the current image (depth cleared
before each); the result is copied to the canvas. **Fast path**: when no pass is active, the video, objects and
overlay go straight to the canvas, with no render target and no copy (stickers, text, models).

Stack rules: within a stage, stack order then layer order; passes are chained; objects are merged; the background is
exclusive (last enabled filter wins, with a warning). The per-stage lists are rebuilt only when the stack changes.

**Draw order of transparent objects** (`draw-order.ts`, #150): three.js sorts them back to front by the depth of their
centre, which swaps objects stacked on one anchor when the head turns (a text 0.02 in front of its bubble, off its
centre). Spec §7 orders objects of the same face on the same anchor by their offset z, then stack and layer order.
`DrawOrder` is the renderer's transparent sort (`setTransparentSort`): before each render it sorts the placements
shown into groups (stage, face id, anchor; the screen is one anchor) by offset z then rank, and gives the members of
each group of two or more a sort depth, the running minimum of their own depths along the group (a member is never
drawn before the ones it covers), with the group order as tie-break. Every other object keeps three's depth. Each
render item thus has one fixed key, which keeps `Array.sort` well defined (a pairwise rule "same anchor: offset,
else depth" would not be transitive), and each member sits among the other objects at its own depth, or at the depth of a member
it must cover when it is deeper than that one.
The meshes of a model's instance share its key and keep their own depth order among themselves. Insertion sort over
preallocated entries: no per-frame allocation (`draw-order.test.ts`). Opaque objects and the head occluders are not
affected: they use the depth buffer.

Image buffers hold **sRGB-encoded bytes**, like the camera texture and the canvas: raw shader passes read and write
them unchanged. Render targets are tagged sRGB with an RGBA8 internal format, and flagged `isXRRenderTarget`: three only
encodes its built-in materials' output to the target's color space for XR targets, so without it lit models and text
were written linear (darker) whenever a pass was active. They now get the same bytes whether they render to a target
or to the canvas (checked by `e2e/model.spec.ts`, #21).

## Outputs (#33)

`engine.snapshot()`, `engine.record()` and `engine.outputStream()` give the host the composited image as the user sees
it (mirrored for a front camera, spec §5.1), at the internal render size, minus the overlay layers marked
`excludeFromCapture` (spec §6.2). Code: `outputs.ts`.

- **Capture surface**: overlay layers with `excludeFromCapture` are a third scene (`Compositor.excludedOverlay`),
  drawn last, straight into the canvas. While an output is in use, the compositor copies the canvas into a hidden 2D
  canvas (`drawImage`, in the task that rendered it) just before drawing them. With no output in use nothing is
  copied; the excluded overlays are drawn last either way, so the screen does not change when a recording starts.
  Consequence: they are drawn above the other overlay layers, whatever the stack and layer order (spec §6.2).
- **`snapshot({ type, quality })`**: resolves with the next rendered frame, encoded by the browser (`toBlob`; PNG by
  default). It waits while nothing is rendered (no source, a paused video) and rejects if the engine is disposed.
- **`outputStream({ frameRate })`**: `captureStream()` of the capture surface, a new stream per call, one video track,
  a frame per rendered frame. The copy runs until the host stops every track it was given; `dispose()` ends them.
- **`record(options)`**: `MediaRecorder` on such a track plus the audio tracks the host passes (`audio`: the engine
  never opens the microphone and never stops the host's tracks). Real time: an `OfflineVideoSource` at `rate: Infinity`
  is not recorded frame by frame. Type: `mimeType` if given (refused when unsupported), else the first supported of
  `RECORDING_TYPES`: H.264 MP4 (plays everywhere, iOS and messaging apps included, hardware-encoded on most devices),
  then WebM VP9, VP8, then the bare `video/mp4` / `video/webm`. Chunks every second; `stop()` and `done` resolve with
  one `Blob`. Errors: `OuafError` with code `unsupported` (no `MediaRecorder`, type, `captureStream` in a worker).

## Spaces and anchors

Objects use a perspective camera matched to the tracker: camera space in cm, +x right, +y up, looking down -z,
vertical field of view 63° over the analysed frame (MediaPipe's face geometry convention), the cover crop applied in
the projection. `frame.anchors.face(i, anchor, follow, outMatrix)` gives the anchor frame of face slot `i` in that
space, scaled so 1 unit = the distance between the eye centres (spec §5.1). Mirroring (front camera) is applied to the
poses (M' = S·M·S, S = diag(-1, 1, 1)), never to the projection, so text and models are not mirrored.
`anchors.screen(out)` places `anchor: "screen"` content on a plane in front of the faces, 1 unit = screen height.

Anchors come from #13 (`packages/core/src/anchoring/`): head pose fitted to the landmarks (MediaPipe's face geometry,
so any tracker works), rigid anchors from the canonical face, expression anchors from the live landmarks. Each new
tracking result gets a stable face id (500 ms grace delay, `frame.anchors.id(i)`) and One Euro smoothing per face;
every rendered frame then extrapolates the smoothed landmarks to its own time (at most 100 ms), which hides most of
the age of a worker tracker's results. Layers and bindings read these predicted faces.

## Scripts (spec §12, #26)

Code: `packages/core/src/script/`. A filter with a `script` section has its `script.js` read at load time; when the
filter is added to the stack, the engine starts a `ScriptHost` for it:

- **Sandbox** (`sandbox.ts`): a `sandbox="allow-scripts"` `srcdoc` iframe with a CSP that blocks the network, which
  starts a classic Worker from a `blob:` URL and hands it one end of a `MessageChannel`. Removing the iframe kills the
  Worker (watchdog). A module Worker does not load from a `blob:` URL of an opaque origin in Chromium, hence classic.
- **Runtime** (`runtime.ts`): the Worker's code, a self-contained function turned into source with `toString()` (no
  bundler-specific worker import); `import()` of `script.js` lives in the Worker source text, because bundlers rewrite
  `import()` calls in code. It implements `f`, timers in media time, events in order, per-face state.
- **Host** (`host.ts`): one frame in flight; answers are applied at the start of the next rendered frame
  (`beginFrame`, before the layers update), frames are sent after rendering (`endFrame`); 1 s watchdog
  (`OuafError('SCRIPT_STOPPED')`), re-armed instead when its timer fires more than 250 ms late (the main thread was
  busy, so the answer may be queued behind the timer); at activation it starts when the runtime says that the script
  starts (`started`), after the runtime has prepared the canvases and fonts (10 s bound before that); `f.emit`
  limits.
- **Canvas images** (#25, #158): the Worker's canvases are CPU-backed (`willReadFrequently`) and read with
  `getImageData`, premultiplied in the Worker; the pixels are transferred and uploaded as a `DataTexture`. A
  GPU-backed canvas and `transferToImageBitmap` made each draw wait on the GPU process, busy with the engine's own
  rendering: about 1 s per draw of the `stress` demo with SwiftShader on 2 cores, which tripped the watchdog. The
  slow first use of a canvas is paid at `init`, before `started`.
- **Script values** (`overrides.ts`): in a scripted filter, every bindable property compiled with a `name`
  (`BindableProperty.name`) is wrapped by the bindings compiler (`BindingEnv.overrides`), so `.set()` and
  `.animate()` reach every layer type without code in the layers. Values are per face id or for every instance;
  animations run on a media-time clock. Layer types only need to pass `name` when they compile their properties.
- **Frame data** (`frame-data.ts`): only what `script.uses` declares, in normalized display space, plus
  `frame.aspect` (the render size's width / height: the displayed image, cover crop included; no pixel sizes, which
  depend on the device).
- **Canvas fonts** (#150, spec §12.6): the `font` assets of the manifest (files, or `builtin:font/…` under a name of
  the filter) are preloaded with the others; the font loader keeps their bytes (`LoadedFont.data`) and the host sends
  them with `init` (copied, since text layers keep using them). The runtime registers each one in the Worker's
  `FontFaceSet` (`new FontFace(name, bytes)`, family = the asset name, unquoted: Chromium takes the string as the
  name itself, quotes included) and awaits them before importing `script.js`, so `setup` and the first draw have
  them. No fetch: the sandbox CSP is unchanged. Without `FontFace` or `self.fonts` in the Worker, one warning and the
  platform's fonts.
- **Seed**: the script's `f.random()` runs in the Worker, seeded with `scriptSeed(filter.seed)`; when the engine
  reseeds the filter (a new source run, #32), the next frame sent carries the new seed.
- **Models and shaders**: `.play(name)` goes to `ModelLayerInstance.play`; shader uniforms are set as
  `.set({ uniforms: { name: value } })`, registered as the properties `uniforms.<name>`.

## Provisional parts, and who replaces them

| Part | Now | Replaced by |
|---|---|---|
| Params `apply: "reload"` | applied at the next frame like `live` | engine `ReloadHooks`: preload a new filter instance, swap it in |
| Face tracker | MediaPipe tasks-vision, main thread | LiteRT.js pipeline in a worker (face-runtime.md, tracking-worker.md) |
| Host files for a video or spritesheet sticker, or a shader texture | images only; `textures` take assets only | a later version (spec §8.1) |
| Scripts waiting for the answer with file sources (spec §12.1) | never waits | #32 (offline sources) |
| `performance` events, hiding below the floor | `Compositor.render(passes, showFilters)` ready | #90 governor |
| Head occluder (`model.occlusion: "head"`) | the face landmark mesh, moved back 0.2 face units along the camera rays, closed by the back of an average head (#155); the ellipsoid alone without usable landmarks | ears and hair (segmentation), one occluder per face shared by the layers |
| Model animations | three's `AnimationMixer` (boxes a few numbers per animated face and frame) | an allocation-free sampler, if profiles show GC |
| Frame-exact video export | `record()`: `MediaRecorder`, real time; WebM without duration in its header (not seekable until remuxed) | WebCodecs `VideoEncoder` + an MP4 muxer, driven by file-regime frames (#137) |
| glTF limits | 32 MB per file, textures not size-checked, no KTX2 textures | the limits of spec Appendix C; KTX2 with #116 |

## Testing a layer type

- Unit tests (Node): `loadFilter` with fake layer types (`packages/core/test/engine-filter.test.ts`).
- Browser: `/engine.html?source=<clip>&autostart&filter=/filters/<path>/` (repeatable `filter`; a `.ouaf` URL, the
  **Open .ouaf** picker or a file dropped on the page load packages), `window.ouaf` exposes
  the engine, `@ouaf/core`, stats, warnings and errors. Fixture filters live in `filters/fixtures/`; the playground's
  test plugin (`playground:tint`, `playground:dot`) shows a minimal pass and object layer. `e2e/engine.spec.ts` checks
  pixels from a canvas screenshot decoded in the page.
