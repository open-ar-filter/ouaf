# Ouaf v1 — Open Universal AR Filter format

**Status**: draft `1.0.0-draft.1` (2026-11-20). Sections marked *provisional* will be confirmed by the performance
prototype (phase 0) and the core implementation (phase 1).

**Reference schema**: [`ouaf-v1.schema.json`](./ouaf-v1.schema.json), generated from the TypeBox schemas in
`packages/spec` (single source of truth). If this document and the schema disagree, the schema is authoritative
for structure and this document for behavior.

---

## 1. Purpose

Ouaf is an **open** format for real-time AR filters (face first, then body, hands and voice) on the web. A filter
describes what gets added to an image or a sound: text, images, 3D objects, deformations, colors, effects, interactive logic.

Design goals:

1. **Declarative first**: most filters contain no code at all.
2. **Portable**: built on existing standards (glTF 2.0, KTX2, Lottie, `.cube`, GLSL ES 3.0, zip, SPDX).
3. **Safe**: a filter cannot leak data; its code runs in a sandbox.
4. **Fast**: the engine knows everything a filter needs without running any code.
5. **Easy to produce, including by AI**: precise contract (JSON Schema), actionable errors.

## 2. Conventions

- **MUST**, **MUST NOT**, **SHOULD**, **MAY** are to be interpreted as described in RFC 2119.
- Paths into the manifest are JSON pointers (RFC 6901), e.g. `/layers/2/anchor`.
- Angles are in **degrees**, durations in **milliseconds**, data time in **seconds**.
- Colors are hexadecimal: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`.
- An **engine** is an implementation that loads and runs filters; a **host** is the page that embeds the engine.

## 3. The `.ouaf` package

A package is a **zip** archive containing, at its root:

```
manifest.json     required — describes the filter (section 4)
script.js         optional — filter logic (section 12), ES module
assets/           optional — files referenced by the manifest (section 10)
```

- Paths MUST be relative, use `/`, contain no `..`, and asset files MUST live under `assets/`.
- A package MUST NOT contain symbolic links or files outside this layout; an engine MUST ignore them.
- Recommended size: **≤ 5 MB** (warning above); an engine MAY refuse packages above **50 MB**.
- During development, an engine MAY load the unzipped **folder**, served over HTTP.

### 3.1 Authoring: `filter.js` → package

Authors write a single `filter.js` (or `filter.ts`) file whose default export is an object: the manifest **data**,
plus **functions** (`setup`, `update`, `on`, `draw`) and the initial `state`.

```js
export default {
  id: 'text-bubble', name: 'Bubble', version: '1.0.0', license: 'CC0-1.0',
  requires: { face: true },
  layers: [{ type: 'text', text: 'Hi 👋', anchor: 'forehead', offset: [0, 0.9, 0] }],
}
```

The `ouaf pack` tool runs this file **once, in a sandbox**, separates data from functions, writes `manifest.json`
(filling in the `ouaf` field and the `script` section), bundles the functions into `script.js` and zips everything.
The engine reads the manifest **without running any code**.

## 4. Manifest

| Field | Type | Req. | Description |
|---|---|---|---|
| `ouaf` | `"1"` | ✔ | Major version of the format. |
| `engine` | semver range | | Compatible engine versions (default `^1`). |
| `id` | identifier | ✔ | Lowercase letters, digits, dashes; 64 characters max. |
| `name` | localized text | ✔ | Display name. `"Pirate"` or `{ "en": "Pirate", "fr": "Pirate" }`. |
| `version` | semver | ✔ | Filter version. |
| `description` | localized text | | |
| `author` | text | | |
| `license` | SPDX | ✔ | License of the filter, e.g. `CC0-1.0`, `MIT`, `CC-BY-4.0`. |
| `credits` | list | | `{ what, author, license, source? }` for each third-party item. `source` is never loaded. |
| `thumbnail` | `assets/…` path | | Thumbnail. |
| `tags` | list | | Keywords `[a-z0-9-]`. |
| `requires` | object | ✔ | Required capabilities (4.1). |
| `params` | object | | Tunable parameters (section 9). |
| `presets` | object | | Named presets (section 9). |
| `assets` | object | | Asset table (section 10). |
| `layers` | list | ✔ | Layers (section 6), 64 max. |
| `events` | object | | Tuning of derived events: `{ "mouthOpen": { "threshold": 0.5, "minDurationMs": 100 } }`. |
| `script` | object | | Filled in by `ouaf pack` (section 12.2). |

Any property not defined by this document is an **error** (no free-form fields), so that typos are caught.

### 4.1 `requires`

| Field | v1 | Effect |
|---|---|---|
| `face` | ✔ | Loads face tracking (478 landmarks, 52 blendshapes, pose). |
| `hands`, `segmentation`, `pose`, `audio` | reserved | Warning in v1; provided by later versions. |
| `plugins` | ✔ | Required plugins: `["mood@^1"]`. An engine MUST refuse the filter when a plugin is missing, with an explicit message. |

An engine MUST only load the trackers requested by the active filters. A filter that uses the face (anchor, data
or event) without `requires.face` is **invalid**.

## 5. Frames and anchors

### 5.1 Face anchor frame

- Origin: the anchor point. **Unit: the distance between the centers of the two eyes** (≈ 6.3 cm for an adult).
- Axes, as seen on screen: **+x** towards the right of the image, **+y** up (towards the forehead), **+z** out of the face
  towards the camera. The frame follows the head rotation.
- **Mirroring** (front camera) is handled by the engine: what you see is what gets captured, and offsets apply as seen on screen.
- "Left" / "right" in anchor names refer to the **person's** side (their left eye appears on the left of the screen in mirrored view).
- 3D objects (glTF) are expressed in this frame: **1 glTF unit = 1 face unit**, unless the layer uses `fit`.

### 5.2 Screen frame (`anchor: "screen"`)

Origin at the **center**, +x right, +y up, **1 unit = screen height** (y goes from -0.5 to +0.5).

### 5.3 v1 anchors

| Anchor | Description |
|---|---|
| `head` | Center of the head; follows the full pose. Default anchor. |
| `forehead` | Top of the forehead. |
| `eyes` | Midpoint between the eyes. |
| `leftEye`, `rightEye` | Center of each eye. |
| `noseBridge`, `noseTip` | Middle of the bridge, tip of the nose. |
| `mouth`, `upperLip`, `lowerLip` | Center of the mouth, middle of each lip. |
| `chin` | Bottom of the chin. |
| `leftCheek`, `rightCheek` | Cheekbones. |
| `leftTemple`, `rightTemple` | Temples (edges of the face at eye level). |
| `screen` | Screen frame (5.2). |

Plugins MAY add anchors (e.g. `leftShoulder` for body pose). The exact MediaPipe landmark (out of 478) behind each
anchor is defined by the reference implementation (*provisional*).

### 5.4 Multiple faces

- Each face has a **stable id** while it stays visible (grace delay of about 500 ms during occlusion).
  A person who leaves and comes back gets a **new** id: the format rules out any face recognition.
- The engine sets the maximum number of faces (`maxFaces`). A layer selects the faces it applies to with `faces`:
  `"all"` (default, one instance per face), `"first"`, `"largest"`, or a maximum count.

## 6. Layers

### 6.1 Common properties

| Property | Description |
|---|---|
| `type` | Layer type (required). |
| `id` | Identifier, unique within the filter; needed for the script to drive the layer. |
| `visible` | Boolean, *bindable*. |
| `opacity` | 0–1, *bindable*. |

### 6.2 Properties of anchored layers (`text`, `sticker`, `model`, `canvas`)

| Property | Default | Description |
|---|---|---|
| `anchor` | `head` | Anchor (section 5). |
| `offset` | `[0,0,0]` | Offset in the anchor frame, *bindable*. |
| `rotation` | `[0,0,0]` | Rotation in degrees, *bindable*. |
| `orient` | `face` | `face`: follows the head; `screen`: keeps facing the screen (readable text). |
| `faces` | `all` | Faces affected (5.4). |
| `overlay` | `false` | Drawn last, after color grading (UI, score). |
| `excludeFromCapture` | `false` | With `overlay`: left out of photos, videos and the output stream. |

### 6.3 v1 types

| Type | Role | Main properties |
|---|---|---|
| `text` | Text (emoji included) | `text`*, `size`, `font`, `color`, `outline`, `shadow`, `align`, `maxWidth`, `lineHeight` |
| `sticker` | Image, spritesheet or video | `src` (asset or `{ pick }`), `size`, `blend`, `loop`, `autoplay`, `rate` |
| `model` | 3D object | `src` (glTF, `{ pick }` or `{ shape }`), `scale`, `fit`, `animation`, `loop`, `occlusion` |
| `warp` | Deformation | `kind` (`bulge`, `pinch`, `swirl`, `stretch`), `anchor` (one or more), `radius`, `strength`, `direction`, `faces` |
| `color` | Color grading | `lut`, `intensity`, `brightness`, `contrast`, `saturation`, `temperature`, `tint`, `vignette`, `grain`, `region` |
| `shader` | GLSL effect | `src`, `stage` (`background`, `face`, `post`), `uniforms`, `textures` |
| `canvas` | Canvas 2D drawing by the script | `width`, `height`, `size`, `fps`; `id` required |

\* required. Exact bounds and defaults are in the schema.

Normative behavior:

- `text`: the engine SHOULD rasterize text once and redraw it only when its content or style changes.
  Emoji MUST be rendered with the built-in set (`builtin:font/emoji`) so they look the same on every device.
- `model.occlusion: "head"`: the part of the object hidden by the head is not drawn (hat, glasses temples).
- `model.fit`: the object is rescaled so its bounding box has the requested width or height.
- `model.src: { shape }`: primitives `box`, `sphere`, `torus`, `ring`, `cone`, `cylinder`, `plane`, of size 1, usable without any file.
- `warp` deforms the image **and** whatever was painted on the face before it (section 7).
- `canvas`: see 12.6.

### 6.4 Reserved types (later versions)

`faceTexture` (makeup on the UV template), `background` (background replacement), `particles`, `lottie`, `ui`, `voice`,
`garment2d`. A v1 validator reports them as unknown.

## 7. Render order and filter stack

Rendering follows **fixed stages**, in this order:

```
background → video → face → warp → objects → color → overlay
```

| Stage | Content |
|---|---|
| `background` | Background, shaders with `stage: "background"` |
| `video` | Input image |
| `face` | Face textures, shaders with `stage: "face"` |
| `warp` | Deformations (applied to everything before) |
| `objects` | `text`, `sticker`, `model`, `canvas`, depth-sorted |
| `color` | `color` layers and shaders with `stage: "post"`, chained |
| `overlay` | Layers with `overlay: true` |

A host MAY stack several filters. Within a stage, order is the **stack** order, then the **layer** order.

- Deformations, color grading and voice effects are **chained** in that order.
- Objects are **merged** and depth-sorted.
- The background is **exclusive**: the last filter in the stack wins, and the engine SHOULD emit a warning.
- Tracking (face, etc.) is **shared** by the whole stack: it is computed only once.
- Filters are isolated from each other: each has its own sandbox and cannot read the others' state.

## 8. Bindings

A property marked *bindable* accepts, instead of a fixed value:

| Form | Effect |
|---|---|
| `{ "param": "name" }` | Value of the `name` parameter (section 9). Types must be compatible (e.g. a size cannot bind to a text parameter). |
| `{ "bind": "path" }` | Tracking data, updated every frame. |
| `{ "bind": "…", "range": [a, b], "to": [c, d] }` | Value clamped to `[a, b]` then linearly mapped to `[c, d]`. `range` and `to` go together. |
| `{ "bind": "…", "map": { … } }` | Lookup table (required to transform string data). |
| `"default": …` | Value used when the data is missing (no face). |

v1 data paths: `time`, `faces.count`, `face.index`, `face.size`, `face.pose.yaw`, `face.pose.pitch`,
`face.pose.roll`, `face.blendshapes.<name>` (appendix B). Plugins MAY add more (e.g. `face.mood`).

Bindings are evaluated by the engine, **outside the sandbox**: they cost neither latency nor data transfer.
The language is deliberately limited to these forms; any richer logic belongs in the script.

## 9. Parameters and presets

```json
"params": {
  "size":  { "type": "number", "default": 1, "min": 0.5, "max": 2, "step": 0.1, "label": { "en": "Size", "fr": "Taille" } },
  "style": { "type": "select", "default": "gold", "options": { "gold": "Gold crown", "flowers": "Flowers" } },
  "team":  { "type": "select", "default": "", "options": { "from": "host" } },
  "logo":  { "type": "asset", "accept": ["image/png", "image/svg+xml"], "maxSize": 500000, "optional": true }
},
"presets": { "subtle": { "size": 0.7 }, "party": { "size": 1.5 } }
```

- Types: `number`, `boolean`, `string`, `text`, `color`, `select`, `vec2`, `vec3`, `asset`.
- Common metadata: `label`, `description`, `group` (localized), `visibleIf`, `apply` (`live` | `reload`), `transition` (ms).
- Parameters **belong to the host and the user**: the script reads them (`f.params`) but CANNOT modify them.
- An engine MUST reject an invalid value (type, bounds, unknown option) with an explicit error, never silently fix it.
- Changes are applied **at the start of the next frame**, batched per frame. `apply: "reload"`: preload, then swap
  without an empty frame. Numbers, colors and vectors MAY be animated (`transition`).
- `options: { "from": "host" }`: the list is supplied at runtime by the host.
- An `asset` parameter is a file supplied at runtime; it goes through the same checks as an untrusted asset (section 15).
- Preset values MUST be valid for their parameter.

## 10. Assets

### 10.1 Declaration

```json
"assets": {
  "hat":  "assets/hat.glb",
  "fire": { "src": "assets/fire.mp4", "alpha": "packed" },
  "walk": { "src": "assets/walk.png", "frames": { "cols": 4, "rows": 2, "fps": 12 } },
  "star": { "svg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'>…</svg>" },
  "cool": { "emoji": "😎" }
}
```

An asset reference (`src`, `font`, `lut`, `textures`…) is one of:

- a **name** declared in `assets`;
- an `assets/…` **path** inside the package;
- a **built-in resource** `builtin:…`.

**Remote URLs are forbidden** (`http:`, `https:`, `data:`…): a remote asset would be a way to leak data.

### 10.2 Formats

| Kind (`kind`) | Formats | Notes |
|---|---|---|
| `image` | PNG, WebP, JPEG, AVIF, SVG, KTX2 | KTX2 recommended on mobile. SVG is rendered as an image: no script, no external resource. |
| `spritesheet` | image + `frames` | Animated grid. |
| `video` | MP4 (H.264), WebM (VP9) | Transparency: `alpha: "packed"` (color on the left, mask on the right), portable across browsers. Muted by default. |
| `model` | glTF 2.0 / GLB | Animations, Draco or meshopt compression. |
| `lut` | `.cube` | |
| `shader` | `.frag`, `.glsl` | Section 11. |
| `font` | WOFF2, WOFF, TTF, OTF | |
| `audio` | OGG, MP3, WAV, Opus | Sound effects triggered by the script. |
| `lottie` | `.lottie`, or `.json` with `kind: "lottie"` | Reserved (Lottie plugin). |
| `data` | JSON | Data read by the script. |

The kind is inferred from the extension; `kind` overrides it when needed.

### 10.3 v1 built-in resources

Fonts `builtin:font/sans`, `sans-bold` (default), `rounded-bold`, `serif`, `mono`, `handwritten`, `emoji` (Noto);
LUTs `builtin:lut/vintage`, `noir`, `warm`, `cool`, `vivid`.

### 10.4 Loading

- An engine MUST preload all of a filter's assets **before** activating it.
- An engine MUST check size and dimensions **before** decoding (images ≤ 4096 px per side, videos ≤ 1080p, ≤ 720p recommended).
- Mobile recommendation: at most **2 videos** playing at the same time.

## 11. Shaders

```glsl
// assets/glitch.frag — the author only writes effect()
vec4 effect(vec2 uv) {
  vec4 c = ouaf_sample(uv + vec2(sin(ouaf_time * 20.0) * amount * 0.01, 0.0));
  return c;
}
```

- **Fragment only**, GLSL ES 3.0, **without** a `#version` directive or `main()`: the engine provides the wrapper.
- Provided inputs: `ouaf_sample(vec2)` (image at this stage), `ouaf_time` (s), `ouaf_resolution` (px), `ouaf_faceMask`,
  `ouaf_prevFrame` (previous frame, for trail effects); *provisional*: `ouaf_personMask`, `ouaf_audioLevel`, anchor positions.
