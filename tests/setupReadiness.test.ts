import { describe, expect, it } from 'vitest'
import { buildReadiness, isFullyReady, type ReadinessSnapshot } from '~/utils/setupReadiness'
import { parsePortalSettings } from '~/utils/settings'
import { PAYMENT_SP_CONFIG_KEY, DISTRIBUTION_SP_CONFIG_KEY } from '~/config/distributionSp'

// Setup-readiness checklist (#409/#405) — «что настроено, а что нет» for a PORTAL (not the infra
// probe in server/utils/readiness.ts). The point of the model is that a half-configured portal is
// VISIBLY half-configured, so the tests care about which line goes red and what it tells the admin
// to do — not about wording in general.

function snap(over: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot {
  return {
    settings: parsePortalSettings(null),
    connectedAccounts: 0,
    pendingAccounts: 0,
    pollEnabled: false,
    pollIntervalMin: 5,
    lastRunMs: null,
    ...over
  }
}

/** Settings with both distribution smart processes provisioned. */
function withSp() {
  const s = parsePortalSettings(null)
  s.recognition.configFields = {
    [PAYMENT_SP_CONFIG_KEY]: '1044',
    [DISTRIBUTION_SP_CONFIG_KEY]: '1046'
  }
  return s
}

function item(items: ReturnType<typeof buildReadiness>, key: string) {
  const found = items.find(i => i.key === key)
  if (!found) throw new Error(`no readiness item ${key}`)
  return found
}

describe('buildReadiness', () => {
  it('a fresh portal is red on every line and says what to do on each', () => {
    const items = buildReadiness(snap())
    expect(items.every(i => !i.ok)).toBe(true)
    expect(items.every(i => i.hint.length > 0)).toBe(true)
    expect(isFullyReady(items)).toBe(false)
  })

  it('bank turns green on the first connected account and counts them in Russian', () => {
    expect(item(buildReadiness(snap({ connectedAccounts: 1 })), 'bank').detail).toBe('1 счёт')
    expect(item(buildReadiness(snap({ connectedAccounts: 2 })), 'bank').detail).toBe('2 счёта')
    expect(item(buildReadiness(snap({ connectedAccounts: 5 })), 'bank').detail).toBe('5 счетов')
    expect(item(buildReadiness(snap({ connectedAccounts: 11 })), 'bank').detail).toBe('11 счетов')
    expect(item(buildReadiness(snap({ connectedAccounts: 21 })), 'bank').detail).toBe('21 счёт')
  })

  it('подключение без выбранного счёта не считается готовым и напоминает о себе (#407)', () => {
    // Админ авторизовался и закрыл вкладку: раньше такое подключение было видно только в списке
    // внутри карточки банка, то есть фактически нигде.
    const only = item(buildReadiness(snap({ connectedAccounts: 0, pendingAccounts: 1 })), 'bank')
    expect(only.ok).toBe(false)
    expect(only.detail).toContain('без выбранного счёта')
    expect(only.hint).toContain('укажите номер')

    // Даже при живом подключении незавершённое не даёт закрыть строку — иначе о нём забудут.
    const mixed = item(buildReadiness(snap({ connectedAccounts: 2, pendingAccounts: 1 })), 'bank')
    expect(mixed.ok).toBe(false)
    expect(mixed.detail).toContain('ещё 1 без счёта')
  })

  it('tells a portal without a bank that manual upload still works', () => {
    // Otherwise a red line reads as «приложение не работает», which is false.
    expect(item(buildReadiness(snap()), 'bank').hint).toContain('ручная загрузка')
  })

  it('chat is green once a dialog is chosen, and shows its title when known', () => {
    const settings = parsePortalSettings(null)
    settings.chat.dialogId = 'chat123'
    settings.chat.title = 'Бухгалтерия'
    const row = item(buildReadiness(snap({ settings })), 'chat')
    expect(row.ok).toBe(true)
    expect(row.detail).toBe('Бухгалтерия')
  })

  it('smart processes need BOTH ids — one alone is not «настроено»', () => {
    const half = parsePortalSettings(null)
    half.recognition.configFields = { [PAYMENT_SP_CONFIG_KEY]: '1044' }
    expect(item(buildReadiness(snap({ settings: half })), 'smart-process').ok).toBe(false)
    expect(item(buildReadiness(snap({ settings: withSp() })), 'smart-process').ok).toBe(true)
  })

  it('says the poll gate is not a portal setting — the admin cannot fix it themselves', () => {
    const off = item(buildReadiness(snap({ pollEnabled: false })), 'poll')
    expect(off.ok).toBe(false)
    expect(off.hint).toContain('владельцу приложения')

    const on = item(buildReadiness(snap({ pollEnabled: true, pollIntervalMin: 5 })), 'poll')
    expect(on.ok).toBe(true)
    expect(on.detail).toBe('каждые 5 мин')
    expect(on.hint).toBe('')
  })

  it('чат ошибок — ОТДЕЛЬНАЯ строка: без него сообщения о проблемных платежах не приходят никуда', () => {
    const settings = withSp()
    settings.chat.dialogId = 'chat123'
    // Чат уведомлений выбран, а чат ошибок — нет: именно в него уходит всё, что приложение не
    // разложило само, поэтому «зелено по чату» здесь было бы обманом.
    const red = item(buildReadiness(snap({ settings })), 'error-chat')
    expect(red.ok).toBe(false)
    expect(red.hint).toContain('чат ошибок')

    settings.errorChat.dialogId = 'err123'
    expect(item(buildReadiness(snap({ settings })), 'error-chat').ok).toBe(true)
  })

  it('карта распознавания краснеет, пока нет ни одного шаблона номера', () => {
    // Без матриц приложение не видит в назначении НИ ОДНОГО номера — дела пишутся, но ни к чему
    // не привязываются, и снаружи это выглядит как «разнесение не работает».
    const settings = withSp()
    expect(item(buildReadiness(snap({ settings })), 'recognition').ok).toBe(false)

    settings.recognition.matrices = [{ mask: 'dddd', kind: 'invoice-number', note: '' }]
    const green = item(buildReadiness(snap({ settings })), 'recognition')
    expect(green.ok).toBe(true)
    expect(green.detail).toBe('1 шаблон')

    settings.recognition.matrices.push({ mask: 'СЧ-dddd', kind: 'invoice-number', note: '' })
    expect(item(buildReadiness(snap({ settings })), 'recognition').detail).toBe('2 шаблона')
  })

  it('is fully ready only when every line is ok', () => {
    const settings = withSp()
    settings.chat.dialogId = 'chat123'
    settings.errorChat.dialogId = 'err123'
    settings.recognition.matrices = [{ mask: 'dddd', kind: 'invoice-number', note: '' }]
    const items = buildReadiness(snap({ settings, connectedAccounts: 1, pollEnabled: true }))
    expect(isFullyReady(items)).toBe(true)
    expect(items.every(i => i.hint === '')).toBe(true)
  })
})
