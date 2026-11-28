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
- Paths are compared **exactly as written**: case-sensitive, without Unicode normalization (`assets/Hat.png` and
  `assets/hat.png` are two files). A validator SHOULD warn about paths that differ only by case or normalization,
  since most file systems cannot hold both once the package is unpacked.
- An engine and a validator MUST **refuse** a package that contains a symbolic link or another special entry (device,
  FIFO…), an unsafe path (absolute, with a drive letter or `\`, with a `.`, `..` or empty segment) or the same path
  twice.
- A package SHOULD NOT contain regular files outside this layout: an engine MUST ignore them, a validator warns.
- **Size** is that of the content, the files unpacked: **≤ 5 MB** recommended (a validator warns above); an engine
  MAY refuse a package whose files total more than **50 MB** unpacked, or that has more than **1000 entries**. The
  size of the archive itself is not a limit.
- An engine MUST protect itself while it reads a package: it bounds the declared sizes before decompressing anything,
  and MUST stop decompressing an entry as soon as it goes past its declared size or the limit. It MAY stop reading
  or downloading an archive larger than the limit plus the zip structure (in the reference implementation, 1 KiB per
  entry for headers and names, 64 KiB for the archive comment and 0.1 % of the content for deflate: 51.14 MB).
- **Zip features**: entries are stored or deflated (methods 0 and 8), names are UTF-8 (general purpose flag bit 11;
  plain ASCII names read the same without it), and directory entries are allowed and ignored. ZIP64, encryption,
  multi-disk archives and other compression methods are not supported: an engine refuses them with an explicit
  error. Each entry's size and CRC-32 are checked.
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

The data MUST be plain JSON values (objects, lists, strings, finite numbers, booleans, `null`): a function anywhere
else than `setup`, `update`, `on.<event>` and `draw.<layer>` is an error. Of the `script` section, the author only
writes `uses` (12.2); `ouaf pack` fills in the rest from the functions.

`filter.js` MAY import other modules and JSON files (`import levels from './levels.json'`): `ouaf pack` bundles them
into `script.js`. This is how a script gets static data (word lists, levels, tables): a v1 script cannot read a
`data` asset (10.2).

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
| `face` | ✔ | Loads face tracking (478 landmarks, pose, and blendshapes when the filter uses them). |
| `blendshapes` | ✔ | The filter does not work without blendshapes: the engine never drops them (16.2) and hides the filter rather than degrading it. Requires `face`. |
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

| Anchor | Description | `follow: auto` |
|---|---|---|
| `head` | Center of the head; follows the full pose. Default anchor. | rigid |
| `forehead` | Top of the forehead. | rigid |
| `eyes` | Midpoint between the eyes. | rigid |
| `leftEye`, `rightEye` | Center of each eye (not the iris: it does not move with the gaze). | rigid |
| `noseBridge`, `noseTip` | Middle of the bridge, tip of the nose. | rigid |
| `mouth`, `upperLip`, `lowerLip` | Center of the mouth, middle of each lip. | expression |
| `chin` | Bottom of the chin. | expression |
| `leftCheek`, `rightCheek` | Cheekbones. | rigid |
| `leftTemple`, `rightTemple` | Temples (edges of the face at eye level). | rigid |
| `screen` | Screen frame (5.2). | — |

Every face anchor shares the orientation of the `head` frame; only the origin differs. A **rigid** anchor position
comes from the head pose alone, so it stays steady while the person talks or smiles; an **expression** anchor follows
the live landmarks, so a beard on `chin` follows the jaw. Layers override the default with `follow` (6.2).

Plugins MAY add anchors (e.g. `leftShoulder` for body pose). The landmarks behind each anchor in the reference
implementation are listed in Appendix D (informative).

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

Hiding a layer, with `visible` false or `opacity` 0, neither pauses nor restarts its animations (spritesheets,
videos, a `model`'s `animation`): as an animation under CSS `visibility: hidden`, they keep advancing and resume
where they are when the layer is shown again. When they start is given by each type (6.3).

### 6.2 Properties of anchored layers (`text`, `sticker`, `model`, `canvas`)

| Property | Default | Description |
|---|---|---|
| `anchor` | `head` | Anchor (section 5). |
| `offset` | `[0,0,0]` | Offset in the anchor frame, *bindable*. Its z also orders the objects on one anchor (section 7). |
| `rotation` | `[0,0,0]` | Rotation in degrees around the x, y, z axes of the anchor frame, *bindable*. Euler order XYZ: the rotation matrix is Rx · Ry · Rz, so z is applied first, then y, then x. |
| `scale` | `1` | Size multiplier, a number or `[x, y, z]`, *bindable*; e.g. animated by a script for a "pop" (12.4). It multiplies the layer's size (`size`, `fit`) along the x, y, z axes of the layer (the anchor frame turned by `rotation`): a number scales uniformly, `[1, 1.4, 1]` stretches vertically. `scale` is a visual transform of the drawn layer: a `text` is scaled as drawn, around its anchor point, without being laid out or rasterized again (its wrapping, `maxWidth`, does not change), so it is cheap to animate but can blur when enlarged (above about 1.5×). `size` is the font size: the text is laid out at it. An engine MAY rasterize text again at a resolution that follows its size on screen, and SHOULD NOT do so while `scale` animates (it MAY once `scale` settles). An animated "pop" uses `scale`; a lasting larger text uses `size`. An instance with a factor of 0 or less is not drawn. |
| `orient` | `face` | `face`: follows the head; `screen`: keeps facing the screen (readable text). |
| `follow` | `auto` | What the anchor **position** follows: `rigid`: the head pose only (stable, ignores expressions); `expression`: the live landmarks (moves with the mouth, brows, cheeks); `auto`: the anchor's default (5.3). Rotation always follows the head. No effect with `anchor: "screen"`. |
| `faces` | `all` | Faces affected (5.4). |
| `overlay` | `false` | Drawn last, after color grading (UI, score). |
| `excludeFromCapture` | `false` | With `overlay`: left out of photos, videos and the output stream. Drawn above the other overlay layers, whatever the stack and layer order. |

### 6.3 v1 types

| Type | Role | Main properties |
|---|---|---|
| `text` | Text (emoji included) | `text`*, `size`, `font` (asset or `{ param }`), `color`, `outline`, `shadow`, `align`, `maxWidth`, `lineHeight` |
| `sticker` | Image, spritesheet or video | `src` (asset, `{ pick }` or `{ param }`), `size`, `blend`, `loop`, `autoplay`, `rate` |
| `model` | 3D object | `src` (glTF, `{ pick }`, `{ shape }` or `{ param }`), `scale`, `fit`, `animation`, `loop`, `occlusion` |
| `warp` | Deformation | `kind` (`bulge`, `pinch`, `swirl`, `stretch`), `anchor` (one or more), `radius`, `strength`, `direction`, `faces` |
| `color` | Color grading | `lut` (asset or `{ param }`), `intensity`, `brightness`, `contrast`, `saturation`, `temperature`, `tint`, `vignette`, `grain`, `region` |
| `shader` | GLSL effect | `src`, `stage` (`background`, `face`, `post`), `uniforms`, `textures` |
| `canvas` | Canvas 2D drawing by the script | `width`, `height`, `size`, `fps`; `id` required |

\* required. Exact bounds and defaults are in the schema.

Normative behavior:

- `text`: `size` is the font size (em) in anchor units and `lineHeight` the line spacing as a multiple of it;
  `outline.width`, `shadow.blur` and `shadow.offset` are relative to the font size, the offset with +y up (defaults
  in the schema). The anchor point is on the alignment edge of the text block (its left edge with `align: "left"`,
  its centre with `center`, its right edge with `right`), at the vertical middle of the block; `maxWidth` wraps the
  lines. The engine SHOULD rasterize text once and redraw it only when its content or style changes.
  Emoji (in text and `{ "emoji": … }` assets) are drawn with the platform's emoji font, so they look different from
  one device to another. A host MAY provide a reference emoji set; the engine then SHOULD draw emoji from it, so
  they look the same on every device.
- `sticker`: `size` is the height in anchor units, the width follows the asset's aspect ratio. Animated assets
  (spritesheets, videos) play from their first frame when the filter is activated and when the first selected face
  appears after none was (a screen sticker: at activation only); a face that appears while another is selected joins
  the running animation; hidden by `visible` or `opacity`, they keep advancing (6.1). They advance with the media
  time times `rate`; with `autoplay: false` they stay on the first frame; without `loop` they hold the last frame.
  `rate` is one value for the layer, read for its first selected face. `{ pick }`: see 10.1.
- `model.animation`: the clip plays from its start when the filter is activated and, for each face, when that face
  appears (a new face id).
- `model.occlusion: "head"`: the part of the object hidden by the head is not drawn (hat, glasses temples).
  *Informative*: the reference implementation hides it with an invisible surface per face that only writes depth,
  drawn before the objects: the face landmark mesh (forehead, eyes, cheeks, temples, jaw, as tracked, expressions
  included), moved back by 0.2 face units (≈ 1.3 cm) along the camera rays, and closed behind by the back of an
  average adult head on the `head` anchor. So the face's outline in the image is exact, while what lies on the face or
  just under its surface stays drawn: stickers, the front of glasses, temples that touch the side of the head. Ears,
  hair and the neck are not part of it. A face without usable landmarks gets an ellipsoid of an average head on the
  `head` anchor instead. Another engine MAY use another head shape.
- `model.fit`: the object is rescaled so its bounding box has the requested width or height.
- `model.src: { shape }`: primitives `box`, `sphere`, `torus`, `ring`, `cone`, `cylinder`, `plane`, of size 1, usable
  without any file, centred on the anchor: `box` 1 × 1 × 1; `sphere` diameter 1; `cylinder` diameter 1 and height 1,
  and `cone` base diameter 1 and height 1 (tip up), both with their axis along y; `plane` 1 × 1 and `torus` and
  `ring` of outer diameter 1, in the xy plane (facing the camera when `orient` and `rotation` leave them so).
  `thickness` applies to `torus` and `ring` only: the width of their band (outer minus inner radius). Other
  proportions (a disc, a rod) are made with `scale`.
- `warp` deforms the image **and** whatever was painted on the face before it (section 7). Each anchor of each
  selected face is the center of a disc of `radius` face units (screen heights with `anchor: "screen"`), so the
  deformation keeps its size relative to the face at any distance; discs stay round on screen. The effect is
  strongest at the center and fades smoothly to none at the radius. `strength` goes from -1 to 1, a negative value
  inverting the effect, 0 none: `bulge` magnifies the disc (negative: shrinks it), `pinch` is the opposite of
  `bulge` (the same deformation with the opposite strength, kept as its own kind so that a filter reads as what it
  does), `swirl` turns it counter-clockwise as seen on screen (negative: clockwise), `stretch` drags it along
  `direction` (negative: against it). `direction` is in the anchor frame (5.1: as seen on screen, turning with the
  head); only its orientation counts; default `[0, 1]` (up). `opacity` scales the strength. The deformation SHOULD
  never fold the image over itself. In the reference implementation, at strength 1, `bulge` magnifies the center 4×,
  `swirl` turns it half a turn and `stretch` moves it by 0.6 radius.
- `color` works on the sRGB-encoded values of the image (what `.cube` LUTs for photo and video expect), in this
  order: `lut`, `brightness`, `contrast`, `saturation`, `temperature`, `tint`, `vignette`, `grain`. `intensity` is
  the strength of the LUT only: 0 leaves the image as it was before the LUT, and the other adjustments still apply.
  `tint` multiplies the image by the color, its alpha being the strength (white: no change). `grain` MUST depend
  only on the pixel and the frame time (12.5). The result is clamped to 0–1 and mixed with the image below by
  `opacity`. `region: "face"` limits it to the face ovals, with a soft edge; it uses face tracking. The reference
  formulas are in Appendix E (informative); another engine MAY use other curves with the same meaning.
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
| `objects` | `text`, `sticker`, `model`, `canvas`, depth-sorted (below) |
| `color` | `color` layers and shaders with `stage: "post"`, chained |
| `overlay` | Layers with `overlay: true` |

A host MAY stack several filters. Within a stage, order is the **stack** order, then the **layer** order.

- Deformations, color grading and voice effects are **chained** in that order.
- Objects are **merged** and depth-sorted (below).
- The background is **exclusive**: the last filter in the stack wins, and the engine SHOULD emit a warning.
- Tracking (face, etc.) is **shared** by the whole stack: it is computed only once.
- Filters are isolated from each other: each has its own sandbox and cannot read the others' state.

**Order of objects.** Within the `objects` stage, and within the `overlay` stage, objects are drawn back to front by
depth: the depth of each one's centre. Objects of the **same face on the same anchor** (the `screen` anchor counts
as one anchor, whatever the face) are drawn in the order of their `offset` along the anchor frame's z axis instead,
the lowest first (+z points towards the camera, 5.1): a higher `offset` z is drawn in front, whatever the head's
rotation and the objects' `orient`. Equal offsets are drawn in stack order, then layer order, across filters. Objects
of different anchors or faces keep the depth order; an engine places each same-anchor group among them by depth,
without breaking the group's order. Only the order of drawing changes: an opaque model, and a head occluder
(`occlusion: "head"`), still hide what is behind them with the depth buffer, whatever their order. A text 0.02 in
front of its bubble on the same anchor thus stays in front when the head turns, which ordering by the depth of their
centres does not ensure once they are not centred on each other.

## 8. Bindings

A property marked *bindable* accepts, instead of a fixed value:

| Form | Effect |
|---|---|
| `{ "param": "name" }` | Value of the `name` parameter (section 9). Types must be compatible (e.g. a size cannot bind to a text parameter). |
| `{ "bind": "path" }` | Tracking data, updated every frame. |
| `{ "bind": "…", "range": [a, b], "to": [c, d] }` | Value clamped to `[a, b]` then linearly mapped to `[c, d]`. `range` and `to` go together. |
| `{ "bind": "…", "map": { … } }` | Lookup table: data value → property value (keys: below). |
| `"default": …` | Value used when the data is missing (no face). |

v1 data paths: `time`, `faces.count`, `face.index`, `face.size`, `face.pose.yaw`, `face.pose.pitch`,
`face.pose.roll`, `face.blendshapes.<name>` (appendix B). Plugins MAY add more (e.g. `face.mood`).

**Per data type.** v1 data paths are all numbers; plugins MAY add `string` and `boolean` data (their registry gives
each path's type). What a `{ "bind" }` can feed:

| Data | Plain `{ "bind" }` | `range` / `to` | `map` keys that match |
|---|---|---|---|
| number | A number property; or a text property, as JSON writes the number (`2`, `0.5`) | Yes, into a number property | The number written as JSON writes it: `"1"` matches 1, `"0.5"` matches 0.5; `"1.0"`, `"01"`, `"1e0"`, `"x"` never match |
| boolean | A boolean property | No | `"true"`, `"false"` |
| string | A string property (e.g. `text`) | No | The same string |

- Any other conversion needs `map`: a color, a vector (`offset`, `rotation`) or a boolean (`visible`) from numeric
  data, a color or a number from string data, e.g. `{ "bind": "face.index", "map": { "0": "#ff0000",
  "1": "#0000ff" } }`. `map` values MUST have the property's type; `map` and `range` cannot be combined.
- A plain `{ "bind" }` whose data does not fit the property (above) is an error, reported by a validator and, at
  load, by an engine. A `map` key that can never match its data is dead: a validator SHOULD warn about it.
- **Missing data** (no face at that slot, blendshapes dropped, a value with no `map` entry) gives the binding's
  `default`, used as it is: it is not passed through `map` or `range`/`to`, so it MUST have the property's type.
  Without `default`, the property takes its default value (section 6).
- `{ "param" }`: a number property takes a `number` parameter, a boolean property a `boolean`, a text property a
  `string`, `text`, `select` or `color`, a color property a `color`, a vector property a `vec2` or `vec3` of its size.

Blendshapes are an optional capability (16.2): while the engine has dropped them, `face.blendshapes.<name>` bindings
take their `default` value, as when no face is visible.

Bindings are evaluated by the engine, **outside the sandbox**: they cost neither latency nor data transfer.
The language is deliberately limited to these forms; any richer logic belongs in the script.

### 8.1 Content properties

`sticker.src`, `model.src`, `text.font` and `color.lut` hold an asset (10.1). They are not *bindable* (an asset is
not tracking data: no `{ bind }`), but each takes, instead of an asset, a parameter binding of its own:

| Form | Shows |
|---|---|
| `{ "param": "logo" }` | The file the host gives the `asset` parameter `logo` (9), once it has passed the checks of section 15. |
| `{ "param": "style", "map": { "gold": "crown-gold", "flowers": "crown-flowers" } }` | The asset `map` gives for the value of the `select` or `string` parameter `style`. |

- **Parameter types**: `asset`, without `map`; `select` or `string`, with `map` (required). Any other type is an error.
- **`map` values** are asset references (10.1) of a kind the property shows: an image, spritesheet or video for
  `sticker.src`, a model for `model.src`, a font for `text.font`, a LUT for `color.lut`. A validator reports any other
  value as an error, and warns about an option of a `select` that has no entry in `map` and about a key that is not
  an option (it never matches).
- **`accept`** of an `asset` parameter bound to a content property lists only media types that property can show;
  a validator reports any other:

  | Property | Media types |
  |---|---|
  | `sticker.src` | `image/png`, `image/jpeg`, `image/webp`, `image/avif`, `image/svg+xml`, `image/ktx2` |
  | `model.src` | `model/gltf-binary`, `model/gltf+json` |
  | `text.font` | `font/woff2`, `font/woff`, `font/ttf`, `font/otf` |
  | `color.lut` | `text/x-cube` (`.cube` has no registered media type) |

  A host file is an image, never a spritesheet or a video (it has no `frames` or `alpha`). An `asset` parameter bound
  to several content properties must fit all of them.
- **No asset** (an `asset` parameter without a file, a value `map` does not list): a `sticker` or `model` layer is not
  drawn, a `text` uses the default font (`builtin:font/sans-bold`), a `color` layer applies no LUT (its other
  adjustments still apply).
- **When it applies**: at the start of a frame, like any parameter change (9). The `map` values are assets of the
  filter, preloaded with it (10.4): the next frame shows the new one. A host file is loaded and checked first, as with
  `apply: "reload"`: the layer keeps showing its previous asset meanwhile, switches at the start of a frame (never
  an empty frame), and the previous file is then released. The parameter's value (`f.params`, `paramChange`) changes
  at that frame. A file that fails the checks is refused (9) and changes nothing.
- **`{ pick }`** and a parameter binding are alternatives of `src`: a pick list holds assets only, and a `map` value is
  one asset.
- `shader.textures` are not content properties in v1 (a later version MAY add them).
- A script MAY replace a content property's value with the name of a declared asset (12.4).

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
  A layer shows it through a content property (8.1). When it is set, its declared media type, if it has one, MUST be
  in `accept`, and its size at most `maxSize` and the package limit (50 MB, section 3); its content is checked when it
  is loaded, and a file refused then is reported asynchronously, with the same kind of error (reference engine: an
  `InvalidParamError` with the reason `content` on `engine.on('error')`); the parameter keeps its previous file.
  `optional: true` lets the host remove the file (`null`). A parameter without a file, optional or not, shows no asset
  (8.1) until the host gives one; an engine SHOULD warn about a non-optional one at load.
- Preset values MUST be valid for their parameter.

## 10. Assets

### 10.1 Declaration

```json
"assets": {
  "hat":  "assets/hat.glb",
  "fire": { "src": "assets/fire.mp4", "alpha": "packed" },
  "walk": { "src": "assets/walk.png", "frames": { "cols": 4, "rows": 2, "fps": 12 } },
  "star": { "svg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'>…</svg>" },
  "cool": { "emoji": "😎" },
  "title": "builtin:font/rounded-bold"
}
```

An entry is an `assets/…` path, `{ "src": … }` with options, an inline `svg`, an `emoji`, or a built-in resource
`builtin:…` (10.3) under a name of the filter: e.g. a built-in font a canvas draws with by that name (12.6).

An asset reference (`src`, `font`, `lut`, `textures`…) is one of:

- a **name** declared in `assets`;
- an `assets/…` **path** inside the package;
- a **built-in resource** `builtin:…`.

**Remote URLs are forbidden** (`http:`, `https:`, `data:`…): a remote asset would be a way to leak data.

A content property (`src`, `font`, `lut`) may take a parameter binding instead of a reference (8.1).

**Picking.** A `src` of `{ "pick": [...], "by": "face" | "random" }` (`sticker`, `model`) gives each selected face
one asset of the list, kept while the face keeps its stable id (5.4); a face that leaves and comes back gets a new
pick. `by: "face"` (default) takes entry (id − 1) mod n, so successive faces get successive assets and the result
is the same on every run; `by: "random"` draws an entry when the face gets its id (seed: 12.5). A layer with
`anchor: "screen"` picks for its first selected face, or for id 0 while no face is tracked (the first entry with
`by: "face"`).

### 10.2 Formats

| Kind (`kind`) | Formats | Notes |
|---|---|---|
| `image` | PNG, WebP, JPEG, AVIF, SVG, KTX2 | KTX2 recommended on mobile: a 2D texture (one face, one layer, no depth) with the sRGB transfer function, in Basis Universal (ETC1S or UASTC) or uncompressed `R8G8B8A8_SRGB` without supercompression, with straight or premultiplied alpha (the descriptor's flag). SVG is rendered as an image: no script, no external resource. |
| `spritesheet` | image + `frames` | Animated grid. |
| `video` | MP4 (H.264), WebM (VP9) | Transparency: `alpha: "packed"` (color on the left, mask on the right), portable across browsers. Muted by default. |
| `model` | glTF 2.0 / GLB | Animations, Draco or meshopt compression. |
| `lut` | `.cube` | |
| `shader` | `.frag`, `.glsl` | Section 11. |
| `font` | WOFF2, WOFF, TTF, OTF | `text.font`; by asset name in canvases (12.6). |
| `audio` | OGG, MP3, WAV, Opus | Sound effects triggered by the script. |
| `lottie` | `.lottie`, or `.json` with `kind: "lottie"` | Reserved (Lottie plugin). |
| `data` | JSON | Reserved: no v1 layer or script API reads it (plugin layers may). JSON a script uses is imported in `filter.js` and bundled into `script.js` by `ouaf pack` (3.1). A later version may add an API to read it (`f.data`), compatibly. |

The kind is inferred from the extension; `kind` overrides it when needed.

### 10.3 v1 built-in resources

Fonts `builtin:font/sans`, `sans-bold` (default), `rounded-bold`, `serif`, `mono`, `handwritten`;
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
- **Output.** The engine's `main()` mixes the color returned by `effect(uv)` over `ouaf_sample(uv)` by its alpha
  (clamped to 0–1) times the layer's `opacity`, and, on the `face` stage, the soft edge of the face mesh:
  `mix(ouaf_sample(uv).rgb, c.rgb, a)`. The result is opaque: returning `vec4(c.rgb, 0.0)` leaves the image as it
  is, and an `opacity` of 0.5 blends the effect halfway.
- Each `uniforms` entry becomes a uniform of the same name (number → `float`, boolean → `bool`, `vec2`, `vec3`,
  color → `vec4`); each `textures` entry a `sampler2D` of the same name. These names MUST therefore be GLSL
  identifiers (letters, digits and `_`, not starting with a digit) that are not GLSL keywords or built-in names
  (`float`, `texture`…), do not start with `gl_` or contain `__` (reserved by GLSL), are not `main` or `effect`, and
  are not used in both `uniforms` and `textures`; a validator reports any other name.
- `stage`: `background`, `face` (limited to the face mesh) or `post` (full screen, default).
- Names starting with `ouaf_` or `OUAF_` are reserved for the engine.

### 11.1 Inputs

| Input | Description |
|---|---|
| `vec4 ouaf_sample(vec2 uv)` | Image at this stage: what was drawn before this shader, as sRGB-encoded values. |
| `float ouaf_time`, `float ouaf_dt` | Media time and duration of the frame, in seconds. |
| `vec2 ouaf_resolution` | Size of the rendered image, in pixels. |
| `float ouaf_faceMask(vec2 uv)` | 0 to 1: soft mask covering every tracked face (1 inside, feathered at the edge). |
| `vec4 ouaf_prevFrame(vec2 uv)` | Output of **this shader** at the previous frame (trails, feedback); black at the first frame. |
| `int ouaf_faceCount` | Number of tracked faces (0 when none), at most `OUAF_MAX_FACES`. |
| `OUAF_MAX_FACES` | Size of the per-face arrays: the engine's maximum number of faces (5.4). |
| `float ouaf_faceSize[OUAF_MAX_FACES]` | Distance between the eye centres of each face, in `uv` units of the image height. |
| `vec2 ouaf_anchor_<name>[OUAF_MAX_FACES]` | Position of each anchor declared in the layer's `anchors` (below), per face. |

- `uv` and anchor positions follow the GLSL convention: from 0 to 1 over the image, **origin at the bottom left, y up**,
  in the image as displayed (mirroring applied). Values of the per-face arrays are only meaningful for
  `i < ouaf_faceCount`.
- **Anchors are declared**, since GLSL has no strings: `"anchors": ["noseTip", "leftEye"]` in the layer gives
  `ouaf_anchor_noseTip` and `ouaf_anchor_leftEye`. Only declared anchors are computed and uploaded. Face anchors only
  (5.3).
- **Face inputs need `requires.face`**: declaring anchors, using `stage: "face"`, or using `ouaf_faceMask`,
  `ouaf_faceCount` or `ouaf_faceSize` in the source (comments do not count). Without it, no face is tracked and they
  read as when no face is visible. A validator that can read the shader file (a package or a folder) reports a face
  input used without `requires.face` as an error, and does not report `requires.face` as unused when a shader uses
  one. An engine that loads such a shader anyway SHOULD warn.
- An engine only allocates what a shader uses: `ouaf_prevFrame` costs an extra image buffer, so the engine provides
  it only to a shader that calls it.
- Reserved for later versions: `ouaf_personMask` (segmentation, phase 2), `ouaf_audioLevel` (audio, phase 3).
- A validator SHOULD compile the shader and report errors with their line numbers, counted in the author's file.
- An engine MUST handle GPU context loss and disable a filter whose shader causes it.
- A draw call cannot be interrupted: a shader that runs for seconds stalls the whole page (on some systems the
  browser's compositor too) until the GPU finishes or the browser resets it. An engine SHOULD disable a filter whose
  shader keeps the GPU busy for more than **3 s** a frame on two frames in a row, or on one frame that has not finished
  after 6 s, and report it as for a context loss. Informative: the reference engine measures each frame that draws
  an author shader with a fence (`fenceSync`) polled on a timer, does not count frames while the page is hidden, and
  emits an `error` event with the code `gpu-stalled`.
- For a future WebGPU renderer, GLSL → WGSL translation happens at packaging time; authors only write GLSL.

## 12. Scripts

### 12.1 Execution model

- The script runs in a **sandbox** (section 15): no DOM, no network, no access to the host. Each filter has its own.
- It talks to the engine through messages. Its commands take effect **at the earliest at the next frame**: the
  answer to frame N is applied when rendering frame N+1 or later. Hence the rule: **spatial work is native**
  (anchoring, tracking, bindings, animations) and **the script does the logic** (change a text, start an animation,
  count points).
- It only receives the data it asks for (12.4).
- **Live sources** (camera, a playing video): the engine never waits for the script. An answer is applied at the
  first frame rendered after it arrives.
- **File sources** (image, offline video, `pushFrame`): the engine waits for the answer to frame N before rendering
  frame N+1, so that every run gives the same result (12.5). The watchdog (12.7) still applies.

### 12.2 The manifest's `script` section (filled in by `ouaf pack`)

```json
"script": { "entry": "script.js", "setup": true, "update": true, "on": ["smile", "message:startGame"], "draw": ["bubble"], "uses": ["face.pose"] }
```

`uses` lists the data the script receives (12.4); when omitted, `["face.pose", "face.blendshapes"]`. It is the one
field the author writes in `filter.js` (`script: { uses: ["face.anchors"] }`); the others describe the functions.

`script.js` is a self-contained ES module (no `import`): its default export is an object with the functions of
`filter.js` and the initial state (`state`, `setup`, `update`, `on`, `draw`; other keys are ignored). The engine
reads the manifest, not this object, to know which functions exist and which events the script handles.

### 12.3 Functions in `filter.js`

```js
import { defineFilter } from '@ouaf/spec'

export default defineFilter({
  // … manifest data …
  state: { smiles: 0 },                       // initial (global) state
  setup(f) { },                               // once, on activation
  on: {
    smile(f, { face }) {                      // every face event carries the face concerned
      f.state.smiles++
      f.layer('label', face).set({ text: `😄 × ${f.state.smiles}` })
      f.layer('label', face).animate({ scale: { keyframes: [1, 1.4, 1] } }, { duration: 300, easing: 'outBack' })
      f.emit('smiles', f.state.smiles)
    },
  },
  update(f, frame) { },                       // every frame (avoid it when a binding is enough)
  draw: { bubble(ctx, f, frame) { } },        // canvas layers
})
```

`defineFilter` returns its argument unchanged; it only gives editors and type checkers the types of the format
(`f.layer()` only accepts the declared layer ids).

### 12.4 The `f` API and `frame` data

| API | Purpose |
|---|---|
| `f.layer(id, face?)` | Handle on a layer (below). With `face`, the instance of that face; without, every instance. |
| `f.state` / `face.state` | Global state / per-face state (reset when the face leaves). Plain data. |
| `f.params` | Parameters, **read-only**, updated at each frame. |
| `f.emit(name, data?)` | Message to the host: `handle.on('filter:<name>', data)` and `engine.on('filter:<name>', { filter, data })`. |
| `f.asset(name)` | Image asset (image, SVG, emoji, spritesheet) declared in `assets`, by name, as an `ImageBitmap` drawable in a canvas (a spritesheet gives its first frame). Synchronous: assets are preloaded (10.4). Only scripts that draw canvas layers get them. |
| `f.sound(name)` | `.play()`, `.stop()` *(reserved)*. |
| `f.random()` | Number in [0, 1) from the filter's seeded generator (12.5). |
| `f.after(ms, fn)`, `f.every(ms, fn)` | Timers in **media time**: `fn(f)` runs at the first frame whose time reaches the deadline. They return `{ cancel() }` and are all cancelled when the filter is deactivated. |

Static data (word lists, levels, tables) is imported in `filter.js` and bundled by `ouaf pack` (3.1); v1 has no API to
read a `data` asset (10.2).

**Layer handles.**

- `.set(props)`: sets properties. Settable: every *bindable* property, plus the content properties `text`, `color`,
  `font`, `src`, `lut`, `animation`, `size` and `scale`. `src` (`sticker`, `model`), `font` and `lut` take the name
  of an asset declared in `assets` that the property can show (8.1), not a path or `builtin:`; an engine preloads
  every such asset of a filter with a script (10.4), so the change shows at the next frame. `animation` takes the
  name of a clip of the model, started from its beginning. Another value is ignored with a warning. Structural
  properties (`type`, `id`, `anchor`, `faces`, `stage`, `kind`, `width`, `height`) cannot be set. A set value
  **replaces** the property's binding, if any, or its `{ pick }`, until the script sets the property to `null`,
  which restores the manifest value (fixed, picked or bound).
- A shader layer's `uniforms` are set **one by one**: `.set({ uniforms: { amount: 2 } })` only changes `amount`,
  and `{ uniforms: { amount: null } }` only restores `amount`'s manifest value (fixed or bound). A value has the
  uniform's type, given by its manifest value: a number (`float`), a boolean (`bool`), `[x, y]` or `[x, y, z]`
  (`vec2`, `vec3`), a color (`vec4`); a script cannot add a uniform nor change its type. `.animate()` animates
  number, vector and color uniforms (`{ uniforms: { amount: 4 } }`).
- `.animate(props, { duration, easing?, delay?, repeat? })`: animates numbers, vectors and colors, played by the
  engine at the frame rate (no per-frame message). A value is the target, animated from the current value: a number,
  a color or a vector (`{ scale: [1, 1.4, 1] }` stretches vertically). Keyframes are written `{ keyframes: [...] }`:
  at least two values of the property's type, evenly spaced over `duration`, the first one replacing the current
  value (`{ scale: { keyframes: [1, 1.4, 1] } }` is a uniform "pop"). An array is never read as keyframes, so a
  vector target is never ambiguous. `repeat`: number of extra runs, `-1` for endless. Animating a
  property cancels the previous animation of that property. The final value stays set, as with `.set()`.
- `.play(animationName)` (model), `.invalidate()` (canvas: redraw at the next frame).
- Easings: `linear`, and `in`, `out`, `inOut` × `Quad`, `Cubic`, `Back`, `Elastic`, `Bounce` (e.g. `outBack`,
  `inOutQuad`), with the usual definitions of Robert Penner's equations. Default: `inOutQuad`.

**Messages.** `data` of `f.emit` MUST be structured-cloneable and at most 64 KB; an engine MUST refuse larger
messages with a warning, and MAY drop messages above 60 per second. The host sends messages the other way with
`handle.send(name, data)` (one filter) or `engine.send(name, data)` (every filter of the stack); the script receives
them as the `message:<name>` event (13), with the payload `{ data }`. The same rules apply in that direction, but an
engine checks them **at the call**, which throws (reference engine: `OuafError` with the code `invalid-message`): the
name is a letter, then letters, digits, `_` or `-` (`startGame`, `level-2`); `data` is optional, MUST be
structured-cloneable and at most 64 KB, and is copied at the call (as by `postMessage`), so changing it afterwards
changes nothing. The 64 KB are measured as for `f.emit` (reference engine: a walk of the data counting strings at 2
bytes a character, numbers at 8, typed arrays and `ArrayBuffer`s at their byte length, keys included).

**`frame` data.** `frame.time` (media time, s), `frame.dt` (s since the previous call to the script, which covers the
frames it skipped, 12.7), `frame.aspect` (the displayed width / height, e.g. 0.5625 for a 9:16 portrait image),
`frame.faces` (list) and, with `uses: ["pairs"]`, `frame.pairs`. Each face has `id`
(stable while the face is tracked, 5.4), `index`, `state`, and, depending on `uses`:

| `uses` | Per face |
|---|---|
| `face.pose` (default) | `pose: { yaw, pitch, roll }` in degrees and `size`, as the data paths of section 8. |
| `face.blendshapes` (default) | `blendshapes: { jawOpen: 0.3, … }` from 0 to 1; absent while the engine has dropped them (16.2). |
| `face.anchors` | `anchors: { noseTip: [x, y], … }`: every face anchor of 5.3. |
| `face.landmarks` | `landmarks`: `Float32Array` of 478 × 3 values `x, y, z`. |
| `pairs` | (on `frame`) `pairs`: one `{ a, b, distance, contact }` per pair of faces (below). |

- **Positions** (`anchors`, `landmarks`) are in **display space, normalized**: from 0 to 1 over the displayed image,
  origin at the top left, **y down** (as in a canvas), mirroring applied, so they match what the person sees. x is
  over the width and y over the height: `dx * frame.aspect` and `dy` measure an on-screen distance in screen heights
  (a circle on screen has the same radius in both). There are no pixel sizes: they depend on the device, and a
  canvas has its own size (12.6).
  `landmarks` `z` is a relative depth at the scale of `x` (smaller is closer to the camera).
- **Pairs**: `a` and `b` are faces of `frame.faces`; `distance` is the on-screen distance between the two head
  centres, in **face units** (the mean eye distance of the two faces), so it does not depend on how far the people
  are from the camera; `contact` is `true` while the face outlines touch or overlap on screen (the `pairContact`
  event, 13). The distance is measured on screen: two people one behind the other can look in contact.

### 12.5 Determinism

- With a file source (image, offline video, `pushFrame`), a filter MUST produce the same result on every run:
  `frame.time` is the media time, the engine waits for the script (12.1), and `f.random()` is seeded with a fixed value.
- With a live source, `f.random()` is seeded randomly at each activation, so that random choices differ between
  sessions. The same rule applies to `{ pick, by: "random" }` assets (10.1).
- A host MAY fix the seed (reference engine: `createEngine({ seed })`), e.g. to reproduce a bug.

### 12.6 Canvas

`draw.<id>(ctx, f, frame)` receives a standard `CanvasRenderingContext2D` (`OffscreenCanvas`) of `width` × `height`
pixels, origin at the top left, y down; `frame` is the data of 12.4 (the frame of the call).

- **When.** The engine calls it after `update`: with the first frame the script receives, then at most `fps` times per
  second of media time (`frame.time`), and after `f.layer(id).invalidate()`, in the same frame when `invalidate()` is
  called from a timer, an event or `update`, at the next frame when it is called from a `draw` function. `fps: 0`:
  only the first time and after `invalidate()`.
- **What.** Each call starts from a transparent canvas; the rest of the context state (transform, styles) carries
  over from the previous call. The image is shown from the frame that applies the script's answer (12.1), and stays
  until the next draw. When `draw` throws, the layer keeps its previous image. The canvas keeps the size of the
  manifest: an engine MUST NOT show an image of another size.
- **Where.** A canvas layer has one image, shown on every face it selects (`faces`) like a sticker: `size` is its height
  in anchor units, the width follows `width / height`. Nothing is shown before the first draw.
- `f.asset(name)` gives the manifest's image assets (12.4) to draw with `ctx.drawImage`.
- **Fonts.** The `font` assets declared in the manifest's `assets` (font files, and built-in fonts under a name of
  the filter, `"title": "builtin:font/rounded-bold"`, 10.1) are available to `ctx.font` under their asset name:
  `ctx.font = '24px title'`. The engine registers them in the sandbox (reference engine: the Worker's `FontFaceSet`)
  from the package bytes before `setup`, so they are ready at the first draw; nothing is fetched. A name that is a
  CSS keyword (`serif`, `monospace`, `inherit`…) is quoted: `'24px "serif"'`. Any other family is the platform's,
  which differs between devices. Where the platform cannot register fonts in the sandbox, an engine draws with the
  platform's fonts and SHOULD warn once.

The main cost is uploading the image to the GPU at each draw: keep canvases small, and `fps` low.

### 12.7 Limits

The sandbox runs the script off the rendering thread: a slow script makes its own commands late, never the rendering.

- An engine MUST NOT block rendering on a script with a live source.
- **One frame in flight**: an engine MUST NOT send frame N+1 to the script before it has answered frame N. Frames
  produced in between are not sent to the script (the next `frame.dt` covers them); events are queued and delivered
  in order, never dropped, except that the queue of a script that gets no frames (its filter disabled, or hidden as
  in 16.3) MUST be bounded: once it is full, an engine keeps only the last `message:<name>` of each name and the last
  `paramChange` of each parameter (with the `previous` of the first change it replaces), then drops the oldest events.
  The reference engine bounds it at 256 events and warns once.
- An engine MAY send no frame to a script that has nothing to do with it: no `update`, no queued event, no timer due
  and no canvas to draw (12.6). The script cannot tell: only `update` and `draw` receive `frame`, `frame.dt` covers the
  frames not sent, and the next frame sent carries the parameters and the seed that changed meanwhile. The reference
  engine does so, so that a script that only reacts to events costs the rendering thread almost nothing per frame.
- **Watchdog**: a script that does not answer within **1 s** (`setup` included) MUST be stopped (the reference
  engine terminates its Worker). The second is the script's: an engine SHOULD NOT count its own preparation of the
  sandbox (canvases, fonts) before `script.js` is evaluated, nor the time a host thread too busy to receive the
  answer adds, so that a slow device does not stop a script that does not loop. The engine emits an `error` event
  with the code `SCRIPT_STOPPED`; the rest of the filter (layers, bindings, animations already started) keeps
  working. The script stays stopped until the filter is activated again.
- An engine SHOULD emit a warning when the script answers more slowly than the rendering frame rate.

## 13. Events

| Event | Trigger | Default threshold (tunable) |
|---|---|---|
| `faceEnter`, `faceLeave` | A face appears / disappears | — |
| `blink` | Both eyes close briefly | 0.5 |
| `wink` | A single eye; `payload.side` = `left` \| `right` | 0.5 |
| `mouthOpen`, `mouthClose` | `jawOpen` crosses the threshold | 0.35 |
| `smile`, `smileEnd` | Average of `mouthSmileLeft/Right` | 0.5 |
| `eyebrowRaise` | `browInnerUp` | 0.5 |
| `kiss` | `mouthPucker` | 0.7 |
| `nod`, `shake` | Vertical / horizontal head oscillation | 0.5 |
| `paramChange` | A parameter changed: `{ name, value, previous }` | — |
| `pairContact`, `pairSeparate` | Two faces touch / move apart on screen; `payload.faces` = `[a, b]` (12.4) | 0 |
| `message:<name>` | Message from the host (`handle.send(name, data)` or `engine.send(name, data)`); payload `{ data }`, a structured clone of `data` (12.4). `name`: a letter, then letters, digits, `_`, `-` | — |

- Pair events carry the two faces instead of one. Their threshold is the gap between the two face outlines, in face
  units: `0` fires when the outlines touch, `0.2` slightly before. `frame.pairs[].contact` is the same state: `true`
  from `pairContact` to `pairSeparate`. A pair missing from a frame (one face not tracked for a moment) keeps its
  state during the grace delay of the face ids (5.4); a face that leaves while in contact ends the contact with
  `pairSeparate`.
- Expression events fire **once** at the start of the gesture, with **hysteresis** (no bursts on the slightest twitch).
- Expression events MUST keep working when blendshapes are dropped (16.2): the engine then derives them from the
  landmark geometry (mouth opening, eyelid opening, eyebrow height, mouth corners…), mapped to the same 0–1 scale as
  the blendshapes, so the thresholds above keep their meaning.
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
   uses a `sandbox` iframe (opaque origin), a `connect-src 'none'` CSP and a Worker. The script shares that context
   with the engine's runtime, so it can rewrite the runtime's messages: an engine MUST check every message that comes
   out of it (commands, events, warnings, images), and bound what it accepts.
2. **Minimization.** A script only receives the data declared in `uses`. A filter without a script sends no data
   to untrusted code.
3. **No identification.** An engine MUST NOT recognize or re-identify a person. Face ids are ephemeral.
4. **Untrusted assets.** Size and dimensions are checked before decoding; SVGs are rendered as images; no remote resources.
   The files a host gives `asset` parameters (9) are untrusted too: their format is identified from their content,
   not from their declared type or name, and MUST be one of the accepted media types (8.1); then they pass the checks
   of a package asset of their kind (size, dimensions before decoding, SVG rendered as an image, a glTF without
   external files).
   A package is untrusted input too (3): links, special entries, unsafe paths and duplicate entries are refused, and
   decompression is bounded by the declared sizes and the size limit, so an archive cannot write outside the package
   or inflate without bound (zip bomb).
5. **Denial of service.** The script never blocks rendering, at most one frame is in flight to it, a script that
   does not answer within 1 s is stopped (12.7), GPU context loss is handled and a shader that stalls the GPU is
   disabled (11).
6. **Deceptive UI.** `overlay` layers are drawn into the canvas: a filter cannot create input fields.
7. **Expressions, not emotions.** Events describe expressions (smile, open mouth). Emotion inference is reserved for an
   explicit plugin; hosts in education or workplace settings MUST disable it (EU AI Act).

## 16. Performance and device adaptation

The power of the devices that run filters varies by a factor of ten or more, and it cannot be predicted from the
device model: on some phones the GPU inference path is twice as slow as the CPU one. An engine therefore adapts to
what it **measures** while the filter runs, within limits the filter declares.

### 16.1 Tracking rate and floor

- The **tracking rate** is the number of tracking results completed per second, measured over a sliding window of a
  few seconds. It can be lower than the rendering frame rate: an engine MAY render every camera frame and update
  tracking less often.
- **Floor: 12 Hz.** Below it, anchored content visibly lags behind the face, even with the smoothing and prediction
  an engine applies between results. A filter that uses face tracking is not displayed while the rate stays below the
  floor (16.3). The floor is a *tracking* rate: rendering may keep the camera's frame rate meanwhile (a rendering floor
  such as 15 frames per second is another measure). Informative: on a mid-range phone (Redmi Note 11S), 16–18 Hz of
  tracking with prediction between results was judged to follow the face well.
- Filters without face tracking (e.g. a color grade on the whole image) are not subject to the floor.

### 16.2 Optional capabilities

To keep the tracking rate above the floor, an engine MAY drop the following capabilities, **in this order**:

| Order | Capability | While dropped |
|---|---|---|
| 1 | Blendshapes, unless `requires.blendshapes` (4.1) | `face.blendshapes.<name>` bindings take their `default` (8); `face.blendshapes` is absent from script data (12.4); expression events come from the landmark geometry (13). |
| 2 | Faces beyond the first | The engine lowers `maxFaces` (5.4), down to the number of faces tracked, which also drops the search for new faces while every slot is taken: layers keep applying to the faces still tracked, and a person who enters the image is not picked up until the capability is restored. |
| 3 | Analysis resolution | The engine analyses a smaller copy of the camera image; tracking is less precise on small faces. |

- An engine MUST NOT drop a required capability: face landmarks and pose, and blendshapes when `requires.blendshapes`
  is set.
- Before hiding a filter (16.3), an engine MUST have dropped every optional capability the filter uses. It MAY drop
  them earlier to reach a higher rate than the floor.
- An engine SHOULD restore dropped capabilities one at a time, in reverse order, with hysteresis, so that they do not
  switch on and off around a threshold.
- Capabilities reserved for later versions (segmentation, irises, hands) will be added to this list with their version.

### 16.3 Below the floor

- **At startup**, the engine judges the rate over the first 3 s, after dropping the optional capabilities it needs to,
  without counting the tracker's warm-up (its first, slower results).
- **While running**, the filter is hidden once the rate has stayed below **12 Hz for 3 s**, and shown again once the
  rate is back above **14 Hz**. The gap between the two thresholds prevents flicker. The rate that counts is the one
  with the filter shown and the faces tracked: hiding the filter frees the device, and a tracker is faster without a
  face to analyse, so neither is a recovery by itself. A tracker that runs off the main thread (a worker) gains little
  from the hide: the engine MAY then judge on the rate measured while the filter is hidden, so that a filter hidden by
  a short dip is shown again within seconds.
- While a filter is hidden, the engine renders the **raw camera image**, without any part of the filter. The filter is
  suspended: no layers are drawn, no events are delivered and its script is not called. Tracking keeps running, to
  measure when the filter can be shown again.
- The engine notifies the host with a `performance` event (`engine.on('performance', e)`) at each state change:
  `e.state` is `"ok"`, `"degraded"` (some optional capabilities dropped, listed in `e.dropped`) or `"unsupported"`
  (filter hidden), and `e.trackingHz` is the measured rate. The engine displays no message of its own: the host
  decides what to tell the person.

### 16.4 Choosing the inference backend

- An engine SHOULD choose its inference backend (wasm CPU, WebGL, WebGPU…) by **measuring** it on the device, not from
  the device model, GPU name or number of cores. The reference implementation runs a short benchmark (1 to 2 s) at
  first start and caches the result locally, keyed by engine version.
- The benchmark result stays on the device: it MUST NOT be transmitted (15).

### 16.5 Rendering resolution

- An engine MAY lower its internal rendering resolution while it cannot render every frame of a live source, and
  SHOULD raise it again once it can, one step at a time and with hysteresis, so that the image does not switch back
  and forth between two sizes. This is independent of the tracking rate (16.1): the image is drawn smaller, then
  scaled to the host's display, and nothing else changes.
- Filters therefore MUST NOT depend on the internal resolution in pixels: shaders read `ouaf_resolution` (11.1),
  which follows it, and positions are in `uv` or anchor units. A change of size clears `ouaf_prevFrame` (black, as at
  the first frame).
- A file source (12.1) is never adapted: its frames are rendered at the host's resolution, whatever the time they
  take.
- Informative: the reference engine measures the share of the camera's frames it did not render
  (`requestVideoFrameCallback`'s presented frames), lowers the resolution in steps down to half of the host's, keeps
  a step only when it reduced that share (otherwise the bottleneck was not the pixels: it goes back), and reports the
  scale in its `stats` event (`renderScale`, `missedFrames`).

## 17. Versioning and compatibility

- The `ouaf` field changes value only for a breaking change.
- Minor versions of the spec (1.1, 1.2…) add fields, types, anchors or events **without** breaking existing filters.
- A 1.x engine MUST refuse a filter whose `engine` range excludes its version, with an explicit message.
- Plugins follow semver; `requires.plugins` expresses a range.

## 18. Conformance

- **Conforming validator**: checks the schema **and** the semantic rules (anchors, asset references, parameters and presets,
  bindings, events, drawn canvas layers, `requires`), and reports for each problem a code, a JSON pointer, a message and,
  when possible, a suggestion. Reference implementation: `validateManifest()` in `@ouaf/spec`, and `ouaf validate`.
- **Conforming engine**: follows sections 5 to 16; rendering differences between engines are acceptable as long as
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

The 51 values (0 to 1) provided by MediaPipe FaceLandmarker, ARKit convention (MediaPipe outputs 52 categories,
the extra one being `_neutral`):
`browDownLeft`, `browDownRight`, `browInnerUp`, `browOuterUpLeft`, `browOuterUpRight`, `cheekPuff`, `cheekSquintLeft`,
`cheekSquintRight`, `eyeBlinkLeft`, `eyeBlinkRight`, `eyeLookDownLeft`, `eyeLookDownRight`, `eyeLookInLeft`, `eyeLookInRight`,
`eyeLookOutLeft`, `eyeLookOutRight`, `eyeLookUpLeft`, `eyeLookUpRight`, `eyeSquintLeft`, `eyeSquintRight`, `eyeWideLeft`,
`eyeWideRight`, `jawForward`, `jawLeft`, `jawOpen`, `jawRight`, `mouthClose`, `mouthDimpleLeft`, `mouthDimpleRight`,
`mouthFrownLeft`, `mouthFrownRight`, `mouthFunnel`, `mouthLeft`, `mouthLowerDownLeft`, `mouthLowerDownRight`, `mouthPressLeft`,
`mouthPressRight`, `mouthPucker`, `mouthRight`, `mouthRollLower`, `mouthRollUpper`, `mouthShrugLower`, `mouthShrugUpper`,
`mouthSmileLeft`, `mouthSmileRight`, `mouthStretchLeft`, `mouthStretchRight`, `mouthUpperUpLeft`, `mouthUpperUpRight`,
`noseSneerLeft`, `noseSneerRight` (plus `_neutral`, not exposed).

## Appendix C — To be confirmed (phase 1)

The phase 0 measurements (`docs/decisions/`) settled the tracking runtime, the worker and the default number of faces,
which are implementation choices outside this specification. The items below remain open and are settled by the
phase 1 work they depend on.

- Offset of the `head` origin (Appendix D), to be checked once rigid anchors are rendered.
- Default event thresholds, after measurements on a variety of faces, and the mapping of the geometric measures used
  when blendshapes are dropped (13, 16.2) onto the same scale. The reference engine's first mapping is fitted on the
  test clips (#90): it covers blinks, smiles and speech; a wide-open mouth, raised eyebrows and a kiss are extrapolated.
  For blinks and winks it also uses the eye geometry while blendshapes are available (the larger of the two values per
  eye): MediaPipe's `eyeBlink` peaks at 0.5–0.6 on a full blink for some people, and a blink sampled at 10–15 Hz is
  often caught half-closed. The default blink threshold stays 0.5.
- Pair contacts (13): the reference engine releases a contact when the gap exceeds the threshold by 0.1 face unit,
  for at least 100 ms (`events.pairSeparate.minDurationMs`); `pairContact` fires on the first frame in contact
  (`minDurationMs` 0). Its face outline is the face oval of the landmarks; head centres and face units come from the
  `head` frame (Appendix D), so a turned head keeps its unit. To be checked on clips of people actually touching.
- Numeric limits (package size, dimensions, number of layers) after measurements on mobile: the phase 0 runs only
  drew a debug overlay (1–3 ms per frame), so rendering limits are measured with real layers (benchmark page,
  adaptive quality).

## Appendix D — Reference anchor mapping (informative)

How the reference implementation derives the v1 anchors from MediaPipe FaceLandmarker (478 landmarks, facial
transformation matrix). Another engine MAY use a different tracker as long as the anchors keep the meaning of 5.3.
Indices were checked visually with the playground's anchors overlay.

**`head` frame.** Derived from the facial transformation matrix, i.e. the rigid pose of MediaPipe's canonical face
model, which does not change with expressions.

- Axes: those of the canonical model, as seen on screen after mirroring (5.1): +x right, +y up, +z towards the camera.
- Unit: the distance between the two eye centers (below) **measured on the canonical model**, so the unit does not
  fluctuate with expressions or landmark noise.
- Origin: the `eyes` point of the canonical model, moved back along -z by 1.5 units (≈ 9.5 cm), which approximates
  the center of the head (*provisional*).

**Anchor origins.** "Left" / "right" are the person's sides. Where two indices are given, the origin is their midpoint.

| Anchor | Landmarks |
|---|---|
| `forehead` | 10 |
| `eyes` | 168 |
| `leftEye` | 263, 362 (eye corners) |
| `rightEye` | 33, 133 (eye corners) |
| `noseBridge` | 6 |
| `noseTip` | 1 |
| `mouth` | 13, 14 (inner lips) |
| `upperLip` | 0 |
| `lowerLip` | 17 |
| `chin` | 152 |
| `leftCheek` | 280 |
| `rightCheek` | 50 |
| `leftTemple` | 356 |
| `rightTemple` | 127 |

- `follow: rigid`: the landmarks are taken on the canonical model and transformed by the head pose.
- `follow: expression`: the live landmarks of the current frame are used (then smoothed).
- In both cases the anchor orientation is the `head` orientation.

## Appendix E — Reference color grading (informative)

The formulas of the reference implementation for the `color` layer (6.3), on each channel c of the sRGB-encoded
image, in 0–1, in this order:

| Step | Property | Formula |
|---|---|---|
| LUT | `lut`, `intensity` i | c = mix(c, lut(c), i); the LUT's input is mapped from `DOMAIN_MIN`–`DOMAIN_MAX`, `LUT_3D_SIZE` (trilinear) or `LUT_1D_SIZE` |
| Brightness | `brightness` b | c = c^(2^−b): a midtone curve, black and white unchanged |
| Contrast | `contrast` k | c = (c − ½)(1 + k) + ½ (−1: flat grey) |
| Saturation | `saturation` s | c = Y + (c − Y)(1 + s), Y the Rec. 709 luma (−1: black and white) |
| Temperature | `temperature` t | red × (1 + 0.2t), blue × (1 − 0.2t) |
| Tint | `tint` (color, alpha a) | c = mix(c, c × tint, a) |
| Vignette | `vignette` v | c × (1 − v · smoothstep(0.35, 1, r)), r from 0 at the centre to 1 in the corners |
| Grain | `grain` g | c + 0.2g(n − ½), n a monochrome noise in 0–1 whose pattern depends on the pixel and changes 24 times per second of media time |

The result is clamped to 0–1, then mixed with the image below: mix(image, result, `opacity` × mask), the mask being
1 everywhere, or the soft face ovals with `region: "face"`.