- Each `uniforms` entry becomes a uniform of the same name (float, bool, vec2, vec3, color → vec4); each `textures`
  entry a `sampler2D`.
- `stage`: `background`, `face` (limited to the face mesh) or `post` (full screen, default).
- A validator SHOULD compile the shader and report errors with their line numbers.
- An engine MUST handle GPU context loss and disable a filter whose shader causes it.
- For a future WebGPU renderer, GLSL → WGSL translation happens at packaging time; authors only write GLSL.

## 12. Scripts *(provisional)*

### 12.1 Execution model

- The script runs in a **sandbox** (section 15): no DOM, no network, no access to the host.
- It talks to the engine through messages; its commands take effect with **at least one frame of latency**.
  Hence the rule: **spatial work is native** (anchoring, tracking, bindings) and **the script does the logic**
  (change a text, start an animation, count points).
- It only receives the data it asks for (12.4).

### 12.2 The manifest's `script` section (filled in by `ouaf pack`)

```json
"script": { "entry": "script.js", "setup": true, "update": true, "on": ["smile", "message:startGame"], "draw": ["bubble"], "uses": ["face.pose"] }
```

### 12.3 Functions in `filter.js`

```js
export default {
  // … manifest data …
  state: { smiles: 0 },                       // initial (global) state
  setup(f) { },                               // once, on activation
  on: {
    smile(f, { face }) {                      // every event carries the face concerned
      f.state.smiles++
      f.layer('label', face).set({ text: `😄 × ${f.state.smiles}` })
      f.layer('label', face).animate({ scale: [1, 1.4, 1] }, { duration: 300, easing: 'outBack' })
      f.emit('smiles', f.state.smiles)
    },
  },
  update(f, frame) { },                       // every frame (avoid it when a binding is enough)
  draw: { bubble(ctx, f, frame) { } },        // canvas layers
}
```

