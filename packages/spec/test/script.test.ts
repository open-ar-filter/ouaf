import { describe, expect, it } from 'vitest'
import { createRegistry, defineFilter, DEFAULT_SCRIPT_USES, EASINGS, SCRIPT_USES, type Easing } from '../src/index.ts'

describe('script API vocabulary (spec §12.4)', () => {
  it('has the 16 easings', () => {
    expect(EASINGS).toHaveLength(16)
    expect(EASINGS).toContain('outBack')
    expect(EASINGS).toContain('inOutBounce')
    const typed: readonly Easing[] = EASINGS // the list and the type agree
    expect(new Set(typed).size).toBe(16)
  })

  it('lists the same script data as the registry', () => {
    const reg = createRegistry()
    expect([...SCRIPT_USES].sort()).toEqual([...reg.scriptData.keys()].sort())
    expect([...DEFAULT_SCRIPT_USES].sort()).toEqual([...reg.scriptData.values()].filter((d) => d.default).map((d) => d.name).sort())
  })
})

describe('defineFilter', () => {
  const def = defineFilter({
    id: 'smiles',
    name: 'Smiles',
    version: '1.0.0',
    license: 'CC0-1.0',
    requires: { face: true },
    layers: [{ id: 'label', type: 'text', text: '' }, { id: 'bubble', type: 'canvas', width: 64, height: 64 }],
    state: { smiles: 0 },
    on: {
      smile(f, { face }) {
        f.state.smiles++
        f.layer('label', face).set({ text: `${f.state.smiles}`, opacity: null })
        f.layer('label', face).animate({ scale: [1, 1.4, 1] }, { duration: 300, easing: 'outBack' })
        // @ts-expect-error: no layer has this id
        f.layer('nope')
        // @ts-expect-error: unknown easing
        f.layer('label').animate({ opacity: 0 }, { duration: 100, easing: 'wobble' })
      },
      pairContact(f, { faces: [a, b] }) {
        f.emit('contact', [a.id, b.id])
      },
      paramChange(_f, { name }) {
        void name
      },
    },
    draw: {
      bubble(ctx, f, frame) {
        ctx.fillRect(0, 0, frame.faces.length, f.random())
      },
    },
  })

  it('returns its argument unchanged', () => {
    expect(def.id).toBe('smiles')
    expect(def.layers[0].id).toBe('label')
    expect(typeof def.on?.smile).toBe('function')
  })
})
