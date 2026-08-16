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

describe('серверные команды: рантбук ⇄ Makefile ⇄ scripts (#487)', () => {
  it('каждая упомянутая в документации цель `make` существует', () => {
    // Опечатка или переименование цели превращают рантбук в набор команд, которые не выполняются.
    // ⚠ Берём только собственные цели (`[a-z]`), а не любую строку после `make` — в текстах есть
    // и `make -n`, и англоязычное «make sure».
    const missing: string[] = []
    for (const { path, text } of operatorDocs()) {
      for (const m of text.matchAll(/\bmake\s+([a-z][a-z0-9-]*)\b/g)) {
        const target = m[1]!
        if (!TARGETS.has(target)) missing.push(`${path}: make ${target}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('каждый скачиваемый скрипт лежит в scripts/', () => {
    // URL собирается из строки, а не из пути в файловой системе, поэтому переименование скрипта
    // здесь ничего не ломает при сборке — только в момент запуска на сервере, кодом 404.
    expect(DOWNLOADED.length).toBeGreaterThan(0)
    for (const name of DOWNLOADED) {
      expect(existsSync(join(ROOT, 'scripts', name)), `scripts/${name}`).toBe(true)
    }
  })

  it('серверные цели объявлены в .PHONY', () => {
    // Иначе появившийся в каталоге файл с именем цели молча выключает её: make сочтёт цель
    // собранной и не выполнит рецепт.
    const phony = /^\.PHONY:(.*)$/m.exec(MAKEFILE)?.[1]?.split(/\s+/) ?? []
    for (const target of ['doctor', 'queue-stats']) {
      expect(phony, target).toContain(target)
    }
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