### 12.4 The `f` API and `frame` data

| API | Purpose |
|---|---|
| `f.layer(id, face?)` | Layer handle: `.set(props)`, `.animate(props, { duration, easing })`, `.play(animationName)`, `.invalidate()` (canvas). |
| `f.state` / `face.state` | Global state / per-face state. |
| `f.params` | Parameters, **read-only**. |
| `f.emit(name, data)` | Message to the host (`engine.on('filter:name')`). |
| `f.asset(name)` | Asset usable in a canvas. |
| `f.sound(name)` | `.play()`, `.stop()` *(reserved)*. |
| `f.random()` | **Seeded** random numbers (reproducible rendering). |
| `f.after(ms, fn)`, `f.every(ms, fn)` | Timers, in media time. |

`frame` contains `time` (media time, s), `faces` (list), and for each face `id`, `index`, and depending on `uses`:
`face.pose` + `face.size` (default), `face.blendshapes` (default), `face.anchors` (screen positions), `face.landmarks` (478 points).

### 12.5 Determinism

With a file source (image, video), a filter MUST produce the same result on every run:
`frame.time` is the media time and `f.random()` is seeded with a fixed value.

### 12.6 Canvas

`draw.<id>(ctx, f, frame)` receives a standard `CanvasRenderingContext2D` (`OffscreenCanvas`). The engine calls it at most
`fps` times per second; `fps: 0`: only after `f.layer(id).invalidate()`. The main cost is uploading the image to the GPU:
keep canvases small.

