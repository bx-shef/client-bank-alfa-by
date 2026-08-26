import { describe, expect, it } from 'vitest'
import {
  bankDisconnectAuditLine,
  handleAddBankAccount,
  handleDisconnectBankAccount,
  handleListBankAccounts,
  handlePauseBankPoll,
  handleSetBankAccount,
  type AddAccountDeps,
  type DisconnectDeps,
  type ListAccountsDeps,
  type PausePollDeps,
  type SetAccountDeps
} from '../server/utils/bankAccounts'
import { provisionalAccountKey } from '../app/utils/bankAccountKey'
import { classifyProvisionError } from '../server/utils/provisionRequest'
import type { BankAccountInfo } from '../server/utils/bankTokenStore'

// Connected bank accounts (#404). The gate is the interesting part: this endpoint pair reveals and
// revokes portal-wide bank bindings, so it must refuse exactly where /api/bank/connect refuses —
// unknown portal, a frame token that isn't this portal's, and non-admins.

const ROW: BankAccountInfo = {
  id: 42,
  // ⚠ НЕНУЛЕВОЕ по той же причине, что `consentExpiresAt` ниже (находка ревью): с нулём обе
  // проверки поля сводились к «0 === 0», и мутация `lastAttemptAt: 0` прямо в проекции роута
  // проходила зелёной. Ноль ловил только ПРОПАЖУ ключа, но не подмену его константой — а поле
  // несущее: на нём держится `expiredCause` («банк отказал» против «мы не пытались»).
  lastAttemptAt: 1_700_000_123_000,
  memberId: 'M1',
  provider: 'alfa-by',
  accountKey: 'BY01ALFA0001',
  connectedAt: 1_700_000_000_000,
  expiresAt: 1_700_003_600_000,
  hasRefresh: true,
  pollPaused: false,
  // ⚠ НЕНУЛЕВОЕ значение принципиально. С `undefined`/дефолтом `toEqual` сравнивает вакуумно:
  // Vitest игнорирует ключи со значением `undefined`, поэтому «точный состав полей» проходил и
  // тогда, когда поле вообще выпилили из ответа (#503, находка ревью).
  consentExpiresAt: 1_700_000_500_000,
  accountConfirmedAt: 0,
  grantId: 'g1'
}

function listDeps(over: Partial<ListAccountsDeps> = {}): ListAccountsDeps {
  return {
    memberIdByDomain: async () => 'M1',
    validateFrame: async () => ({ userId: '7', isAdmin: true }),
    list: async () => [ROW],
    ...over
  }
}

function disconnectDeps(over: Partial<DisconnectDeps> = {}): DisconnectDeps {
  return {
    memberIdByDomain: async () => 'M1',
    validateFrame: async () => ({ userId: '7', isAdmin: true }),
    remove: async () => 'removed' as const,
    ...over
  }
}

function pauseDeps(over: Partial<PausePollDeps> = {}): PausePollDeps {
  return {
    memberIdByDomain: async () => 'M1',
    validateFrame: async () => ({ userId: '7', isAdmin: true }),
    setPaused: async () => 'updated' as const,
    ...over
  }
}

const input = { accessToken: 't', domain: 'p.bitrix24.by' }

