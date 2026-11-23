# Ouaf — Open Universal AR Filter

A free and open-source engine for real-time AR filters on the web (Snapchat-style face filters, and later body,
hands and voice), designed to be embedded as a library, with an open filter format.

- **Writing a filter**: [`AUTHORING.md`](AUTHORING.md), the authoring guide for people and AI agents
  ([`llms.txt`](llms.txt) indexes the docs for LLMs)
- Format specification: [`docs/spec/ouaf-v1.md`](docs/spec/ouaf-v1.md) (draft)
- Manifest JSON Schema: [`docs/spec/ouaf-v1.schema.json`](docs/spec/ouaf-v1.schema.json) (generated — do not edit by hand)
- TypeBox schemas and validator: [`packages/spec`](packages/spec)
- Engine: [`packages/core`](packages/core)
- Command-line tool (`ouaf validate`, `ouaf pack`, `ouaf pack-alpha`): [`packages/cli`](packages/cli)
- Dev app: [`apps/playground`](apps/playground)
- Performance recordings (playground export format): [`docs/perf/session-format.md`](docs/perf/session-format.md)

```sh
npm install
npm test               # validator and published-schema tests
npm run typecheck
npm run build:schema   # regenerates the JSON Schema from packages/spec
npm run fetch-models   # downloads the MediaPipe models (needed for face tracking in the playground) and extracts their TFLite files
npm run dev            # serves the playground over HTTPS on the LAN
npm run build          # production build of the playground
npm run test:browser   # browser tests on the test clips (Playwright; needs `npm run fetch-models`)
```

### Testing on a phone

The camera (`getUserMedia`) only works in a secure context, so `npm run dev` serves the playground over HTTPS
with a self-signed certificate and listens on every interface. Open the `Network: https://…:5173/` URL printed
by Vite on a phone connected to the same network, accept the certificate warning, then tap **Start camera**.

### Without a camera

`/?source=<clip>` plays one of the [test clips](test-media/README.md) instead of the camera (e.g.
`/?source=pesquet-talk`), so tracking and rendering can be checked, and devices measured, on a fixed input.

### Face tracking assets

Face tracking uses MediaPipe FaceLandmarker, self-hosted: nothing is loaded from a CDN at runtime. The playground
serves the wasm files of `@mediapipe/tasks-vision` under `/mediapipe/wasm/` and the model under
`/models/face_landmarker.task` (in dev and in the build). The model is not committed: `npm run fetch-models`
downloads it, checks its SHA-256 and stores it in `apps/playground/models/` (gitignored). Without it, the
playground still runs and the **Faces** row says why tracking is unavailable.

MediaPipe Tasks always sends usage metrics (no images, no face data) to Google. The playground blocks them with a
Content-Security-Policy; see [`docs/privacy.md`](docs/privacy.md) for what is sent and how to block it.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) (setup, checks, conventions) and the [Code of Conduct](CODE_OF_CONDUCT.md).
Coding agents: [`AGENTS.md`](AGENTS.md).

## License

- Code (engine, packages, tools, generated JSON Schema): [Apache-2.0](LICENSE)
- Specification text (`docs/spec/*.md`): [CC-BY-4.0](docs/spec/LICENSE)
- Example filters and their assets: CC0-1.0 (dedicated `LICENSE` in their folder)
- Test clips (`test-media/`): CC BY 4.0, Ifremer — see [`test-media/README.md`](test-media/README.md)
