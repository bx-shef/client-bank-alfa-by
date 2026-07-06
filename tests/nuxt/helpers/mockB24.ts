import { vi } from 'vitest'
import type { B24Frame, Result } from '@bitrix24/b24jssdk'
import type { useB24 } from '~/composables/useB24'

export interface MockB24Options {
  /** Whether a B24 frame is present (default true). `false` = standalone mode. */
  isInit?: () => boolean
  /** Whether the current portal user is an admin (`$b24.auth.isAdmin`, default true). */
  isAdmin?: boolean
  /** Stable spy for `$b24.installFinish()` (so a test can assert it was called). */
  installFinish?: ReturnType<typeof vi.fn>
  /** Stable spy for `$b24.parent.setTitle()`. */
  setTitle?: ReturnType<typeof vi.fn>
  /** Lets a test make `$b24.actions.v2.batch.make()` reject (error/retry path). */
  batchMake?: ReturnType<typeof vi.fn>
}

/**
 * Typed fake of `useB24()`'s return for component tests, which can't load the
 * real Bitrix24 SDK. The `ReturnType<typeof useB24>` annotation makes TypeScript
 * fail here if the composable's surface changes — so the mock can't drift from
 * the real API silently.
 */
export function makeMockB24(opts: MockB24Options = {}): ReturnType<typeof useB24> {
  const ok = { isSuccess: true } as unknown as Result
  // Minimal B24Frame fake — only what install.vue / the in-portal pages touch.
  const frame = {
    auth: { getAuthData: () => ({ domain: 'example.bitrix24.by' }), isAdmin: opts.isAdmin ?? true },
    parent: { setTitle: opts.setTitle ?? vi.fn(async () => {}), fitWindow: vi.fn(async () => {}) },
    actions: { v2: { batch: { make: opts.batchMake ?? vi.fn(async () => ({ getData: () => ({}) })) } } },
    installFinish: opts.installFinish ?? vi.fn(async () => {})
  } as unknown as B24Frame
  return {
    init: vi.fn(async () => ok),
    get: () => frame,
    getOrThrow: () => frame,
    set: () => ok,
    isInit: () => opts.isInit?.() ?? true,
    targetOrigin: () => 'https://example.bitrix24.by',
    getRequiredRights: () => []
  }
}
