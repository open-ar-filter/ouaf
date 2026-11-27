/** `ouaf preview --param` and `--event-threshold` (#197): checking the values, rewriting the packages. */
import { join } from 'node:path'
import type { TManifest } from '@ouaf/spec'
import { describe, expect, it } from 'vitest'
import { loadFilters, PreviewSetupError, tuneFilters } from '../src/preview.ts'
import {
  handledThresholds,
  parseAssignments,
  parseEventThresholds,
  readManifest,
  replaceManifest,
  resolveParams,
  TuningError,
  withEventThresholds,
} from '../src/preview/tuning.ts'
import { readZipEntries } from '../src/zip.ts'

const repo = join(import.meta.dirname, '../../..')
const birthday = join(repo, 'filters/ai-birthday')

const manifest = (id: string, params: TManifest['params'], extra: Partial<TManifest> = {}): TManifest =>
  ({ ouaf: '1', id, name: id, version: '1.0.0', license: 'CC0-1.0', requires: { face: true }, params, layers: [], ...extra }) as TManifest

const all = manifest('all', {
  size: { type: 'number', default: 1, min: 0.5, max: 2 },
  on: { type: 'boolean', default: false },
  name: { type: 'string', default: 'Alex', maxLength: 5 },
  tint: { type: 'color', default: '#ff0000' },
  style: { type: 'select', default: 'gold', options: { gold: 'Gold', flowers: 'Flowers' } },
  team: { type: 'select', default: '', options: { from: 'host' } },
  offset: { type: 'vec2', default: [0, 0] },
  logo: { type: 'asset', accept: ['image/png'], optional: true },
})

const resolve = (args: string[], manifests = [all]) => resolveParams(manifests, parseAssignments('param', args))

describe('parseAssignments', () => {
  it('name=value pairs, in order; the value may contain "=" or be empty', () => {
    expect([...parseAssignments('param', ['a=1', 'b=x=y', 'c='])]).toEqual([['a', '1'], ['b', 'x=y'], ['c', '']])
    expect(parseAssignments('param', undefined).size).toBe(0)
  })

  it('a missing name or "=", a name given twice', () => {
    expect(() => parseAssignments('param', ['size'])).toThrow('--param expects <name>=<value>, got "size".')
    expect(() => parseAssignments('param', ['=1'])).toThrow(TuningError)
    expect(() => parseAssignments('event-threshold', ['a=1', 'a=2'])).toThrow('--event-threshold: "a" is given twice.')
  })
})

describe('resolveParams', () => {
  it('each type from its text', () => {
    const [values] = resolve(['size=1.5', 'on=true', 'name=Sam', 'tint=#00ff00', 'style=flowers', 'team=', 'offset=0.1, -0.2'])
    expect(values).toEqual({ size: 1.5, on: true, name: 'Sam', tint: '#00ff00', style: 'flowers', team: '', offset: [0.1, -0.2] })
  })

  it('a value the engine would refuse: a usage error naming the parameter and the filter', () => {
    expect(() => resolve(['size=3'])).toThrow('--param size=3: all: Invalid value for parameter "size": 3 is outside [0.5, 2].')
    expect(() => resolve(['size='])).toThrow(/expected a finite number/)
    expect(() => resolve(['size=big'])).toThrow(/expected a finite number/)
    expect(() => resolve(['on=yes'])).toThrow(/expected a boolean.*\(true or false\)$/)
    expect(() => resolve(['name=Alexandre'])).toThrow(/at most 5/)
    expect(() => resolve(['tint=red'])).toThrow(/hex color/)
    expect(() => resolve(['style=silver'])).toThrow(/"silver" is not one of the options \("gold", "flowers"\)/)
    expect(() => resolve(['team=blue'])).toThrow(/has not supplied the options/)
    expect(() => resolve(['offset=1'])).toThrow(/array of 2 finite numbers.*two numbers separated by a comma/)
    expect(() => resolve(['offset=1,'])).toThrow(/array of 2 finite numbers/)
    expect(() => resolve(['logo=logo.png'])).toThrow('--param logo: asset parameters cannot be set from the command line.')
  })

  it('a stack: set on every filter that declares the name; an unknown name lists the parameters', () => {
    const other = manifest('other', { size: { type: 'number', default: 1 } })
    const bare = manifest('bare', undefined)
    expect(resolve(['size=0.75'], [all, bare, other])).toEqual([{ size: 0.75 }, {}, { size: 0.75 }])
    expect(() => resolve(['color=#fff'], [bare, other])).toThrow('--param color: no filter of the stack declares this parameter (parameters: size).')
    expect(() => resolve(['color=#fff'], [bare])).toThrow('(no parameters)')
  })
})

