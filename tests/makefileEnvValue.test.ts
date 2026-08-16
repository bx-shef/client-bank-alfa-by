import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Как `Makefile` читает `./.env` (#487).
//
// Раньше здесь было `set -a; . ./.env`, то есть ИСПОЛНЕНИЕ файла: `POSTGRES_PASSWORD=x y z`
// превращался в команду, а переменные ниже сломанной строки не доезжали — команда молча уходила не
// с тем токеном. Замена — текстовый разбор, и у него ровно обратная опасность: он может оказаться
// УЖЕ формата, который тот же `.env` обязан поддерживать для `docker compose` (цели `prod-up`
// и соседние читают этот же файл). Тогда `DOMAIN="x.by"` доедет вместе с кавычками, и
// `prod-doctor.sh` объявит «ПЛОХО» по всем внешним проверкам живого сайта — ложная тревога в
// аварию, то есть худший исход для инструмента, которому в этот момент верят.
//
// ⚠ Макрос берётся ИЗ САМОГО `Makefile` и прогоняется настоящим `make`, а не переписывается сюда
// шеллом. Копия разошлась бы молча, а тут ещё и три слоя экранирования (`make` → `sh` → `sed`),
// в которых уже один раз незаметно пропала половина выражения: `#` в значении переменной make —
// начало КОММЕНТАРИЯ, и `s/…#.*//` съел остаток строки, не сломав сборку.

const ROOT = join(import.meta.dirname, '..')
const MAKEFILE = readFileSync(join(ROOT, 'Makefile'), 'utf8')

/** Прогнать `$(call env-value,KEY)` настоящим make в каталоге с фикстурным `.env`. */
function envValue(key: string, dotenv: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'env-value-'))
  if (dotenv !== null) writeFileSync(join(dir, '.env'), dotenv)
  // Свой `Makefile` + цель-зонд: так проверяется ровно тот текст макроса, что лежит в репозитории,
  // со всеми правилами раскрытия make, а не наше представление о них.
  writeFileSync(join(dir, 'Makefile'), `${MAKEFILE}\n\nprobe:\n\t@printf '%s' "$(call env-value,${key})"\n`)
  return execFileSync('make', ['--no-print-directory', 'probe'], { cwd: dir, encoding: 'utf8' })
}

describe('Makefile читает ./.env текстом, не исполняя (#487)', () => {
  it.each([
    ['голое значение', 'DOMAIN=bank.example.by\n', 'bank.example.by'],
    ['необязательный export', 'export DOMAIN=bank.example.by\n', 'bank.example.by'],
    ['двойные кавычки снимаются', 'DOMAIN="bank.example.by"\n', 'bank.example.by'],
    ['одинарные кавычки снимаются', 'DOMAIN=\'bank.example.by\'\n', 'bank.example.by'],
    ['пробелы вокруг =', 'DOMAIN = bank.example.by\n', 'bank.example.by'],
    ['комментарий в конце строки', 'DOMAIN=bank.example.by # прод\n', 'bank.example.by'],
    ['закомментированный ключ выше не побеждает', '#DOMAIN=old.by\nDOMAIN=bank.example.by\n', 'bank.example.by'],
    ['ключ-префикс не путается', 'DOMAIN_ALT=nope.by\nDOMAIN=bank.example.by\n', 'bank.example.by'],
    ['CRLF не протекает в значение', 'DOMAIN=bank.example.by\r\n', 'bank.example.by'],
    ['«=» внутри значения не режет его', 'DOMAIN=a=b.example.by\n', 'a=b.example.by'],
    ['хвостовые пробелы срезаются', 'DOMAIN=bank.example.by   \n', 'bank.example.by'],
    ['ключа нет', 'OTHER=x\n', ''],
    ['файла нет', null, '']
  ])('%s', (_label, dotenv, expected) => {
    expect(envValue('DOMAIN', dotenv)).toBe(expected)
  })

  it('соседняя строка с пробелами в значении не ломает чтение', () => {
    // Тот самый случай, на котором ломался `. ./.env`: значение с пробелом становилось командой,
    // и всё, что НИЖЕ него, не доезжало. Здесь `DOMAIN` объявлен после такой строки.
    expect(envValue('DOMAIN', 'POSTGRES_PASSWORD=x y z\nDOMAIN=bank.example.by\n')).toBe('bank.example.by')
  })

  it('значение не ИСПОЛНЯЕТСЯ — подстановка команды остаётся текстом', () => {
    // Главное свойство замены. Если оно когда-нибудь отвалится, `.env` снова станет исполняемым
    // кодом, а `.env` — это файл с паролями, который правят руками.
    expect(envValue('DOMAIN', 'DOMAIN=$(echo pwned)\n')).toBe('$(echo pwned)')
    expect(envValue('DOMAIN', 'DOMAIN=`echo pwned`\n')).toBe('`echo pwned`')
  })

  it('при дублирующемся ключе побеждает ПЕРВАЯ строка', () => {
    // Расходится с привычкой (`. ./.env` оставил бы последнюю), поэтому закреплено явно: пусть
    // смена этого поведения будет решением, а не побочным эффектом правки регулярки.
    expect(envValue('DOMAIN', 'DOMAIN=first.by\nDOMAIN=second.by\n')).toBe('first.by')
  })
})
