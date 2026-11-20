# Performance session export format (`ouaf-perf-session`, version 1)

Recordings made with the playground performance panel (or with `SessionRecorder` from `@ouaf/core`) are
exported as one JSON document. The TypeScript type `PerfSession` in
[`packages/core/src/perf-session.ts`](../../packages/core/src/perf-session.ts) is the reference; this page
summarizes it for people analysing the files.

## Conventions

- `format` is always `"ouaf-perf-session"`. `version` is an integer bumped on any breaking change: check it
  before reading a file.
- Times are milliseconds relative to the start of the recording, on the page's `performance.now()` clock, unless
  stated otherwise. Raw values are rounded to 0.01 ms (`mediaTime`: 0.00001 s); statistics to 0.001.
- A statistic that cannot be computed (no data) is `null`.
- Percentiles use linear interpolation between the closest ranks (NumPy's default).
- Timer precision depends on the browser (`device.timerResolutionMs`: about 0.1 ms in Chromium and about 1 ms in Safari
  and Firefox without cross-origin isolation): sub-millisecond differences are not meaningful there.

## Top-level fields

| Field        | Description |
|--------------|-------------|
| `startedAt`  | Wall-clock start (ISO 8601, UTC). |
| `durationMs` | Length of the recording, hidden periods included. |
| `stopReason` | `"manual"`, `"duration"` (5/10-minute preset reached), `"full"` (sample buffers full; the recorder holds 72 000 samples = 10 min at 120 fps), or `null` if exported while recording. |
| `app`        | Producer description, e.g. `{ "name": "ouaf-playground", "core": "0.1.0", "scheduler": "video-frame" }`. |
| `pipeline`   | `PipelineInfo` at the start: `delegate` (`"GPU"`, `"CPU"` or `null` when unknown), camera `videoWidth`×`videoHeight`, `renderWidth`×`renderHeight`, `maxFaces`. Changes are logged as `pipeline` events. |
| `device`     | Best-effort device description, every field optional: `userAgent`, `platform`, `language`, `userAgentData` (Client Hints incl. `model`, `platformVersion`, `architecture` when granted), `hardwareConcurrency`, `deviceMemory`, `maxTouchPoints`, `screen` (`width`, `height`, `devicePixelRatio`, `orientation`), `gpu` (`api`, `vendor`, `renderer`, `unmaskedVendor`, `unmaskedRenderer` from `WEBGL_debug_renderer_info`, `maxTextureSize`), `crossOriginIsolated`, `timerResolutionMs`. |
| `summary`    | Statistics over the whole recording (see below), plus `hiddenMs` (time the page was hidden) and `droppedEvents`. |
| `intervalMs`, `intervals` | Statistics per consecutive interval (60 000 ms by default), each with `startMs` and `durationMs` (the last one may be shorter). Use them to spot thermal throttling: fps falling or tracking time rising over the minutes. |
| `events`     | Notable events, in order (see below). |
| `samples`    | Raw per-frame data in columns (see below). |

### Statistics (`summary` and each interval)

`samples` (count), `fps`, `frameMs`, `trackingMs`, `renderMs` (each `{ mean, p50, p95, p99, max }`) and `faces`
(mean number of detected faces).

`frameMs` is the time between consecutive samples. Deltas that span a `visibility` or `pipeline` event are
excluded (the camera was paused or restarted, so the delta is not a frame time), and `fps` is
`1000 / mean(frameMs)` over the remaining deltas. A sample belongs to the interval containing its `t`.

### Events

Each event has `t` (ms since the start) and `type`:

| `type`       | Fields | Meaning |
|--------------|--------|---------|
| `visibility` | `state`: `"hidden"` / `"visible"` | The page was hidden (no frames are processed while hidden). |
| `pipeline`   | `pipeline` | The pipeline changed (camera switch, restart, delegate). |
| `full`       | — | The sample buffers were full; the recording stopped. |
| `wakeLock`   | `state`: `"acquired"`, `"released"`, `"unsupported"`, `"error"`; `message?` | Screen Wake Lock status (the screen may have dimmed or locked without it). |
| `battery`    | `level?` (0–1), `charging?` | Battery status at the start and on change (Battery Status API, Chromium). Charging heats the device. |
| `pressure`   | `source` (`"cpu"`), `state` (`"nominal"`, `"fair"`, `"serious"`, `"critical"`) | Compute Pressure API changes (Chromium desktop), a hint of thermal throttling. |
| `note`       | `message` | Free-form annotation. |

### Samples

`samples` holds one array per column, all of the same length, one entry per processed camera frame:

| Column       | Unit | Source |
|--------------|------|--------|
| `t`          | ms since the start | `FrameSample.now` (frame callback time) |
| `mediaTime`  | s | `FrameSample.mediaTime` (camera media time; gaps reveal frames dropped before processing) |
| `trackingMs` | ms | time spent in `FaceTracker.detect` |
| `renderMs`   | ms | time spent rendering |
| `faces`      | count | faces detected |

A 10-minute run at 30 fps is about 18 000 samples, roughly 0.6 MB of JSON.

## Example

```json
{
  "format": "ouaf-perf-session",
  "version": 1,
  "startedAt": "2026-11-21T12:00:00.000Z",
  "durationMs": 600000,
  "stopReason": "duration",
  "app": { "name": "ouaf-playground", "core": "0.1.0", "scheduler": "video-frame" },
  "pipeline": { "delegate": "GPU", "videoWidth": 1280, "videoHeight": 720, "renderWidth": 1280, "renderHeight": 720, "maxFaces": 2 },
  "device": { "userAgent": "…", "hardwareConcurrency": 8, "gpu": { "api": "webgl2", "unmaskedRenderer": "Adreno (TM) 730" } },
  "summary": { "samples": 17950, "fps": 29.92, "frameMs": { "mean": 33.42, "p50": 33.3, "p95": 36.1, "p99": 41.2, "max": 120.4 }, "…": "…", "hiddenMs": 0, "droppedEvents": 0 },
  "intervalMs": 60000,
  "intervals": [
    { "startMs": 0, "durationMs": 60000, "samples": 1800, "fps": 30, "…": "…" }
  ],
  "events": [
    { "t": 1.2, "type": "wakeLock", "state": "acquired" }
  ],
  "samples": {
    "t": [12.5, 45.83, 79.17],
    "mediaTime": [0.03333, 0.06667, 0.1],
    "trackingMs": [11.2, 10.9, 12.05],
    "renderMs": [1.8, 1.75, 1.9],
    "faces": [1, 1, 1]
  }
}
```
