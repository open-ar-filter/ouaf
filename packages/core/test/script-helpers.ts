/**
 * Helpers of the script tests: the runtime run in-process (a fake global scope, a MessageChannel, script.js evaluated
 * with `new Function`), and the bindings environment.
 */
import type { BindingEnv } from '../src/bindings/index.ts'
import { scriptRuntime, type RuntimeScope, type WireDone } from '../src/script/runtime.ts'

export const env = (overrides?: BindingEnv['overrides']): BindingEnv => ({
  data: { resolve: () => undefined },
  params: { type: () => undefined, get: () => undefined },
  ...(overrides ? { overrides } : {}),
})

export function fakeScope(): RuntimeScope & { send(data: unknown, ports?: unknown[]): void } {
  const listeners = new Set<(e: { data: unknown; ports?: readonly unknown[] }) => void>()
  return {
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
    send: (data, ports) => {
      for (const l of [...listeners]) l({ data, ports: ports ?? [] })
    },
  }
}

export const load = async (code: string) => ({ default: new Function(code.replace('export default', 'return'))() as unknown })

/** The engine's end of the channel to the runtime (structurally a `ScriptConnection` of host.ts). */
export interface TestConnection {
  port: { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((event: { data: unknown }) => void) | null }
  terminate(): void
  terminated: boolean
}

/**
 * A fake `OffscreenCanvas` for canvas layers: it records the 2D calls of each draw (`log`), and its "image" is an
 * `ArrayBuffer` (transferable in Node) holding `[draw number, width, height]`.
 */
export class FakeCanvas {
  static all: FakeCanvas[] = []
  width: number
  height: number
  draws = 0
  log: string[] = []
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    FakeCanvas.all.push(this)
  }
  getContext(): unknown {
    const log = this.log
    return {
      canvas: this,
      save: () => log.push('save'),
      restore: () => log.push('restore'),
      setTransform: (...a: number[]) => log.push(`setTransform ${a.join(',')}`),
      clearRect: (...a: number[]) => log.push(`clearRect ${a.join(',')}`),
      fillRect: (...a: number[]) => log.push(`fillRect ${a.join(',')}`),
    }
  }
  transferToImageBitmap(): unknown {
    return new Uint16Array([++this.draws, this.width, this.height]).buffer
  }
}

/** Reads a fake canvas image: `[draw number, width, height]`. */
export const fakeImage = (image: unknown) => [...new Uint16Array(image as ArrayBuffer)]

/** Starts the runtime in-process; returns the engine's end of the channel (script.js comes with `init`). */
export function runtime(): TestConnection {
  const scope = fakeScope()
  scriptRuntime(scope, { harden: false, load: (c) => load(c) as Promise<{ default?: unknown }>, canvas: (w, h) => new FakeCanvas(w, h) })
  const channel = new MessageChannel()
  scope.send({ t: 'port' }, [channel.port2])
  const conn = {
    port: channel.port1 as unknown as TestConnection['port'],
    terminated: false,
    terminate() {
      conn.terminated = true
      channel.port1.close()
    },
  }
  return conn
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 15))

/** Sends one message and waits for the answer. */
export async function ask(conn: Pick<TestConnection, 'port'>, message: unknown): Promise<WireDone> {
  const answer = new Promise<WireDone>((resolve) => {
    conn.port.onmessage = (e) => resolve(e.data as WireDone)
  })
  conn.port.postMessage(message)
  return answer
}

export const init = (code: string, extra: Record<string, unknown> = {}) => ({ t: 'init', code, layers: ['label', '', 'dot'], params: { size: 1 }, seed: 42, clock: 0, time: 0, assets: {}, canvases: [], ...extra })
export const frame = (seq: number, extra: Record<string, unknown> = {}) => ({ t: 'frame', seq, time: seq / 30, dt: 1 / 30, clock: seq / 30, faces: [], events: [], ...extra })