### 12.7 Limits

An engine MUST enforce a per-frame time budget for the script. A late answer is ignored for the current frame;
repeated overruns stop the script (the declarative rest of the filter keeps working).

## 13. Events

| Event | Trigger | Default threshold (tunable) |
|---|---|---|
| `faceEnter`, `faceLeave` | A face appears / disappears | — |
| `blink` | Both eyes close briefly | 0.5 |
| `wink` | A single eye; `payload.side` = `left` \| `right` | 0.5 |
| `mouthOpen`, `mouthClose` | `jawOpen` crosses the threshold | 0.35 |
| `smile`, `smileEnd` | Average of `mouthSmileLeft/Right` | 0.5 |
| `eyebrowRaise` | `browInnerUp` | 0.5 |
| `kiss` | `mouthPucker` | 0.6 |
| `nod`, `shake` | Vertical / horizontal head oscillation | 0.5 |
| `paramChange` | A parameter changed: `{ name, value, previous }` | — |
| `message:<name>` | Message from the host (`engine.send(name, data)`) | — |

- Expression events fire **once** at the start of the gesture, with **hysteresis** (no bursts on the slightest twitch).
- `events.<name>.threshold` and `minDurationMs` tune detection; the engine MAY calibrate against the person's neutral face.
- Reserved: `tap`, `doubleTap`, `longPress`, `drag`, `pinch`, `swipe`, `tap:<layer>`, `ended`, `cue:<time>`.

