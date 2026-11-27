# Filters

Filter folders served by the playground at `/filters/<path>/` (`manifest.json` + `assets/`), loaded with
`engine.addFilter('/filters/<path>/')` or `/engine.html?filter=/filters/<path>/`.

- `fixtures/`: small filters used by the browser tests (`e2e/`). They may use the playground's test plugin
  (`playground:*` layer types, `apps/playground/src/engine/test-plugin.ts`).
- Demo filters (#37): one folder per filter id, next to it. They use only the built-in layer types.
- [`evil/`](evil/): malicious filters (#27) that the engine must defeat, run by `e2e/evil.spec.ts` on three browsers
  ([`SECURITY.md`](../SECURITY.md)).

## Demo filters

Each demo documents a feature set, is a test and can serve as a benchmark. Together they cover the seven v1 layer
types (spec §6.3).

| Demo | Shows | Clip |
|---|---|---|
| [`text-bubble`](text-bubble/) | `text` on face and screen anchors, `orient`, `maxWidth`, built-in fonts, outline and shadow; text, color and size bound to parameters, presets; no script | `pesquet-talk` |
| [`glasses`](glasses/) | a glTF `model` with head occlusion (the temples go behind the head), SVG `sticker`s (moustache on an expression anchor, glints with `blend: "screen"`) | `pesquet-walk` |
| [`wink-crown`](wink-crown/) | glTF animations: `drop` played by the engine when a face appears, `spin` played by the script on `wink` for that face only; `uses: []` | `pesquet-walk` |
| [`big-eyes`](big-eyes/) | `warp` (`bulge` on two anchors, `pinch`), strength bound to `jawOpen` with `range` / `to`, radius bound to a parameter | `two-faces-stacked` |
| [`vintage`](vintage/) | `color` (built-in LUT, grain, vignette) then a custom post `shader` (uniforms bound to parameters, integer hashing so every GPU draws the same); no face tracking | `pesquet-walk` |
| [`smile-counter`](smile-counter/) | script sandbox: `smile` events, per-face and global state, `.set()`, `.animate()` keyframes, `f.emit()`; a sticker whose opacity follows the smile | `pesquet-talk` |
| [`canvas-bubble`](canvas-bubble/) | `canvas` drawn by the script: `fps`, `frame.time`, `face.pose`, `f.asset()`, a built-in font declared as an asset in `ctx.font`, `invalidate()` on `blink` | `pesquet-talk` |
| [`duo`](duo/) | two faces: `{ pick }` by face; distance between faces computed in the script from `face.anchors`, `face.size` and `frame.aspect`; a screen sticker placed by the script midway between the faces | `two-faces-stacked` |
| [`ai-birthday`](ai-birthday/) | written by an AI agent from `AUTHORING.md` alone (#38, [acceptance test](../docs/acceptance/ai-birthday/README.md)): a party hat built from model shapes with head occlusion on every face, a greeting set by the script from a string parameter, confetti drawn on a full-screen canvas for 2.6 s on `mouthOpen` | `two-faces-stacked` |
| [`stress`](stress/) | internal benchmark: every layer type at once on four faces, a feedback shader, canvases fed with every landmark; each group has a switch (parameters, presets) | `four-faces-grid` |

Try them on `/engine.html` (the "Demo filters" list: each one on its clip, or on the camera; the stack's "Add a
filter" menu stacks them). `duo`, `big-eyes` and
`stress` need a host with `maxFaces` ≥ 2 (4 for `stress`): the links set it.
`stress` has one more link, "slow device": device adaptation on (spec §16) and tracking slowed down to about 12 Hz
(`&adapt=1&throttle=80`), to watch in the perf panel the engine drop optional capabilities, then hide the filter if
that is not enough; `e2e/device-adaptation.spec.ts` checks that on `stress` they drop in order, that the filter is
hidden and shown again, and that its script copes without blendshapes.

[`demos.json`](demos.json) lists the demos for the playground and for `e2e/demos.spec.ts`, which renders each one
frame by frame on its clip and compares it with its reference image (`e2e/demos.spec.ts-snapshots/<id>.jpeg`;
`npx playwright test demos --update-snapshots=all` rewrites them after an intended change, check them before
committing: plain `--update-snapshots` only rewrites the images outside the tolerance).
`packages/cli/test/demo-filters.test.ts` checks that every demo of `demos.json` passes `ouaf validate` without a
warning, and that together they use the seven layer types.

Scripted demos are written as `ouaf pack` writes them (`manifest.json` with its `script` section, and `script.js`), so
the playground loads the folder as it is; their `filter.js` would hold the same functions.

## Assets and licence

The demo filters and every file in them are our own work, dedicated to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (`license: "CC0-1.0"` in each manifest). No third-party
asset, no image of anyone: faces come only from the licensed test clips (`test-media/`, CC BY 4.0), which are not part
of the filters.

| Files | Made with |
|---|---|
| `glasses/assets/glasses.glb`, `wink-crown/assets/crown.glb`, `stress/assets/*.glb` (copies) | [`make-demo-assets.ts`](make-demo-assets.ts): geometry and animations computed in code, written by a small GLB writer (`node filters/make-demo-assets.ts`, no dependency, same bytes on every run) |
| `*.svg` | written by hand |
| `vintage/assets/film.frag`, `stress/assets/*.frag` | written by hand (`stress/assets/film.frag` is a copy of `vintage`'s) |
| Built-in fonts and LUTs (`builtin:…`) | not in the folders: see [`packages/builtins/assets/CREDITS.md`](../packages/builtins/assets/CREDITS.md) |

A package is self-contained (spec §3), so a demo copies what it shares with another rather than pointing to it.
