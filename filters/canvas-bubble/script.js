// Script of the canvas-bubble demo, as `ouaf pack` would write it from filter.js: an ES module without imports.
// draw.bubble paints the 256 × 160 canvas of the layer (origin top left, y down, spec §12.6).

const PHRASES = ['Hi there!', 'Blink at me', 'Turn your head', 'Ouaf ouaf!']
const W = 256
const H = 160

/** The bubble outline: a rounded box with a tail pointing down left, towards the face. */
function bubble(ctx) {
  const r = 26
  const x0 = 8
  const y0 = 8
  const x1 = W - 8
  const y1 = H - 38
  ctx.beginPath()
  ctx.moveTo(x0 + r, y0)
  ctx.lineTo(x1 - r, y0)
  ctx.arcTo(x1, y0, x1, y0 + r, r)
  ctx.lineTo(x1, y1 - r)
  ctx.arcTo(x1, y1, x1 - r, y1, r)
  ctx.lineTo(x0 + 92, y1)
  ctx.lineTo(x0 + 18, H - 6)
  ctx.lineTo(x0 + 50, y1)
  ctx.lineTo(x0 + r, y1)
  ctx.arcTo(x0, y1, x0, y1 - r, r)
  ctx.lineTo(x0, y0 + r)
  ctx.arcTo(x0, y0, x0 + r, y0, r)
  ctx.closePath()
}

/** Two cartoon eyes whose pupils look where the head turns (yaw in degrees). */
function eyes(ctx, x, y, yaw) {
  const look = Math.max(-1, Math.min(1, yaw / 30)) * 6
  for (const dx of [-14, 14]) {
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = '#1a1a2e'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.ellipse(x + dx, y, 11, 14, 0, 0, 2 * Math.PI)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#1a1a2e'
    ctx.beginPath()
    ctx.arc(x + dx + look, y + 2, 5, 0, 2 * Math.PI)
    ctx.fill()
  }
}

export default {
  state: { blinks: 0 },
  on: {
    blink(f) {
      f.state.blinks++
      // Redrawn in this frame, without waiting for the next of the 4 draws per second.
      f.layer('bubble').invalidate()
    },
  },
  draw: {
    bubble(ctx, f, frame) {
      bubble(ctx)
      ctx.fillStyle = '#fffdf4'
      ctx.fill()
      ctx.lineWidth = 6
      ctx.lineJoin = 'round'
      ctx.strokeStyle = '#1a1a2e'
      ctx.stroke()

      const face = frame.faces[0]
      eyes(ctx, 48, 52, face?.pose?.yaw ?? 0)

      // The manifest's font asset "rounded" (a built-in font, bold): the same text on every device.
      const phrase = PHRASES[Math.floor(frame.time / 2.5) % PHRASES.length]
      ctx.fillStyle = '#1a1a2e'
      ctx.font = 'bold 24px rounded'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(phrase, 82, 52, W - 98)

      // One heart per blink, up to eight.
      const heart = f.asset('heart')
      for (let i = 0; i < Math.min(8, f.state.blinks); i++) ctx.drawImage(heart, 24 + i * 27, 86, 24, 22)
    },
  },
}