## 14. Plugins

- Plugins are **trusted code**, installed by the host. A filter CANNOT embed a plugin; it declares the plugins it needs
  in `requires.plugins`.
- A plugin MAY add: sources, trackers, landmark modifiers, events, anchors, data paths, layer types, render passes,
  audio effects, asset loaders.
- A plugin MUST publish the schema of its vocabulary, which is merged into validation and documentation.
- **Third-party** plugins MUST prefix their vocabulary: `myplugin:type`, `myplugin:anchor`, data `ext.myplugin.…`.
  Official plugins of the project use plain names.

## 15. Security and privacy (normative)

1. **No data leaves.** Filter code MUST NOT have any network access. An engine MUST run it in an isolated context,
   without access to the host's DOM, cookies or storage, with the network blocked. The reference implementation
   uses a `sandbox` iframe (opaque origin), a `connect-src 'none'` CSP and a Worker.
2. **Minimization.** A script only receives the data declared in `uses`. A filter without a script sends no data
   to untrusted code.
3. **No identification.** An engine MUST NOT recognize or re-identify a person. Face ids are ephemeral.
4. **Untrusted assets.** Size and dimensions are checked before decoding; SVGs are rendered as images; no remote resources.
5. **Denial of service.** Per-frame time budget, script stopped after repeated overruns, GPU context loss handled.
6. **Deceptive UI.** `overlay` layers are drawn into the canvas: a filter cannot create input fields.
7. **Expressions, not emotions.** Events describe expressions (smile, open mouth). Emotion inference is reserved for an
   explicit plugin; hosts in education or workplace settings MUST disable it (EU AI Act).

