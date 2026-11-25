// Malicious filter (#27): exhausts memory once a host message says how. The allocation starts in the next `update`.

let mode = ''
const hoard = []

export default {
  update(f) {
    if (mode === 'heap') {
      // JavaScript objects until the Worker runs out of heap (or the watchdog stops it).
      for (let i = 0; ; i++) hoard.push(new Array(1_000_000).fill(i))
    }
    if (mode === 'buffers') {
      // 64 MB array buffers, written so that the memory is really committed, until an allocation fails.
      for (;;) {
        const buffer = new Uint8Array(64 * 1024 * 1024)
        buffer.fill(1)
        hoard.push(buffer)
      }
    }
    if (mode === 'emit') {
      // Oversized messages to the host, many times a frame (under the 60 a second): they must be dropped.
      mode = ''
      const big = new Uint8Array(32 * 1024 * 1024)
      for (let i = 0; i < 50; i++) f.emit('bomb', { big, text: 'x'.repeat(1_000_000) })
      f.emit('done')
    }
  },
  on: {
    'message:heap'() {
      mode = 'heap'
    },
    'message:buffers'() {
      mode = 'buffers'
    },
    'message:emit'() {
      mode = 'emit'
    },
  },
}
