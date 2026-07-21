import { describe, expect, it } from 'vitest'
import { withFrameRouteSpan } from '../server/utils/frameRouteSpan'

// withFrameRouteSpan is a thin wrapper over withSpan: it runs the handler, exposes a mutable
// `span.outcome` (defaulting 'ok'), and — since telemetry is OFF by default (no SDK registered) —
// is a transparent pass-through that never alters the handler's return value or throwing behavior.
// (The PII-safe attribute plumbing is covered by telemetryAttributes.test.ts; here we pin the
// pass-through contract so a wrapped route behaves exactly like the unwrapped one.)

describe('withFrameRouteSpan', () => {
  it('returns the handler result unchanged (telemetry off → pass-through)', async () => {
    const out = await withFrameRouteSpan(
      { name: 'http.test.get', method: 'GET', op: 'test.load', domain: 'x.bitrix24.by' },
      async () => ({ status: 200, value: 42 })
    )
    expect(out).toEqual({ status: 200, value: 42 })
  })

  it('passes the mutable span so the handler can set an outcome without affecting the result', async () => {
    let seen: string | undefined
    const out = await withFrameRouteSpan(
      { name: 'http.test.post', method: 'POST', op: 'test.save', domain: undefined },
      async (span) => {
        seen = span.outcome // defaults to 'ok'
        span.outcome = 'forbidden'
        return 'body'
      }
    )
    expect(seen).toBe('ok')
    expect(out).toBe('body')
  })

  it('propagates a thrown error (does not swallow) so the route fails as before', async () => {
    await expect(withFrameRouteSpan(
      { name: 'http.test.get', method: 'GET', op: 'test.load', domain: 'x.bitrix24.by' },
      async () => { throw new Error('boom') }
    )).rejects.toThrow('boom')
  })
})
