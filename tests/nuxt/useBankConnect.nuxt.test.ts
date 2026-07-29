import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBankConnect } from '~/composables/useBankConnect'

// useBankConnect wires the frame token → POST /api/bank/connect → RETURNS the authorize URL (the
// component opens the tab synchronously). Mock the shared frame-auth (token+domain) and $fetch so
// we test the wiring without a portal.
const auth = { value: { token: 'TKN', domain: 'p.bitrix24.by' } as { token: string, domain: string } | null }

vi.mock('~/composables/useFrameAuth', () => ({
  frameAuth: () => auth.value,
  frameAuthHeaders: (a: { token: string, domain: string }) => ({ 'authorization': `Bearer ${a.token}`, 'x-b24-domain': a.domain }),
  frameFetchError: (_e: unknown, fallback: string) => fallback
}))

const fetchMock = vi.fn()
vi.stubGlobal('$fetch', fetchMock)

afterEach(() => {
  fetchMock.mockReset()
  auth.value = { token: 'TKN', domain: 'p.bitrix24.by' }
})

describe('useBankConnect', () => {
  it('POSTs provider+trimmed account with frame headers and returns the authorize URL', async () => {
    fetchMock.mockResolvedValueOnce({ authorizeUrl: 'https://alfa/authorize?x=1' })
    const { start, connecting, error, enabled } = useBankConnect()
    const url = await start('alfa-by', '  BY13ALFA  ')
    expect(url).toBe('https://alfa/authorize?x=1')
    expect(fetchMock).toHaveBeenCalledWith('/api/bank/connect', {
      method: 'POST',
      headers: { 'authorization': 'Bearer TKN', 'x-b24-domain': 'p.bitrix24.by' },
      body: { provider: 'alfa-by', accountKey: 'BY13ALFA' } // trimmed
    })
    expect(connecting.value).toBe(false)
    expect(error.value).toBe('')
    expect(enabled.value).toBe(true)
  })

  it('surfaces a backend error body, returns null, and resets connecting', async () => {
    fetchMock.mockResolvedValueOnce({ error: 'provider not available' })
    const { start, error, connecting } = useBankConnect()
    expect(await start('alfa-by', 'BY13ALFA')).toBeNull()
    expect(error.value).toBe('provider not available')
    expect(connecting.value).toBe(false) // finally reset on the failure branch
  })

  it('maps a thrown fetch to a friendly message and resets connecting', async () => {
    fetchMock.mockRejectedValueOnce(new Error('500'))
    const { start, error, connecting } = useBankConnect()
    expect(await start('alfa-by', 'BY13ALFA')).toBeNull()
    expect(error.value).toBe('Не удалось начать подключение')
    expect(connecting.value).toBe(false)
  })

  it('счёт НЕ обязателен (#407): пустой — валидный старт, на сервер уходит пустая строка', async () => {
    // Порядок «сначала банк, потом счёт»: подключаемся, а номер указываем после возврата (сервер
    // положит подключение под временный ключ). Раньше пустой счёт был отказом ещё до запроса.
    fetchMock.mockResolvedValueOnce({ authorizeUrl: 'https://alfa/authorize' })
    const { start, error } = useBankConnect()
    expect(await start('alfa-by', '   ')).toBe('https://alfa/authorize')
    expect(error.value).toBe('')
    expect((fetchMock.mock.calls[0]![1] as { body: { accountKey: string } }).body.accountKey).toBe('')
  })

  it('inert outside the portal frame (no token → no fetch)', async () => {
    auth.value = null
    const { start, enabled, error } = useBankConnect()
    expect(await start('alfa-by', 'BY13ALFA')).toBeNull()
    expect(enabled.value).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(error.value).toMatch(/портал/i)
  })

  it('syncEnabled resolves frame presence for the preview note', () => {
    const { syncEnabled, enabled } = useBankConnect()
    expect(enabled.value).toBe(false) // default before resolution
    syncEnabled()
    expect(enabled.value).toBe(true) // token present
    auth.value = null
    syncEnabled()
    expect(enabled.value).toBe(false)
  })
})
