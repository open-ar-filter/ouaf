// Hardening removes globals for good (non-configurable): it runs in this file of its own, whose test worker it alters.
import { describe, expect, it } from 'vitest'
import { scriptRuntime } from '../src/script/runtime.ts'
import { ask, fakeScope, init, load, type TestConnection } from './script-helpers.ts'

describe('script runtime: hardening (spec §15)', () => {
  it('removes the network and storage globals once it has its port, wherever they live, and keeps working', async () => {
    const g = globalThis as Record<string, unknown>
    expect(typeof g.fetch).toBe('function') // Node has these
    expect(g.navigator).toBeDefined()
    // One more on the prototype chain, as a Worker's `self` has them (WorkerGlobalScope.prototype).
    const proto = Object.getPrototypeOf(globalThis) as Record<string, unknown>
    Object.defineProperty(proto, 'importScripts', { value: () => {}, configurable: true, writable: true })

    const scope = fakeScope()
    scriptRuntime(scope, { load })
    expect(typeof g.fetch).toBe('function') // not before the port arrives
    const channel = new MessageChannel()
    scope.send({ t: 'port' }, [channel.port2])

    for (const name of ['fetch', 'WebSocket', 'navigator', 'importScripts', 'Request', 'Response', 'Headers', 'BroadcastChannel', 'indexedDB']) {
      expect(g[name], name).toBeUndefined()
      const d = Object.getOwnPropertyDescriptor(globalThis, name)
      expect([d?.configurable, d?.writable], name).toEqual([false, false])
    }
    expect(Object.hasOwn(proto, 'importScripts')).toBe(false)
    expect(() => {
      'use strict'
      g.fetch = () => {}
    }).toThrow(TypeError)

    const done = await ask({ port: channel.port1 as unknown as TestConnection['port'] }, init(`export default { setup(f) { f.emit('fetch', typeof fetch) } }`))
    expect(done.emits).toEqual([['fetch', 'undefined']])
    channel.port1.close()
  })
})