describe('handleListBankAccounts', () => {
  it('returns the portal accounts without any token material or internal ids', async () => {
    const res = await handleListBankAccounts(listDeps(), input)
    expect(res.status).toBe(200)
    const accounts = res.body.accounts as Record<string, unknown>[]
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toEqual({
      id: 42,
      provider: 'alfa-by',
      accountKey: 'BY01ALFA0001',
      connectedAt: ROW.connectedAt,
      expiresAt: ROW.expiresAt,
      hasRefresh: true,
      consentExpiresAt: ROW.consentExpiresAt,
      // ⚠ `accountConfirmedAt` в браузер НЕ едет намеренно (#615): признак нужен серверу, чтобы
      // решить, можно ли объединять счёт с чужим, а интерфейсу он пока ничего не даёт. Появится
      // на экране — добавлять сюда осознанно, а не потому, что «поле есть в строке».
      pollPaused: false,
      // ⚠ Отметка последней ПОПЫТКИ обновления обязана доехать (#488). По ней экран отличает
      // «банк отказал» (помогает переподключение) от «продление ни разу не бралось за строку»
      // (переподключение вернёт зелёный ровно на один срок жизни токена и всё повторится).
      // Потеряй проекция это поле — пришло бы `undefined`, что читается как «не пробовали», и
      // экран советовал бы искать поломку у нас на исправном портале. Секрета в ней нет: это
      // время НАШЕЙ попытки, ни номера, ни токена.
      lastAttemptAt: ROW.lastAttemptAt,
      // ⚠ Грант ОБЯЗАН доехать до браузера (#23): по нему интерфейс решает, показывать ли «Добавить
      // счёт». Потеряй его проекция — поле пришло бы `undefined`, проверка `!== ''` дала бы истину,
      // и кнопка появилась бы ровно у тех подключений, которым сервер гарантированно откажет.
      grantId: 'g1'
    })
    // Отдельной строкой и на КОНКРЕТНОЕ значение: потеря поля по дороге беззвучна — сервер
    // продолжает хранить и считать дату, а предупреждения в интерфейсе просто нет.
    expect(accounts[0]!.consentExpiresAt).toBe(1_700_000_500_000)
    // То же и для отметки попытки: `undefined` здесь читался бы как «не пробовали», то есть
    // потеря поля не молчала бы, а ВРАЛА — и врала бы в сторону «чините свой сервер».
    expect(accounts[0]!.lastAttemptAt).toBe(ROW.lastAttemptAt)
    // memberId is an internal identifier — it must not be echoed to the browser.
    expect(JSON.stringify(res.body)).not.toContain('M1')
  })

  it('is 400 without frame auth, 409 for an unknown portal', async () => {
    expect((await handleListBankAccounts(listDeps(), { accessToken: '', domain: '' })).status).toBe(400)
    expect((await handleListBankAccounts(listDeps({ memberIdByDomain: async () => null }), input)).status).toBe(409)
  })

  it('is 403 when the frame token is not valid for that portal (domain spoofing)', async () => {
    const deps = listDeps({
      validateFrame: async () => {
        throw new Error('nope')
      }
    })
    expect((await handleListBankAccounts(deps, input)).status).toBe(403)
  })

  it('is 403 for a non-admin — and never reads the accounts', async () => {
    let read = false
    const deps = listDeps({
      validateFrame: async () => ({ userId: '9', isAdmin: false }),
      list: async () => {
        read = true
        return [ROW]
      }
    })
    expect((await handleListBankAccounts(deps, input)).status).toBe(403)
    expect(read).toBe(false)
  })

  it('answers with an empty list for a portal that connected nothing', async () => {
    const res = await handleListBankAccounts(listDeps({ list: async () => [] }), input)
    expect(res.status).toBe(200)
    expect(res.body.accounts).toEqual([])
  })
})

describe('classifyProvisionError', () => {
  it('recognises the SDK-shaped scope error, not just the machine code', () => {
    // The SDK surfaces getErrorMessages() only, so the usual text is the human description with
    // «higher privileges» and NO `insufficient_scope` — the branch must catch that shape (#408).
    for (const raw of [
      'insufficient_scope',
      'The request requires higher privileges than provided by the access token',
      'ACCESS DENIED: userfieldconfig.add'
    ]) {
      expect(classifyProvisionError(raw)).toContain('userfieldconfig')
    }
  })

  it('does NOT read a plain field conflict as «reinstall the app»', () => {
    // The method name alone must not trigger the scope advice — a duplicate fieldName also echoes
    // `userfieldconfig`, and sending the admin to reinstall would be actively wrong.
    const msg = classifyProvisionError('userfieldconfig: field with this name already exists')
    expect(msg).not.toContain('Переустановите')
  })

  it('separates rights, expired auth and network from the generic case', () => {
    expect(classifyProvisionError('ACCESS_DENIED')).toContain('администратор')
    expect(classifyProvisionError('expired_token')).toContain('авторизация')
    expect(classifyProvisionError('fetch failed')).toContain('не ответил вовремя')
    expect(classifyProvisionError('some unknown portal burp')).toContain('Повторите попытку')
  })

  it('never promises the admin a message they cannot see', () => {
    // The raw text goes to the server log only, so «пришлите этот текст» sent them hunting for
    // something that is not on screen.
    expect(classifyProvisionError('whatever')).not.toContain('этот текст')
  })
})

