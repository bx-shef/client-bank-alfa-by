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

    // Ловушки русского счёта: 5 и 11 — «шаблонов», 22 — «шаблона».
    const many = (n: number) => {
      const st = withSp()
      st.recognition.matrices = Array.from({ length: n }, () => ({ mask: 'd+', kind: 'invoice-number' as const }))
      return item(buildReadiness(snap({ settings: st })), 'recognition').detail
    }
    expect(many(5)).toBe('5 шаблонов')
    expect(many(11)).toBe('11 шаблонов')
    expect(many(22)).toBe('22 шаблона')
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

describe('строка «Моя компания» (#493)', () => {
  // На боевом портале ноль записей при исправном транспорте держались ровно на этом, и узнать
  // причину можно было только по счётчикам в чужой БД. Строка идёт ПЕРВОЙ — это порядок
  // действий: без неё подключение банка проходит целиком и не создаёт ни одной записи.
  const base = {
    settings: parsePortalSettings(null),
    connectedAccounts: 1,
    pollEnabled: true,
    pollIntervalMin: 5,
    lastRunMs: null
  }

  it('идёт ПЕРВОЙ, раньше банка', () => {
    const items = buildReadiness({ ...base, myCompany: 'no-company' })
    expect(items[0]!.key).toBe('my-company')
    expect(items[1]!.key).toBe('bank')
  })

  it('три состояния различаются подсказкой — они чинятся по-разному', () => {
    const hint = (v: 'ok' | 'no-company' | 'no-account') =>
      buildReadiness({ ...base, myCompany: v }).find(i => i.key === 'my-company')!
    expect(hint('ok').ok).toBe(true)
    expect(hint('ok').hint).toBe('')
    expect(hint('no-company').hint).toContain('Моя компания')
    expect(hint('no-account').hint).toContain('расчётный счёт')
    expect(hint('no-company').hint).not.toBe(hint('no-account').hint)
  })

  it('⚠ не спросили — строки НЕТ вовсе, а не зелёная галочка', () => {
    // Выдуманная галочка на этом экране особенно дорога: его открывают, чтобы понять, почему
    // ничего не работает.
    expect(buildReadiness(base).some(i => i.key === 'my-company')).toBe(false)
  })

  it('без «моей компании» экран НЕ считается готовым', () => {
    expect(isFullyReady(buildReadiness({ ...base, myCompany: 'no-account' }))).toBe(false)
  })
})

describe('нерабочее подключение не красится зелёным (#504)', () => {
  // ⚠ Экран существует ровно ради таких случаев: строка в БД есть, а импорта нет. Раньше «Банк
  // подключён» горело зелёным по факту наличия строки — то есть громче всего врало именно тогда,
  // когда подключение сломалось.
  const withBank = (over: Partial<ReadinessSnapshot>) => buildReadiness({
    settings: parsePortalSettings(null),
    connectedAccounts: 2,
    pollEnabled: true,
    pollIntervalMin: 5,
    lastRunMs: null,
    ...over
  }).find(r => r.key === 'bank')!

  it('все подключения живы — зелено', () => {
    expect(withBank({ unhealthyAccounts: 0 }).ok).toBe(true)
  })

  it('есть истёкшее — НЕ зелено, и сказано сколько', () => {
    const row = withBank({ unhealthyAccounts: 1 })
    expect(row.ok).toBe(false)
    expect(row.detail).toContain('1 не работает')
  })

  it('подсказка ведёт к действию — вход владельца счёта в интернет-банк', () => {
    // Единственное, чем это лечится. Общая «подключите счёт» тут не помогает: счёт подключён.
    expect(withBank({ unhealthyAccounts: 1 }).hint).toContain('интернет-банк')
  })

  it('нерабочее важнее незавершённого — подсказка про поломку, а не про выбор счёта', () => {
    // Там настройку не доделали, здесь она была доделана и сломалась: импорт уже стоит.
    const row = withBank({ unhealthyAccounts: 1, pendingAccounts: 1 })
    expect(row.hint).toContain('интернет-банк')
    expect(row.ok).toBe(false)
  })

  it('старый сервер поля не прислал — строка не краснеет на ровном месте', () => {
    // Дефолт «считать сломанным» дал бы красную строку на исправном портале.
    expect(withBank({}).ok).toBe(true)
  })
})

describe('#576 пауза автоопроса на экране готовности', () => {
  const base = (over: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot => snap({
    connectedAccounts: 2, pollEnabled: true, pollIntervalMin: 5, ...over
  })
  const poll = (s: ReadinessSnapshot) => buildReadiness(s).find(i => i.key === 'poll')!

  it('часть подключений на паузе — строка остаётся ЗЕЛЁНОЙ, но говорит об этом', () => {
    // ⚠ Красное здесь означает «настройка не доведена», а пауза — доведённая настройка, которой
    // воспользовались. Покрасив её красным, мы приучили бы админа видеть красное на экране,
    // который он сам и привёл в это состояние.
    const item = poll(base({ pausedAccounts: 1 }))
    expect(item.ok).toBe(true)
    expect(item.detail).toContain('1 подключение на паузе')
  })

  it('ВСЕ подключения на паузе — прямо сказано, что выписки не будет', () => {
    // Без этого строка «каждые 5 мин» была бы ложью, и тишину пошли бы искать в банке.
    const item = poll(base({ pausedAccounts: 2 }))
    expect(item.detail).toContain('все подключения на паузе')
    expect(item.hint).toContain('возобновите')
  })

  it('пауз нет — строка прежняя, без приписок', () => {
    expect(poll(base()).detail).toBe('каждые 5 мин')
    expect(poll(base({ pausedAccounts: 0 })).detail).toBe('каждые 5 мин')
  })

  it('опрос выключен НА СЕРВЕРЕ — пауза этого не перекрывает', () => {
    // Два разных «не опрашиваем», и чинят их разные люди: серверный гейт — владелец приложения,
    // паузу — админ портала. Слить их значило бы отправить админа не туда.
    const item = poll(base({ pollEnabled: false, pausedAccounts: 2 }))
    expect(item.ok).toBe(false)
    expect(item.hint).toContain('владельцу приложения')
  })
})
