import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { bankRefreshLockKey, isLockTimeout, PG_LOCK_TIMEOUT } from '../server/utils/bankRefreshLock'
import { BANK_REFRESH_LOCK_WAIT, DEFAULT_LOCK_WAIT, MIN_LOCK_WAIT } from '../server/utils/dbLock'
import { LISTABLE_PROVIDERS } from '../server/utils/bankAccountList'

// Лок, сериализующий двух писателей в одну строку `bank_tokens` (#509).
//
// Стороны две и они НЕ похожи друг на друга: обновление токена меняет секреты, а выбор счёта
// меняет `account_key` — то самое поле, по которому первая сторона находит свою строку. Общий у
// них только ключ лока, и именно он — единственное, что мешает им разъехаться. Поэтому здесь
// проверяется не столько сама функция (она в одну строку), сколько то, что её НИКТО НЕ ОБХОДИТ.

describe('bankRefreshLockKey', () => {
  it('различает портал, банк и счёт', () => {
    // Пер-портальный лок сериализовал бы независимые счета и растянул часовой скан на сумму
    // сетевых задержек; пер-банковский склеил бы два счёта одного банка.
    const base = bankRefreshLockKey('m1', 'alfa-by', 'BY01')
    expect(base).not.toBe(bankRefreshLockKey('m2', 'alfa-by', 'BY01'))
    expect(base).not.toBe(bankRefreshLockKey('m1', 'prior-by', 'BY01'))
    expect(base).not.toBe(bankRefreshLockKey('m1', 'alfa-by', 'BY02'))
  })

  it('устойчив: одинаковый вход — одинаковый ключ', () => {
    expect(bankRefreshLockKey('m1', 'alfa-by', '~pending:n1')).toBe(bankRefreshLockKey('m1', 'alfa-by', '~pending:n1'))
  })
})

describe('isLockTimeout', () => {
  it('узнаёт именно ожидание лока, а не любую ошибку БД', () => {
    // Спутать значит превратить настоящий сбой БД в бодрое «повторите через несколько секунд» —
    // человек будет жать кнопку, пока не надоест, а причина всё это время в другом месте.
    expect(isLockTimeout({ code: PG_LOCK_TIMEOUT })).toBe(true)
    expect(isLockTimeout({ code: '57014' })).toBe(false) // statement_timeout
    expect(isLockTimeout({ code: '23505' })).toBe(false) // unique_violation
    expect(isLockTimeout(new Error('connection lost'))).toBe(false)
    expect(isLockTimeout(null)).toBe(false)
    expect(isLockTimeout(undefined)).toBe(false)
  })
})

