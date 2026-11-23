// Script of the content fixture, as `ouaf pack` would write it: an ES module without imports.

export default {
  on: {
    // `src` of the scripted sticker: the name of a declared image asset, or null to restore "blue" (spec §12.4).
    'message:src'(f, { data }) {
      f.layer('scripted').set({ src: data })
    },
    // `lut` of the color layer: a declared LUT asset, or null to restore the one the "grade" param picks.
    'message:lut'(f, { data }) {
      f.layer('grade').set({ lut: data })
    },
  },
}
