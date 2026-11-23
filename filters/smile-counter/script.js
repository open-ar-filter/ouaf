// Script of the smile-counter demo, as `ouaf pack` would write it from filter.js: an ES module without imports.
// It needs no tracking data (`uses: []`): the engine detects smiles and sends the events.

export default {
  // Global state, shared by every face of this filter.
  state: { smiles: 0 },

  setup(f) {
    f.emit('smiles', { total: f.state.smiles })
  },

  on: {
    smile(f, { face }) {
      // Per-face state: reset by the engine when the face leaves (a person who comes back starts again).
      face.state.smiles = (face.state.smiles ?? 0) + 1
      f.state.smiles++
      const label = f.layer('label', face)
      label.set({ text: `x${face.state.smiles}` })
      // A "pop": the engine plays it at the frame rate, no message per frame.
      label.animate({ size: { keyframes: [0.55, 0.8, 0.55] } }, { duration: 350, easing: 'outBack' })
      f.layer('total').set({ text: `SMILES ${f.state.smiles}` })
      f.emit('smiles', { total: f.state.smiles, face: face.id })
    },
  },
}
