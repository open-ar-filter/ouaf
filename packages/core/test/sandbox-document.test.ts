import { describe, expect, it } from 'vitest'
import { SANDBOX_CSP, SANDBOX_HEADERS, SANDBOX_PROTOCOL, sandboxDocument } from '../src/index.ts'

describe('sandbox document (#181)', () => {
  it('carries its CSP and announces its protocol version', () => {
    const html = sandboxDocument()
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`)
    expect(html).toContain(`parent.postMessage({ t: 'ouaf:ready', v: ${SANDBOX_PROTOCOL} }, '*')`)
    expect(SANDBOX_CSP).toContain("connect-src 'none'")
  })

  it('is served sandboxed, with the same policy', () => {
    const csp = SANDBOX_HEADERS['Content-Security-Policy']!
    expect(csp.startsWith('sandbox allow-scripts; ')).toBe(true)
    expect(csp).toContain(SANDBOX_CSP)
    expect(SANDBOX_HEADERS['Content-Type']).toMatch(/^text\/html/)
  })
})