describe('handleDisconnectBankAccount', () => {
  const body = { ...input, id: 42, provider: 'alfa-by', accountKey: ' BY01ALFA0001 ' }

  describe('след в журнале: КТО оборвал связь с банком (#641)', () => {
    // ⚠ Асимметрия, которую этим чинят: ОБРАТИМАЯ пауза писала имя нажавшего, а НЕОБРАТИМОЕ
    // отключение не писало ничего. Живой разбор 2026-08-26 упёрся ровно в это — строк
    // `bank_tokens` не осталось, а кто их убрал, было неоткуда узнать.
    type Entry = { memberId: string, userId: string, provider: string, id: number }

    function withAudit(over: Partial<DisconnectDeps> = {}) {
      const seen: Entry[] = []
      const deps = disconnectDeps({ audit: (e: Entry) => seen.push(e), ...over })
      return { deps, seen }
    }

    it('состоявшееся удаление пишет портал, пользователя, банк и адрес строки', async () => {
      const { deps, seen } = withAudit()
      expect((await handleDisconnectBankAccount(deps, body)).status).toBe(200)
      expect(seen).toEqual([{ memberId: 'M1', userId: '7', provider: 'alfa-by', id: 42 }])
    })

    it('⚠ «строки уже нет» НЕ пишется — это двойной клик, связь оборвал кто-то другой', async () => {
      // Иначе журнал заполнится записями о несостоявшихся отключениях, и настоящую в нём не найдут
      // ровно тогда, когда придут искать.
      const { deps, seen } = withAudit({ remove: async () => 'gone' as const })
      expect((await handleDisconnectBankAccount(deps, body)).status).toBe(200)
      expect(seen, 'запись об отключении, которого не было').toEqual([])
    })

    it('⚠ «список устарел» тоже НЕ пишется — ничего не удалили', async () => {
      const { deps, seen } = withAudit({ remove: async () => 'stale' as const })
      expect((await handleDisconnectBankAccount(deps, body)).status).toBe(409)
      expect(seen).toEqual([])
    })

    it('⚠ отказ гейта не пишется и до удаления не доходит', async () => {
      // Запись о том, что не-админ «отключил», обвиняла бы невиновного.
      const { deps, seen } = withAudit({ validateFrame: async () => ({ userId: '9', isAdmin: false }) })
      expect((await handleDisconnectBankAccount(deps, body)).status).toBe(403)
      expect(seen).toEqual([])
    })

    it('⚠ ТЕКСТ записи проверяется на КАЖДОМ поле — иначе его можно сломать молча', () => {
      // Находка ревью тестировщика: пока строка собиралась шаблоном внутри проводки роута,
      // единственной её проверкой было `toContain('подключение ОТКЛЮЧЕНО пользователем')` по
      // исходнику. Мутация «поменять местами `${provider}` и `${id}`» проходила зелёной — то есть
      // сломать можно было ровно то, ради чего запись и делается.
      const line = bankDisconnectAuditLine({ memberId: 'M1', userId: '7', provider: 'alfa-by', id: 42 })
      expect(line).toContain('portal M1:')
      expect(line, 'банк и адрес строки перепутаны местами').toContain('alfa-by #42')
      expect(line).toContain('пользователем 7')
      expect(line, 'запись не говорит, что действие необратимо').toContain('необратимо')
      // ⚠ Номера счёта в записи быть не должно: лог живёт до вытеснения по объёму (#617).
      expect(line).not.toMatch(/BY\d{2}[A-Z]{4}/)
    })

    it('неизвестный пользователь не превращается в пустое место', () => {
      // `validateFrame` отдаёт пустую строку, когда портал не вернул `profile.ID`. Без фолбэка
      // строка обрывалась бы на «пользователем », и читатель решил бы, что запись битая.
      expect(bankDisconnectAuditLine({ memberId: 'M1', userId: '', provider: 'alfa-by', id: 42 }))
        .toContain('пользователем —')
    })

    it('журнал НЕОБЯЗАТЕЛЕН: без него отключение работает как прежде', async () => {
      // Диагностика не смеет быть условием работоспособности действия.
      const res = await handleDisconnectBankAccount(disconnectDeps(), body)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ removed: true })
    })
  })

  it('удаляет по НЕИЗМЕНЯЕМОМУ адресу, а не по номеру счёта', async () => {
    // ⚠ Номер МЕНЯЕТСЯ: выбор счёта переименовывает `~pending:`-ключ. Адресация по нему промахивалась
    // мимо строки и отвечала успехом, пока приложение продолжало ходить в банк клиента (#517).
    const seen: string[] = []
    const deps = disconnectDeps({
      remove: async (memberId, id, expected) => {
        seen.push(`${memberId}|${id}|${expected}`)
        return 'removed'
      }
    })
    const res = await handleDisconnectBankAccount(deps, body)
    expect(res.status).toBe(200)
    expect(res.body.removed).toBe(true)
    // memberId — из НАШЕГО поиска по домену, никогда из тела запроса.
    expect(seen).toEqual(['M1|42|BY01ALFA0001'])
  })

  it('409, если строка изменилась под пользователем — и это НЕ успех', async () => {
    // Ровно тот дефект: раньше такой клик отвечал `200 {removed:false}`, неотличимо от честного
    // «уже отключено», и человек считал, что отключил.
    const res = await handleDisconnectBankAccount(disconnectDeps({ remove: async () => 'stale' }), body)
    expect(res.status).toBe(409)
    expect(res.body.removed).toBeUndefined()
  })

  it('идемпотентность сохранена: строки нет — 200 {removed:false}, не ошибка', async () => {
    // Двойной клик и повтор из другой вкладки не должны выглядеть поломкой (#404).
    const res = await handleDisconnectBankAccount(disconnectDeps({ remove: async () => 'gone' }), body)
    expect(res.status).toBe(200)
    expect(res.body.removed).toBe(false)
  })

  it('отвергает пустой и кривой провайдер/адрес до обращения к хранилищу', async () => {
    let touched = false
    const deps = disconnectDeps({
      remove: async () => {
        touched = true
        return 'removed'
      }
    })
    expect((await handleDisconnectBankAccount(deps, { ...body, provider: '' })).status).toBe(400)
    expect((await handleDisconnectBankAccount(deps, { ...body, accountKey: '' })).status).toBe(400)
    expect((await handleDisconnectBankAccount(deps, { ...body, provider: 'evil-bank' })).status).toBe(400)
    // ⚠ Без адреса удалять нечего: молча взять «первую подходящую» строку было бы худшим исходом.
    expect((await handleDisconnectBankAccount(deps, { ...body, id: 0 })).status).toBe(400)
    expect((await handleDisconnectBankAccount(deps, { ...body, id: -1 })).status).toBe(400)
    expect((await handleDisconnectBankAccount(deps, { ...body, id: 1.5 })).status).toBe(400)
    expect((await handleDisconnectBankAccount(deps, { ...body, id: Number.NaN })).status).toBe(400)
    // ⚠ Сверхбольшое целое тоже 400, а не 500: `Number.isInteger(1e21)` истинно, но pg отдаст его
    // в bigint-параметр экспонентой («1e+21»), и Postgres ответит синтаксической ошибкой.
    expect((await handleDisconnectBankAccount(deps, { ...body, id: 1e21 })).status).toBe(400)
    expect((await handleDisconnectBankAccount(deps, { ...body, id: Number.POSITIVE_INFINITY })).status).toBe(400)
    expect(touched).toBe(false)
  })

  it('403 для не-админа — и ничего не удаляет', async () => {
    let touched = false
    const deps = disconnectDeps({
      validateFrame: async () => ({ userId: '9', isAdmin: false }),
      remove: async () => {
        touched = true
        return 'removed'
      }
    })
    expect((await handleDisconnectBankAccount(deps, body)).status).toBe(403)
    expect(touched).toBe(false)
  })
})

