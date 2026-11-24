# Authoring Ouaf filters

How to write a filter for Ouaf (Open Universal AR Filter), for people and for AI agents. It covers everything an
author needs, from a text above the head to a scripted mini-game; the details live in the
[format specification](docs/spec/ouaf-v1.md) (linked as §n below) and the
[JSON Schema](docs/spec/ouaf-v1.schema.json). If this guide and the spec disagree, the spec wins; if the spec and the
schema disagree on structure, the schema wins.

The format is a draft (`1.0.0-draft.1`) and the tools are not published yet: today you write filters in a clone of
this repository. Every complete example below is checked by the unit tests (`packages/cli/test/authoring-guide.test.ts`).
Section 14 lists what is specified but not available yet; this guide only promises what works today.

**Contents**: 1 Quick start · 2 Package layout · 3 Manifest · 4 Anchors · 5 Layers · 6 Assets · 7 Params and presets ·
8 Bindings · 9 Events · 10 Scripts · 11 Shaders · 12 Limits · 13 Privacy and security · 14 Not available yet ·
15 Complete examples · 16 Validation errors · 17 Working with an AI agent

## 1. Quick start

```sh
git clone https://github.com/open-ar-filter/ouaf.git && cd ouaf
npm ci
npm run fetch-models   # face tracking model, needed to preview face filters
```

Create `filters/hello/manifest.json`:

```json ouaf=hello/manifest.json
{
  "ouaf": "1",
  "id": "hello",
  "name": "Hello",
  "version": "1.0.0",
  "license": "CC0-1.0",
  "requires": { "face": true },
  "layers": [
    { "type": "text", "text": "Hello 👋", "anchor": "forehead", "offset": [0, 0.8, 0], "size": 0.5, "orient": "screen" }
  ]
}
```

Check it, then preview it:

```sh
npx ouaf validate filters/hello        # exit 0: valid; 1: errors (listed with a fix); 2: usage error
npx ouaf preview filters/hello         # screenshots on reference faces: ouaf-preview/<reference>.png
npm run dev                            # https://localhost:5173 (self-signed certificate: accept it)
```

`ouaf preview` renders the filter in headless Chromium on a few frames of the test clips and writes one screenshot
per reference face (section 17); it needs Playwright's Chromium once: `npx playwright install chromium`. To see it
live, open `https://localhost:5173/engine.html?filter=/filters/hello/&source=pesquet-talk&autostart`: the engine page
plays a [test clip](test-media/README.md) (`source=<clip>`, `autostart` starts it) with your filter on top. Without
`source`, click **Start** to use the camera. Other query parameters: `filter` can be repeated to stack filters,
`maxFaces=<1–16>` (default 1), `seed=<n>` fixes random choices. Parameters (section 7) appear as controls on the page;
warnings and errors are printed under the video. Reload the page after editing a file.

## 2. Package layout

A filter is a folder; `ouaf pack` turns it into a `.ouaf` package (a zip) for distribution (§3).

| Form | Folder content | Check | Preview |
|---|---|---|---|
| **Manifest folder** (no code) | `manifest.json`, optional `assets/` | `npx ouaf validate <folder>` | the folder itself |
| **Source folder** (with a script) | `filter.ts` or `filter.js`, optional `assets/` | `npx ouaf pack <folder> -o <file.ouaf>` (packs and validates) | the package it packs to (below) |
| **Package** | `<id>.ouaf`: `manifest.json`, `script.js`, `assets/` | `npx ouaf validate <file.ouaf>` | `?filter=/filters/<id>.ouaf`, or open / drop the file on the page |

- Asset files live under `assets/`; paths are relative, use `/`, never `..`, and are case-sensitive; no symbolic
  links (§3).
- `ouaf pack` bundles `filter.ts` (TypeScript is fine, relative imports and npm packages are bundled), runs it once
  to read its default export, writes `manifest.json` from the data and `script.js` from the functions, then zips
  and validates the result. Nothing is written when there are errors. Other files of the folder (README…) are left out.
- `ouaf validate` on a source folder fails with `missing-manifest`: pack it instead.
- To preview a source folder, pack it where the dev server serves it, e.g.
  `npx ouaf pack filters/my-filter -o filters/my-filter.ouaf`, then open
  `/engine.html?filter=/filters/my-filter.ouaf&source=pesquet-talk&autostart` (`.ouaf` files under `filters/` are
  git-ignored); pack again and reload after each edit. A `.ouaf` from anywhere else can be opened with the page's
  **Open .ouaf** button or dropped on the page (it is read locally). `npx ouaf preview <folder>` packs it in memory
  and renders it, nothing to serve (section 17).
- A manifest folder may also hold a hand-written `script.js` (a self-contained ES module, as in
  `filters/fixtures/canvas-screen/`), but then you write the manifest's `script` section yourself (§12.2): prefer
  `filter.ts`.
- `--json` (every command) prints a machine-readable report; `--strict` fails on warnings too.

## 3. Manifest

| Field | Req. | Notes |
|---|---|---|
| `ouaf` | ✔ | `"1"`. In `filter.ts`, leave it out: `ouaf pack` adds it. |
| `id` | ✔ | `[a-z0-9-]`, starts with a letter or digit, 64 characters max. |
| `name` | ✔ | Text or translations: `"Pirate"` or `{ "en": "Pirate", "fr": "Pirate" }`. Same form for `description`. |
| `version` | ✔ | Semver, e.g. `"1.0.0"`. |
| `license` | ✔ | SPDX id or expression, e.g. `"CC0-1.0"`, `"MIT"`, `"CC-BY-4.0 AND MIT"`. |
| `requires` | ✔ | `{ "face": true }` when anything uses the face (anchor, binding, event, script data); `{}` otherwise. `blendshapes: true` only if the filter is useless without them (§4.1, §16.2). `plugins: ["name@^1"]` for plugin vocabulary. |
| `layers` | ✔ | Up to 64, in order (section 5). |
| `author`, `credits`, `thumbnail`, `tags` | | `credits`: `[{ "what", "author", "license", "source"? }]` for third-party assets; `thumbnail`: an `assets/…` path; `tags`: `[a-z0-9-]`, 16 max. |
| `params`, `presets` | | Section 7. |
| `assets` | | Section 6. |
| `events` | | Tuning of expression events (section 9). |
| `engine` | | Compatible engine range, default `"^1"`. |
| `script` | | Written by `ouaf pack`. In `filter.ts`, write only `script: { uses: [...] }` (section 10). |
| `$schema` | | Optional, for editors, e.g. `"../../docs/spec/ouaf-v1.schema.json"` from `filters/<id>/`. |

**Unknown properties are errors** everywhere (typos are caught, with a "did you mean"). Units: angles in degrees,
durations in milliseconds, times in seconds, colors `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`.