## 16. Versioning and compatibility

- The `ouaf` field changes value only for a breaking change.
- Minor versions of the spec (1.1, 1.2…) add fields, types, anchors or events **without** breaking existing filters.
- A 1.x engine MUST refuse a filter whose `engine` range excludes its version, with an explicit message.
- Plugins follow semver; `requires.plugins` expresses a range.

## 17. Conformance

- **Conforming validator**: checks the schema **and** the semantic rules (anchors, asset references, parameters and presets,
  bindings, events, drawn canvas layers, `requires`), and reports for each problem a code, a JSON pointer, a message and,
  when possible, a suggestion. Reference implementation: `validateManifest()` in `@ouaf/spec`, and `ouaf validate`.
- **Conforming engine**: follows sections 5 to 15; rendering differences between engines are acceptable as long as
  anchoring, stage order and layer semantics are respected.

---

## Appendix A — Complete example

```json
{
  "ouaf": "1",
  "id": "smile-counter",
  "name": { "en": "Smile counter", "fr": "Compteur de sourires" },
  "version": "1.0.0",
  "license": "CC0-1.0",
  "requires": { "face": true },
  "params": {
    "color": { "type": "color", "default": "#ffffff", "label": { "en": "Text color" } }
  },
  "assets": { "cool": { "emoji": "😎" } },
  "layers": [
    { "id": "label", "type": "text", "text": "😐", "color": { "param": "color" },
      "anchor": "forehead", "offset": [0, 0.9, 0], "size": 0.4, "orient": "screen" },
    { "type": "sticker", "src": "cool", "anchor": "eyes", "size": 0.6,
      "opacity": { "bind": "face.blendshapes.jawOpen", "range": [0.2, 0.6], "to": [0, 1] } },
    { "type": "warp", "kind": "bulge", "anchor": ["leftEye", "rightEye"], "strength": 0.2 }
  ],
  "events": { "smile": { "threshold": 0.6 } },
  "script": { "entry": "script.js", "on": ["smile", "faceLeave"] }
}
```

