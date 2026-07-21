import { describe, expect, it } from 'vitest'
import { clientIpKey, createRateLimiter } from '../server/utils/loginRateLimit'

describe('createRateLimiter (fixed window)', () => {
  it('allows up to `max` hits per window, then blocks with a Retry-After', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 3 })
    const t = 1_000
    expect(rl.check('ip', t).allowed).toBe(true)
    expect(rl.check('ip', t).allowed).toBe(true)
    expect(rl.check('ip', t).allowed).toBe(true)
    const blocked = rl.check('ip', t)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSec).toBe(60) // full window remains
  })

  it('resets after the window elapses', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 1 })
    expect(rl.check('ip', 0).allowed).toBe(true)
    expect(rl.check('ip', 100).allowed).toBe(false)
    expect(rl.check('ip', 60_001).allowed).toBe(true) // new window
  })

  it('keys independently per client', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 1 })
    expect(rl.check('a', 0).allowed).toBe(true)
    expect(rl.check('a', 0).allowed).toBe(false)
    expect(rl.check('b', 0).allowed).toBe(true) // different key unaffected
  })

  it('retryAfter counts down within the window (ceil, min 1s)', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 1 })
    rl.check('ip', 0)
    expect(rl.check('ip', 59_500).retryAfterSec).toBe(1) // 500ms left → ceil → 1
    expect(rl.check('ip', 30_000).retryAfterSec).toBe(30)
  })

  it('prunes/clears when the key map blows past maxKeys (memory backstop)', () => {
    const rl = createRateLimiter({ windowMs: 10, max: 1, maxKeys: 2 })
    // Fill 3 keys with SHORT windows, all expired by t=100.
    rl.check('a', 0)
    rl.check('b', 0)
    rl.check('c', 0)
    // Next hit at t=100: size (3) > maxKeys (2) → expired entries pruned; 'a' gets a fresh window.
    expect(rl.check('a', 100).allowed).toBe(true)
  })
})

describe('clientIpKey', () => {
  it('prefers the first X-Forwarded-For hop', () => {
    expect(clientIpKey('203.0.113.7, 10.0.0.1', '10.0.0.1')).toBe('203.0.113.7')
  })
  it('falls back to the remote address, then a constant', () => {
    expect(clientIpKey(undefined, '198.51.100.4')).toBe('198.51.100.4')
    expect(clientIpKey('', '')).toBe('unknown')
  })
})
