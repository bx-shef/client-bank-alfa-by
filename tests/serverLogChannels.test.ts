import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LogLevel } from '@bitrix24/b24jssdk'
import { resolveLogLevel, SERVER_LOG_CHANNELS } from '../server/utils/serverLogger'

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
    .map(f => read(join('server', f)))
}

describe('каналы логгера = маркеры, по которым ищут', () => {
  const sources = serverSources()
  const used = new Set(
    sources.flatMap(src => [...src.matchAll(/useServerLogger\('([^']+)'\)/g)].map(m => m[1]!))
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
    const cited = new Set(
      [...runbook.matchAll(/\[([a-z][a-z-]{2,})\]/g)].map(m => m[1]!)
        .filter(name => (SERVER_LOG_CHANNELS as readonly string[]).includes(name)
          || printedLiterally.includes(`'${name}'`)
          || printedLiterally.includes(`[${name}]`))
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
    const offenders = sources.filter(src =>
      // Комментарии не в счёт: они законно упоминают прежний механизм.
      /^\s*(?!.*\/\/).*console\.(log|info|warn|error)\(/m.test(src.replace(/^\s*\/\/.*$/gm, ''))
    )
    expect(offenders).toHaveLength(0)
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
