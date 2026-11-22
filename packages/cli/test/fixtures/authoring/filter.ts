// Source fixture of `ouaf pack` (#29): TypeScript, a relative import, a module-level helper, assets and
// `script.uses`. The tests pack it and run the result in the script runtime of @ouaf/core.
import { defineFilter } from '@ouaf/spec'
import { LABEL } from './helpers.ts'

const greet = (n: number): string => `${LABEL} × ${n}`

export default defineFilter({
  id: 'smile-counter',
  name: { en: 'Smile counter', fr: 'Compteur de sourires' },
  version: '1.0.0',
  license: 'CC0-1.0',
  requires: { face: true },
  assets: { star: 'assets/star.png' },
  layers: [
    { id: 'label', type: 'text', text: '😐', anchor: 'forehead', offset: [0, 0.9, 0], size: 0.4, orient: 'screen' },
    { type: 'sticker', src: 'star', anchor: 'noseTip', size: 0.3 },
  ],
  events: { smile: { threshold: 0.6 } },
  script: { uses: ['face.pose'] },
  state: { smiles: 0 },
  setup(f) {
    f.emit('ready', { random: f.random() })
  },
  on: {
    smile(f, { face }) {
      f.state.smiles++
      f.layer('label', face).set({ text: greet(f.state.smiles) })
      f.emit('smiles', f.state.smiles)
    },
    'message:reset'(f) {
      f.state.smiles = 0
      f.layer('label').set({ text: null })
    },
  },
})
