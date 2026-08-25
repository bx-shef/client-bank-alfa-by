import { describe, expect, it } from 'vitest'
import {
  deadDays,
  isSubscriptionEnded,
  SUBSCRIPTION_CUTOFF_DAYS,
  subscriptionCutoffDue
} from '~/utils/portalSubscription'

// Подписка портала на REST истекла (#614).
//
// ⚠ Отключение банковских подключений НЕОБРАТИМО для клиента: чтобы вернуться, владельцу счёта
// придётся заново авторизоваться в интернет-банке. Поэтому тесты здесь проверяют не «срабатывает
// ли», а «не сработает ли раньше срока».

const DAY = 86_400_000
const NOW = 1_800_000_000_000

describe('isSubscriptionEnded', () => {
  it('узнаёт сообщение, каким его прислал живой портал', () => {
    // Замер 2026-08-25: именно этой строкой падала КАЖДАЯ операция портала.
    expect(isSubscriptionEnded(new Error('Subscription has been ended'))).toBe(true)
  })

  it('регистр и обрамление не мешают', () => {
    expect(isSubscriptionEnded('Error: subscription has been ended')).toBe(true)
    expect(isSubscriptionEnded(new Error('SUBSCRIPTION HAS BEEN ENDED'))).toBe(true)
  })

  it('чужие отказы НЕ считает — иначе отключим за сетевой блип', () => {
    for (const m of ['ECONNRESET', 'QUERY_LIMIT_EXCEEDED', 'invalid_grant', 'ACCESS_DENIED', '']) {
      expect(isSubscriptionEnded(new Error(m)), m || '(пусто)').toBe(false)
    }
  })

  it('мусор не роняет', () => {
    expect(isSubscriptionEnded(null)).toBe(false)
    expect(isSubscriptionEnded({ message: 42 })).toBe(false)
  })
})

describe('deadDays', () => {
  it('без метки — ноль', () => {
    expect(deadDays(0, NOW)).toBe(0)
    expect(deadDays(null, NOW)).toBe(0)
  })

  it('считает ПРОШЕДШИЕ сутки, а не начатые', () => {
    // ⚠ Округление вверх означало бы отключение раньше названного срока — а оно необратимо.
    expect(deadDays(NOW - 3.9 * DAY, NOW)).toBe(3)
    expect(deadDays(NOW - 4 * DAY, NOW)).toBe(4)
  })

  it('метка из будущего даёт ноль, а не отрицательное', () => {
    expect(deadDays(NOW + DAY, NOW)).toBe(0)
  })
})

describe('subscriptionCutoffDue', () => {
  it('до срока НЕ отключаем', () => {
    expect(subscriptionCutoffDue(NOW - 3 * DAY, NOW)).toBe(false)
    expect(subscriptionCutoffDue(NOW - (4 * DAY - 1), NOW), 'за миллисекунду до срока').toBe(false)
  })

  it('на сроке — отключаем (граница включительно)', () => {
    expect(subscriptionCutoffDue(NOW - SUBSCRIPTION_CUTOFF_DAYS * DAY, NOW)).toBe(true)
  })

  it('без метки не отключаем НИКОГДА', () => {
    // Самый опасный промах: отключить портал, у которого подписка в порядке.
    expect(subscriptionCutoffDue(0, NOW)).toBe(false)
    expect(subscriptionCutoffDue(null, NOW)).toBe(false)
    expect(subscriptionCutoffDue(undefined, NOW)).toBe(false)
  })

  it('часы из будущего дают отсрочку, а не досрочное отключение', () => {
    expect(subscriptionCutoffDue(NOW + 10 * DAY, NOW)).toBe(false)
  })

  it('срок — ЧЕТЫРЕ дня (решение владельца, не месяц)', () => {
    expect(SUBSCRIPTION_CUTOFF_DAYS).toBe(4)
  })
})
