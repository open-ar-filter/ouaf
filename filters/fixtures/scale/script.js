// Script of the scale fixture, as `ouaf pack` would write it: an ES module without imports.

const SCREEN = ['text', 'sticker', 'canvas']

export default {
  on: {
    // `scale` of the three screen layers: set at once, or animated (spec §12.4).
    'message:set'(f, { data }) {
      for (const id of SCREEN) f.layer(id).set({ scale: data })
    },
    'message:animate'(f, { data }) {
      for (const id of SCREEN) f.layer(id).animate({ scale: data }, { duration: 200, easing: 'linear' })
    },
  },
  draw: {
    canvas(ctx) {
      ctx.fillStyle = '#00ffff'
      ctx.fillRect(0, 0, 32, 32)
    },
  },
}
