# Test media

Short video clips used by the playground (`?source=<name>`) and the browser tests, so that tracking, rendering and
anchors can be checked, and devices measured, without a person in front of a camera.

| Clip | Duration | Content |
|---|---|---|
| `pesquet-walk.mp4` | 8.5 s | One face; climbs out of the submersible and walks towards the camera (large motion, scale change) |
| `pesquet-talk.mp4` | 8.0 s | One face in close-up, talking and laughing, head turns; a second face at the end |
| `pesquet-closeup.mp4` | 3.1 s | Dim close-up, a hand passes in front of the face (occlusion) |
| `pesquet-turn.mp4` | 2.4 s | Fast head turn, a second person in the background |
| `two-faces.mp4` | 3.1 s | Two faces, one frontal with glasses, one in profile (MediaPipe finds only the frontal one) |
| `two-faces-stacked.mp4` | 3.1 s | Two frontal faces stacked vertically (composite of two extracts), for multi-face tests |
| `four-faces-grid.mp4` | 3.1 s | Four faces in a 2×2 grid (≈ 35–40 % of the frame width each), for the multi-face cost (#8): the two extracts of `two-faces-stacked`, and the same two played backwards and mirrored. MediaPipe finds all four |
| `three-faces-grid.mp4` | 3.1 s | Same grid with the bottom-right face replaced by underwater footage: three faces |
| `group-far.mp4` | 5.0 s | 2 to 4 small faces (≈ 12 % of the frame width), one with sunglasses; contains cuts. MediaPipe's short-range detector misses faces this small |
| `no-face.mp4` | 2.4 s | Underwater footage, no face (negative case) |
| `pesquet-closeup-360.mp4`, `pesquet-talk-360.mp4` | | Same as without `-360`, at 360×640, to measure the effect of the input resolution |

All clips: H.264 (Main profile), 720×1280 (portrait, like a phone; `-360` variants: 360×640), 30 fps, `+faststart`, no audio (tracking only
needs the picture; clips with sound will be added for the audio features).
They play in every target browser, including iOS Safari.

## Credits and licence

Extracts of **"Thomas Pesquet plonge dans le Nautile"** (Ifremer, campaign ESSNAUT25), videos by
**Theo Tanguy, Stéphane Lesbats, Olivier Dugornay — Ifremer**, licensed under
[**CC BY 4.0**](https://creativecommons.org/licenses/by/4.0/):

- [57767](https://commons.wikimedia.org/wiki/File:Thomas_Pesquet_plonge_dans_le_Nautile_(Ifremer_00985-109683_-_57767).webm) → `pesquet-turn.mp4`
- [57768](https://commons.wikimedia.org/wiki/File:Thomas_Pesquet_plonge_dans_le_Nautile_(Ifremer_00985-109683_-_57768).webm) → `pesquet-closeup.mp4`, `pesquet-closeup-360.mp4`, `two-faces-stacked.mp4` (bottom), `four-faces-grid.mp4` and `three-faces-grid.mp4` (top right, bottom left)
- [57769](https://commons.wikimedia.org/wiki/File:Thomas_Pesquet_plonge_dans_le_Nautile_(Ifremer_00985-109683_-_57769).webm) → `no-face.mp4`, `three-faces-grid.mp4` (bottom right)
- [57770](https://commons.wikimedia.org/wiki/File:Thomas_Pesquet_plonge_dans_le_Nautile_(Ifremer_00985-109683_-_57770).webm) → `pesquet-walk.mp4`, `pesquet-talk.mp4`, `pesquet-talk-360.mp4`, `two-faces.mp4`, `group-far.mp4`, `two-faces-stacked.mp4` (top), `four-faces-grid.mp4` (top left, bottom right), `three-faces-grid.mp4` (top left)

**Changes:** cut into short extracts, audio removed, rescaled to 720×1280 and re-encoded to H.264; `two-faces-stacked.mp4` stacks two cropped extracts; `four-faces-grid.mp4` and `three-faces-grid.mp4` tile four
cropped extracts (rescaled to 0.65 of the source size), two of them played backwards and mirrored horizontally. The original
on-screen captions and logos are kept (mirrored in the mirrored cells, cut by the crops). These clips are distributed under the same CC BY 4.0 licence; this folder is
not covered by the repository's Apache-2.0 licence.

The people shown appear in footage published by Ifremer; the clips are used only to test face tracking, never for
identification.

## Using them

- Playground: `/?source=<clip>` (without `.mp4`); `&mirror=1` mirrors, `&loop=0` plays once, `&autostart` starts
  without a tap, `&test` exposes counters on `window.ouafTest`.
- Browser tests: `npm run test:browser` (Playwright, headless Chromium; needs `npm run fetch-models`). They analyse
  each clip step by step (every 0.1 s), so the results do not depend on the machine speed.
  `OUAF_PORT=5199 npm run test:browser` starts the server on another port (when a dev server already runs on 5173).

## Rebuilding

`test-media/make.sh` downloads the sources (pinned SHA-256) and recreates the clips with ffmpeg
(made with ffmpeg 6.1.1; another version may produce different bytes).