describe('event thresholds', () => {
  it('tunable events only, from 0 to 1', () => {
    expect([...parseEventThresholds(new Map([['mouthOpen', '0.25'], ['pairContact', '0']]))]).toEqual([['mouthOpen', 0.25], ['pairContact', 0]])
    expect(() => parseEventThresholds(new Map([['mouthClose', '0.2']]))).toThrow(/"mouthClose" has no threshold of its own\. Events with a threshold: blink, wink, mouthOpen/)
    expect(() => parseEventThresholds(new Map([['jump', '0.2']]))).toThrow(/unknown event "jump"/)
    for (const v of ['', '1.5', '-0.1', 'high']) {
      expect(() => parseEventThresholds(new Map([['smile', v]]))).toThrow(`--event-threshold smile expects a number from 0 to 1, got "${v}".`)
    }
  })

  it('written into the events section, other tuning kept', () => {
    const m = manifest('m', undefined, { events: { mouthOpen: { threshold: 0.5, minDurationMs: 120 }, smile: { minDurationMs: 50 } } })
    expect(withEventThresholds(m, new Map())).toBe(m)
    expect(withEventThresholds(m, new Map([['mouthOpen', 0.25], ['blink', 0.4]])).events).toEqual({
      mouthOpen: { threshold: 0.25, minDurationMs: 120 },
      smile: { minDurationMs: 50 },
      blink: { threshold: 0.4 },
    })
    expect(m.events!.mouthOpen!.threshold).toBe(0.5)
  })

  it('the threshold of each threshold event a script handles: its tuning, else the default', () => {
    const script = { entry: 'script.js', on: ['paramChange', 'mouthOpen', 'smile', 'mouthClose', 'wink'] } as TManifest['script']
    expect(handledThresholds(manifest('m', undefined, { script, events: { mouthOpen: { threshold: 0.5 } } }))).toEqual({ mouthOpen: 0.5, smile: 0.5 })
    expect(handledThresholds(manifest('m', undefined))).toEqual({})
  })
})

describe('tuneFilters', () => {
  it('rewrites the package with the thresholds, resolves the parameters', async () => {
    const filters = await loadFilters([birthday])
    const before = readZipEntries(filters[0]!.zip!).map((e) => e.name)
    const params = tuneFilters(filters, { params: new Map([['name', 'Sam']]), eventThresholds: new Map([['mouthOpen', 0.25]]) })
    expect(params).toEqual([{ name: 'Sam' }])
    expect(filters[0]).toMatchObject({ params: { name: 'Sam' }, thresholds: { mouthOpen: 0.25 } })
    const m = readManifest(filters[0]!.zip!)
    expect(m.events).toEqual({ mouthOpen: { threshold: 0.25, minDurationMs: 120 } })
    expect(m.id).toBe('ai-birthday')
    expect(readZipEntries(filters[0]!.zip!).map((e) => e.name)).toEqual(before)
  })

  it('nothing to change: the package as packed, the thresholds of the manifest', async () => {
    const filters = await loadFilters([birthday])
    const zip = filters[0]!.zip
    expect(tuneFilters(filters, {})).toEqual([{}])
    expect(filters[0]!.zip).toBe(zip)
    expect(filters[0]).toMatchObject({ thresholds: { mouthOpen: 0.5 } })
    expect(filters[0]).not.toHaveProperty('params')
  })

  it('an invalid parameter value: a setup error (usage error, exit 2)', async () => {
    const filters = await loadFilters([birthday])
    expect(() => tuneFilters(filters, { params: new Map([['name', 'x'.repeat(30)]]) })).toThrow(PreviewSetupError)
  })

  it('replaceManifest drops directory entries and keeps the other files', async () => {
    const filters = await loadFilters([birthday])
    const zip = filters[0]!.zip!
    const m = readManifest(zip)
    const out = replaceManifest(zip, { ...m, name: 'Renamed' })
    expect(readManifest(out).name).toBe('Renamed')
    expect(readZipEntries(out).map((e) => e.name)).toEqual(readZipEntries(zip).map((e) => e.name).filter((n) => !n.endsWith('/')))
    expect(() => readManifest(new Uint8Array(22).fill(0).map((_, i) => [0x50, 0x4b, 5, 6][i] ?? 0))).toThrow('The package has no manifest.json.')
  })
})
