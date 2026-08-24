import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { runBankKeepAlive } from '../server/utils/bankTokenKeepAlive'

// Гард диагностического скрипта опроса (#522).
//
// ⚠ Он ищет в логе конкретные маркеры, и маркеры эти живут в коде воркера. Разойдись они — скрипт
// продолжит «работать», показывая пустые секции, и пустота будет означать не «всё тихо», а
// «я больше не знаю, что искать». Это самый неприятный вид отказа диагностики: молчание, похожее
// на здоровье, ровно тогда, когда её открыли из-за подозрений.

const ROOT = join(import.meta.dirname, '..')
const POLL_CHECK_PATH = join(ROOT, 'scripts', 'prod-poll-check.sh')
const SCRIPT = readFileSync(POLL_CHECK_PATH, 'utf8')
const WORKER = readFileSync(join(ROOT, 'server/queue/worker.ts'), 'utf8')
const OBSERV = readFileSync(join(ROOT, 'server/queue/workerObservability.ts'), 'utf8')
const PLUGIN = readFileSync(join(ROOT, 'server/plugins/queue.ts'), 'utf8')
// ⚠ `[crm-sync]` строится НЕ в воркере: итоговая строка прогона живёт в чистом модуле политики
// логирования (#498), а воркер только печатает возвращённое. Тест это поймал — искал не там.
const OPLOG = readFileSync(join(ROOT, 'app/utils/opLogPolicy.ts'), 'utf8')

describe('диагностика опроса ищет маркеры, которые код действительно печатает (#522)', () => {
  it('исходники читаются', () => {
    expect(SCRIPT.length).toBeGreaterThan(500)
    expect(WORKER).toContain('useServerLogger(')
  })

  /**
   * Текст ВСЕХ команд `grep` в скрипте — и только их.
   *
   * ⚠ Мутационное ревью поймало здесь дыру: первая версия искала маркер в файле ЦЕЛИКОМ, а он есть
   * ещё и в заголовке секции («ПАДЕНИЯ задач [queue-job-failed]»). Поэтому переименование маркера
   * в самой команде `grep` тест проходил зелёным — то есть гард проверял оформление, а не поиск.
   */
  const grepLines = SCRIPT.split('\n').filter(l => /\bgrep\b/.test(l)).join('\n')

  it('регулярка выбирает именно команды grep', () => {
    // Без этого «маркер найден» достигалось бы и пустой выборкой.
    expect(grepLines).toContain('grep')
    expect(grepLines.split('\n').length).toBeGreaterThan(5)
    // Заголовки секций в выборку попасть не должны.
    expect(grepLines).not.toContain('section "')
  })

  it('каждый маркер ИЩЕТСЯ командой grep', () => {
    for (const marker of ['[fetch]', '[crm-sync]', '[op]', '[queue-job-failed]',
      '[queue-job-retry]', '[queue-worker-error]', 'real poll']) {
      // В grep скобки бывают экранированы (`\[queue-job-failed\]`) — сверяем по содержимому.
      expect(grepLines, `команды grep больше не ищут ${marker}`).toContain(marker.replace(/^\[|\]$/g, ''))
    }
  })

  it('каждый маркер ПЕЧАТАЕТСЯ кодом — теперь как КАНАЛ логгера', () => {
    // ⚠ После #529 маркер в исходнике больше не литерал в строке: его печатает канал
    // (`[{channel}] {level}: …`), то есть искать надо объявление канала. Смысл гарда не изменился —
    // переименуй канал «покрасивее», и скрипт молча начнёт искать то, чего больше нет.
    //
    // ⚠ Второе мутационное ревью поймало обратную дыру: сверка по маркеру БЕЗ скобок проходила,
    // потому что слово `fetch` встречается в `worker.ts` повсюду (`fetchQueueFor`, имена очередей,
    // комментарии). Поэтому здесь проверяется точная форма объявления канала, а не вхождение слова.
    for (const [channel, source] of [
      ['fetch', WORKER], ['op', WORKER], ['crm-sync', WORKER], ['queue', PLUGIN]
    ] as Array<[string, string]>) {
      expect(source, `код больше не заводит канал ${channel}`).toContain(`useServerLogger('${channel}')`)
    }
    // ⚠ `[queue] real poll` — маркер из ДВУХ частей: канал плюс начало сообщения. Скрипт ищет их
    // вместе, поэтому и проверяем обе половины, а не одну.
    expect(PLUGIN, 'сообщение `real poll` больше не печатается').toContain('log.info(`real poll:')
    // Текст итога прогона по-прежнему собирается чистым модулем политики — там маркера уже нет,
    // и это тоже часть контракта: второй `[crm-sync]` дал бы задвоенный префикс в строке.
    // ⚠ Комментарии вырезаем: маркер законно упоминается в объяснении рядом, и проверка по файлу
    // целиком краснела бы на верном коде (та же ловушка, что уже ловилась в #542).
    const oplogCode = OPLOG.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')
    expect(oplogCode, 'маркер вернулся в текст итога — будет задвоен каналом').not.toContain('[crm-sync]')
    // ⚠ Формы записи РАЗНЫЕ, и это не придирка: два тега выбираются тернарником и лежат в файле
    // строковыми литералами (`'queue-job-failed'`), а третий подставлен прямо в шаблон
    // (`[queue-worker-error] queue=…`). Проверка «только в кавычках» пропускала третий, проверка
    // «просто вхождение» ловила бы его же из комментария в шапке модуля.
    for (const tag of ['queue-job-failed', 'queue-job-retry', 'queue-worker-error']) {
      expect(OBSERV, `наблюдаемость больше не печатает ${tag}`).toMatch(new RegExp(`'${tag}'|\\[${tag}\\]`))
    }
  })

  it('строки планирования крона ИСКЛЮЧЕНЫ из широкого невода', () => {
    // ⚠ Причина, по которой скрипт вообще написан: строка планирования печатается каждые 5 минут и
    // содержит `prior-by`/`alfa-by`. Любой греп по названию банка тонет в ней, и `tail` показывает
    // только её — вытесняя ровно то, ради чего смотрели.
    expect(SCRIPT).toMatch(/grep -v 'real poll'/)
  })

  it('пустая секция подписана явно, а не оставлена пустой', () => {
    // Пустой вывод неотличим от оборвавшейся команды; в диагностике это недопустимо.
    expect(SCRIPT).toContain('(ничего)')
  })

  it('скрипт только ЧИТАЕТ — ничего не перезапускает и не правит', () => {
    // ⚠ Его будут запускать в момент подозрения на аварию. Диагностика, которая что-то меняет,
    // уничтожает состояние, которое пришли изучать.
    expect(SCRIPT).not.toMatch(/up -d|restart|down\b|rm -f|sed -i|printenv/)
    expect(SCRIPT).toMatch(/logs --since/)
  })
})

