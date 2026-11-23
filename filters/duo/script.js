// Script of the duo demo, as `ouaf pack` would write it from filter.js: an ES module without imports.
//
// Interactions between faces from their positions (`uses: ["face.anchors"]`, normalized display space: x over the
// width, y over the height, y down) and sizes (`face.size`: eye distance over the screen height). The engine has no
// pair data yet (`frame.pairs`, issue #116), so the script measures the distance itself.

/** Hysteresis around the "together" distance (face units), so the state does not flicker at the threshold. */
const MARGIN = 0.3

/**
 * Width / height of the display. Frame data gives no image size, but each face does: its eye distance is `size`
 * screen heights on screen, and the eye vector is (dx, dy) in normalized coordinates, so (dx · aspect)² + dy² = size².
 */
function aspectOf(faces) {
  let sum = 0
  let n = 0
  for (const face of faces) {
    const l = face.anchors?.leftEye
    const r = face.anchors?.rightEye
    if (!l || !r || !(face.size > 0)) continue
    const dx = Math.abs(l[0] - r[0])
    const dy = l[1] - r[1]
    const a = Math.sqrt(Math.max(0, face.size * face.size - dy * dy)) / dx
    if (Number.isFinite(a) && a > 0.2 && a < 5) {
      sum += a
      n++
    }
  }
  return n > 0 ? sum / n : 9 / 16
}

/** Sends a property only when it changes, to keep the messages small. */
function setIf(f, state, key, handle, props) {
  const value = JSON.stringify(props)
  if (state[key] === value) return
  state[key] = value
  handle.set(props)
}

export default {
  state: { together: false, sent: {} },

  update(f, frame) {
    const s = f.state
    const faces = frame.faces.filter((face) => face.anchors?.noseTip && face.size > 0)
    if (faces.length < 2) {
      for (const face of frame.faces) setIf(f, face.state, 'heart', f.layer('heart', face), { visible: false })
      setIf(f, s.sent, 'status', f.layer('status'), { text: frame.faces.length === 1 ? 'Waiting for a friend' : 'Two faces, please' })
      s.together = false
      return
    }
    const [a, b] = faces
    const aspect = aspectOf(faces)
    // From a's nose to b's, in screen heights, +y up (the frame of the layers).
    const dx = (b.anchors.noseTip[0] - a.anchors.noseTip[0]) * aspect
    const dy = -(b.anchors.noseTip[1] - a.anchors.noseTip[1])
    const length = Math.hypot(dx, dy) || 1
    const distance = length / ((a.size + b.size) / 2) // in face units: eye distances
    const ux = dx / length
    const uy = dy / length

    // Each heart sits 1.4 units from its nose, towards the other face, and grows as they get closer.
    const grow = Math.min(1, Math.max(0, (10 - distance) / 7))
    const size = Math.round((0.35 + 0.45 * grow) * 100) / 100
    const round = (v) => Math.round(v * 20) / 20
    setIf(f, a.state, 'heart', f.layer('heart', a), { visible: true, size, offset: [round(1.4 * ux), round(1.4 * uy), 0.3] })
    setIf(f, b.state, 'heart', f.layer('heart', b), { visible: true, size, offset: [round(-1.4 * ux), round(-1.4 * uy), 0.3] })

    const limit = f.params.together
    const together = s.together ? distance < limit + MARGIN : distance < limit - MARGIN
    if (together !== s.together) {
      s.together = together
      f.emit('together', { together, distance: Math.round(distance * 10) / 10 })
    }
    setIf(f, s.sent, 'status', f.layer('status'), { text: together ? 'Together!' : `Closer! ${distance.toFixed(1)} apart` })
  },
}
