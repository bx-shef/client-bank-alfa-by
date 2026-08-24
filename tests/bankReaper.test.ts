import { describe, expect, it } from 'vitest'
import {
  bankDeathSinceMs,
  bankDeadForDays,
  bankReaperLogLine,
  bankFleetBreach,
  reapVerdict,
  resolveBankReapDays,
  MIN_BANK_REAP_DAYS,
  DEFAULT_BANK_REAP_DAYS,
  MAX_BANK_REAP_PER_RUN,
  type BankReapFacts
} from '../app/utils/bankReaper'
import { BANK_REFRESH_TTL_SEC } from '../app/utils/bankTokenLifetime'

const NOW = 1_700_000_000_000
const DAY = 86_400_000
const ALFA_TTL = BANK_REFRESH_TTL_SEC['alfa-by'] * 1000

// ⚠ Смысл всего набора — «стираем ТОЛЬКО измеренно-мёртвое». Ошибка в другую сторону (снести живое)
// стоит владельцу счёта похода в интернет-банк, поэтому догадка о сроке в кандидаты не попадает.

describe('bankDeathSinceMs — измеренная смерть, не догадка (#599)', () => {
  it('истёкшее согласие банка — смерть с ДАТЫ БАНКА, для любого провайдера', () => {
    const at = NOW - 5 * DAY
    expect(bankDeathSinceMs({ provider: 'prior-by', connectedAt: NOW, hasRefresh: true, consentExpiresAt: at }, NOW)).toBe(at)
    expect(bankDeathSinceMs({ provider: 'alfa-by', connectedAt: NOW, hasRefresh: true, consentExpiresAt: at }, NOW)).toBe(at)
  })

  it('Альфа старше ИЗМЕРЕННОГО TTL — смерть в connectedAt+TTL', () => {
    const connectedAt = NOW - ALFA_TTL - 3 * DAY
    expect(bankDeathSinceMs({ provider: 'alfa-by', connectedAt, hasRefresh: true }, NOW)).toBe(connectedAt + ALFA_TTL)
  })

  it('ПРИОР по догадке о сроке refresh — НИКОГДА не мёртв (нет измеренного TTL)', () => {
    // ⚠ Главный инвариант. Приорский TTL — наша догадка; хоронить по ней значит удалять живое.
    const connectedAt = NOW - 100 * DAY // как угодно старо
    expect(bankDeathSinceMs({ provider: 'prior-by', connectedAt, hasRefresh: true }, NOW)).toBeNull()
    // Даже без refresh-токена — это «нужно переподключить», но не измеренная смерть без даты банка.
    expect(bankDeathSinceMs({ provider: 'prior-by', connectedAt, hasRefresh: false }, NOW)).toBeNull()
  })

  it('свежая Альфа — жива (TTL всего ~10 ч, берём час)', () => {
    expect(bankDeathSinceMs({ provider: 'alfa-by', connectedAt: NOW - 3_600_000, hasRefresh: true }, NOW)).toBeNull()
  })

  it('сработали ОБА условия — берём более раннее', () => {
    const connectedAt = NOW - ALFA_TTL - 10 * DAY // TTL-смерть = connectedAt+TTL (10 дней назад)
    const consentAt = NOW - 2 * DAY // согласие истекло позже
    const d = bankDeathSinceMs({ provider: 'alfa-by', connectedAt, hasRefresh: true, consentExpiresAt: consentAt }, NOW)
    expect(d).toBe(connectedAt + ALFA_TTL)
  })

  it('согласие 0/отсутствует — не считается истёкшим', () => {
    expect(bankDeathSinceMs({ provider: 'prior-by', connectedAt: NOW - DAY, hasRefresh: true, consentExpiresAt: 0 }, NOW)).toBeNull()
  })
})

describe('bankDeadForDays', () => {
  it('целые дни от смерти; null — не мёртво', () => {
    expect(bankDeadForDays(NOW - 40 * DAY, NOW)).toBe(40)
    expect(bankDeadForDays(null, NOW)).toBeNull()
    expect(bankDeadForDays(NOW + DAY, NOW)).toBe(0) // из будущего — не отрицательное
  })
})

describe('resolveBankReapDays — кламп ВВЕРХ от пола (#599)', () => {
  it('мусор/пусто/ноль → умолчание, а не 0', () => {
    for (const raw of ['', ' ', undefined, 'x', '0', '-3']) {
      expect(resolveBankReapDays(raw)).toBe(DEFAULT_BANK_REAP_DAYS)
    }
  })
  it('ниже пола поднимается до пола; выше — как есть', () => {
    expect(resolveBankReapDays('3')).toBe(MIN_BANK_REAP_DAYS)
    expect(resolveBankReapDays('90')).toBe(90)
  })
})

describe('bankFleetBreach — доля, а не число', () => {
  it('на крошечном флоте не срабатывает', () => {
    expect(bankFleetBreach(2, 3)).toBe(false)
  })
  it('большая доля от многих — срабатывает', () => {
    expect(bankFleetBreach(40, 100)).toBe(true)
    expect(bankFleetBreach(10, 100)).toBe(false)
  })
})

describe('bankReaperLogLine — печатается всегда', () => {
  const base: BankReapFacts = { candidates: 0, reaped: 0, failed: 0, skipped: 0, capped: false, breach: false, days: 30 }
  it('предохранитель — своя формулировка', () => {
    expect(bankReaperLogLine({ ...base, candidates: 40, breach: true })).toContain('НИЧЕГО не стёрто')
  })
  it('потолок и отказы попадают в строку', () => {
    const l = bankReaperLogLine({ ...base, candidates: 8, reaped: MAX_BANK_REAP_PER_RUN, failed: 1, capped: true })
    expect(l).toContain('стёрто 5')
    expect(l).toContain('НЕ УДАЛОСЬ стереть 1')
    expect(l).toContain('не больше')
  })
})

describe('reapVerdict — общий с #574', () => {
  it('мёртв дольше порога → reap; недавно → too-early; нет метки → alive', () => {
    expect(reapVerdict(NOW - 40 * DAY, NOW, 30)).toBe('reap')
    expect(reapVerdict(NOW - 10 * DAY, NOW, 30)).toBe('too-early')
    expect(reapVerdict(null, NOW, 30)).toBe('alive')
  })
})
