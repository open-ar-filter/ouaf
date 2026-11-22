# Privacy: what leaves the device

Ouaf processes the camera, the microphone and the face data **on the device**. The engine itself never sends images,
landmarks, blendshapes or any other data anywhere, and filters run without network access (spec §15).

There is one exception, coming from a third-party dependency, that hosts embedding `@ouaf/core` should know about.

## MediaPipe usage metrics

Face tracking uses [MediaPipe Tasks](https://www.npmjs.com/package/@mediapipe/tasks-vision) (`@mediapipe/tasks-vision`,
1.2.x). MediaPipe **always** sends usage metrics to Google, and offers no option to turn this off.

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

## Reference

The playground (`apps/playground/index.html`) blocks the metrics with
`connect-src 'self' ws: wss:` (`ws:`/`wss:` for Vite's hot reload), in a `<meta>` tag and, from its dev and preview
servers, as a header too (for the tracking worker of the `/spikes/worker.html` page, which reports what happens to the
request in its "MediaPipe metrics" row). A static deployment of the playground must send that header itself.