## 4. Anchors and coordinates

**Face anchor frame** (§5.1): origin at the anchor, **1 unit = the distance between the eye centres** (≈ 6.3 cm),
**+x right, +y up, +z towards the camera, as seen on screen**; it turns with the head. Mirroring is handled by the
engine. "Left/right" in anchor names are the person's side (their left eye is on the left of a mirrored view).

| Anchor | Where | Follows |
|---|---|---|
| `head` (default) | centre of the head (about 1.5 units behind the eyes) | rigid |
| `forehead`, `eyes`, `leftEye`, `rightEye`, `noseBridge`, `noseTip` | top of the forehead, between the eyes, eye centres, nose | rigid |
| `mouth`, `upperLip`, `lowerLip`, `chin` | mouth centre, lips, bottom of the chin | expression |
| `leftCheek`, `rightCheek`, `leftTemple`, `rightTemple` | cheekbones, temples | rigid |
| `screen` | the screen: origin at the centre, +y up, **1 unit = screen height** (y from -0.5 to 0.5) | — |

- A **rigid** anchor follows the head pose only (steady while talking); an **expression** anchor follows the live
  landmarks (a beard on `chin` follows the jaw). Override per layer with `follow: "rigid" | "expression" | "auto"`.
- `orient: "face"` (default) turns the layer with the head; `orient: "screen"` keeps it facing the screen (readable
  text).
- `faces`: `"all"` (default, one instance per face), `"first"`, `"largest"`, or a maximum count (1–16). The host
  sets how many faces are tracked (`maxFaces`, default 1 in the reference engine).
- `offset` `[x, y, z]` is in anchor units (screen heights with `screen`); `rotation` `[x, y, z]` in degrees, applied
  z, then y, then x; `scale` a number or `[x, y, z]`.

## 5. Layers