describe('#576 handlePauseBankPoll — пауза автоопроса', () => {
  const body = { ...input, id: 42, provider: 'alfa-by', accountKey: ' BY01ALFA0001 ', paused: true }

  it('ставит на паузу по НЕИЗМЕНЯЕМОМУ адресу, номер счёта — только ожидание', async () => {
    const seen: string[] = []
    const res = await handlePauseBankPoll(pauseDeps({
      setPaused: async (memberId, id, expected, paused) => {
        seen.push(`${memberId}|${id}|${expected}|${paused}`)
        return 'updated'
      }
    }), body)
    expect(res.status).toBe(200)
    expect(res.body.paused).toBe(true)
    // memberId — из НАШЕГО поиска по домену, никогда из тела запроса.
    expect(seen).toEqual(['M1|42|BY01ALFA0001|true'])
  })

  it('снимает паузу тем же вызовом', async () => {
    const res = await handlePauseBankPoll(pauseDeps(), { ...body, paused: false })
    expect(res.status).toBe(200)
    expect(res.body.paused).toBe(false)
  })

  it('409, если строка изменилась под пользователем', async () => {
    // За это время подключение могло стать другим — класть паузу вслепую нельзя.
    const res = await handlePauseBankPoll(pauseDeps({ setPaused: async () => 'stale' }), body)
    expect(res.status).toBe(409)
  })

  it('404, если строки нет — а НЕ идемпотентный успех', async () => {
    // ⚠ Отличие от «Отключить»: там «строки нет» и есть желаемый исход, здесь просили изменить
    // состояние строки, которой нет. Успех показал бы в интерфейсе паузу, которой в базе не
    // существует.
    const res = await handlePauseBankPoll(pauseDeps({ setPaused: async () => 'gone' }), body)
    expect(res.status).toBe(404)
  })

  it('`paused` обязан быть булевым — строка «false» это 400, а не тихое включение паузы', async () => {
    // ⚠ При мягком приведении `'false'` стало бы `true`: «возобновить» молча поставило бы на
    // паузу, и человек искал бы причину тишины в банке.
    let touched = false
    const deps = pauseDeps({
      setPaused: async () => {
        touched = true
        return 'updated'
      }
    })
    expect((await handlePauseBankPoll(deps, { ...body, paused: 'false' as unknown as boolean })).status).toBe(400)
    expect((await handlePauseBankPoll(deps, { ...body, paused: undefined as unknown as boolean })).status).toBe(400)
    expect(touched).toBe(false)
  })

  it('отвергает кривой провайдер/адрес до обращения к хранилищу', async () => {
    let touched = false
    const deps = pauseDeps({
      setPaused: async () => {
        touched = true
        return 'updated'
      }
    })
    expect((await handlePauseBankPoll(deps, { ...body, provider: 'evil-bank' })).status).toBe(400)
    expect((await handlePauseBankPoll(deps, { ...body, accountKey: '' })).status).toBe(400)
    expect((await handlePauseBankPoll(deps, { ...body, id: 0 })).status).toBe(400)
    // Сверхбольшое целое — 400, а не 500: pg отдал бы его в bigint экспонентой.
    expect((await handlePauseBankPoll(deps, { ...body, id: 1e21 })).status).toBe(400)
    expect(touched).toBe(false)
  })

  it('403 для не-админа — и ничего не меняет', async () => {
    // Банк привязан ко ВСЕМУ порталу: остановка импорта затрагивает всех сотрудников, а не того,
    // кто нажал.
    let touched = false
    const deps = pauseDeps({
      validateFrame: async () => ({ userId: '9', isAdmin: false }),
      setPaused: async () => {
        touched = true
        return 'updated'
      }
    })
    expect((await handlePauseBankPoll(deps, body)).status).toBe(403)
    expect(touched).toBe(false)
  })
})

