// Script of the canvas-fonts fixture (#150), as `ouaf pack` would write it: an ES module without imports.
//
// The same word in two canvases: one in the declared font asset "title" (a built-in font under a name of the
// filter), one in a family nobody declared (the platform's fallback). Each draw reports a hash of its pixels and the
// measured width of the word.

/** FNV-1a over the pixels: equal images give equal hashes. */
function hash(ctx) {
  const d = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data
  let h = 0x811c9dc5
  for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 0x01000193)
  return h >>> 0
}

function word(ctx, f, id, font) {
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 160, 40)
  ctx.font = font
  ctx.fillStyle = '#000000'
  ctx.textBaseline = 'middle'
  ctx.fillText('Ouaf ouaf', 8, 20)
  f.emit('drawn', { id, font: ctx.font, width: ctx.measureText('Ouaf ouaf').width, hash: hash(ctx) })
}

export default {
  on: {
    'message:redraw'(f) {
      f.layer('declared').invalidate()
      f.layer('fallback').invalidate()
    },
  },
  draw: {
    declared(ctx, f) {
      word(ctx, f, 'declared', '28px title')
    },
    fallback(ctx, f) {
      word(ctx, f, 'fallback', '28px undeclared-family')
    },
  },
}
