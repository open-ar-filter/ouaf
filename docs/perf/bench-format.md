# Benchmark results format (`ouaf-bench`, version 1)

The benchmark page (`/bench.html` of the playground, #39) downloads its results as one JSON document. The
TypeScript type `BenchReport` in [`apps/playground/src/bench/report.ts`](../../apps/playground/src/bench/report.ts)
is the reference; this page summarizes it.

## What is measured

Each case is a stack of filters on a test clip (`test-media/`). The page creates an engine for it (`maxFaces` of the
case, device adaptation off, seed 1), decodes the clip frame by frame (`OfflineVideoSource`, looping over it as
needed) and gives each frame to `engine.pushFrame` (the file regime of spec §12.1: the frame is tracked, then
rendered). A frame's time runs from `pushFrame` to a one-pixel `readPixels`, which waits for the GPU to finish the
frame: tracking, the layers and the GPU work are counted, decoding is not. Filter scripts run in their Worker meanwhile,
off the timed path.

The first `settings.warmup` frames of each case are not counted (shader compilation, the tracker's first runs); a
case that tracks faces keeps warming up until the tracker finds its first face (at most 15 s). Then
`settings.frames` frames are measured.

The cases: the baselines and the stacks of [`filters/bench.json`](../../filters/bench.json), and every demo of
`filters/demos.json` alone on its clip; or the stack given in the page's URL (`?filter=…&source=…`).

Numbers from different devices, browsers or trackers are not comparable; compare runs of one device. Rendering in
software (headless browsers in CI: SwiftShader) gives meaningless absolute numbers.

## Fields

| Field | Description |
|---|---|
| `format`, `version` | `"ouaf-bench"`, `1`. `version` is bumped on any breaking change. |
| `startedAt`, `durationMs` | Wall-clock start (ISO 8601, UTC) and length of the run. |
| `app` | `{ name: "ouaf-bench-page", core, commit }`: the `@ouaf/core` version and the commit the page was served from (`+` when the working tree had changes). |
| `device` | Best-effort device description (`collectDeviceInfo` of `@ouaf/core`, the same as in `ouaf-perf-session`, see [session-format.md](session-format.md)), or `null`. |
| `settings` | `warmup`, `frames` (per case) and `backend` (the `?backend=` forced, or `null`). |
| `results` | One entry per case, in the order run. |

### Results

| Field | Description |
|---|---|
| `name`, `clip`, `maxFaces`, `filters` | The case. `filters`: URLs, bottom of the stack first. |
| `frames` | Frames measured (fewer than `settings.frames` if the run was stopped, 0 on an error before the first). |
| `frameMs` | Time per frame (ms): `{ mean, p50, p95, p99, max }`, percentiles interpolated between the closest ranks (NumPy's default); `null` without frames. |
| `fps` | Frames per second the device can render this case: `1000 / frameMs.mean`; `null` without frames. |
| `faces` | Mean number of faces drawn per frame (`engine.faceCount`). |
| `size` | Internal rendering size, `<width>×<height>`. |
| `tracker` | The tracker in use (`EngineStats.tracker`; `(pending)`: the backend was not measured on this device yet, spec §16.4), `null` when not known. |
| `errors`, `warnings` | What the engine reported during the case. |

Values are rounded to 0.001.

## Comparing

The page loads an earlier document ("Compare with an earlier result") and adds, per case of the same name, the change
in `fps` and in `frameMs.p95`. "Copy as Markdown" gives the table, with the device line, for an issue or a pull
request.