describe('handleSetBankAccount', () => {
  const PENDING = provisionalAccountKey('n1')

  function deps(over: Partial<SetAccountDeps> = {}): SetAccountDeps {
    return {
      memberIdByDomain: async () => 'M1',
      validateFrame: async () => ({ userId: '7', isAdmin: true }),
      rename: async () => 'renamed',
      ...over
    }
  }
  const body = { ...input, provider: 'alfa-by', pendingKey: PENDING, accountKey: 'BY01ALFA0001' }

  it('назначает счёт подключению, которое ждало выбора', async () => {
    const seen: string[] = []
    const d = deps({
      rename: async (memberId, provider, from, to) => {
        seen.push(`${memberId}|${provider}|${from}|${to}`)
        return 'renamed'
      }
    })
    const res = await handleSetBankAccount(d, body)
    expect(res.status).toBe(200)
    // memberId берётся из проверенного домена, а не из тела запроса.
    expect(seen).toEqual([`M1|alfa-by|${PENDING}|BY01ALFA0001`])
  })

  it('НЕ даёт подменить счёт у живого подключения — только временный ключ', async () => {
    // Иначе это был бы способ увести операции чужого счёта на другой номер.
    let touched = false
    const d = deps({
      rename: async () => {
        touched = true
        return 'renamed'
      }
    })
    const res = await handleSetBankAccount(d, { ...body, pendingKey: 'BY01ALFA9999' })
    expect(res.status).toBe(400)
    expect(touched).toBe(false)
  })

  it('409, если такой счёт уже подключён — не затираем живой токен', async () => {
    const res = await handleSetBankAccount(deps({ rename: async () => 'conflict' }), body)
    expect(res.status).toBe(409)
  })

  it('404, если ожидающего подключения нет', async () => {
    const res = await handleSetBankAccount(deps({ rename: async () => 'not-found' }), body)
    expect(res.status).toBe(404)
  })

  it('503 «занято», когда строку держит обновление токена — и это НЕ 409', async () => {
    // ⚠ Разные смыслы, которые легко слить в один: 409 — «так не будет никогда» (номер занят,
    // нужен другой), 503 — «сейчас занято, через несколько секунд пройдёт» (#509). Слив приучил бы
    // либо повторять там, где повтор бесполезен, либо сдаваться там, где хватило бы второго клика.
    const res = await handleSetBankAccount(deps({ rename: async () => 'busy' }), body)
    expect(res.status).toBe(503)
    expect(res.status).not.toBe(409)
  })

  it('отвергает пустые и кривые значения до обращения к хранилищу', async () => {
    let touched = false
    const d = deps({
      rename: async () => {
        touched = true
        return 'renamed'
      }
    })
    expect((await handleSetBankAccount(d, { ...body, accountKey: '' })).status).toBe(400)
    expect((await handleSetBankAccount(d, { ...body, accountKey: 'BY 01/ALFA' })).status).toBe(400)
    expect((await handleSetBankAccount(d, { ...body, provider: 'evil' })).status).toBe(400)
    expect(touched).toBe(false)
  })

  it('403 не-админу — и ничего не переименовывает', async () => {
    let touched = false
    const d = deps({
      validateFrame: async () => ({ userId: '9', isAdmin: false }),
      rename: async () => {
        touched = true
        return 'renamed'
      }
    })
    expect((await handleSetBankAccount(d, body)).status).toBe(403)
    expect(touched).toBe(false)
  })
})

