import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Guard for the drift that made #487 a bug in the first place — and that survived the fix's own PR.
//
// На сервере нет репозитория (только `docker-compose.prod.yml`, `Makefile` и `.env`), поэтому
// серверные скрипты вызываются целями `make`. Беда в том, что ни один файл здесь не называет
// другой: рантбук пишет команду прозой, `Makefile` объявляет цель, `scripts/` держит сам скрипт.
// Разъехаться они могут молча и в любую сторону, а обнаруживается это в аварию — когда набранная
// из рантбука команда не работает.
//
// Это не гипотеза: сам PR, закрывавший #487, переписал не все места вызова, и три ревьюера нашли
// одно и то же чтением. Ровно тот случай, когда нужен тест, а не ещё один комментарий.

const ROOT = join(import.meta.dirname, '..')
const MAKEFILE = readFileSync(join(ROOT, 'Makefile'), 'utf8')

/** Файлы, которые читает человек, когда чинит стенд. */
function operatorDocs(): { path: string, text: string }[] {
  const files = [
    'CLAUDE.md',
    'docker-compose.prod.yml',
    ...readdirSync(join(ROOT, 'docs'))
      .filter(f => f.endsWith('.md'))
      .map(f => join('docs', f))
  ]
  return files
    .filter(f => existsSync(join(ROOT, f)))
    .map(path => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }))
}

/** Имена целей `Makefile` — левая часть строки `цель:` в первой колонке. */
const TARGETS = new Set(
  [...MAKEFILE.matchAll(/^([a-z][a-z0-9-]*):/gm)].map(m => m[1]!)
)

/** Цели, которые качают скрипт из `scripts/` и потому обязаны на что-то реально указывать. */
const DOWNLOADED = [...MAKEFILE.matchAll(/\$\(RAW\)\/([\w.-]+)/g)].map(m => m[1]!)

/**
 * Имена из объявления `.PHONY`, включая перенесённые на следующие строки через `\`.
 *
 * ⚠ Разбирается построчно, а не одной многострочной регуляркой: та молча захватывала только две
 * строки из трёх, и «цель не в .PHONY» тогда сообщалось бы про цели, которые там есть. Тест,
 * ошибающийся в свою пользу, хуже отсутствующего — но и ошибающийся против тоже: он приучает
 * править не то.
 */
/** Цели, объявленные в файле (левая часть до двоеточия, в начале строки). */
function makeTargets(): string[] {
  return [...new Set([...MAKEFILE.matchAll(/^([a-z][a-z-]*):/gm)].map(m => m[1]!))]
}

function phonyTargets(): string[] {
  const lines = MAKEFILE.split('\n')
  const start = lines.findIndex(l => l.startsWith('.PHONY:'))
  if (start < 0) return []
  const out: string[] = []
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!
    const body = i === start ? line.slice('.PHONY:'.length) : line
    out.push(...body.replace(/\\$/, '').split(/\s+/).filter(Boolean))
    if (!line.trimEnd().endsWith('\\')) break
  }
  return out
}

