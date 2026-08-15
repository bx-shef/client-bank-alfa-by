import { describe, expect, it } from 'vitest'
import {
  BANK_REFRESH_TTL_SEC, connectionHealth, connectionHealthBadge, refreshAtAgeMs
} from '../app/utils/bankTokenLifetime'

// ⚠ Эти числа читают ДВА потребителя: сервер решает по ним, кого обновлять, интерфейс — что
// показать администратору. Разъехавшись, они дали бы зелёную строку на подключении, которое
// сервер уже похоронил, — то есть ровно ту беду, ради которой всё и писалось (#488).

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const c = (over: Partial<Parameters<typeof connectionHealth>[0]> = {}) =>
  ({ provider: 'alfa-by' as const, connectedAt: NOW - HOUR, hasRefresh: true, ...over })

describe('connectionHealth', () => {
  it('свежее подключение — «ok», и бейджа у него нет', () => {
    // Значок на каждой исправной строке приучает не читать значки.
    expect(connectionHealth(c(), NOW)).toBe('ok')
    expect(connectionHealthBadge('ok')).toBeNull()
  })

  it('в полосе обновления — «due», и человеку сказано, что делать НИЧЕГО не надо', () => {
    expect(connectionHealth(c({ connectedAt: NOW - 9 * HOUR }), NOW)).toBe('due')
    expect(connectionHealthBadge('due')?.hint).toContain('Действий не требуется')
  })

  it('старше всего срока жизни — «expired», и сказано, что нужен владелец счёта', () => {
    expect(connectionHealth(c({ connectedAt: NOW - 11 * HOUR }), NOW)).toBe('expired')
    expect(connectionHealthBadge('expired')?.hint).toContain('интернет-банк')
  })

  it('без refresh-токена — «no-refresh» ДАЖЕ если подключение свежее', () => {
    // Возраст тут ни при чём: продлевать нечем с самого начала.
    expect(connectionHealth(c({ hasRefresh: false, connectedAt: NOW }), NOW)).toBe('no-refresh')
  })

  it('неизвестный срок жизни — молчим, а не гадаем', () => {
    expect(connectionHealth(c({ provider: 'manual' }), NOW)).toBe('unknown')
    expect(connectionHealthBadge('unknown')).toBeNull()
  })

  it('метка времени из будущего — «unknown», а не «свежайшее»', () => {
    // Расхождение часов не должно читаться как подтверждение здоровья.
    expect(connectionHealth(c({ connectedAt: NOW + HOUR }), NOW)).toBe('unknown')
    expect(connectionHealth(c({ connectedAt: Number.NaN }), NOW)).toBe('unknown')
  })

  it('порог обновления — 80% срока жизни провайдера', () => {
    expect(refreshAtAgeMs('alfa-by')).toBe(8 * HOUR)
    expect(BANK_REFRESH_TTL_SEC['alfa-by']).toBe(36_000)
  })
})
