# Ouaf — Open Universal AR Filter

A free and open-source engine for real-time AR filters on the web (Snapchat-style face filters, and later body,
hands and voice), designed to be embedded as a library, with an open filter format.

- Format specification: [`docs/spec/ouaf-v1.md`](docs/spec/ouaf-v1.md) (draft)
- Manifest JSON Schema: [`docs/spec/ouaf-v1.schema.json`](docs/spec/ouaf-v1.schema.json) (generated — do not edit by hand)
- TypeBox schemas and validator: [`packages/spec`](packages/spec)

```sh
npm install
npm test               # validator and published-schema tests
npm run typecheck
npm run build:schema   # regenerates the JSON Schema from packages/spec
```

## License

- Code (engine, packages, tools, generated JSON Schema): [Apache-2.0](LICENSE)
- Specification text (`docs/spec/*.md`): [CC-BY-4.0](docs/spec/LICENSE)
- Example filters and their assets: CC0-1.0 (dedicated `LICENSE` in their folder)
