// Malicious filter (#27): the script runs in the same Worker as the runtime, so it can hook the methods the runtime
// calls and speak on its port. The host must treat every message from the sandbox as untrusted (spec §15.1).
//
// - `tamper`: rewrites the next answer: invalid commands, a `__proto__` key, NaN and huge values,
//   1 000 warnings of 10 000 characters, oversized emits, too many emits, invalid emit names, canvas images of the
//   wrong size or for layers that do not exist.
// - `flood`: does the same to every answer for 2 s.
// - `swallow`: takes the port's `onmessage` and never answers again (the watchdog must stop the script).

const post = MessagePort.prototype.postMessage
let port
let tamperFrames = 0

const big = 'x'.repeat(10_000)
/** Over the 64 KB of an emit (2 bytes a character). */
const huge = 'x'.repeat(40_000)

function tamper(message) {
  const polluted = JSON.parse('{"__proto__": {"polluted": "yes"}, "constructor": {"prototype": {"polluted": "yes"}}}')
  return {
    ...message,
    warnings: Array.from({ length: 1_000 }, (_, i) => `forged warning ${i} ${big}`),
    commands: [
      ['set', 0, null, polluted],
      ['set', 0, null, { saturation: Number.NaN, contrast: Infinity, tint: { r: 1 } }],
      ['set', 0, null, { opacity: 1e308 }],
      ['set', '__proto__', null, { opacity: 0 }],
      ['set', 99, null, { opacity: 0 }],
      ['set', -1, null, { opacity: 0 }],
      ['animate', 0, null, { opacity: 0 }, { duration: Infinity, repeat: 1e9 }],
      ['animate', 0, null, { opacity: { keyframes: new Array(100_000).fill(0.5) } }, { duration: 10 }],
      ['play', 0, null, 'constructor'],
      ['eval', 0, null, 'alert(1)'],
      'not a command',
      null,
    ],
    emits: [
      ...Array.from({ length: 100 }, () => ['stolen', huge]),
      ...Array.from({ length: 200 }, (_, i) => ['spam', i]),
      ['__proto__', 1],
      [{ name: 'object' }, 1],
    ],
    images: [
      [1, new Uint8ClampedArray(64 * 64 * 4 + 1)],
      [1, new Uint8ClampedArray(16)],
      [7, new Uint8ClampedArray(64 * 64 * 4)],
      ['board', new Uint8ClampedArray(64 * 64 * 4)],
      [1, 'not pixels'],
    ],
  }
}

MessagePort.prototype.postMessage = function (message, transfer) {
  port = this
  if (tamperFrames > 0 && message && message.t === 'done') {
    tamperFrames--
    return post.call(this, tamper(message), transfer)
  }
  return post.call(this, message, transfer)
}

export default {
  on: {
    'message:tamper'() {
      tamperFrames = 1
    },
    'message:flood'() {
      tamperFrames = 60
    },
    'message:swallow'() {
      // The next frame goes to this handler, not to the runtime: nothing answers it.
      if (port) port.onmessage = () => {}
    },
  },
  draw: {
    board(ctx) {
      ctx.fillStyle = '#f0f'
      ctx.fillRect(0, 0, 64, 64)
    },
  },
}