describe('серверные команды: рантбук ⇄ Makefile ⇄ scripts (#487)', () => {
  /**
   * Слова, которые идут после `make` в ПРОЗЕ, а не в вызове цели. Список закрытый: новое слово
   * обязано получить здесь причину, иначе исключения превращаются в свалку, гасящую настоящие
   * находки.
   *
   * ⚠ `target` — из дословной цитаты ошибки `No rule to make target 'self-update'`. Цитата в
   * рантбуке нужна: оператор увидит эту строку на экране и будет искать её текстом. Переписывать
   * её ради теста значило бы испортить документацию в угоду проверке.
   *
   * ⚠ Сюда же просилось англоязычное «make sure» — но соседний тест показал, что в операторских
   * документах его нет вовсе. Это и есть смысл проверки на протухание: умозрительное исключение
   * ничего не гасит сегодня и молча погасит настоящую находку завтра.
   */
  const PROSE_AFTER_MAKE = new Set(['target'])

  it('каждая упомянутая в документации цель `make` существует', () => {
    // Опечатка или переименование цели превращают рантбук в набор команд, которые не выполняются.
    // ⚠ Берём только собственные цели (`[a-z]`), а не любую строку после `make` — в текстах есть
    // и `make -n`, и англоязычное «make sure».
    const missing: string[] = []
    for (const { path, text } of operatorDocs()) {
      for (const m of text.matchAll(/\bmake\s+([a-z][a-z0-9-]*)\b/g)) {
        const target = m[1]!
        if (!TARGETS.has(target) && !PROSE_AFTER_MAKE.has(target)) missing.push(`${path}: make ${target}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('исключения не протухли — каждое всё ещё встречается в документации', () => {
    // Иначе список копит слова, которых давно нет, и гасит будущие настоящие находки.
    const all = operatorDocs().map(d => d.text).join('\n')
    for (const word of PROSE_AFTER_MAKE) {
      expect(all, `«make ${word}» больше не встречается — уберите из списка`).toMatch(new RegExp(`\\bmake\\s+${word}\\b`))
    }
  })

  it('каждый скачиваемый скрипт лежит в scripts/', () => {
    // URL собирается из строки, а не из пути в файловой системе, поэтому переименование скрипта
    // здесь ничего не ломает при сборке — только в момент запуска на сервере, кодом 404.
    expect(DOWNLOADED.length).toBeGreaterThan(0)
    for (const name of DOWNLOADED) {
      expect(existsSync(join(ROOT, 'scripts', name)), `scripts/${name}`).toBe(true)
    }
  })

  it('КАЖДАЯ цель объявлена в .PHONY, а не выборочные две', () => {
    // Иначе появившийся в каталоге файл с именем цели молча выключает её: make сочтёт цель
    // собранной и не выполнит рецепт.
    //
    // ⚠ Проверялись ровно `doctor` и `queue-stats`, то есть НИ ОДНА из целей, добавленных позже.
    // Мутационное ревью показало эффект вживую: `touch help && make help` печатает
    // «make: 'help' is up to date», выходит с кодом 0 и не делает ничего — отказ выглядит успехом.
    // Для `self-update` это особенно скверно: случайный файл с таким именем в каталоге деплоя тихо
    // парализует единственный путь обновления сервера.
    //
    // Поэтому список не перечисляется руками, а СВЕРЯЕТСЯ ЦЕЛИКОМ: новая цель обязана попасть в
    // `.PHONY` либо получить здесь причину.
    const phony = new Set(phonyTargets())
    /** Цели, которым `.PHONY` не нужен, — файлов с такими именами не бывает по построению. */
    const EXEMPT = new Set<string>()
    const missing = makeTargets().filter(t => !phony.has(t) && !EXEMPT.has(t))
    expect(missing, 'цели не в .PHONY').toEqual([])
    // Регулярка не должна «находить» пустоту — иначе тест зелен при сломанном разборе.
    expect(phony.size).toBeGreaterThan(10)
  })

  it('.PHONY не перечисляет несуществующих целей', () => {
    // Обратная сторона: протухший список создаёт ложное ощущение охвата.
    const phony = [...new Set(phonyTargets())]
    const known = new Set(makeTargets())
    expect(phony.filter(t => !known.has(t)), 'в .PHONY есть цели, которых нет').toEqual([])
  })

  it('документация не зовёт серверные скрипты так, как на сервере не выполнить', () => {
    // Регресс #487 в чистом виде: `bash scripts/prod-doctor.sh` в рантбуке подразумевает клон
    // репозитория, которого на сервере нет. ⚠ Исключение — `docs/DEPLOY.md`: там это в разделе
    // «Если репозиторий приватный», где скрипты кладут рядом с compose ОСОЗНАННО, и вызов идёт
    // не из `scripts/`, а из текущего каталога.
    const offenders: string[] = []
    for (const { path, text } of operatorDocs()) {
      for (const name of DOWNLOADED) {
        const re = new RegExp(String.raw`(?:bash\s+|\./|\s)scripts/${name.replace('.', '\\.')}`)
        if (re.test(text)) offenders.push(`${path}: scripts/${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('документация не советует «подсосать» .env исполнением файла', () => {
    // `set -a; . ./.env; set +a` ЗАПУСКАЕТ файл: значение с пробелом становится командой, и
    // переменные ниже сломанной строки не доезжают — команда уходит не с тем токеном молча.
    // Совет остался в рантбуке уже один раз, пережив тот самый PR, который назвал его дефектом.
    const offenders: string[] = []
    for (const { path, text } of operatorDocs()) {
      for (const line of text.split('\n')) {
        // ⚠ Ищем ИНСТРУКЦИЮ, а не упоминание: и `Makefile`, и рантбук объясняют, почему так
        // делать нельзя, и наивный поиск по подстроке объявил бы нарушителем объяснение.
        if (/(?:^|[^`])set -a;\s*\.\s+\.\/\.env/.test(line) && !/⚠|нельзя|ИСПОЛНЯЕТ|дефект/.test(line)) {
          offenders.push(`${path}: ${line.trim().slice(0, 80)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
