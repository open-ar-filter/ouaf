# Agent instructions

Ouaf (Open Universal AR Filter): an open-source engine for real-time AR filters on the web, with an open filter
format. Human contributor guide: [`CONTRIBUTING.md`](CONTRIBUTING.md); these rules apply on top of it.

These instructions are for changing the engine, the tools and the format. To write a filter, follow
[`AUTHORING.md`](AUTHORING.md) (section 17: the create → validate → preview loop) instead.

## Layout

npm workspaces monorepo, TypeScript only, Node >= 24.

| Path | Content |
|---|---|
| `packages/spec` | `@ouaf/spec`: TypeBox schemas and validator of the Ouaf v1 manifest; `scripts/build-schema.ts` |
| `packages/core` | `@ouaf/core`: the engine (camera, scheduler, face tracking, anchors, renderer, perf stats) |
| `packages/cli` | `@ouaf/cli`: the `ouaf` command (`validate`, `pack`, `preview`, `pack-alpha`; one file per command in `src/commands/`) |
| `packages/builtins` | `@ouaf/builtins`: built-in fonts and LUTs (`assets/`, credits in `assets/CREDITS.md`) and the `builtin:` resolver; `scripts/make.sh` rebuilds the fonts |
| `apps/playground` | Vite dev app; `spikes/*.html` are extra pages for phase 0 spikes; `scripts/fetch-models.ts` |
| `e2e/` | Playwright browser tests, driving the playground on the test clips |
| `test-media/` | Licensed test clips (CC BY 4.0) and `make.sh` to rebuild them |
| `docs/spec/` | Format specification `ouaf-v1.md` and the generated `ouaf-v1.schema.json` |
| `docs/decisions/`, `docs/perf/` | Design decisions and spike reports, perf export format |
| `docs/privacy.md` | What leaves the device |
| `filters/` | Demo filters, test fixtures, and the malicious filters of `filters/evil/` ([`SECURITY.md`](SECURITY.md)) |

Packages export their TypeScript sources directly (`exports: ./src/index.ts`); there is no package build step.

## Commands

```sh
npm ci                 # install
npm run typecheck      # tsc over all workspaces, scripts, tests, e2e
npm test               # Vitest unit tests (packages/*/test)
npm run test:coverage  # same with V8 coverage → coverage/index.html; fails below 80 % (skips the allocation tests)
npm run build          # playground production build
npm run build:schema   # regenerate the JSON Schema; commit docs/spec/ and packages/spec/schema/ changes
npm run fetch-models   # face model into apps/playground/models/ (gitignored); needed by the browser tests
npm run test:browser   # Playwright (starts `npm run dev` itself; all of e2e/ but evil.spec.ts); first run: npx playwright install chromium
npm run test:security  # malicious filters (filters/evil/) on Chromium, Firefox, WebKit; Linux: xvfb-run -a …
npm run dev            # playground on https://localhost:5173 (self-signed); /?source=<clip> plays a test clip
npx ouaf validate <folder|file.ouaf> [--json]   # check a filter; exit 0 valid, 1 invalid, 2 usage error
npx ouaf pack <folder> [-o out.ouaf]   # filter.ts/filter.js + assets/ → .ouaf (spec §3.1); same exit codes
npx ouaf preview <filter>... [--json]  # render on reference faces in headless Chromium → ouaf-preview/<ref>.png
npx ouaf pack-alpha <video|png-folder> -o out.mp4   # packed-alpha H.264 MP4 (spec §10.2); needs ffmpeg
```

Run `npm run typecheck` and `npm test` before every commit, and `npm run test:coverage` when adding code (CI fails
below 80 % coverage: add tests, never exclude a module that runs in Node); `npm run build:schema` whenever
`packages/spec/src` changes (CI fails on an uncommitted schema diff).

## Conventions

- Code, comments, docs, commits and PRs in **English**.
- TypeScript `strict` + `noUncheckedIndexedAccess`; erasable syntax only (no `enum`, `namespace`, parameter
  properties) because Node runs the `.ts` scripts directly; relative imports end in `.ts`.
- TypeBox in `packages/spec` is the single source of the format types and JSON Schema. Never edit
  `ouaf-v1.schema.json` by hand. A format change updates the spec text, the schemas, the validator and the tests
  together, and `AUTHORING.md` when authors see it (its examples are tested by
  `packages/cli/test/authoring-guide.test.ts`; section 14 lists what the engine does not support yet).
- Style: match the surrounding code (2 spaces, single quotes, no semicolons, ~120 columns). No formatter.
- No runtime network calls or CDN loads from the engine or playground (privacy, see `docs/privacy.md`).
- Do not add new dependencies without a reason stated in the PR.
- A change to the script sandbox, the package reader or the shader layer keeps `npm run test:security` green; a new
  attack the engine resists gets a filter in `filters/evil/`.

## Test media

Use only the clips in `test-media/` (or public-domain / CC0 / synthetic material). Never use, generate from or commit
images of real people who have not licensed them, including the user's own face.

## Workflow

- One issue per branch: `feat/<issue>-<slug>` from up-to-date `origin/main` (`spike/<issue>-<slug>` for spikes).
- Commit messages: short summary line, then a body explaining what and why.
- PR body: `Closes #<issue>` (or `Refs #<issue>` for partial work), what changes, and the choices a reviewer should
  check. Merged with a merge commit after CI passes; do not merge your own PR unless asked.
