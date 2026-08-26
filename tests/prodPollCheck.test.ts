import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { runBankKeepAlive } from '../server/utils/bankTokenKeepAlive'
import { runSummaryLine } from '../app/utils/opLogPolicy'

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
      hasRefresh: true, lastAttemptAt: 0, consentExpiresAt: 0, accountConfirmedAt: 0, pollPaused: false, grantId: ''
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

describe('воронка платежа (#501)', () => {
  // ⚠ Секция РАЗБИРАЕТ итоговую строку `[crm-sync]`, а не считает строки лога. Первая редакция
  // считала маркеры и печатала «[fetch] 15 → [op] 4» как воронку — а это несравнимые величины:
  // `[fetch]` пишется на каждый опрос (по три строки), `[op]` — только на НЕ приземлившиеся
  // операции. Живой прогон 2026-08-24 дал «15 → 4» при 296 реально обработанных, то есть цифры
  // врали на два порядка. Теперь берём числа, которые приложение посчитало само.

  /** Настоящая итоговая строка — тем же билдером, что печатает воркер. */
  // ⚠ БЕЗ каста: он скрывал бы несовпадение формы, а именно от расхождения формы этот гард и стоит.
  const REAL_SUMMARY = runSummaryLine('M1', {
    processed: 296, created: 3, landed: 0, unmatched: 3, unresolved: 0, recognized: 0,
    skipped: 293, excluded: 0
  }, 'notable')

  /** Тот же конвейер извлечения поля, что в скрипте. */
  function field(line: string, name: string): number {
    const out = execFileSync('sh', ['-c',
      `grep -oE "[0-9]+ ${name}" | grep -oE '^[0-9]+' | tail -1`
    ], { input: line, encoding: 'utf8' }).trim()
    return Number(out || NaN)
  }

  it('КАЖДОЕ поле воронки читается из НАСТОЯЩЕЙ строки итога', () => {
    // ⚠ Это и есть гард дрейфа: переименуй воркер поле — и скрипт молча покажет нули, то есть
    // объявит обрыв там, где его нет. Строка берётся у `runSummaryLine`, а не выдумывается.
    expect(field(REAL_SUMMARY, 'обработано')).toBe(296)
    expect(field(REAL_SUMMARY, 'создано')).toBe(3)
    expect(field(REAL_SUMMARY, 'приземлилось')).toBe(0)
    expect(field(REAL_SUMMARY, 'без клиента')).toBe(3)
    expect(field(REAL_SUMMARY, 'без цели')).toBe(0)
    expect(field(REAL_SUMMARY, 'с распознанным номером')).toBe(0)
  })

  it('скрипт извлекает ровно эти поля, а не какие-то свои', () => {
    for (const f of ['обработано', 'создано', 'приземлилось', 'без клиента', 'без цели', 'с распознанным номером']) {
      expect(SCRIPT, `воронка перестала читать поле «${f}»`).toContain(`fld '${f}'`)
    }
  })

  const printed = SCRIPT.split('\n').filter(l => /^\s*printf /.test(l)).join('\n')

  it('«клиент не опознан» объясняется как НЕ поломка распознавания', () => {
    // Самый вероятный неверный ход: тянет крутить карту распознавания, а чинится реквизитом в CRM.
    expect(printed).toMatch(/КЛИЕНТ не опознан/)
    expect(printed, 'оператору не сказано, почему поиск цели не запускался').toMatch(/company-скоуп|IDOR/)
    expect(printed, 'оператору не сказано, чем это лечится').toMatch(/реквизит/i)
  })

  it('распознавание и клиент — ДВА независимых предусловия, о обоих говорится', () => {
    // ⚠ Живой прогон поймал прежнюю редакцию: она выбирала одно «место обрыва» и молчала о втором,
    // хотя не выполнены были ОБА. Приземление требует и распознанного номера, и найденного клиента.
    expect(printed).toMatch(/НОМЕР не распознан/)
    expect(printed).toMatch(/КЛИЕНТ не опознан/)
  })

  it('про пустые матрицы больше не утверждается как о факте', () => {
    // Прежняя редакция писала «Пустые матрицы = распознавать нечем», хотя причина может быть и в
    // том, что номеров в назначениях просто нет. Утверждать первое — отправлять крутить настройки.
    expect(printed).not.toMatch(/Пустые матрицы/)
    expect(printed, 'не названа вторая возможная причина').toMatch(/номеров действительно нет|номеров в назначениях/i)
  })
})