describe('ключ лока строится ТОЛЬКО хелпером', () => {
  it('каждый ПИСАТЕЛЬ в bank_tokens классифицирован явно', () => {
    // ⚠ Проверки ниже ловят НЕВЕРНО НАПИСАННЫЙ ключ, но не ловят ОТСУТСТВИЕ лока: писатель, который
    // просто не зовёт хелпер, для них невидим — он ничего не пишет неправильно, он молчит. А
    // писателей у строки больше двух, и третий уже существует: `saveBankToken` (OAuth-колбэк)
    // делает `INSERT … ON CONFLICT DO UPDATE` по тем же колонкам, что и обновление токена.
    //
    // Сегодня он безопасен: подключение всегда заводит НОВУЮ `~pending:`-строку (UI не передаёт
    // `accountKey`), поэтому конкурировать за живой ключ ему не с кем. Но серверный контракт
    // `accountKey` принимает, и первая же кнопка «переподключить именно этот счёт» сделает его
    // настоящим третьим писателем — с той же тихой потерей ротированного refresh.
    //
    // Поэтому список писателей ЗАКРЫТ: новый (или изменивший поведение) писатель роняет тест и
    // требует решения — берёт лок или объясняет, почему не должен. Это единственное место, где
    // такое решение вообще кто-то примет осознанно.
    const ROOT = join(import.meta.dirname, '..')
    const store = readFileSync(join(ROOT, 'server/utils/bankTokenStore.ts'), 'utf8')
    const writers = new Set<string>()
    for (const m of store.matchAll(/^export (?:async )?function (\w+)/gm)) {
      const start = m.index!
      const next = store.indexOf('\nexport ', start + 1)
      const body = store.slice(start, next < 0 ? undefined : next)
      if (/(?:INSERT INTO|UPDATE|DELETE FROM)\s+bank_tokens/.test(body)) writers.add(m[1]!)
    }

    // Каждому — своя причина. Менять список молча нельзя: это и есть решение.
    const CLASSIFIED: Record<string, string> = {
      // Под локом (`ensureBankToken`) — сериализован с переименованием.
      updateBankTokenSecrets: 'locked',
      // Под тем же локом (`makeLockedRename`) — меняет ключ, по которому ищет предыдущий.
      renameBankTokenAccount: 'locked',
      // ⚠ БЕЗ лока и пока безопасно: заводит новую `~pending:`-строку, за живой ключ не борется.
      // Появится «переподключить этот счёт» — обязан взять лок.
      saveBankToken: 'unlocked-creates-new-row',
      // ⚠ БЕЗ лока намеренно (#23). Исходная строка только ЧИТАЕТСЯ, а пишется НОВАЯ, за которую
      // пока никто не борется, — то есть спора за живую строку не возникает вовсе. Обновление
      // токена, идущее параллельно, запишет ротированную пару во все строки гранта: успевшую
      // вставиться нашу — включая, не успевшую — нет, и тогда она получает ту же пару, что видела
      // исходная (обе взяты одним чтением одной строки, разойтись не могут).
      // ⚠ Появится здесь UPDATE существующей строки — классификация обязана пересматриваться.
      // ⚠ ПОД ГРАНТОВЫМ ЛОКОМ (`makeLockedAddAccount`, находка ревью по гонкам). Первая версия шла
      // без лока, рассуждая, что исходная строка только читается. Рассуждение неверно при read
      // committed: `INSERT … SELECT` не блокируется на НЕЗАКОММИЧЕННОМ `UPDATE` обновления и читает
      // предыдущую версию строки, поэтому в окно между записью ротированной пары и её коммитом
      // новая строка получила бы refresh, который банк уже отозвал, — со штампом `now()`, то есть
      // выглядящий самым свежим в гранте. У банков со стандартной проверкой повторного
      // использования предъявление такого токена отзывает грант ЦЕЛИКОМ.
      addBankAccountToGrant: 'locked',
      // Удаление под локом не нуждается: строки не станет в любом порядке, и обновление это
      // увидит (UPDATE-only вернёт `false`) — ровно исход #505, он правильный.
      deleteBankToken: 'unlocked-delete-is-terminal',
      // ⚠ То же удаление, но адресованное неизменяемым `id` и со сверкой ключа (#517). Лок не нужен
      // по той же причине; сверка решает ДРУГУЮ задачу — не гонку за строку, а протухший список в
      // браузере, который лок не лечит в принципе.
      deleteBankTokenById: 'unlocked-delete-is-terminal',
      deleteBankTokensForPortal: 'unlocked-delete-is-terminal',
      // ⚠ БЕЗ лока намеренно (#576). Пишет ТОЛЬКО `poll_paused` — колонку, за которую обновление
      // токена не борется вовсе: оно меняет секреты, срок и `updated_at`, а эту не читает и не
      // пишет. Две параллельные UPDATE в одну строку сериализует сам Postgres построчной
      // блокировкой, и каждая пишет СВОИ колонки — терять тут нечего.
      // ⚠ Гонка с переименованием обработана не локом, а исходом: `account_key` в WHERE не совпадёт,
      // строк ноль, ответ `stale` — «список устарел, перезагрузите». Это и есть правильный ответ,
      // потому что за это время подключение могло стать другим, и класть паузу вслепую нельзя.
      // ⚠ Брать лок здесь было бы ВРЕДНО: держит его сетевой POST к банку (до 15 с), а на этом
      // конце человек, ткнувший переключатель. Тот же довод, что у `markBankRefreshAttempt`.
      // ⚠ Появится второе поле в этом UPDATE — классификация обязана пересматриваться.
      setBankPollPaused: 'unlocked-single-column',
      // ⚠ БЕЗ лока намеренно (#489). Пишет ТОЛЬКО `last_attempt_at` — метку «мы ходили в банк», и
      // ни одного поля, за которое борется обновление токена. Проигранная гонка здесь стоит одной
      // лишней попытки через шесть часов, а взятие лока — наоборот, дорого: отметка идёт ДО похода
      // в банк, то есть держала бы лок всё время сетевого запроса, ради значения, точность
      // которого никому не нужна.
      // ⚠ Появится второе поле в этом UPDATE — классификация обязана пересматриваться.
      markBankRefreshAttempt: 'unlocked-writes-only-the-attempt-stamp'
    }
    expect([...writers].sort()).toEqual(Object.keys(CLASSIFIED).sort())
  })

  it('ни один модуль не собирает строку `bankrefresh:` сам', () => {
    // ⚠ Ровно тот дефект, о котором предупреждает issue: разойдись стороны в написании ключа хоть
    // на символ — лок формально взят, а стороны не пересеклись. Ошибка невидима полностью: тесты
    // зелёные, ошибок нет, подключение умирает через сутки. Поэтому нарушение ловится структурно,
    // а не чтением ревью.
    const ROOT = join(import.meta.dirname, '..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name)
        if (entry.isDirectory()) walk(rel)
        else if (entry.name.endsWith('.ts')) {
          // Литерал ключа легален только в самом хелпере — там он и определён.
          if (rel === join('server', 'utils', 'bankRefreshLock.ts')) continue
          const text = readFileSync(join(ROOT, rel), 'utf8')
          for (const line of text.split('\n')) {
            // Интересует ПОСТРОЕНИЕ ключа, а не упоминание в комментарии: и хелпер, и оба
            // вызывающих объясняют правило словами, и наивный поиск по подстроке объявил бы
            // нарушителем объяснение.
            //
            // ⚠ Форм построения ДВЕ. Шаблонная строка — идиома репозитория, но конкатенация даёт
            // ТО ЖЕ значение, и функциональные тесты разницы не увидят по построению: ключ-то
            // совпал. То есть обход через `'bankrefresh:' + a` не ловился бы вообще ничем —
            // проверено мутацией (ревью тестировщика). Ловим обе.
            if (/`bankrefresh:\$\{/.test(line) || /['"]bankrefresh:['"]\s*\+/.test(line)) {
              offenders.push(`${rel}: ${line.trim().slice(0, 70)}`)
            }
          }
        }
      }
    }
    walk('server')
    walk('app')
    expect(offenders).toEqual([])
  })

  it('обе стороны ссылаются на хелпер ключа', () => {
    // Обратная проверка к предыдущей: без неё «нарушителей нет» достигалось бы и тем, что лок
    // перестали брать вовсе. Сторон ровно две — обновление секретов и смена ключа.
    //
    // ⚠ Это проверка ПРИСУТСТВИЯ идентификатора в файле, не поведения: обход, при котором импорт
    // остался, а `withLock` больше не зовётся, здесь не виден (проверено мутацией). Его ловит
    // поведенческий `tests/bankAccountRename.test.ts`. Название теста говорит ровно то, что он
    // делает, — обещать больше значит создать ложное чувство покрытия.
    const ROOT = join(import.meta.dirname, '..')
    for (const file of ['server/utils/ensureBankToken.ts', 'server/utils/bankAccountRename.ts']) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).toContain('bankRefreshLockKey')
    }
  })

  it('роут выбора счёта не ходит в хранилище мимо лока', () => {
    // Проводка — единственное место, где лок можно потерять целиком, не тронув ни одной из сторон:
    // достаточно вернуть в роут прямой вызов `renameBankTokenAccount(dbQuery, …)`, и всё снова
    // «работает», молча и до первой ротации refresh.
    const ROOT = join(import.meta.dirname, '..')
    const route = readFileSync(join(ROOT, 'server/api/bank/set-account.post.ts'), 'utf8')
    expect(route).toContain('makeLockedRename')
    expect(route).not.toMatch(/renameBankTokenAccount\s*\(\s*dbQuery/)
  })
})

/** Длительность Postgres (`2s`, `100ms`, `1min`) в миллисекундах — чтобы сравнивать ожидания
 *  величинами, а не строками. Хватает единиц, которыми мы реально пользуемся. */
function durationMs(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)$/.exec(raw.trim())
  if (!m) throw new Error(`не разобрал длительность: ${raw}`)
  const unit = { us: 0.001, ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'ms']
  return Number(m[1]) * unit
}

/** Ожидания лока, которые вызывающий может назвать по имени. Значения — из production, а не
 *  переписаны сюда: разъехавшись, копия проверяла бы саму себя. */
const KNOWN_WAITS: Record<string, number | undefined> = {
  BANK_REFRESH_LOCK_WAIT: durationMs(BANK_REFRESH_LOCK_WAIT),
  MIN_LOCK_WAIT: durationMs(MIN_LOCK_WAIT),
  DEFAULT_LOCK_WAIT: durationMs(DEFAULT_LOCK_WAIT)
}

describe('HTTP-маршруты не ждут лок по-машинному (#539)', () => {
  // ⚠ Проверяется СТРУКТУРНО, потому что дефект был именно структурным: `/api/bank/matrix` звал
  // `ensureBankToken` без указания ожидания и МОЛЧА унаследовал умолчание в 10 с — вчетверо
  // дольше двух уже починенных маршрутов. Поведенческий тест такого не ловит: маршрут работает,
  // просто занимает соединение из пула (пул — 10) ради шанса выиграть у держателя, который сам
  // ограничен 15 секундами. Новый маршрут повторил бы ошибку тем же способом.
  // ⚠ Обход РЕКУРСИВНЫЙ и по всему `server/api`, а не по одному каталогу: подкаталогов там сегодня
  // нет, но обещание «каждый HTTP-маршрут» плоским обходом не выполняется, и вложенный роут гард
  // обошёл бы МОЛЧА — тем же способом, каким появился сам дефект.
  //
  // ⚠ Честная граница гарда: он видит вызовы, написанные в самом файле роута. Маршрут, который
  // провяжет `ensureFresh` через модуль в `server/utils` (так делают `bankFetch`/`priorFetch`),
  // унаследует машинное умолчание, и текстом это не ловится. Поэтому у `ensureBankToken` умолчания
  // НЕТ вовсе — решение принимает вызывающий и обязано быть написано явно.
  it('каждый вызов ensureBankToken из HTTP-маршрутов задаёт lockWait', () => {
    const offenders: string[] = []
    for (const file of readdirSync(join(process.cwd(), 'server/api'), { recursive: true, encoding: 'utf8' })) {
      if (!file.endsWith('.ts')) continue
      const src = readFileSync(join(process.cwd(), 'server/api', file), 'utf8')
      // ⚠ Регулярка допускает ОДИН уровень вложенных скобок. Наивная `[^)]*` обрывается на первой
      // же закрывающей: у `ensureBankToken(token, bankDeps(), { lockWait: … })` она видит только
      // `…bankDeps()`, не находит `lockWait` и краснеет на ВЕРНОМ коде. Второй параметр — объект
      // зависимостей, то есть ровно то место, где фабричный вызов и появляется (`liveDeps` рядом
      // это показывает), а красный билд на верном коде учит ослаблять гард (замерено мутацией).
      for (const call of src.match(/ensureBankToken\((?:[^()]|\([^()]*\))*\)/g) ?? []) {
        // ⚠ Проверяем ВЕЛИЧИНУ ожидания, а не имя константы. Первая версия требовала дословно
        // `BANK_REFRESH_LOCK_WAIT` — и краснела на верном коде, подставившем другое человеческое
        // значение (тогда это был `SINGLE_FLIGHT_LOCK_WAIT`, 1 с — короче нашего, тот же класс
        // «человек ждёт»; сам он с тех пор ушёл вместе с локом провижининга, #538).
        // Красный билд на верном коде учит ослаблять гард, то есть такой гард сам себе враг
        // (замерено мутацией). Но и «параметр есть» проверять мало: явно вписанное машинное
        // умолчание проходит и не меняет ровно ничего — это дефект #539, произнесённый вслух.
        const wait = /lockWait:\s*'?([\w.]+)'?/.exec(call)?.[1]
        const ms = wait === undefined
          ? undefined
          : KNOWN_WAITS[wait] ?? (/^\d/.test(wait) ? durationMs(wait) : undefined)
        if (ms === undefined) offenders.push(`${file}: ожидание не задано или незнакомо — ${call}`)
        else if (ms >= durationMs(DEFAULT_LOCK_WAIT)) offenders.push(`${file}: ждёт по-машинному — ${call}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('человеческое ожидание КОРОЧЕ машинного умолчания, а не просто другое', () => {
    // ⚠ Проверка «не равно» слабее, чем кажется: `30s` — втрое дольше умолчания, то есть точная
    // противоположность замыслу («человеку быстро, машине долго») — проходила её зелёной
    // (замерено мутацией). Сравниваем ВЕЛИЧИНЫ.
    expect(durationMs(BANK_REFRESH_LOCK_WAIT)).toBeLessThan(durationMs(DEFAULT_LOCK_WAIT))
  })
})

describe('маршруты, ждущие этот лок, не могут выесть пул соединений', () => {
  // ⚠ Считаем ОДНОВРЕМЕННОСТЬ, а не темп. Первая версия этого гарда сверяла `burst` с размером
  // пула — и это было неверно дважды: `burst` одновременность не ограничивает вовсе (четыре
  // запроса висят разом при любом его значении, а держатель занимает соединение до 15 с при
  // пополнении ведра за 3 с), и понижение `burst` ломало исправный портал — зона `import` общая,
  // открытие настроек делает 6–8 запросов подряд. Настоящий потолок ставит `limit_conn`.
  //
  // ⚠ Это SMOKE-проверка, а не доказательство: из тех же 10 соединений одновременно черпают
  // readiness-проба, события установки и другие порталы. Она ловит грубое совпадение с размером
  // пула, а не гарантирует его достаточность.
  const ROOT = process.cwd()
  const nginx = readFileSync(join(ROOT, 'nginx.conf'), 'utf8')
  const poolMax = Number(/max:\s*(\d+)/.exec(readFileSync(join(ROOT, 'server/db/client.ts'), 'utf8'))?.[1])

  /** Директива внутри `location` — читаем ИМЕННО её, а не текст блока: соседний комментарий
   *  объясняет числа, и наивный поиск по подстроке вытащил бы число из объяснения. */
  function directive(location: string, name: string): string {
    const block = nginx.slice(nginx.indexOf(`location = ${location}`))
    return block.slice(0, block.indexOf('}'))
      .split('\n')
      .find(line => new RegExp(`^\\s*${name}\\s`).test(line)) ?? ''
  }

  // ⚠ Маршруты НАХОДИМ, а не перечисляем руками: список ровно так и отстаёт — новый маршрут,
  // берущий этот лок, попал бы в проверку выше (она обходит `server/api`) и не попал бы сюда,
  // тем же молчаливым способом, каким появился #539. Ищем оба входа в лок: обновление токена и
  // переименование ключа.
  const LOCK_ENTRIES = /ensureBankToken\(|renameBankTokenAccount\(|handleSetBankAccount\(/
  const lockRoutes = readdirSync(join(ROOT, 'server/api'), { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.ts'))
    .filter(f => LOCK_ENTRIES.test(readFileSync(join(ROOT, 'server/api', f), 'utf8')))
    // `bank/matrix.get.ts` → `/api/bank/matrix`
    .map(f => `/api/${f.replace(/\\/g, '/').replace(/\.(get|post|put|delete)?\.?ts$/, '')}`)

  it('находит маршруты, а не верит списку', () => {
    expect(lockRoutes).toContain('/api/bank/matrix')
    expect(lockRoutes).toContain('/api/bank/set-account')
  })

  it.each(['/api/bank/matrix'])('%s ограничивает одновременные запросы', (location) => {
    // Стоимость запроса — число провайдеров: банки спрашиваются параллельно, каждый берёт лок,
    // то есть своё соединение. Символ, а не литерал: третий банк ужесточит гард сам.
    const conn = Number(/limit_conn\s+\S+\s+(\d+)/.exec(directive(location, 'limit_conn'))?.[1])
    expect(conn).toBeGreaterThan(0)
    expect(conn * LISTABLE_PROVIDERS.length).toBeLessThan(poolMax)
  })

  it('троттл сверки не строже соседей — он срабатывает САМ, на открытии экрана', () => {
    // ⚠ Замерено: открытие настроек делает 6–8 запросов в ОБЩУЮ зону `import`. Порог ниже
    // соседних означал бы 429 на исправном портале при втором открытии подряд, а отказ здесь
    // убирает выбор IBAN кликом и возвращает к ручному вводу 28 знаков (#494).
    const burst = (loc: string) => Number(/burst=(\d+)/.exec(directive(loc, 'limit_req'))?.[1])
    expect(burst('/api/bank/matrix')).toBeGreaterThanOrEqual(burst('/api/bank/accounts'))
  })
})

describe('#23 при общем гранте лок берётся ПО ГРАНТУ, а не по счёту', () => {
  it('счета одного гранта получают ОДИН И ТОТ ЖЕ ключ лока', () => {
    // ⚠ Иначе лок не сериализует ничего: два счёта одного согласия взяли бы РАЗНЫЕ ключи, пошли бы
    // в банк параллельно, и второй потратил бы refresh, который первый уже сжёг ротацией. То есть
    // та самая тихая ночная смерть — но теперь при формально взятом локе, что хуже её отсутствия.
    const a = bankRefreshLockKey('M1', 'alfa-by', 'BY01', 'G1')
    const b = bankRefreshLockKey('M1', 'alfa-by', 'BY02', 'G1')
    expect(a).toBe(b)
  })

  it('разные гранты — разные ключи: независимые подключения не сериализуются', () => {
    expect(bankRefreshLockKey('M1', 'alfa-by', 'BY01', 'G1'))
      .not.toBe(bankRefreshLockKey('M1', 'alfa-by', 'BY01', 'G2'))
  })

  it('ПУСТОЙ грант оставляет прежний ключ по счёту — старые подключения не склеиваются', () => {
    // Пустая строка означает «не размечено», а не «общий грант»: общий лок на такие строки
    // сериализовал бы независимые подключения портала, растянув часовой скан на сумму задержек.
    expect(bankRefreshLockKey('M1', 'alfa-by', 'BY01', ''))
      .not.toBe(bankRefreshLockKey('M1', 'alfa-by', 'BY02', ''))
    expect(bankRefreshLockKey('M1', 'alfa-by', 'BY01', ''))
      .toBe(bankRefreshLockKey('M1', 'alfa-by', 'BY01'))
  })

  it('портал и банк остаются частью ключа при любом гранте', () => {
    expect(bankRefreshLockKey('M1', 'alfa-by', 'BY01', 'G1'))
      .not.toBe(bankRefreshLockKey('M2', 'alfa-by', 'BY01', 'G1'))
    expect(bankRefreshLockKey('M1', 'alfa-by', 'BY01', 'G1'))
      .not.toBe(bankRefreshLockKey('M1', 'prior-by', 'BY01', 'G1'))
  })
})

describe('#23 грант ДОЕЗЖАЕТ до лока на каждом маршруте, а не только объявлен', () => {
  // ⚠ Класс дефекта тот же, ради которого написан весь этот файл: ключ берётся добросовестно, но
  // «не тот». Чистые функции покрыты своими тестами; здесь проверяется ПРОВОДКА — что роут вообще
  // передаёт грант. Замерено: подмена `grantOf` на `async () => ''` выключала грантовый лок в
  // переименовании, и весь набор оставался зелёным.
  const api = join(process.cwd(), 'server/api/bank')

  it('set-account берёт грант из хранилища, а не пустую строку', () => {
    const src = readFileSync(join(api, 'set-account.post.ts'), 'utf8')
    expect(src).toMatch(/grantOf:/)
    expect(src).toMatch(/getBankGrantId\(/)
  })

  it('add-account берёт грант из хранилища и идёт под локом', () => {
    const src = readFileSync(join(api, 'add-account.post.ts'), 'utf8')
    expect(src).toMatch(/makeLockedAddAccount\(/)
    expect(src).toMatch(/getBankRowGrant\(/)
    expect(src).toMatch(/withLock:\s*withAdvisoryLock/)
  })

  it('свип брошенных подключений берёт лок ВМЕСТЕ с грантом', () => {
    // ⚠ Свип живёт в `server/utils`, поэтому проверки по `server/api/**` его не видят — а именно он
    // после появления гранта перестал пересекаться с обновлением: колбэк размечает грантом и
    // `~pending:`-строки, значит обновление берёт по ним ключ ВИДА ГРАНТА. Свип с ключом по счёту
    // перечитал бы до-рефрешную строку, счёл её брошенной и снёс подключение, которое прямо сейчас
    // доказало банку свою жизнеспособность.
    const src = readFileSync(join(process.cwd(), 'server/utils/pendingSweep.ts'), 'utf8')
    expect(src).toMatch(/bankRefreshLockKey\([^)]*grantId/)
  })
})
