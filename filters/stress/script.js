// Script of the stress demo, as `ouaf pack` would write it from filter.js: an ES module without imports.
// Deliberately heavy: it receives every landmark of every face (`uses: ["face.landmarks"]`, 478 × 3 floats per face
// and frame), plots them into a canvas 30 times per second, and draws a jawOpen meter 15 times per second.

const COLORS = ['#ff4d6d', '#4dd2ff', '#ffd24d', '#7dff4d']

export default {
  draw: {
    // Every face's landmarks, in display coordinates (0–1, y down), on a dark square.
    mesh(ctx, f, frame) {
      ctx.fillStyle = 'rgba(10, 10, 30, 0.75)'
      ctx.fillRect(0, 0, 192, 192)
      for (const face of frame.faces) {
        const l = face.landmarks
        if (!l) continue
        ctx.fillStyle = COLORS[face.index % COLORS.length]
        for (let i = 0; i < l.length; i += 3) ctx.fillRect(l[i] * 192 - 0.5, l[i + 1] * 192 - 0.5, 1.5, 1.5)
      }
    },
    // A bar for the mouth opening of the first face; the same image is shown on every face (spec §12.6).
    meter(ctx, f, frame) {
      const jaw = frame.faces[0]?.blendshapes?.jawOpen ?? 0
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
      ctx.fillRect(0, 0, 128, 32)
      ctx.fillStyle = '#80ffcc'
      ctx.fillRect(4, 6, Math.round(120 * Math.min(1, jaw * 2)), 20)
    },
  },
}
