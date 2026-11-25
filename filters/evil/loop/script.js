// Malicious filter (#27): blocks its Worker for good once a host message says how. The loop starts in the next
// `update`, so the frame in flight is never answered.

let mode = ''

async function microtasks() {
  // Each `await` yields to the next microtask only: the Worker's event loop never gets the turn.
  for (;;) await null
}

export default {
  update() {
    if (mode === 'sync') for (;;) {}
    if (mode === 'microtasks') void microtasks()
  },
  on: {
    'message:sync'() {
      mode = 'sync'
    },
    'message:microtasks'() {
      mode = 'microtasks'
    },
  },
}