## Appendix B — Blendshapes

The 52 values (0 to 1) provided by MediaPipe FaceLandmarker, ARKit convention:
`browDownLeft`, `browDownRight`, `browInnerUp`, `browOuterUpLeft`, `browOuterUpRight`, `cheekPuff`, `cheekSquintLeft`,
`cheekSquintRight`, `eyeBlinkLeft`, `eyeBlinkRight`, `eyeLookDownLeft`, `eyeLookDownRight`, `eyeLookInLeft`, `eyeLookInRight`,
`eyeLookOutLeft`, `eyeLookOutRight`, `eyeLookUpLeft`, `eyeLookUpRight`, `eyeSquintLeft`, `eyeSquintRight`, `eyeWideLeft`,
`eyeWideRight`, `jawForward`, `jawLeft`, `jawOpen`, `jawRight`, `mouthClose`, `mouthDimpleLeft`, `mouthDimpleRight`,
`mouthFrownLeft`, `mouthFrownRight`, `mouthFunnel`, `mouthLeft`, `mouthLowerDownLeft`, `mouthLowerDownRight`, `mouthPressLeft`,
`mouthPressRight`, `mouthPucker`, `mouthRight`, `mouthRollLower`, `mouthRollUpper`, `mouthShrugLower`, `mouthShrugUpper`,
`mouthSmileLeft`, `mouthSmileRight`, `mouthStretchLeft`, `mouthStretchRight`, `mouthUpperUpLeft`, `mouthUpperUpRight`,
`noseSneerLeft`, `noseSneerRight` (plus `_neutral`, not exposed).

## Appendix C — To be confirmed (phase 0 / phase 1)

- Exact MediaPipe landmarks behind each anchor, and the precise definition of `head`.
- Detailed script API (section 12): signatures, available easings, per-frame time budget.
- Provisional shader inputs (`ouaf_personMask`, `ouaf_audioLevel`, anchors).
- Default event thresholds, after measurements on a variety of faces.
- Numeric limits (package size, dimensions, number of layers) after measurements on mobile.
