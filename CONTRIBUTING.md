# Contributing to Ouaf

Thanks for your interest in Ouaf (Open Universal AR Filter). This guide covers setting up the project, the checks a
pull request must pass, and the conventions we follow. By taking part you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Requirements: **Node.js 24 or later** (CI runs on 24 and 26) and npm. A browser with WebGL2 for the playground.

```sh
git clone https://github.com/open-ar-filter/ouaf.git
cd ouaf
npm ci                 # install the exact versions in package-lock.json
npm run fetch-models   # download the MediaPipe face model into apps/playground/models/ (not committed)
npm run dev            # serve the playground over HTTPS on the LAN
```

Open the `https://localhost:5173/` URL printed by Vite and accept the self-signed certificate. To test on a phone,
open the `Network:` URL from a device on the same network (see [README](README.md#testing-on-a-phone)). Without a
camera, `/?source=pesquet-talk` plays a [test clip](test-media/README.md) instead.

Without `npm run fetch-models` the playground still runs, but face tracking is unavailable.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Playground dev server (HTTPS, all interfaces, port 5173) |
| `npm run build` | Production build of the playground |
| `npm test` | Unit tests (Vitest, `packages/*/test/**/*.test.ts`) |
| `npm run typecheck` | TypeScript type check of every workspace, scripts and tests |
| `npm run build:schema` | Regenerates the JSON Schema from the TypeBox schemas in `packages/spec` |
| `npm run fetch-models` | Downloads and checks the face model, extracts its TFLite files |
| `npm run test:browser` | Browser tests on the test clips (Playwright, Chromium; needs `fetch-models`) |
| `npx ouaf validate <folder\|file.ouaf>` | Checks a filter (manifest, files, formats, limits); `--json` for tools |
| `npx ouaf pack-alpha <input> -o out.mp4` | Converts a video with transparency (WebM, ProRes 4444, PNG frames) into a packed-alpha MP4; needs [ffmpeg](https://ffmpeg.org) |

The first time you run the browser tests, install Chromium: `npx playwright install chromium` (add `--with-deps` on
Linux if system libraries are missing).

`npm test` needs no ffmpeg: the `pack-alpha` tests that run the real ffmpeg (`packages/cli/test/pack-alpha.ffmpeg.test.ts`)
are skipped, with a message, when it is not installed (or point `OUAF_FFMPEG` to it).

## Before opening a pull request

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the following; run them locally first:

```sh
npm run typecheck
npm test
npm run build
npm run build:schema   # then commit any change under docs/spec/ and packages/spec/schema/
npm run test:browser   # when you touched tracking, rendering, the playground or e2e/
```

CI fails if the generated JSON Schema is not committed: never edit `ouaf-v1.schema.json` by hand, change the TypeBox
schemas in `packages/spec/src` and run `npm run build:schema`.

## Workflow

1. Pick an open issue (or open one first for anything non-trivial, using the templates). Phases are tracked as
   milestones.
2. Create a branch from an up-to-date `main`: `feat/<issue>-<slug>` (e.g. `feat/68-contributor-setup`);
   `spike/<issue>-<slug>` for time-boxed investigations, `docs/<slug>` or `chore/<slug>` when there is no issue.
3. Commit with clear messages: a short summary line, then a body explaining what and why.
4. Open a pull request against `main` and fill in the template:
   - **Title**: a short summary, optionally prefixed with the area, e.g. `Spec §16: device adaptation`,
     `CI: …`, `Spike #83: …`.
   - **Body**: `Closes #<issue>` when the PR completes the issue, `Refs #<issue>` when it covers part of it; what
     changes; and the choices made along the way that a reviewer should look at.
5. PRs are merged with a merge commit once CI is green and the review is done.

## Conventions

- **English** for code, comments, commit messages, documentation and issues.
- **TypeScript strict** (`strict`, `noUncheckedIndexedAccess`). Node runs `.ts` files directly (type stripping), so
  only erasable syntax is allowed: no `enum`, `namespace` or constructor parameter properties. Relative imports
  include the `.ts` extension.
- **TypeBox is the single source** of the filter-format types and of the published JSON Schema (`packages/spec`).
  Do not duplicate those types by hand.
- **Spec first**: a change to the filter format updates [`docs/spec/ouaf-v1.md`](docs/spec/ouaf-v1.md), the TypeBox
  schemas, the validator and its tests together. Design decisions go to [`docs/decisions/`](docs/decisions).
- **Style**: follow the surrounding code (2-space indent, single quotes, no semicolons, lines around 120 columns).
  There is no formatter or linter yet.
- **Tests**: add unit tests next to the package (`packages/<name>/test/`), browser tests in `e2e/`.
- **Privacy**: the engine never sends images or face data anywhere. Do not add network calls or CDN dependencies at
  runtime; see [`docs/privacy.md`](docs/privacy.md).

## Test media and faces

- Use only the licensed clips in [`test-media/`](test-media/README.md) (CC BY 4.0, Ifremer) or public-domain / CC0
  or synthetic material for tests, screenshots and bug reports.
- **Never commit or attach images or videos of real people** who have not licensed them, including yourself (no
  selfies), and never use the clips to identify anyone.
- New clips must come with their source, licence and a reproducible recipe (`test-media/make.sh`).

## Licences

By contributing you agree that your contribution is licensed under the licence of the files it touches:

- Code (engine, packages, tools, generated JSON Schema): [Apache-2.0](LICENSE)
- Specification text (`docs/spec/*.md`): [CC-BY-4.0](docs/spec/LICENSE)
- Example filters and their assets: CC0-1.0
- Test clips (`test-media/`): CC BY 4.0, Ifremer

Only add dependencies and assets whose licence is compatible with these.

## Coding agents

Instructions for coding agents (Claude Code, Codex, etc.) are in [`AGENTS.md`](AGENTS.md); the same rules apply to
their contributions.
