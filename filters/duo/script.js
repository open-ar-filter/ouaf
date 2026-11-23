// Script of the duo demo, as `ouaf pack` would write it from filter.js: an ES module without imports.
//
// Interactions between faces from their positions (`uses: ["face.anchors"]`, normalized display space: x over the
// width, y over the height, y down), the display's `frame.aspect` (width / height) and the faces' sizes (`face.size`:
// eye distance over the screen height). The engine has no pair data yet (`frame.pairs`, issue #116), so the script
// measures the distance itself.

/** Hysteresis around the "together" distance (face units), so the state does not flicker at the threshold. */
const MARGIN = 0.3

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
    const heart = f.layer('heart')
    const faces = frame.faces.filter((face) => face.anchors?.noseTip && face.size > 0)
    if (faces.length < 2) {
      setIf(f, s.sent, 'heart', heart, { visible: false })
      setIf(f, s.sent, 'status', f.layer('status'), { text: frame.faces.length === 1 ? 'Waiting for a friend' : 'Two faces, please' })
      s.together = false
      return
    }
    const [a, b] = faces
    const [ax, ay] = a.anchors.noseTip
    const [bx, by] = b.anchors.noseTip
    // From a's nose to b's in screen heights (x times the aspect ratio), then in face units: mean eye distances.
    const unit = (a.size + b.size) / 2
    const distance = Math.hypot((bx - ax) * frame.aspect, by - ay) / unit

    // One heart on the screen, midway between the two noses, growing from 0.5 to 1.2 mean eye distances as they get
    // closer. Screen frame (spec §5.2): origin at the centre, +y up, sizes and offsets in screen heights.
    const grow = Math.min(1, Math.max(0, (10 - distance) / 7))
    const round = (v) => Math.round(v * 200) / 200
    const offset = [round(((ax + bx) / 2 - 0.5) * frame.aspect), round(0.5 - (ay + by) / 2), 0]
    setIf(f, s.sent, 'heart', heart, { visible: true, size: round((0.5 + 0.7 * grow) * unit), offset })

    const limit = f.params.together
    const together = s.together ? distance < limit + MARGIN : distance < limit - MARGIN
    if (together !== s.together) {
      s.together = together
      f.emit('together', { together, distance: Math.round(distance * 10) / 10 })
    }
    setIf(f, s.sent, 'status', f.layer('status'), { text: together ? 'Together!' : `Closer! ${distance.toFixed(1)} apart` })
  },
}
