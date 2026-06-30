import { describe, expect, it } from 'vitest'
import { useB24 } from '~/composables/useB24'
import { B24_REQUIRED_SCOPES } from '~/config/b24'

// Exercises the REAL composable (not the mock). happy-dom leaves window.name
// empty, so we're never inside a portal frame — this covers the standalone
// guards, which are the composable's pure logic. The in-frame `set()` path is
// portal-only and verified manually / via the install component test's mock.
describe('useB24 (outside a portal frame)', () => {
  it('init() is a no-op without window.name → isInit() stays false', async () => {
    const b24 = useB24()
    await b24.init()
    expect(b24.isInit()).toBe(false)
  })

  it('init() is idempotent — a second call is still a no-op', async () => {
    const b24 = useB24()
    await b24.init()
    await b24.init()
    expect(b24.isInit()).toBe(false)
  })

  it('getOrThrow() throws before initialisation', () => {
    expect(() => useB24().getOrThrow()).toThrow()
  })

  it('targetOrigin() returns "?" outside a frame', () => {
    expect(useB24().targetOrigin()).toBe('?')
  })

  it('getRequiredRights() returns the configured scopes', () => {
    expect(useB24().getRequiredRights()).toEqual([...B24_REQUIRED_SCOPES])
  })
})
