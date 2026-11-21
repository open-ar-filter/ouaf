#!/usr/bin/env node
// Entry point of the `ouaf` command (Node >= 24 runs this TypeScript file directly).
import { run } from './cli.ts'

process.exitCode = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
})