describe('тишина в продлении токенов читается как АВАРИЯ, а не как норма (#504)', () => {
  // ⚠ Подсказка в этой секции раньше утверждала обратное — «пусто здесь ХОРОШО, строка печатается
  // только при сбое». Это неверно: сводка прогона уходит в `deps.log` БЕЗУСЛОВНО на каждом
  // завершённом скане, раз в час. Значит пустая секция за окно длиннее часа означает «продление не
  // отработало ни разу» — ровно тот отказ, из-за которого подключение Альфы умирало за ночь.
  //
  // ⚠ Проверки здесь ВЫПОЛНЯЮТ код, а не грепают его текст, и это не педантизм. Первая редакция
  // грепала — и ревью прошло её насквозь двумя мутациями: ранний `return` перед сводкой и
  // оборачивающий `if` на соседней строке гасили тихий тик, оставляя саму строку нетронутой, а
  // тест зелёным. Ровно тот класс, который CLAUDE.md уже описывал про `shouldLogOperation`:
  // «текстовый гард такое не ловит принципиально». Второй раз наступать не будем.

  it('на ТИХОМ тике (обновлять нечего) сводка всё равно печатается', async () => {
    // Это и есть спорный случай: если молчать, когда нечего делать, то «пусто» снова становится
    // нормой, и отличить его от «таймер мёртв» станет нечем.
    const logged: string[] = []
    await runBankKeepAlive({
      now: () => 1_700_000_000_000,
      listAccounts: async () => [],
      getToken: async () => null,
      refresh: async t => t,
      log: (m: string) => logged.push(m)
    })
    expect(logged.some(l => l.startsWith('selected=')),
      'на тихом тике сводки нет — «пусто» снова неотличимо от мёртвого таймера').toBe(true)
    expect(logged.join('\n')).toContain('selected=0')
  })

  it('и на тике С работой — тоже (сводка одна на все исходы)', async () => {
    const logged: string[] = []
    const NOW = 1_700_000_000_000
    const acc = {
      id: 1, memberId: 'M1', provider: 'alfa-by' as const, accountKey: 'BY01',
      connectedAt: NOW - 9 * 3_600_000, expiresAt: NOW + 60_000,
      hasRefresh: true, lastAttemptAt: 0, consentExpiresAt: 0, pollPaused: false, grantId: ''
    }
    await runBankKeepAlive({
      now: () => NOW,
      listAccounts: async () => [acc],
      getToken: async () => ({
        memberId: 'M1', provider: 'alfa-by', accountKey: 'BY01',
        accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 60_000
      }),
      refresh: async t => t,
      log: (m: string) => logged.push(m)
    })
    const line = logged.find(l => l.startsWith('selected='))
    expect(line, 'сводки нет на рабочем тике').toBeTruthy()
    expect(line!).toMatch(/refreshed=\d+/)
  })

  it('скрипт предупреждает о пустоте, а не называет её нормой', () => {
    expect(SCRIPT, 'вернулась формулировка «пусто — хорошо»').not.toMatch(/Пусто здесь — ХОРОШО/)
    expect(SCRIPT, 'нет предупреждения про отсутствие прогонов').toMatch(/НИ ОДНОГО прогона/)
  })
})

