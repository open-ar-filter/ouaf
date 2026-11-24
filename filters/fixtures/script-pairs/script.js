// Script of the script-pairs fixture, as `ouaf pack` would write it: an ES module without imports.
// Emits `pairs` (frame.pairs, by face id) at every frame, and each pair event with the ids of its two faces.

const ids = (faces) => faces.map((face) => face.id)

export default {
  update(f, frame) {
    f.emit('pairs', { time: frame.time, pairs: frame.pairs.map((p) => [p.a.id, p.b.id, p.distance, p.contact]) })
  },
  on: {
    pairContact(f, { faces }) {
      f.emit('event', ['pairContact', ...ids(faces)])
    },
    pairSeparate(f, { faces }) {
      f.emit('event', ['pairSeparate', ...ids(faces)])
    },
  },
}
