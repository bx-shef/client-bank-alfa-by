import { describe, expect, it, vi } from 'vitest'
import { FRAME_PULSE_MAX_MS } from '../../app/utils/frameTokenPulse'
import { useFrameTokenPulse } from '../../app/composables/useFrameTokenPulse'

// Проводка продления токена фрейма — в nuxt-проекте, потому что она держится на `document`
// (подписка на возврат вкладки), а в node-прогоне DOM'а нет вовсе.
//
// ⚠ Живая находка владельца 2026-09-10: вкладка настроек повисела без единого действия, и три
// блока разом сказали «invalid frame token for this portal». SDK продлевает токен сам, но только
// у СВОИХ вызовов, а на портальных страницах их после рукопожатия нет ни одного.

const sec = (ms: number): number => ms / 1000

describe('проводка продления', () => {
  const makeAuth = (expiresMs: number) => {
    const auth = {
      getAuthData: vi.fn(() => ({ expires: sec(expiresMs) })),
      refreshAuth: vi.fn(async () => ({ expires: sec(Date.now() + 60 * 60_000) }))
    }
    return auth
  }

  it('свежий токен не продлеваем — лишняя ротация никому не нужна', async () => {
    vi.useFakeTimers()
    try {
      const auth = makeAuth(Date.now() + 60 * 60_000)
      const pulse = useFrameTokenPulse()
      pulse.start(auth)
      await vi.advanceTimersByTimeAsync(0)
      expect(auth.refreshAuth).not.toHaveBeenCalled()
      pulse.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('истекающий токен продлевается сразу на старте', async () => {
    vi.useFakeTimers()
    try {
      const auth = makeAuth(Date.now() + 1000)
      const pulse = useFrameTokenPulse()
      pulse.start(auth)
      await vi.advanceTimersByTimeAsync(0)
      expect(auth.refreshAuth).toHaveBeenCalledTimes(1)
      pulse.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // ⚠ ТАЙМЕРА ОДНОГО НЕ ХВАТИТ: браузер душит таймеры в фоновой вкладке, и замороженную будят уже
  // по возвращении. Сценарий владельца — «долго сидел и ничего не трогал» — закрывает именно эта
  // подписка, поэтому она проверяется вызовом, а не чтением кода.
  it('возврат на вкладку проверяет токен НЕМЕДЛЕННО', async () => {
    vi.useFakeTimers()
    try {
      const auth = makeAuth(Date.now() + 60 * 60_000)
      const pulse = useFrameTokenPulse()
      pulse.start(auth)
      await vi.advanceTimersByTimeAsync(0)
      const before = auth.getAuthData.mock.calls.length
      auth.getAuthData.mockReturnValue({ expires: sec(Date.now() + 1000) })
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
      expect(auth.getAuthData.mock.calls.length).toBeGreaterThan(before)
      expect(auth.refreshAuth).toHaveBeenCalledTimes(1)
      pulse.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // ⚠ Отказ портала не должен ронять страницу: продление — лучшие усилия, лечится перезагрузкой
  // человеком, а не нами.
  it('отказ продления проглатывается', async () => {
    vi.useFakeTimers()
    try {
      const auth = {
        getAuthData: vi.fn(() => false as const),
        refreshAuth: vi.fn(async () => { throw new Error('portal is gone') })
      }
      const pulse = useFrameTokenPulse()
      pulse.start(auth)
      await expect(vi.advanceTimersByTimeAsync(0)).resolves.not.toThrow()
      pulse.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop снимает таймер — иначе он пережил бы уход фрейма', async () => {
    vi.useFakeTimers()
    try {
      const auth = makeAuth(Date.now() + 60 * 60_000)
      const pulse = useFrameTokenPulse()
      pulse.start(auth)
      await vi.advanceTimersByTimeAsync(0)
      pulse.stop()
      const after = auth.getAuthData.mock.calls.length
      await vi.advanceTimersByTimeAsync(FRAME_PULSE_MAX_MS * 3)
      expect(auth.getAuthData.mock.calls.length).toBe(after)
    } finally {
      vi.useRealTimers()
    }
  })
})