describe('minutes_of разбирает окно ВЕРНО — проверяется исполнением, а не грепом (#504)', () => {
  // ⚠ Первая редакция проверяла `expect(SCRIPT).toContain('minutes_of')`. Ревью выпотрошило тело
  // функции до `echo "0"` — все тесты остались зелёными, а тревога перестала срабатывать когда бы
  // то ни было. Проверка имени функции — не проверка функции.
  const call = (window: string) => execFileSync('bash', ['-c',
    `source <(sed -n '/^minutes_of()/,/^}/p' "$1"); minutes_of "$2"`, '_', POLL_CHECK_PATH, window
  ], { encoding: 'utf8' }).trim()

  it.each([
    ['30m', '30'], ['3h', '180'], ['1h30m', '90'], ['90s', '1'], ['70m', '70'], ['2h30m', '150']
  ])('%s → %s мин', (w, want) => expect(call(w)).toBe(want))

  it('регистр не имеет значения — мобильный терминал капитализирует сам', () => {
    // ⚠ Живой дефект, найденный ревью: `2H` возвращала 0, и тревога о мёртвом продлении молча не
    // срабатывала — ровно в том сценарии (владелец с телефона), ради которого скрипт и написан.
    expect(call('2H')).toBe('120')
    expect(call('30M')).toBe('30')
  })

  it('мусор даёт 0, а не срыв', () => {
    for (const junk of ['', 'abc', 'm', '10']) expect(call(junk)).toBe('0')
  })

  it('суток нет — docker их не принимает, и обещать их значило бы звать в тупик', () => {
    // ⚠ `docker logs --since 3d` → «failed to parse value as time or duration». Ревью прогнало это
    // на живом демоне: при `3d` падают ВСЕ секции разом (каждый `docker compose logs` возвращает
    // ошибку), и эта — ещё и кричит о несуществующей аварии продления. Поэтому `d` не поддержан, а
    // окно проверяется ДО первого обращения к docker (см. следующий тест).
    expect(call('3d')).toBe('0')
  })

  it('скрипт отвергает окно, которое docker не примет, ДО первого обращения к нему', () => {
    // ⚠ Проверяется КОДОМ ВОЗВРАТА, а не текстом: скрипт обязан остановиться, а не «пожаловаться и
    // продолжить». Продолжив, он напечатал бы семь пустых секций и одну ложную тревогу.
    let code = 0
    let out: string
    try {
      out = execFileSync('bash', [POLL_CHECK_PATH, '3d'], { encoding: 'utf8', stdio: 'pipe' })
    } catch (e) {
      const err = e as { status?: number, stdout?: string }
      code = err.status ?? 0
      out = err.stdout ?? ''
    }
    expect(code, 'скрипт не остановился на окне, которое docker отвергнет').toBe(2)
    expect(out).toMatch(/3d/)
  })
})