describe('handleAddBankAccount — второй счёт без повторного входа в банк (#23)', () => {
  function deps(over: Partial<AddAccountDeps> = {}): AddAccountDeps {
    return {
      memberIdByDomain: async () => 'M1',
      validateFrame: async () => ({ userId: '7', isAdmin: true }),
      add: async () => 'added',
      ...over
    }
  }
  const body = { ...input, id: 5, sourceAccountKey: 'BY01ALFA0001', accountKey: 'BY02ALFA0002' }

  it('добавляет счёт к существующему подключению', async () => {
    const seen: string[] = []
    const d = deps({
      add: async (memberId, sourceId, expected, accountKey) => {
        seen.push(`${memberId}|${sourceId}|${expected}|${accountKey}`)
        return 'added'
      }
    })
    expect((await handleAddBankAccount(d, body)).status).toBe(200)
    // memberId — из ПРОВЕРЕННОГО домена, а не из тела запроса.
    expect(seen).toEqual(['M1|5|BY01ALFA0001|BY02ALFA0002'])
  })

  it('403 не-админу — и ничего не пишет', async () => {
    // Банковский доступ портало-широкий: добавление счёта расширяет его, не спрашивая банк.
    let touched = false
    const d = deps({
      validateFrame: async () => ({ userId: '9', isAdmin: false }),
      add: async () => {
        touched = true
        return 'added'
      }
    })
    expect((await handleAddBankAccount(d, body)).status).toBe(403)
    expect(touched).toBe(false)
  })

  it('НЕЗАВЕРШЁННОЕ подключение — 409, а не обход `set-account`', async () => {
    // ⚠ У него самого счёт ещё не выбран. «Добавить второй» к строке без первого — это не
    // добавление, а способ завести настоящий номер мимо единственного маршрута, который умеет
    // превращать временный ключ в постоянный.
    let touched = false
    const d = deps({
      add: async () => {
        touched = true
        return 'added'
      }
    })
    const res = await handleAddBankAccount(d, { ...body, sourceAccountKey: provisionalAccountKey('n1') })
    expect(res.status).toBe(409)
    expect(touched).toBe(false)
  })

  it('кривой номер счёта отбраковывается ДО записи', async () => {
    let touched = false
    const d = deps({
      add: async () => {
        touched = true
        return 'added'
      }
    })
    for (const accountKey of ['', ' ', 'BY01 ALFA', 'BY01;DROP', 'ы'.repeat(3)]) {
      expect((await handleAddBankAccount(d, { ...body, accountKey })).status).toBe(400)
    }
    expect(touched).toBe(false)
  })

  it('исходы стора отображаются в РАЗНЫЕ коды — тупик и «повторите» не путаются', async () => {
    const codes: Record<string, number> = {
      conflict: 409, gone: 404, stale: 409, unmarked: 409, added: 200
    }
    for (const [outcome, status] of Object.entries(codes)) {
      const d = deps({ add: async () => outcome as 'added' })
      expect((await handleAddBankAccount(d, body)).status).toBe(status)
    }
  })

  it('подключение без гранта объясняет ПРИЧИНУ, а не «конфликт»', async () => {
    // ⚠ Скопировать токены такому подключению значило бы завести вторую строку с парой, которую
    // банк ротирует, — то есть своими руками сделать то, от чего грант защищает. Честный ответ —
    // переподключить, и человек должен это прочитать.
    const res = await handleAddBankAccount(deps({ add: async () => 'unmarked' }), body)
    expect(String(res.body.error)).toContain('reconnect')
  })
})
