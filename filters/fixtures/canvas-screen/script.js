// Script of the canvas-screen fixture (#25), as `ouaf pack` would write it: an ES module without imports.

export default {
  state: { color: '#00ffff', draws: { quads: 0, swatch: 0, ticker: 0 } },
  on: {
    'message:color'(f, { data }) {
      f.state.color = data
      f.layer('swatch').invalidate()
    },
  },
  draw: {
    // Four quadrants, y down as in any canvas: red top left, green top right, blue bottom left, the star asset
    // (yellow) bottom right.
    quads(ctx, f) {
      ctx.fillStyle = '#ff0000'
      ctx.fillRect(0, 0, 32, 32)
      ctx.fillStyle = '#00ff00'
      ctx.fillRect(32, 0, 32, 32)
      ctx.fillStyle = '#0000ff'
      ctx.fillRect(0, 32, 32, 32)
      ctx.drawImage(f.asset('star'), 32, 32, 32, 32)
      f.emit('drawn', { id: 'quads', n: ++f.state.draws.quads })
    },
    swatch(ctx, f) {
      ctx.fillStyle = f.state.color
      ctx.fillRect(0, 0, 32, 32)
      f.emit('drawn', { id: 'swatch', n: ++f.state.draws.swatch })
    },
    // Half-transparent white over the black sticker: mid-gray if the image is blended premultiplied.
    ticker(ctx, f, frame) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'
      ctx.fillRect(0, 0, 16, 16)
      f.emit('drawn', { id: 'ticker', n: ++f.state.draws.ticker, time: frame.time })
    },
  },
}
