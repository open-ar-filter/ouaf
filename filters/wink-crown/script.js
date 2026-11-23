// Script of the wink-crown demo, as `ouaf pack` would write it from filter.js: an ES module without imports.
// It receives no tracking data (`uses: []`), only the wink events of each face.

export default {
  state: { winks: 0 },
  on: {
    // A wink spins the crown of the person who winked, not the others' (a handle with `face`).
    wink(f, { face, side }) {
      f.layer('crown', face).play('spin')
      f.state.winks++
      // The hint has done its job.
      if (f.state.winks === 1) f.layer('hint').set({ visible: false })
      f.emit('wink', { side, winks: f.state.winks })
    },
  },
}
