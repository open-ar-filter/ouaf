# Ouaf — Open Universal AR Filter

A free and open-source engine for real-time AR filters on the web (Snapchat-style face filters, and later body,
hands and voice), designed to be embedded as a library, with an open filter format.

- Format specification: [`docs/spec/ouaf-v1.md`](docs/spec/ouaf-v1.md) (draft)
- Manifest JSON Schema: [`docs/spec/ouaf-v1.schema.json`](docs/spec/ouaf-v1.schema.json) (generated — do not edit by hand)
- TypeBox schemas and validator: [`packages/spec`](packages/spec)
- Engine: [`packages/core`](packages/core)
- Dev app: [`apps/playground`](apps/playground)

```sh
npm install
npm test               # validator and published-schema tests
npm run typecheck
npm run build:schema   # regenerates the JSON Schema from packages/spec
npm run dev            # serves the playground over HTTPS on the LAN
npm run build          # production build of the playground
```

### Testing on a phone

The camera (`getUserMedia`) only works in a secure context, so `npm run dev` serves the playground over HTTPS
with a self-signed certificate and listens on every interface. Open the `Network: https://…:5173/` URL printed
by Vite on a phone connected to the same network, accept the certificate warning, then tap **Start camera**.

## License

- Code (engine, packages, tools, generated JSON Schema): [Apache-2.0](LICENSE)
- Specification text (`docs/spec/*.md`): [CC-BY-4.0](docs/spec/LICENSE)
- Example filters and their assets: CC0-1.0 (dedicated `LICENSE` in their folder)