Layers are drawn in fixed stages, whatever their order in the list (§7):
`background → video → face → warp → objects → color → overlay`. Within a stage, list order applies; objects (`text`,
`sticker`, `model`, `canvas`) are depth-sorted, except objects of the same face on the same anchor: those are drawn
by their `offset` z (higher in front, whatever the head's rotation), then list order. A text over a bubble on the
same anchor only needs a small z gap (`[0.2, 1, 0.01]` over `[0, 1, 0]`). Warps deform everything drawn before
them; color layers and post shaders are chained.

**Every layer**: `type` (required), `id` (unique; needed to drive it from a script), `visible` (bindable),
`opacity` 0–1 (bindable). Hiding a layer does not pause its animations (§6.1).

**Anchored layers** (`text`, `sticker`, `model`, `canvas`) also take `anchor`, `offset`, `rotation`, `scale`,
`orient`, `follow`, `faces` (section 4), `overlay: true` (drawn last, above the color grading: UI, score) and
`excludeFromCapture: true` (with `overlay`: left out of photos, videos and streams).

`scale` (bindable, default 1) multiplies the layer's size: a number scales it uniformly, `[x, y, z]` per axis of the
layer (`[1, 1.4, 1]` stretches it vertically). It is a visual transform of what is drawn: a text is not laid out or
rasterized again, so `scale` is the cheap way to animate a "pop", but a text enlarged a lot (above about 1.5×) gets
blurry; for a lasting larger text, raise `size`.

Bindable properties accept a fixed value, `{ "param": … }` or `{ "bind": … }` (section 8). The asset properties
`src` (sticker, model), `font` and `lut` accept an asset or a `{ "param": … }` binding (section 7). The schema gives
every bound and default; the main ones are below.

### `text`

`text` (required, bindable, 500 characters, emoji allowed), `size` (font size in anchor units, default 0.3,
bindable), `font` (default `builtin:font/sans-bold`, a font asset, or a param: section 7), `color` (default `#ffffff`, bindable),
`outline: { width, color }` (width relative to the font size, ≤ 0.5), `shadow: { color, blur?, offset? }`, `align`
(`left`, `center`, `right`), `maxWidth` (wraps lines, anchor units), `lineHeight` (multiple of `size`, default 1.2).
The anchor is on the alignment edge, at the vertical middle of the block. Emoji use the platform's emoji font.

```json ouaf=layer
{ "id": "score", "type": "text", "text": "SCORE 0", "anchor": "screen", "offset": [0, 0.42, 0], "size": 0.06,
  "font": "builtin:font/mono", "color": "#ffe000", "outline": { "width": 0.1, "color": "#000000" }, "overlay": true }
```

### `sticker`

`src` (required: an image, spritesheet or video asset, `{ "pick": [...], "by": "face" | "random" }`, or a param:
section 7), `size`
(height in anchor units, default 1, width from the aspect ratio, bindable), `blend` (`normal`, `add`, `multiply`,
`screen`), `loop` (default true), `autoplay` (default true), `rate` (playback rate 0–4, bindable).
Animations start when the filter is activated and when the first face appears. `{ pick }` gives each face one asset
of the list, kept while the face is tracked: `by: "face"` (default) cycles through the list in order of appearance,
`by: "random"` draws one (§10.1).

```json ouaf=layer
{ "type": "sticker", "src": { "pick": ["assets/cat.png", "assets/dog.png"], "by": "random" },
  "anchor": "forehead", "offset": [0, 0.5, 0], "size": 1.2, "orient": "screen" }
```

### `model`

`src` (required: a glTF/GLB asset, `{ pick }`, a generated shape, or a param: section 7), `scale`, `fit: { width?, height? }` (rescales
the bounding box to this size in anchor units), `animation` (glTF clip played from activation), `loop` (default
true), `occlusion: "head"` (parts behind the head are hidden: hats, glasses temples; the head is the tracked face,
closed by the back of an average head, and what is less than about 1.3 cm under the face surface stays visible, so
a temple modelled as wide as the head near the ear, x ≈ ±1.2 face units, shows up to the ear). 1 glTF unit = 1 face
unit.
Shapes need no file: `{ "shape": "box" | "sphere" | "torus" | "ring" | "cone" | "cylinder" | "plane", "color"?,
"metalness"?, "roughness"?, "emissive"?, "thickness"? }`, all of size 1 centred on the anchor (`torus`, `ring` and
`plane` in the xy plane, facing the camera; `cone` and `cylinder` along y; `thickness` for `torus` and `ring`).

```json ouaf=layer
{ "id": "hat", "type": "model", "src": "assets/hat.glb", "anchor": "forehead", "offset": [0, 0.4, -0.5],
  "fit": { "width": 2.6 }, "occlusion": "head", "animation": "idle" }
```

### `warp`

`kind` (required: `bulge`, `pinch`, `swirl`, `stretch`), `anchor` (required: one anchor or a list of up to 8),
`radius` (face units, default 0.5, bindable), `strength` (-1 to 1, default 0.3, negative inverts, bindable),
`direction` (`stretch` only, `[x, y]` in the anchor frame, default `[0, 1]`, bindable), `faces`. Not anchored
otherwise (no `offset`). `opacity` scales the strength.

```json ouaf=layer
{ "type": "warp", "kind": "stretch", "anchor": "chin", "radius": 1.2, "strength": 0.5, "direction": [0, -1] }
```

### `color`

`lut` (a `.cube` asset, `builtin:lut/…`, or a param: section 7), `intensity` (strength of the LUT only, default 1), `brightness`,
`contrast`, `saturation`, `temperature` (-1 to 1, default 0), `tint` (color multiplied in, its alpha is the
strength), `vignette`, `grain` (0 to 1), `region: "all" | "face"` (`face`: only the face ovals, needs
`requires.face`). All numbers and `tint` are bindable. Applied in that order on sRGB values (§6.3, Appendix E).

```json ouaf=layer
{ "type": "color", "lut": "builtin:lut/noir", "intensity": 0.8, "contrast": 0.2, "vignette": 0.5, "grain": 0.3 }
```

### `shader`

`src` (required: a `.frag` / `.glsl` file defining `vec4 effect(vec2 uv)`, section 11), `stage` (`post`: full
screen, default; `face`: the face mesh only, needs `requires.face`; `background`), `uniforms` (name → number,
boolean, `[x, y]`, `[x, y, z]` or color; each bindable; 32 max), `textures` (name → image or video asset, 4 max),
`anchors` (face anchors given to the shader, 16 max, needs `requires.face`). Example in section 15.

### `canvas`

A Canvas 2D image drawn by the script's `draw.<id>` function (section 10): `id` (required), `width`, `height`
(pixels, 16–2048, required), `size` (displayed height in anchor units, default 1, bindable), `fps` (maximum redraws
per second of media time, default 30; `0`: only the first time and after `invalidate()`). Keep it small and `fps`
low: each redraw is uploaded to the GPU. Text uses the fonts declared in `assets` by their name (section 10).
Example in section 15.

## 6. Assets

Declare files once in `assets` and refer to them by name, or use an `assets/…` path or a `builtin:` resource
directly (§10.1). **Remote URLs (`http:`, `https:`, `data:`…) are forbidden.**

```json ouaf=part
{
  "assets": {
    "hat": "assets/hat.glb",
    "fire": { "src": "assets/fire.mp4", "alpha": "packed" },
    "walk": { "src": "assets/walk.png", "frames": { "cols": 4, "rows": 2, "count": 7, "fps": 12 } },
    "star": { "svg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><circle cx='5' cy='5' r='5' fill='#fc0'/></svg>" },
    "cool": { "emoji": "😎" },
    "grade": "assets/grade.cube"
  },
  "layers": [
    { "type": "sticker", "src": "fire", "anchor": "mouth", "size": 1 },
    { "type": "sticker", "src": "walk", "anchor": "screen", "size": 0.2 },
    { "type": "model", "src": "hat", "anchor": "forehead" },
    { "type": "sticker", "src": { "pick": ["star", "cool"] }, "anchor": "noseTip", "size": 0.5 },
    { "type": "color", "lut": "grade" }
  ]
}
```

| Kind | Formats | Notes |
|---|---|---|
| image | PNG, WebP, JPEG, AVIF, SVG (+ inline `svg`, `emoji`) | ≤ 4096 px per side. SVG is rendered as an image (no script, no external resource). KTX2 is accepted by the format but not loaded by the engine yet. |
| spritesheet | an image + `frames: { cols, rows, count?, fps }` | Grid read left to right, top to bottom. |
| video | MP4 (H.264), WebM (VP9) | ≤ 1080p, 720p recommended; muted; at most 2 playing at once on phones. Transparency: `"alpha": "packed"` (color left half, mask right half), made with `npx ouaf pack-alpha <webm, ProRes 4444 or PNG folder> -o assets/x.mp4` (needs ffmpeg). |
| model | glTF 2.0 / GLB | Draco and meshopt compression supported; external files must stay under `assets/` (prefer GLB). |
| lut | `.cube` | 1D or 3D. |
| shader | `.frag`, `.glsl` | Section 11. |
| font | WOFF2, WOFF, TTF, OTF | For `text.font`, and by asset name in canvases (`ctx.font`, section 10). |

Data a script needs (word lists, levels, tables) is not an asset: import the JSON in `filter.ts`
(`import levels from './levels.json'`, the file next to `filter.ts`, not in `assets/`) and `ouaf pack` bundles it
into `script.js`. The `data` (`.json`) and `lottie` kinds are reserved: nothing reads them yet, and `ouaf validate`
reports such assets as unused.

The kind comes from the extension; set `kind` to override it. An entry can also be a built-in resource under a name
of your own, e.g. `"title": "builtin:font/rounded-bold"` for the text of a canvas. Built-in resources (§10.3), always
available:
fonts `builtin:font/sans`, `builtin:font/sans-bold` (default), `builtin:font/rounded-bold`, `builtin:font/serif`,
`builtin:font/mono`, `builtin:font/handwritten`; LUTs `builtin:lut/vintage`, `builtin:lut/noir`, `builtin:lut/warm`,
`builtin:lut/cool`, `builtin:lut/vivid`. Credit third-party assets in `credits`, with a license that allows
redistribution.

## 7. Params and presets

Parameters are settings the host or the user changes at run time; the engine shows them as controls in the
playground (§9). A layer uses one with a `{ "param": "name" }` binding; a script reads them (`f.params`) but cannot
change them.

```json ouaf=part
{
  "params": {
    "size": { "type": "number", "default": 1, "min": 0.5, "max": 2, "step": 0.1, "transition": 300,
      "label": { "en": "Size", "fr": "Taille" } },
    "glow": { "type": "boolean", "default": true, "label": "Glow" },
    "word": { "type": "string", "default": "WOW", "maxLength": 20, "label": "Word" },
    "ink": { "type": "color", "default": "#ff3366", "label": "Color", "visibleIf": { "glow": true } },
    "mood": { "type": "select", "default": "happy", "options": { "happy": "Happy", "sad": "Sad" } }
  },
  "presets": { "subtle": { "size": 0.7, "glow": false }, "loud": { "size": 1.8, "word": "WOOOW" } },
  "layers": [
    { "type": "text", "anchor": "forehead", "offset": [0, 0.8, 0], "text": { "param": "word" },
      "size": { "param": "size" }, "color": { "param": "ink" }, "visible": { "param": "glow" } },
    { "type": "text", "anchor": "chin", "offset": [0, -0.5, 0], "size": 0.3,
      "text": { "param": "mood" } }
  ]
}
```

- Types: `number` (`min`, `max`, `step`), `boolean`, `string` and `text` (`maxLength`), `color`, `select`
  (`options`: value → label, or `{ "from": "host" }` for a list the host supplies), `vec2`, `vec3`, `asset` (a file
  supplied at run time, below).
- Metadata: `label`, `description`, `group`, `visibleIf: { "<param>": value }`, `apply` (`live` default, or
  `reload`), `transition` (ms; numbers, colors and vectors animate to a new value).
- A parameter binding must fit the property: a number param for a number, a `color` for a color, `vec3` for
  `offset`; text properties accept `string`, `text`, `select` and `color` params. Preset values must be valid.

**Choosing an asset** (§8.1). The asset properties `src` (sticker, model), `font` (text) and `lut` (color) take a
param too: a `select` (or `string`) param with `map` from its values to the filter's own assets, or an `asset` param
whose file the host gives (a logo, a photo):

```json ouaf=part
{
  "params": {
    "crown": { "type": "select", "default": "gold", "options": { "gold": "Gold", "flowers": "Flowers" } },
    "logo": { "type": "asset", "accept": ["image/png", "image/svg+xml"], "maxSize": 500000, "optional": true, "label": "Logo" }
  },
  "assets": { "gold": { "emoji": "👑" }, "flowers": { "emoji": "🌸" } },
  "layers": [
    { "type": "sticker", "anchor": "forehead", "offset": [0, 0.6, 0], "orient": "screen",
      "src": { "param": "crown", "map": { "gold": "gold", "flowers": "flowers" } } },
    { "type": "sticker", "anchor": "screen", "offset": [0, -0.42, 0], "size": 0.08, "overlay": true, "src": { "param": "logo" } }
  ]
}
```

- `map` values are asset names, `assets/…` paths or `builtin:` resources of the kind the property shows (image,
  spritesheet or video; model; font; LUT); give every option of a `select` an entry. A value without one shows
  nothing: the sticker or model is hidden, the text uses the default font, the color layer applies no LUT. The same
  goes for an `asset` param without a file.
- `accept` lists what the property can show: `image/png`, `image/jpeg`, `image/webp`, `image/avif`, `image/svg+xml`
  for a sticker; `model/gltf-binary`, `model/gltf+json` for a model; `font/woff2`, `font/woff`, `font/ttf`, `font/otf`
  for a font; `text/x-cube` for a LUT. A host file is an image, not a spritesheet or a video.
- The engine checks the host's file like an asset of the package (§15): its content (not its name or declared type)
  must be an accepted format, then the usual limits apply (4096 px per side…). A refused file leaves the previous one
  in place; a valid one replaces it at the start of a frame, once loaded (never an empty frame).

## 8. Bindings

A bindable property can follow tracking data, evaluated by the engine every frame, outside the script, at no cost
(§8):

| Form | Meaning |
|---|---|
| `{ "param": "size" }` | value of a parameter |
| `{ "bind": "face.blendshapes.jawOpen" }` | the data itself |
| `{ "bind": "…", "range": [a, b], "to": [c, d] }` | clamped to `[a, b]`, mapped linearly to `[c, d]` (both or neither) |
| `{ "bind": "…", "map": { "…": … } }` | lookup table: data value → property value |
| `"default": value` | used when the data is missing (no face, blendshapes dropped, a value `map` does not list), as it is (not passed through `map` or `range`) |

Data paths: `time` (media time, s), `faces.count`, `face.index`, `face.size` (eye distance / screen height),
`face.pose.yaw`, `face.pose.pitch`, `face.pose.roll` (degrees), `face.blendshapes.<name>` (0–1, the 51 ARKit names
of Appendix B: `jawOpen`, `mouthSmileLeft`, `mouthSmileRight`, `eyeBlinkLeft`, `eyeBlinkRight`, `browInnerUp`,
`mouthPucker`, `cheekPuff`…). Values are per face: each instance of a layer reads its own face. A `face.*` binding
needs `requires.face`.

```json ouaf=layer
{ "type": "warp", "kind": "bulge", "anchor": ["leftEye", "rightEye"], "radius": 0.5,
  "strength": { "bind": "face.blendshapes.browInnerUp", "range": [0.1, 0.7], "to": [0, 0.6], "default": 0 } }
```

Tracking data are numbers. A number property takes them as they are or through `range` / `to`, a text shows them;
other types (booleans, colors, vectors) need `map`, whose keys are exact values, which suits `faces.count` and
`face.index`. Write numeric keys as JSON writes the number: `"1"` matches 1, but `"1.0"` or `"01"` never match
(`ouaf validate` warns about them). Anything richer (conditions, sums, state) belongs in a script.

```json ouaf=layer
{ "type": "text", "text": "★", "anchor": "forehead", "offset": [0, 0.7, 0], "size": 0.5,
  "color": { "bind": "face.index", "map": { "0": "#ff3060", "1": "#30a0ff" }, "default": "#ffffff" } }
```

## 9. Events

Expression events fire **once** at the start of a gesture, with hysteresis (§13). A script handles them with
`on.<event>` (section 10); a filter without a script cannot use them.

| Event | Trigger | Default threshold |
|---|---|---|
| `faceEnter`, `faceLeave` | a face appears / leaves (after ~0.5 s of grace) | — |
| `blink`, `wink` | both eyes / one eye (`side`: `left` or `right`) | 0.5 |
| `mouthOpen`, `mouthClose` | `jawOpen` crosses the threshold | 0.35 |
| `smile`, `smileEnd` | mean of `mouthSmileLeft/Right` | 0.5 |
| `eyebrowRaise` | `browInnerUp` | 0.5 |
| `kiss` | `mouthPucker` | 0.7 |
| `nod`, `shake` | head "yes" / "no" (0.5 ≈ 10° each way) | 0.5 |
| `paramChange` | a parameter changed: `{ name, value, previous }` | — |
| `message:<name>` | message from the host page (`engine.send(name, data)`): `{ data }`, a copy, ≤ 64 KB; `name`: a letter, then letters, digits, `_`, `-` | — |

Tune them in the manifest: `"events": { "smile": { "threshold": 0.6, "minDurationMs": 150 } }` (`threshold` 0–1,
only for events that have one; `minDurationMs` 0–5000). Face events need `requires.face`. They keep working when the
engine drops blendshapes. Blinks and winks also use the shape of the eyelids, so a person whose `eyeBlink` score stays
low still blinks; keep the default blink threshold unless you have measured otherwise. `pairContact` / `pairSeparate` are specified but not emitted yet (section 14).

## 10. Scripts

Logic goes in `filter.ts` (or `filter.js`): `export default defineFilter({ …manifest data, state, setup, update, on,
draw })`, with `import { defineFilter } from '@ouaf/spec'` (complete examples in section 15). Spatial work stays
native (anchors, bindings, animations); the script does the logic (count, change a text, start an animation).

`defineFilter` returns its argument; it types `f.layer()` (declared ids only), event payloads and `f.state`. The
only data that may hold functions is `setup`, `update`, `on.<event>` and `draw.<canvas id>`; everything else must
be plain JSON (no `Date`, `Map`, getters, `undefined` in lists). The top level of the file runs once at pack time
(within 2 s, without browser or Node APIs): keep work in the functions.

| Function | Called |
|---|---|
| `setup(f)` | once, when the filter is activated |
| `update(f, frame)` | every frame the script receives; avoid it when a binding is enough |
| `on.<event>(f, payload)` | for each event of section 9; face events get `{ face }` (`wink` also `side`), `paramChange` `{ name, value, previous }`, `message:<name>` `{ data }` |
| `draw.<id>(ctx, f, frame)` | canvas layers: first frame, then up to `fps` times per second, and after `.invalidate()`; `ctx` is an `OffscreenCanvasRenderingContext2D` of `width × height` px, cleared before each call; the `font` assets are its fonts by asset name (`ctx.font = '24px title'`) |

**The `f` API** (§12.4):

| | |
|---|---|
| `f.layer(id, face?)` | handle on a layer: every instance, or with `face` only that face's |
| `.set({ … })` | sets properties until set to `null` (back to the manifest value: fixed, picked or bound). Settable: the bindable properties: `visible`, `opacity`, `offset`, `rotation`, `size`, `scale`, `text`, `color`, sticker `rate`, warp `radius` / `strength` / `direction`, the color-layer numbers and `tint`, shader `uniforms: { name: value }` (one by one: `{ uniforms: { amount: null } }` restores only `amount`; a value keeps the uniform's type); and the asset properties `src` (sticker, model), `font`, `lut`, to the **name** of an asset declared in `assets` of the right kind (`{ src: 'crownGold' }`; not a path or `builtin:`), and model `animation` to a clip name |
| `.animate({ prop: target }, { duration, easing?, delay?, repeat? })` | tween numbers, vectors, colors from the current value; `{ prop: { keyframes: [a, b, …] } }` plays evenly spaced values; `repeat: -1` loops |
| `.play(name)` | model layers: start a glTF animation |
| `.invalidate()` | canvas layers: redraw |
| `f.state` | global state (plain data, starts as `state`); `face.state`: per face, reset when the face leaves |
| `f.params` | parameter values, read-only |
| `f.emit(name, data?)` | message to the host (`handle.on('filter:<name>')`): structured-cloneable, ≤ 64 KB, ≤ 60 per second |
| `f.random()` | seeded random in [0, 1): use it instead of `Math.random()` so runs are reproducible |
| `f.after(ms, fn)`, `f.every(ms, fn)` | timers in media time, `fn(f)`; return `{ cancel() }` |
| `f.asset(name)` | an image asset as an `ImageBitmap`, for `ctx.drawImage` (scripts that draw canvas layers only) |

Easings: `linear`, and `in`, `out`, `inOut` × `Quad`, `Cubic`, `Back`, `Elastic`, `Bounce` (e.g. `outBack`);
default `inOutQuad`.

**`frame`**: `time` (s), `dt` (s since the previous call), `aspect` (displayed width / height), `faces` (each with
`id`, stable while tracked, `index`, `state`) and, depending on `script: { uses: [...] }` (data minimization, §12.4,
§15.2):

| `uses` | Per face |
|---|---|
| `face.pose` (default) | `pose: { yaw, pitch, roll }` (degrees), `size` |
| `face.blendshapes` (default) | `blendshapes: { jawOpen: 0.3, … }`; absent when the engine dropped them |
| `face.anchors` | `anchors: { noseTip: [x, y], … }`, 0–1 over the displayed image, origin top left, **y down** |
| `face.landmarks` | `landmarks`: `Float32Array` of 478 × (x, y, z), same space |

Declare only what the script reads: `script: { uses: [] }` when it reads nothing but ids; `face.*` uses need
`requires.face`. Without `uses`, the script gets pose and blendshapes. Positions are normalized over the width and
the height: multiply x differences by `frame.aspect` to measure on-screen distances or keep circles round.

**Canvas fonts**: a `draw` function sees only the platform's fonts, which differ between devices, plus the `font`
assets of the manifest under their asset name: declare `"assets": { "title": "builtin:font/rounded-bold" }` (or a
font file) and write `ctx.font = 'bold 24px title'`. Quote a name that is a CSS keyword (`'24px "serif"'`). Where a
browser cannot load fonts in the script's Worker, the platform font is used and the engine warns.

**Sandbox and timing** (§12.1, §12.7, §15):

- The script runs in a sandboxed Worker: no DOM, no network (`fetch`, `XMLHttpRequest`, `WebSocket`…), no storage,
  no `import()`; it cannot see the page or other filters. `ouaf pack` bundles imports, so `script.js` has none.
- Commands apply at the next frame at the earliest (one frame of latency); a slow script skips frames (`frame.dt`
  covers them) but never slows the rendering. Events are queued, never dropped, except while the filter is disabled or
  hidden: past 256 waiting events, only the last `message:<name>` of each name and `paramChange` of each parameter stay.
- **Watchdog**: a script that does not answer within **1 s** (`setup` included) is stopped (`SCRIPT_STOPPED`); the
  layers, bindings and running animations go on. An exception in a function is reported as a warning and the script
  keeps running.
- Use `frame.time` and `f.after` rather than `Date.now()` or `setTimeout`, and `f.random()` rather than
  `Math.random()`: media time and the seed make offline renders reproducible (§12.5).

## 11. Shaders

A shader file only defines `vec4 effect(vec2 uv)`, in GLSL ES 3.0, **without** `#version` or `main()` (the engine
wraps it, §11). The engine mixes the returned color over the image by its alpha times the layer's `opacity`, so
alpha 0 leaves the image unchanged.

| Input | |
|---|---|
| `vec4 ouaf_sample(vec2 uv)` | the image at this stage (sRGB values) |
| `float ouaf_time`, `float ouaf_dt` | media time and frame duration (s) |
| `vec2 ouaf_resolution` | rendered size in pixels |
| `float ouaf_faceMask(vec2 uv)` | 1 inside the tracked faces, 0 outside, soft edge |
| `vec4 ouaf_prevFrame(vec2 uv)` | this shader's previous output (trails); black at first; costs a buffer |
| `int ouaf_faceCount`, `OUAF_MAX_FACES` | tracked faces, size of the per-face arrays |
| `float ouaf_faceSize[OUAF_MAX_FACES]` | eye distance of each face, in uv units of the image height |
| `vec2 ouaf_anchor_<name>[OUAF_MAX_FACES]` | each anchor listed in the layer's `anchors` |

- `uv` and anchor positions: 0–1 over the image, **origin bottom left, y up** (unlike script data), mirroring
  applied. Per-face values are meaningful for `i < ouaf_faceCount`.
- Each `uniforms` entry is a uniform of the same name (number → `float`, boolean → `bool`, `vec2`, `vec3`,
  color → `vec4`), each `textures` entry a `sampler2D`. Names must be GLSL identifiers, not keywords or built-ins,
  not `main` / `effect`, no `gl_` prefix or `__`; `ouaf_` / `OUAF_` are reserved. Bound uniforms read the first face.
- Declare `requires.face` when the shader uses the face: `anchors`, `stage: "face"`, or `ouaf_faceMask`,
  `ouaf_faceCount`, `ouaf_faceSize` in the source (comments do not count). `ouaf validate` and `ouaf pack` read the
  shader file and report a missing `requires.face`.
- `ouaf validate` checks the declarations, `#version`, `main()` and `effect()`, then compiles each shader layer as
  the engine wraps it (with `OUAF_MAX_FACES` = 1, the engine's default), in headless Chromium: errors come with the
  line in your file (code `glsl`). It needs Playwright's Chromium (`npx playwright install chromium`, as for
  `ouaf preview`); without it, or with `--no-glsl`, compilation is listed under `skipped`. `ouaf pack` does not
  compile.

## 12. Limits

| What | Limit |
|---|---|
| Package | files unpacked: ≤ 5 MB recommended (warning), an engine may refuse above 50 MB or 1000 files |
| Layers / assets / params | 64 / 256 / 64 |
| Images | ≤ 4096 px per side |
| Videos | ≤ 1080p (720p recommended), at most 2 playing at once on phones |
| Text | 500 characters per layer; inline SVG 100 000 characters |
| Shader | 32 uniforms, 4 textures, 16 anchors |
| Canvas | 16–2048 px per side, ≤ 60 fps |
| Script | 1 s watchdog; `f.emit` ≤ 64 KB and ≤ 60 per second; host messages ≤ 64 KB; top level of `filter.ts` ≤ 2 s at pack time |

Performance: prefer bindings to `update`, keep canvases small and slow, few videos, `fps: 0` canvases redrawn on
`invalidate()`, GLB with compressed meshes, and `requires.blendshapes` only when truly needed (it prevents the
engine from dropping them on slow devices).

On a slow device (§16), the engine first drops blendshapes (`face.blendshapes.*` bindings take their `default`,
scripts get none, expression events still fire, from the landmarks), then the faces beyond those tracked, then the
analysis resolution; below 12 Hz of tracking for 3 s it hides face filters and shows the plain camera until the rate
is back above 14 Hz. Give blendshape bindings a sensible `default`. To see it on a desktop, open
`/engine.html?throttle=120&filter=…` (simulated slow tracking, also a slider in the panel).

## 13. Privacy and security

- A filter cannot send data anywhere: no network in scripts, no remote assets, SVGs without scripts (§15).
- A script only gets the data of `script.uses`: ask for the least.
- Face ids are ephemeral; a filter MUST NOT try to recognize people. Events describe expressions, not emotions.
- `overlay` layers are drawn in the image: a filter cannot create input fields.
- Use only assets you may redistribute, credit them, and never use photos or videos of people who have not agreed
  (test with the clips of `test-media/`).

## 14. Not available yet

Specified, or reserved, but not working in the reference engine today. Do not rely on them:

- `pairContact` / `pairSeparate` and `frame.pairs` (`uses: ["pairs"]`): no detector yet, `frame.pairs` is empty (#116).
- Lowering the rendering resolution when the frame budget is exceeded (#34): the engine only adapts face tracking
  (§16) and warns about heavy stacks.
- A host file as a video or spritesheet sticker (only images), or as a shader texture: `textures` take assets only.
- Starting a sticker with `autoplay: false` from a script; `f.sound()` and audio assets; `lottie` and `data` assets
  (reserved: import JSON in `filter.ts`, section 6).
- KTX2 textures; reserved `requires` (`hands`, `segmentation`, `pose`, `audio`)
  and reserved events (`tap`…): warnings.
- With a file source, the engine does not wait for the script yet, so offline renders of scripted filters are not
  frame-exact (#26).

## 15. Complete examples

From simple to complex. Each is a whole folder; in this repository, put it under `filters/<id>/`.

Larger examples: the demo filters next to them (`filters/text-bubble/`, `filters/duo/`…, listed with what each shows
in [`filters/README.md`](filters/README.md)), one per feature set, each with the test clip that shows it. Their ids
are taken: give your filter another one. Their scripts are already packed (`manifest.json` with a `script` section and
`script.js`, section 2).

### Sunglasses and a caption (stickers, params, presets, a binding)

`filters/cool-shades/manifest.json`. The flame shows as the mouth opens.

```json ouaf=cool-shades/manifest.json
{
  "ouaf": "1",
  "id": "cool-shades",
  "name": { "en": "Cool shades", "fr": "Lunettes cool" },
  "version": "1.0.0",
  "license": "CC0-1.0",
  "requires": { "face": true },
  "params": {
    "size": { "type": "number", "default": 1.4, "min": 0.8, "max": 2, "step": 0.1, "transition": 200, "label": "Size" },
    "caption": { "type": "string", "default": "Too cool", "maxLength": 40, "label": "Caption" },
    "ink": { "type": "color", "default": "#ffd400", "label": "Caption color" }
  },
  "presets": { "big": { "size": 2 }, "quiet": { "size": 1, "caption": "" } },
  "assets": { "shades": { "emoji": "😎" }, "fire": { "emoji": "🔥" } },
  "layers": [
    { "type": "sticker", "src": "shades", "anchor": "eyes", "size": { "param": "size" } },
    { "type": "sticker", "src": "fire", "anchor": "mouth", "offset": [0, -0.2, 0.3], "size": 0.8,
      "opacity": { "bind": "face.blendshapes.jawOpen", "range": [0.15, 0.5], "to": [0, 1], "default": 0 } },
    { "type": "text", "text": { "param": "caption" }, "color": { "param": "ink" }, "anchor": "chin",
      "offset": [0, -0.6, 0], "size": 0.35, "orient": "screen", "outline": { "width": 0.08, "color": "#000000" } }
  ]
}
```

### Big eyes, old film (warp, color, a halo)

`filters/old-film/manifest.json`: bulging eyes, a built-in LUT with vignette and grain, and a gold ring above the
head whose back is hidden by the head.

```json ouaf=old-film/manifest.json
{
  "ouaf": "1",
  "id": "old-film",
  "name": "Old film",
  "version": "1.0.0",
  "license": "CC0-1.0",
  "requires": { "face": true },
  "params": {
    "eyes": { "type": "number", "default": 0.4, "min": 0, "max": 1, "step": 0.05, "label": "Big eyes" },
    "film": { "type": "number", "default": 0.8, "min": 0, "max": 1, "step": 0.05, "label": "Film look" },
    "halo": { "type": "boolean", "default": true, "label": "Halo" }
  },
  "presets": { "natural": { "eyes": 0.15, "film": 0.4, "halo": false } },
  "layers": [
    { "type": "warp", "kind": "bulge", "anchor": ["leftEye", "rightEye"], "radius": 0.45, "strength": { "param": "eyes" } },
    { "type": "model", "src": { "shape": "torus", "color": "#ffd700", "emissive": "#806000", "metalness": 0.8,
      "roughness": 0.3, "thickness": 0.08 }, "anchor": "head", "offset": [0, 1.6, 0], "rotation": [80, 0, 0],
      "scale": 2.2, "occlusion": "head", "visible": { "param": "halo" } },
    { "type": "color", "lut": "builtin:lut/vintage", "intensity": { "param": "film" }, "vignette": 0.45, "grain": 0.25 }
  ]
}
```

### Spotlight (a shader with uniforms and anchors)

`filters/spotlight/manifest.json` and `filters/spotlight/assets/spotlight.frag`: everything outside a circle around
each face gets darker.

```json ouaf=spotlight/manifest.json
{
  "ouaf": "1",
  "id": "spotlight",
  "name": "Spotlight",
  "version": "1.0.0",
  "license": "CC0-1.0",
  "requires": { "face": true },
  "params": {
    "darkness": { "type": "number", "default": 0.75, "min": 0, "max": 1, "step": 0.05, "label": "Darkness" }
  },
  "layers": [
    { "type": "shader", "src": "assets/spotlight.frag", "anchors": ["noseTip"],
      "uniforms": { "radius": 2, "darkness": { "param": "darkness" } } }
  ]
}
```

```glsl ouaf=spotlight/assets/spotlight.frag
// Darkens the image outside a circle of `radius` face units around the nose of every face.
vec4 effect(vec2 uv) {
  vec4 c = ouaf_sample(uv);
  vec2 aspect = vec2(ouaf_resolution.x / ouaf_resolution.y, 1.0);
  float light = 0.0;
  for (int i = 0; i < OUAF_MAX_FACES; i++) {
    if (i >= ouaf_faceCount) break;
    float d = length((uv - ouaf_anchor_noseTip[i]) * aspect) / ouaf_faceSize[i];
    light = max(light, 1.0 - smoothstep(radius, radius + 1.0, d));
  }
  return vec4(c.rgb * mix(1.0 - darkness, 1.0, light), 1.0);
}
```

### Smile counter (a script: events, state, set, animate, emit, messages)

`filters/smile-total/filter.ts`. Pack it to try it (section 2). The host can reset the count with
`handle.send('reset')`.

```ts ouaf=smile-total/filter.ts
import { defineFilter } from '@ouaf/spec'

export default defineFilter({
  id: 'smile-total',
  name: { en: 'Smile counter', fr: 'Compteur de sourires' },
  version: '1.0.0',
  license: 'CC0-1.0',
  requires: { face: true },
  assets: { sparkle: { emoji: '✨' } },
  layers: [
    { id: 'count', type: 'text', text: '😐 0', anchor: 'forehead', offset: [0, 0.9, 0], size: 0.4, orient: 'screen' },
    { id: 'sparkle', type: 'sticker', src: 'sparkle', anchor: 'eyes', size: 1.5, opacity: 0 },
  ],
  events: { smile: { threshold: 0.6 } },
  // The script only needs face ids (events carry the face): no tracking data is sent to it.
  script: { uses: [] },
  state: { total: 0 },
  on: {
    smile(f, { face }) {
      f.state.total++
      f.layer('count').set({ text: `😄 ${f.state.total}` })
      f.layer('count').animate({ size: { keyframes: [0.4, 0.6, 0.4] } }, { duration: 400, easing: 'outBack' })
      f.layer('sparkle', face).animate({ opacity: { keyframes: [0, 1, 0] } }, { duration: 800 })
      f.emit('smiles', f.state.total)
    },
    'message:reset'(f) {
      f.state.total = 0
      f.layer('count').set({ text: null })
    },
  },
})
```

### Mouth meter (a canvas drawn by the script, timers, `uses`)

`filters/mouth-meter/filter.ts`: a gauge in the corner of the screen shows how wide the mouth is open, kept out of
photos and videos; a star blinks every half second.

```ts ouaf=mouth-meter/filter.ts
import { defineFilter } from '@ouaf/spec'

export default defineFilter({
  id: 'mouth-meter',
  name: 'Mouth meter',
  version: '1.0.0',
  license: 'CC0-1.0',
  requires: { face: true },
  assets: { star: { emoji: '⭐' } },
  layers: [
    { id: 'meter', type: 'canvas', width: 160, height: 32, fps: 15, anchor: 'screen', offset: [0, -0.4, 0], size: 0.05,
      overlay: true, excludeFromCapture: true },
  ],
  script: { uses: ['face.blendshapes'] },
  state: { star: true },
  setup(f) {
    f.every(500, (f) => {
      f.state.star = !f.state.star
    })
  },
  draw: {
    meter(ctx, f, frame) {
      const open = frame.faces[0]?.blendshapes?.jawOpen ?? 0
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
      ctx.fillRect(0, 0, 160, 32)
      ctx.fillStyle = open > 0.5 ? '#ff3060' : '#30d0ff'
      ctx.fillRect(36, 8, 116 * Math.min(1, open), 16)
      if (f.state.star) ctx.drawImage(f.asset('star'), 4, 4, 24, 24)
    },
  },
})
```

## 16. Validation errors

`ouaf validate` and `ouaf pack` print one line per problem: file and line, JSON pointer, severity, code, message,
then `→` a hint. Fix errors first; warnings do not block (unless `--strict`). Common codes:

| Code | Cause | Fix |
|---|---|---|
| `required` | a required property is missing | add it (`ouaf`, `id`, `name`, `version`, `license`, `requires`, `layers`; `text` of a text layer…) |
| `unknown-property` | a typo, or a property of another layer type | use the suggested name; check the layer's properties in section 5 |
| `enum`, `type`, `format`, `range` | wrong value, type, pattern (ids, colors, semver) or bound | follow the hint: it lists the accepted values |
| `unknown-anchor` | e.g. `"nose"` | `noseTip`; the hint lists every anchor |
| `requires-face` | a face anchor, `face.*` binding, face event, `face.*` use or shader face input (`ouaf_faceMask`…) without `requires.face` | add `"requires": { "face": true }` |
| `unused-requirement` | `requires.face` (or `blendshapes`) while nothing uses it | remove it: tracking costs performance |
| `unknown-asset`, `missing-file` | name not declared in `assets`; file not in the folder (paths are case-sensitive) | declare it / fix the path or the file name |
| `unused-asset`, `unreferenced-file` | declared or shipped but never used (a `data` asset: scripts cannot read it) | remove it, or reference it; import JSON in `filter.ts` |
| `format-mismatch`, `unsupported-format` | the content does not match the extension (a JPEG named `.png`), or an unsupported format (GIF…) | export again in a supported format, fix the extension |
| `image-too-large`, `video-too-large`, `unsupported-codec` | over the limits of section 12, HEVC video… | resize / re-encode (H.264 MP4 or VP9 WebM) |
| `unknown-param`, `param-type-mismatch`, `preset-invalid` | binding or preset on a missing param, of the wrong type or out of bounds | declare the param, use a fitting type |
| `asset-accept`, `asset-kind`, `binding-map-unexpected`, `binding-map-missing` | an asset param whose `accept` lists a type the property cannot show (`video/mp4` for a sticker); a `map` value of the wrong kind (a model for a sticker); `map` on an asset param; a `select` option without a `map` entry (warning) | follow the hint: it lists the accepted types; map every option to an asset the property shows (section 7) |
| `unknown-data-path`, `binding-range`, `binding-map-required`, `binding-map-key` | wrong `bind` path; `range` without `to`; data bound without `map` to a property of another type (a number into a color, a vector or `visible`; plugin text into a color), or a `select` param bound to an asset property without `map`; a `map` key that never matches (`"1.0"` for a number, a key that is not an option) | use a path of section 8; give both `range` and `to`; add `map` from data (or param) values to property values; write the key the hint gives (`"1"`) |
| `unknown-event`, `not-tunable` | wrong event name; `threshold` on an event that has none | names of section 9 |
| `duplicate-id`, `missing-id`, `unknown-layer`, `not-canvas`, `canvas-not-drawn` | layer ids; a canvas needs an `id` and a `draw.<id>` function | give unique ids; add the draw function |
| `shader-version`, `shader-main`, `shader-no-effect`, `shader-name` | `#version`, `main()`, no `effect()`, a reserved uniform name | write only `vec4 effect(vec2 uv)`; rename the uniform |
| `shader-uniform` | a `uniforms` value with no GLSL type (a `map` mixing types, a string) | bind a number, boolean, vec2, vec3 or color |
| `glsl` | the shader does not compile (line in the `.frag` file) | fix the GLSL at that line: types are strict (`2.0`, not `2`), `ouaf_sample` returns a `vec4` |
| `lut-syntax` | malformed `.cube` | export the LUT again |
| `missing-manifest` | `ouaf validate` on a `filter.ts` folder | run `ouaf pack` |
| `function-in-data`, `not-json`, `accessor-in-data`, `script-section` | in `filter.ts`: a function outside `setup` / `update` / `on` / `draw`, a non-JSON value, a getter, or `script.<key>` other than `uses` | keep data plain; let `ouaf pack` write the `script` section |
| `run-error`, `no-default-export`, `build-error` | the top level of `filter.ts` throws, has no default export, or imports something that cannot be bundled (Node built-ins) | `export default defineFilter({ … })`; no browser or Node APIs at the top level |
| `outside-layout` | extra files in a manifest folder (README…) | warning only: they are left out of the package |
| `case-conflict` | two paths that differ only by case (`assets/Hat.png`, `assets/hat.png`) | rename one |
| `package-size`, `package-too-large`, `too-many-entries` | files over 5 MB unpacked (warning), over 50 MB or 1000 files (error) | compress assets (WebP, GLB with Draco/meshopt, 720p videos); merge small images |

## 17. Working with an AI agent

This guide is written so that an agent can write a filter from it alone; [`llms.txt`](llms.txt) indexes it with the
spec and the schema. An agent writing a filter follows this loop:

1. **Create** `filters/<id>/` with `manifest.json` (no logic) or `filter.ts` (logic), and `assets/` for files.
   Start from the closest example of section 15. Use only the vocabulary of this guide; for an exact bound or
   default, read the [JSON Schema](docs/spec/ouaf-v1.schema.json).
2. **Validate**: `npx ouaf validate filters/<id> --json`, or `npx ouaf pack filters/<id> -o filters/<id>.ouaf --json`
   for `filter.ts`. Exit code 0 means valid. Each issue has a `code`, a `file` (with `line` / `column` when known), a
   JSON `path` and a `hint`: apply the hint, then validate again until there are no errors and, ideally, no warnings.
3. **Preview**: `npx ouaf preview filters/<id> --json` (a manifest folder, a `filter.ts` folder or a `.ouaf`; several
   stack, the first at the bottom). It renders the filter in headless Chromium on reference faces, frames of the test
   clips (`talk`, `walk`, `two-faces`, `no-face`; `--ref <id>` picks some, `--input <clip.mp4 | image.png>` uses
   another file, `--at <s>` its time) and writes `ouaf-preview/<reference>.png` (`-o <dir>` elsewhere). Look at
   each screenshot: is every layer where it should be, at the right size? In the JSON, each reference has
   `errors` and `warnings` from the engine (an asset that fails to decode, a script error: things `validate` cannot
   see), `faces` (faces tracked), `changed` (share of the pixels the filter changed: near 0 means
   nothing shows), `pixelsSha256` and `perf` (frame times, measured with software rendering: compare filters, do
   not predict a phone). Exit code 0: rendered without engine errors; 1: errors; 2: usage error (also when
   Playwright's Chromium is missing: `npx playwright install chromium`). The same command gives the same pixels on
   every run on one machine. For a live view, `npm run dev`, then
   `https://localhost:5173/engine.html?filter=/filters/<id>/&source=pesquet-talk&autostart` (section 1).
4. **Report** what the filter does, the commands run and their result, and anything section 14 made impossible.

Rules for agents: do not invent properties, anchors, events or data paths (the validator rejects them); do not use
features of section 14; never fetch remote assets or use images of real people; prefer emoji, inline SVG,
`builtin:` resources and generated shapes over binary files you cannot produce; declare `requires.face` only when
the face is used and `script.uses` as small as possible.

To give an agent these instructions in a project of your own, put this in its `AGENTS.md` (or `CLAUDE.md`):

```md
# Ouaf filter

This folder is an Ouaf (Open Universal AR Filter) filter. Before writing or changing it, read the authoring guide
(AUTHORING.md of https://github.com/open-ar-filter/ouaf) and follow its section 17: create, then validate with
`npx ouaf validate <folder> --json` (`npx ouaf pack <folder> -o <id>.ouaf --json` when the folder has a filter.ts)
until there are no errors, then render it with `npx ouaf preview <folder> --json` and look at the screenshots.
Use only what the guide documents.
```