describe('вердикт «КТО продлевает» не имеет права соврать (живой прогон 2026-08-26)', () => {
  // ⚠ Это исправление ПО ФАКТУ ЛЖИ, а не по подозрению. Владелец прислал прогон, где `[fetch]` был
  // пуст ЦЕЛИКОМ — то есть за окно не случилось ни одного опроса, — а скрипт уверенно ответил
  // «продлевает ОПРОС, а не крон». Вывод делался из `selected=0`, то есть из ОТСУТСТВИЯ работы у
  // крона, и ничем не подкреплялся. Диагностика прозвучала успокаивающе ровно там, где не работало
  // вообще ничего, и увела разбор на день.

  it('«продлевает ОПРОС» произносится ТОЛЬКО при доказанном опросе', () => {
    // Ветка обязана требовать `fetch_n > 0`. Без этого условия она снова начнёт выводить работу
    // опроса из его отсутствия.
    const branch = SCRIPT.split('\n').find(l => l.includes('"${sel:-0}" -eq 0')
      && l.includes('fetch_n'))
    expect(branch, 'ветка «продлевает ОПРОС» не сверяется с числом [fetch]').toBeTruthy()
    expect(branch).toContain('-gt 0')
  })

  it('счётчик [fetch] реально считается, а не берётся из воздуха', () => {
    expect(SCRIPT).toMatch(/fetch_n="\$\(\$DC logs .*grep -cF '\[fetch\]'/)
  })

  it('при пустом [fetch] ответ — «НИКТО», и он называет обе причины', () => {
    expect(SCRIPT).toContain('токен не продлевал НИКТО')
    // Обе проверяемые причины обязаны быть названы: без них ответ верен, но бесполезен.
    expect(SCRIPT).toContain('CRON_REAL_POLL=0')
    expect(SCRIPT).toMatch(/подключённых счетов нет/)
  })

  /**
   * Прогнать САМ блок вердикта из скрипта с подставленными числами.
   *
   * ⚠ Текстовых проверок тут мало, и это доказано мутацией: замена условия покрытия на `if false`
   * прошла зелёной — порядок строк в файле от этого не меняется. Берём блок ИЗ ФАЙЛА и исполняем,
   * как это делает гард отчёта по плательщикам.
   */
  interface VerdictInput {
    runs: number
    sel: number
    ref: number
    fail?: number
    expd: number
    unref: number
    fetch_n: number
    sinceMin: number
  }

  function verdict(v: VerdictInput): string {
    const from = SCRIPT.indexOf('# ⚠ ПОКРЫТИЕ ОКНА')
    const to = SCRIPT.indexOf('section "ВОРОНКА платежа')
    expect(from, 'блок вердикта не найден — его переписали').toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
    const block = SCRIPT.slice(from, to)
    const prelude = `minutes_of() { echo ${v.sinceMin}; }\n`
      + `SINCE=w; runs=${v.runs}; sel=${v.sel}; ref=${v.ref}; fail=${v.fail ?? 0}\n`
      + `expd=${v.expd}; unref=${v.unref}; fetch_n=${v.fetch_n}\n`
    return execFileSync('bash', ['-c', prelude + block], { encoding: 'utf8' })
  }

  it('ПОВЕДЕНЧЕСКИ: пустой [fetch] при нулевом отборе даёт «НИКТО», а не «ОПРОС»', () => {
    // Ровно вход владельца: сутки, один прогон продления... но окно не покрыто, поэтому сперва
    // берём покрытое окно, чтобы проверить именно эту развилку.
    const out = verdict({ runs: 24, sel: 0, ref: 0, expd: 0, unref: 0, fetch_n: 0, sinceMin: 1440 })
    expect(out).toContain('не продлевал НИКТО')
    expect(out).not.toContain('продлевает ОПРОС')
  })

  it('ПОВЕДЕНЧЕСКИ: живой опрос при нулевом отборе — по-прежнему «ОПРОС»', () => {
    const out = verdict({ runs: 24, sel: 0, ref: 0, expd: 0, unref: 0, fetch_n: 12, sinceMin: 1440 })
    expect(out).toContain('продлевает ОПРОС')
    expect(out).not.toContain('не продлевал НИКТО')
  })

  it('ПОВЕДЕНЧЕСКИ: непокрытое окно ГАСИТ любой вердикт', () => {
    // Вход владельца дословно: SINCE=24h, прогонов 1 — контейнер пересоздавали.
    const out = verdict({ runs: 1, sel: 0, ref: 0, expd: 0, unref: 0, fetch_n: 0, sinceMin: 1440 })
    expect(out).toContain('ВЕРДИКТА НЕТ')
    expect(out).not.toContain('продлевает ОПРОС')
    expect(out).not.toContain('не продлевал НИКТО')
    expect(out).not.toContain('продлевает КРОН')
  })

  it('ПОВЕДЕНЧЕСКИ: успешное продление называется кроном', () => {
    const out = verdict({ runs: 24, sel: 3, ref: 3, expd: 0, unref: 0, fetch_n: 0, sinceMin: 1440 })
    expect(out).toContain('продлевает КРОН')
  })

  it('короткое окно вердикт НЕ гасит — там мало прогонов по построению', () => {
    // При SINCE=1h ожидается один прогон, и «один» не значит «логи потеряли».
    const out = verdict({ runs: 1, sel: 0, ref: 0, expd: 0, unref: 0, fetch_n: 5, sinceMin: 60 })
    expect(out).not.toContain('ВЕРДИКТА НЕТ')
    expect(out).toContain('продлевает ОПРОС')
  })

  it('⚠ покрытие окна проверяется ДО вердикта, а не после', () => {
    // Прежде оговорка «бэкенд перезапускали» печаталась строкой НИЖЕ вердикта — то есть после
    // того, как читатель уже принял ответ. На окне в минуты `selected=0` не значит ничего.
    const verdictAt = SCRIPT.indexOf('ВЕРДИКТА НЕТ')
    const cronAnswerAt = SCRIPT.indexOf('продлевает КРОН')
    expect(verdictAt, 'проверка покрытия исчезла').toBeGreaterThan(0)
    expect(verdictAt, 'проверка покрытия должна стоять раньше любого вердикта').toBeLessThan(cronAnswerAt)
  })

  it('покрытие считается от ожидаемого числа прогонов, а не от порога «меньше двух»', () => {
    // Продление ежечасное: за окно N часов прогонов должно быть ~N. Прежний порог «меньше 2»
    // молчал бы про сутки с тремя прогонами — а это тоже потерянные логи.
    expect(SCRIPT).toContain('expected_runs=')
    expect(SCRIPT).toMatch(/minutes_of "\$SINCE"\) \/ 60/)
  })
})