describe('вердикт «КТО продлевает банк-токен» (#488/#489)', () => {
  // ⚠ Секция отвечает на вопрос, который из факта «подключение живёт» НЕ следует: токен обновляет и
  // крон продления, и сам опрос по дороге. Различает только сводка прогона — а значит скрипт
  // РАЗБИРАЕТ её формат, и разойдись они, вердикт молча станет «прогонов не было». То есть
  // диагностика соврала бы в сторону «продление не работает» ровно тогда, когда оно работает.

  /** Тот же конвейер, что в скрипте, — сюда подставляются НАСТОЯЩИЕ строки сводки. */
  function verdictCounts(logLines: string[]): { runs: number, selected: number, refreshed: number } {
    const out = execFileSync('sh', ['-c',
      `grep -F '[bank-keepalive]' | grep -oE 'selected=[0-9]+ refreshed=[0-9]+' `
      + `| awk -F'[= ]' '{sel+=$2; ref+=$4; n++} END {print (n?n:0), (sel?sel:0), (ref?ref:0)}'`
    ], { input: logLines.join('\n'), encoding: 'utf8' }).trim().split(/\s+/).map(Number)
    return { runs: out[0]!, selected: out[1]!, refreshed: out[2]! }
  }

  it('разбирает НАСТОЯЩУЮ строку сводки, а не выдуманную', async () => {
    // Строку берём у самого `runBankKeepAlive`: если он завтра переставит поля, тест упадёт здесь,
    // а не на проде тишиной в диагностике.
    const logged: string[] = []
    await runBankKeepAlive({
      now: () => 1_700_000_000_000,
      listAccounts: async () => [],
      getToken: async () => null,
      refresh: async t => t,
      log: (m: string) => logged.push(m)
    })
    const summary = logged.find(l => l.startsWith('selected='))
    expect(summary, 'сводки нет — вердикту не из чего строиться').toBeTruthy()
    // Канал добавляет реальный логгер; здесь дописываем его так же, как видит `docker compose logs`.
    const counts = verdictCounts([`[bank-keepalive] INFO: ${summary}`])
    expect(counts.runs, 'скрипт не распознал настоящую строку сводки').toBe(1)
  })

  it('«крон продлевал» и «крон ходил вхолостую» РАЗЛИЧАЮТСЯ — в этом вся ценность секции', () => {
    const worked = verdictCounts(['[bank-keepalive] INFO: selected=2 refreshed=2 skipped=0 failed=0 unrefreshable=0 expired=0'])
    expect(worked).toEqual({ runs: 1, selected: 2, refreshed: 2 })

    const idle = verdictCounts([
      '[bank-keepalive] INFO: selected=0 refreshed=0 skipped=0 failed=0 unrefreshable=0 expired=0',
      '[bank-keepalive] INFO: selected=0 refreshed=0 skipped=0 failed=0 unrefreshable=0 expired=0'
    ])
    // Крон отработал дважды и никого не отобрал ⇒ токен всё время свежий ⇒ держит его ОПРОС.
    expect(idle).toEqual({ runs: 2, selected: 0, refreshed: 0 })
  })

  it('чужие строки в счёт не идут', () => {
    expect(verdictCounts(['[queue] INFO: real poll: 2 accounts'])).toEqual({ runs: 0, selected: 0, refreshed: 0 })
  })

  it('скрипт действительно содержит эту секцию и оба вердикта', () => {
    // Иначе тест проверял бы конвейер, которого в скрипте нет.
    expect(SCRIPT).toContain('КТО продлевает банк-токен')
    expect(SCRIPT, 'вердикт «продлевает крон» пропал').toMatch(/продлевает КРОН/)
    expect(SCRIPT, 'вердикт «продлевает опрос» пропал').toMatch(/продлевает ОПРОС/)
  })
})
