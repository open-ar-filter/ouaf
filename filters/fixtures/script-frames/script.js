// Script of the script-frames fixture (#26), as `ouaf pack` would write it: an ES module without imports.
// The n-th frame the script gets (from 0) sets the grade's opacity to n % 2: with a file source, the engine renders
// frame n + 1 with that answer (spec §12.1), so frames 0, 2, 4… are black and white, frames 1, 3, 5… in color.
// Without the wait, a slow answer would land on a later frame and break the pattern.

export default {
  state: { frames: 0 },
  update(f) {
    // Slow on purpose (well under the 1 s watchdog): the answer comes after the engine has tracked the next frame.
    const end = Date.now() + 60
    while (Date.now() < end) {}
    f.layer('grade').set({ opacity: f.state.frames++ % 2 })
  },
}
