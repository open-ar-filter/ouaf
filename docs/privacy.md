# Privacy: what leaves the device

Ouaf processes the camera, the microphone and the face data **on the device**. The engine itself never sends images,
landmarks, blendshapes or any other data anywhere, and filters run without network access (spec §15).

There is one exception, coming from a third-party dependency (MediaPipe, one of the face tracker's backends), that
hosts embedding `@ouaf/core` should know about.

## Photos, videos and streams

`engine.snapshot()`, `engine.record()`, `engine.export()` and `engine.outputStream()` hand the composited image to the host, in memory
(a `Blob`, a `MediaStream`). The engine stores and uploads nothing: what happens to them is the host's decision. The
engine never opens the microphone; a recording has sound only when the host passes its own audio tracks.

## Stored on the device

The engine stores one thing in the page's `localStorage`: the face tracker's backend measured on this device (spec
§16.4), so that the short benchmark of the first start is not run again. Key `ouaf:tracker-backend:<engine
version>:<tracker>`, value `{ backend, measuredMs, userAgent, at }` (the chosen backend, the time per frame of each
backend measured, the browser it was measured with, the date). It is never sent anywhere. Hosts can force the backend
instead (`EngineOptions.trackerBackend`), and the entry disappears with the site's data.

## Filter scripts

A filter's script (spec §12) is untrusted code: the engine runs it in a sandbox that cannot reach the network, the
page or its storage (spec §15). Each script gets:

- a `sandbox="allow-scripts"` iframe (opaque origin: no access to the page's DOM, cookies or storage), whose CSP is
  `default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; img-src 'none'`;
- a Worker created by that iframe from a `blob:` URL, which inherits that policy and runs `script.js`; before
  loading it, the network and storage globals (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
  `importScripts`, `Worker`, `indexedDB`, `caches`…) are removed;
- only the data its manifest declares in `script.uses`, through one `MessagePort`.

The sandbox document is a `srcdoc` iframe, so it also inherits the page's own CSP. A page with a CSP must therefore
allow what the sandbox needs: inline scripts and `blob:` workers for frames (`script-src 'unsafe-inline' blob:` and
`worker-src blob:`, or no `script-src` / `worker-src` at all). Otherwise the script does not start: the engine
emits an `error` (code `script`) and the rest of the filter keeps working.

A host can serve the sandbox document itself instead, from another site (`EngineOptions.sandboxUrl`, see
[`SECURITY.md`](../SECURITY.md#the-sandbox-on-a-site-of-its-own)): its server then receives at most one request per
script start, for the document only, without a referrer (`referrerpolicy="no-referrer"`); what the script gets goes
from the page to the Worker over a `MessagePort`, in the browser, never through that server. The page's own CSP no longer applies to that document, but it must allow its origin in `frame-src`.

## Face tracking backends

The built-in face tracker chooses between two runtimes by measuring them on the device (spec §16.4,
[`device-adaptation.md`](decisions/device-adaptation.md#backend-benchmark-spec-164)):

- **our own pipeline on [LiteRT.js](https://www.npmjs.com/package/@litertjs/core)** (`@litertjs/core`, 2.6.0), in a
  worker: it loads `litert/wasm/litert_wasm_internal.{js,wasm}` (or the `_compat_` build where relaxed SIMD is missing)
  and `models/face_detector.tflite`, `models/face_landmarks_detector.tflite`, `models/face_blendshapes.tflite` from
  `assetsBaseUrl`, and sends nothing anywhere (checked by `e2e/litert-tracker.spec.ts`: no request leaves the page's
  origin);
- **MediaPipe Tasks**, whose metrics are described below. The built-in tracker loads it only when it is measured (the
  first start on a device: about two seconds, with live sources), when it is the backend chosen, or as the fallback
  where the LiteRT.js worker cannot run. A host that wants no MediaPipe at all forces `trackerBackend: 'litert'`
  (MediaPipe then only loads if the worker cannot start) or installs `createLiteRtFaceTracker()` as its tracker.

## MediaPipe usage metrics

[MediaPipe Tasks](https://www.npmjs.com/package/@mediapipe/tasks-vision) (`@mediapipe/tasks-vision`, 1.2.x) **always**
sends usage metrics to Google, and offers no option to turn this off.

| | |
|---|---|
| Destination | `POST https://odml.pa.googleapis.com/v1/log` |
| When | About once a minute while a tracker is running, and when it is closed |
| Content | Usage statistics: task type (face landmarker), delegate (GPU/CPU), latencies |
| Not sent | Images, video frames, landmarks, blendshapes or any face data |

MediaPipe's documentation leaves it to the integrator to inform users and collect consent where needed.

Ouaf does not block it by default: whether these metrics are acceptable is the host's decision.

## Blocking it

Use a [Content-Security-Policy](https://developer.mozilla.org/docs/Web/HTTP/Guides/CSP) whose `connect-src` does not
allow `odml.pa.googleapis.com`. MediaPipe gives up after the first refused request, and tracking keeps working
normally. The browser logs one CSP violation in the console; this is expected.

As an HTTP response header (preferred):

```http
Content-Security-Policy: connect-src 'self'
```

Or in the page, when you cannot set headers:

```html
<meta http-equiv="Content-Security-Policy" content="connect-src 'self'" />
```

Notes:

- `connect-src` also governs `fetch()` of the model and wasm files: keep the origin(s) you serve them from
  (`'self'` when they are self-hosted, as in the playground).
- Add whatever else your page legitimately connects to (your API, analytics you chose, `ws:`/`wss:` for a dev server's
  hot reload, as the playground does).
- If your page already has a CSP with a `script-src`, MediaPipe needs `'wasm-unsafe-eval'` in it to compile its
  WebAssembly.
- **Workers**: a worker loaded from a URL does not get the page's `<meta>` policy; only the `Content-Security-Policy`
  header of the worker script's own response applies to it. If MediaPipe runs in a worker, send the header on the
  worker script (simplest: on every response). A worker created from a `blob:` URL inherits the page's policy.
- The LiteRT.js tracker's worker fetches its wasm and models itself (`connect-src` of the worker script's response),
  compiles WebAssembly (`'wasm-unsafe-eval'`) and evaluates LiteRT.js's Emscripten script with an indirect `eval`
  (LiteRT.js 2.6.0 loads it with `importScripts`, which module workers do not have): a `script-src` on the worker
  script's response must allow `'unsafe-eval'`. Without it the tracker falls back to MediaPipe, with a warning.

### Checking

Open the browser developer tools, **Network** tab, filter on `odml`, and run the camera for more than a minute:

- not blocked: `POST …/v1/log` requests appear;
- blocked: at most one request, marked as blocked by CSP, and none afterwards.

## Self-hosted engine files

Everything else the engine loads comes from the host's `assetsBaseUrl` (`createEngine({ assetsBaseUrl })`), never from
a CDN: the tracking wasm and models, the built-in fonts and LUTs (`builtins/`), and the Draco decoder of the model
layer (`draco/draco_wasm_wrapper.js` and `draco/draco_decoder.wasm`, copied from `three/examples/jsm/libs/draco/gltf/`;
fetched only when a filter has a Draco-compressed model). The meshopt decoder is bundled with the engine. A filter's
glTF models must embed their buffers and images: the engine refuses a model that points to any other file or URL.

With a CSP: the Draco decoder runs in a worker created from a `blob:` URL (`worker-src blob:`, or a `script-src` that
allows it) and compiles WebAssembly (`'wasm-unsafe-eval'`); glTF textures are decoded from `blob:` URLs (`img-src
blob:`), as sticker images are.

## Hosts with a strict CSP

What the engine needs from a page's Content-Security-Policy, directive by directive (each detailed above):

| Directive | Needs | For |
|---|---|---|
| `connect-src` | the origin of `assetsBaseUrl`, and of the filter packages you load | tracking wasm and models, built-in fonts and LUTs, Draco decoder, `.ouaf` files |
| `script-src` | `'wasm-unsafe-eval'` | face tracking (both backends) and the Draco decoder compile WebAssembly |
| `script-src` | `'unsafe-inline' blob:` | the script sandbox (a `srcdoc` iframe inherits the page's policy); not needed with `sandboxUrl` |
| `frame-src` | the origin of `sandboxUrl`, when set | the script sandbox served by the host |
| `worker-src` | `blob:`, and the origin of the tracker worker's script | the script sandbox and the Draco decoder (`blob:`), the LiteRT.js tracker |
| `img-src` | `blob:` | SVG stickers and glTF textures, decoded from `blob:` URLs |
| `media-src` | `blob:` | video stickers (and shader video textures), played from `blob:` URLs; a video file source you pass as a `blob:` URL |

The LiteRT.js tracker's worker follows the policy of its own script's response, not the page's (see the notes above):
it needs `'unsafe-eval'` there. Without `img-src blob:` or `media-src blob:`, those assets fail to load, with an
`AssetError` naming the file.

## Reference

The playground (`apps/playground/index.html`) blocks the metrics with
`connect-src 'self' ws: wss:` (`ws:`/`wss:` for Vite's hot reload), in a `<meta>` tag and, from its dev and preview
servers, as a header too (for the tracking worker of the `/spikes/worker.html` page, which reports what happens to the
request in its "MediaPipe metrics" row). A static deployment of the playground must send that header itself.

`ouaf preview` (the CLI's headless renderer) serves its page on a private origin through Playwright's request
interception, with `connect-src 'self'`, and aborts every request to another origin: the browser it drives never
reaches the network, and nothing listens on a port.
