import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LogLevel } from '@bitrix24/b24jssdk'
import { resolveLogLevel, ServerLineFormatter, SERVER_LOG_CHANNELS } from '../server/utils/serverLogger'

// Гард серверного логгера (#529).
//
// ⚠ Канал — не украшение, а СТРОКА ПОИСКА. По ней грепает `scripts/prod-doctor.sh`, её цитирует
// `docs/OPERATIONS.md`, и именно её человек вбивает в `docker logs | grep`, когда что-то случилось.
// Переименование «покрасивее» ничего не ломает на вид: приложение работает, тесты зелёные, а
// рантбук молча перестаёт находить — то есть отказ диагностики, похожий на тишину.
const ROOT = join(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

/** Все `.ts` сервера — обход рекурсивный: гард, ограниченный одним каталогом, пропустил бы файл в
 *  подпапке, а именно так дыры и заводятся (замерено на #542). */
function serverSources(): string[] {
  return readdirSync(join(ROOT, 'server'), { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.ts'))
    // ⚠ Сам модуль логгера ИСКЛЮЧЁН, и это несущее решение: в нём лежит список каналов, то есть
    // литерал `'fetch',` объявлял бы канал «живым» сам по себе — и проверка «маркер ещё
    // печатается» проходила бы для канала, которого никто не использует. Замерено мутацией
    // (#529): переименование канала везде оставляло гард зелёным.
    .filter(f => !f.endsWith('serverLogger.ts'))
    .map(f => read(join('server', f)))
}

/** Код без комментариев, но СО строками: маркер, если он вернётся, будет жить именно в строковом
 *  литерале, поэтому вырезать строки здесь нельзя. */
function codeOnlyKeepStrings(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/** Код без комментариев и строковых литералов — чтобы гарды искали ВЫЗОВЫ, а не упоминания.
 *  ⚠ Построчная эвристика «строка начинается со слэш-слэш» этого не даёт: она пропускает реальный вызов с хвостовым
 *  комментарием (`console.error(x) // TODO`) и краснеет на упоминании внутри JSDoc — обе ошибки
 *  замерены мутацией. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, '\'\'')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

describe('каналы логгера = маркеры, по которым ищут', () => {
  const sources = serverSources()
  const used = new Set(
    sources.flatMap(src => [...codeOnly(src).matchAll(/useServerLogger\(\s*''\s*\)/g)].map(() => ''))
      .concat(sources.flatMap(src => [...src.matchAll(/useServerLogger\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]!)))
      .filter(Boolean)
  )

  it('каждый использованный канал объявлен в закрытом списке', () => {
    // Канал мимо списка = маркер в логе, которого никто не ищет.
    for (const chan of used) {
      expect(SERVER_LOG_CHANNELS as readonly string[], `канал «${chan}» не объявлен`).toContain(chan)
    }
  })

  it('маркеры, которые грепает prod-doctor.sh, существуют как каналы', () => {
    // ⚠ Скрипт ищет `\[env\]|\[auth\]|\[queue-job-failed\].*FINAL`. Первые два — каналы; третий
    // печатает `workerObservability` строкой в сообщении, поэтому он проверяется отдельно ниже.
    const doctor = read('scripts/prod-doctor.sh')
    for (const marker of ['env', 'auth']) {
      expect(doctor, `prod-doctor больше не ищет [${marker}]`).toContain(`\\[${marker}\\]`)
      expect(used, `канал ${marker} исчез — prod-doctor будет искать пустоту`).toContain(marker)
    }
    // ⚠ Третий маркер — не канал, а тег внутри сообщения (`workerObservability` выбирает его по
    // исходу падения). Комментарий прежней версии обещал «проверяется ниже», а ниже его не было.
    expect(doctor, 'prod-doctor больше не ищет падения задач').toContain('\\[queue-job-failed\\]')
    // ⚠ Именно `codeOnlyKeepStrings`: тег живёт в строковом литерале, и вариант, вырезающий
    // строки, искал бы его там, где его быть не может.
    expect(codeOnlyKeepStrings(read('server/queue/workerObservability.ts')))
      .toMatch(/queue-job-failed/)
  })

  it('маркеры из рантбука существуют как каналы', () => {
    // ⚠ Список берётся из САМОГО рантбука, а не переписан сюда руками: копия разошлась бы с ним
    // молча, и гард охранял бы собственную копию вместо документа, который читает оператор.
    const runbook = read('docs/OPERATIONS.md')
    const printedLiterally = sources.join('\n')
    // ⚠ Маркер может печататься ДВУМЯ способами, и гард обязан знать оба: каналом (`[fetch]`) или
    // литералом внутри сообщения (`queue-job-failed` — тег выбирается по исходу падения). Первая
    // версия этого гарда знала только первый способ и краснела на верном коде — ровно то ложное
    // срабатывание, от которого гард потом и ослабляют.
    // ⚠ Собирать маркеры ТЕМ ЖЕ предикатом, которым потом проверяем, — тавтология: исчезнувший
    // маркер отсеивался бы на сборе и до ассерта не доходил, то есть гард охранял бы сам себя
    // (поймано ревью #529). Поэтому фильтр здесь ровно один и синтаксический: markdown-ссылка
    // `[текст](url)` маркером не является — её и отсекаем по следующей скобке.
    // ⚠ ИСКЛЮЧЕНИЕ, а не фильтр: `crypto-gw` — лог ЧУЖОГО сервиса (образ крипто-шлюза из
    // отдельного репозитория), наш код его не печатает и печатать не должен. Это решение, поэтому
    // оно названо здесь списком из одного имени, а не спрятано в предикате «оставим только то, что
    // и так печатается» — такой предикат сделал бы гард тавтологией (замерено мутацией).
    const FOREIGN = new Set(['crypto-gw'])
    const cited = new Set(
      [...runbook.matchAll(/\[([a-z][a-z-]{2,})\](?!\()/g)].map(m => m[1]!)
        // Имена файлов и якорей в скобках тоже встречаются — берём только те, что похожи на
        // маркер лога: одно слово без точек и слэшей.
        .filter(name => !name.includes('.') && !name.includes('/'))
        .filter(name => !FOREIGN.has(name))
    )
    expect(cited.size, 'рантбук перестал цитировать маркеры — проверьте разбор').toBeGreaterThan(3)
    for (const marker of cited) {
      const alive = used.has(marker)
        || printedLiterally.includes(`'${marker}'`)
        || printedLiterally.includes(`[${marker}]`)
      expect(alive, `рантбук цитирует [${marker}], но код его больше не печатает`).toBe(true)
    }
  })

  it('в server/** не осталось прямых console.* — иначе часть логов мимо каналов и уровней', () => {
    // ⚠ Смысл не в чистоте: строка через `console.*` не проходит ни фильтр уровня, ни процессоры,
    // то есть `LOG_LEVEL` на неё не действует, а маскировка ПДн — тем более.
    // ⚠ Методов больше четырёх: `console.debug`/`trace`/`dir`/`table` пишут в тот же поток мимо
    // уровней и каналов, и первая версия гарда их не видела (замерено мутацией).
    const offenders = sources.filter(src =>
      /console\.(log|info|warn|error|debug|trace|dir|table)\s*\(/.test(codeOnly(src))
    )
    expect(offenders).toHaveLength(0)
  })
})

describe('шаблоны диагностических скриптов находят РЕАЛЬНУЮ строку (#529)', () => {
  // ⚠ Тест, которого не хватало. Прежний гард проверял канал и текст ПОРОЗНЬ — и потому пропустил
  // настоящую поломку: `grep -F '[queue] real poll'` перестал находить, потому что между каналом и
  // текстом встал уровень (`[queue] INFO: real poll:`). Проверка половин по определению не может
  // поймать разрыв МЕЖДУ ними, а скрипт ищет их вместе.
  //
  // Поэтому здесь строка рендерится НАСТОЯЩИМ форматтером, а шаблоны берутся из САМИХ скриптов —
  // не переписанные сюда копии, которые разошлись бы молча.
  const render = (channel: string, level: string, message: string) =>
    new ServerLineFormatter().format({
      channel, levelName: level, message, level: 200, context: {}, extra: {}, timestamp: new Date()
    } as never)

  /** Шаблон `grep` из скрипта → строка, которую он обязан найти. */
  const CASES: Array<{ script: string, needle: string, line: string }> = [
    { script: 'scripts/prod-poll-check.sh', needle: 'real poll', line: render('queue', 'INFO', 'real poll: planned 2 fetch jobs') },
    { script: 'scripts/prod-poll-check.sh', needle: '[fetch]', line: render('fetch', 'INFO', 'alfa-by BY13 2026-08-20..2026-08-21: 3 ops') },
    { script: 'scripts/prod-poll-check.sh', needle: '[crm-sync]', line: render('crm-sync', 'INFO', 'portal M1: 117 обработано') },
    { script: 'scripts/prod-poll-check.sh', needle: '[op]', line: render('op', 'INFO', 'portal M1, op d1: credit') },
    { script: 'scripts/prod-doctor.sh', needle: '[env]', line: render('env', 'ERROR', 'B24_TOKEN_ENC_KEY отсутствует') },
    { script: 'scripts/prod-doctor.sh', needle: '[auth]', line: render('auth', 'WARNING', 'OPERATOR_PASSWORD пуст — вход выключен') }
  ]

  it.each(CASES)('$script: «$needle» находит строку', ({ script, needle, line }) => {
    const src = read(script)
    // ⚠ Строки с `grep -v` ОТБРАСЫВАЕМ: это исключающий фильтр, а не поиск. Замерено мутацией —
    // без этого гард цеплялся за соседний `grep -v 'real poll'`, тот совпадал с отрендеренной
    // строкой, и настоящая поломка поиска (`-F '[queue] real poll'` против `[queue] INFO: real
    // poll`) проходила зелёной. То есть сквозной тест проверял не тот шаблон.
    const patterns = src.split('\n')
      .filter(l => /\bgrep\b/.test(l) && !/\bgrep\s+(?:-\w+\s+)*-v\b|\bgrep\s+-v\b/.test(l))
      .flatMap(l => [...l.matchAll(/grep\s+(?:-\w+\s+)*'([^']+)'/g)].map(m => m[1]!))
      .filter(p => p.includes(needle.replace(/[[\]]/g, '')))
    expect(patterns.length, `${script} больше не ищет ${needle}`).toBeGreaterThan(0)
    // ⚠ И ГЛАВНОЕ: КАЖДЫЙ такой шаблон обязан совпасть с реально отрендеренной строкой. Именно
    // «каждый», а не «хотя бы один»: иначе достаточно одного случайно подходящего рядом.
    for (const pattern of patterns) {
      expect(new RegExp(pattern).test(line), `${script}: «${pattern}» не находит «${line}»`).toBe(true)
    }
  })
})

describe('маркер не задваивается', () => {
  // ⚠ Мутация «вернуть литерал `[op] ` в билдер» проходила ВСЕМИ прежними гардами: `opLogWiring`
  // смотрит только тело воркера, а текст живёт в `opLogLine.ts` — ровно там, куда его и вернули
  // бы. Печаталось бы `[op] INFO: [op] portal …`, то есть строка с двумя одинаковыми префиксами.
  const CHANNEL_MARKERS = SERVER_LOG_CHANNELS.map(c => `[${c}]`)
  const FILES = [
    'server/utils/opLogLine.ts', 'app/utils/opLogPolicy.ts',
    'server/utils/bankTokenKeepAlive.ts', 'server/utils/bankConnectCallback.ts',
    'server/utils/bankConnectStart.ts', 'server/utils/queueHealthTick.ts',
    'server/utils/workerBeat.ts', 'server/utils/keepAliveTick.ts'
  ]

  it.each(FILES)('%s не печатает маркер канала в тексте сообщения', (file) => {
    const code = codeOnlyKeepStrings(read(file))
    for (const marker of CHANNEL_MARKERS) {
      expect(code, `${file} печатает ${marker} — канал добавит второй такой же`).not.toContain(marker)
    }
  })
})

describe('уровень логирования', () => {
  it('умолчание в проде — INFO, а не ERROR', () => {
    // ⚠ Дефолт фабрики SDK — ERROR, и он тут был бы прямым вредом: `OPERATIONS.md` велит читать
    // `[fetch]` и итог `[crm-sync]`, а это ИНФОРМАЦИОННЫЕ строки. «В проде только ошибки» унесло бы
    // ровно ту диагностику, ради которой рантбук написан.
    expect(resolveLogLevel(undefined)).toBe(LogLevel.INFO)
    expect(resolveLogLevel('')).toBe(LogLevel.INFO)
  })

  it('опечатка в переменной не выключает диагностику', () => {
    // Тихий уход в ERROR был бы худшим исходом: строки пропали, а причину никто не связал бы с
    // опечаткой в env.
    expect(resolveLogLevel('INFORMATION')).toBe(LogLevel.INFO)
    expect(resolveLogLevel('верно?')).toBe(LogLevel.INFO)
  })

  it('явные уровни разбираются, регистр и пробелы не мешают', () => {
    expect(resolveLogLevel('debug')).toBe(LogLevel.DEBUG)
    expect(resolveLogLevel(' WARNING ')).toBe(LogLevel.WARNING)
    expect(resolveLogLevel('error')).toBe(LogLevel.ERROR)
  })
})
