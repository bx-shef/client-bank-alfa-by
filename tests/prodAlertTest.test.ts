import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveTelegramConfig } from '../server/utils/telegramAlert'

// #466 §3: проба канала оповещений (`make alert-test`).
//
// ⚠ Почему у пробы свой код, а не вызов боевого транспорта: боевой живёт внутри собранного бандла
// Nitro и снаружи не вызывается. Цена копии — расхождение, поэтому здесь проверяется не «похоже
// написано», а два свойства ИСПОЛНЕНИЕМ: имена переменных те же, что читает боевой резолвер, и
// токен не попадает в вывод НИ НА ОДНОЙ ветке.
//
// ⚠ Второе — не придирка: токен бота стоит в URL каждого вызова, а вывод пробы оператор
// копирует в переписку. Ровно так однажды уехали пароль оператора и ключ подписи (см. шапку
// prod-doctor.sh), и это единственная причина, по которой ошибка сети печатается фиксированной
// строкой вместо текста исключения.

const SCRIPT = readFileSync(resolve(import.meta.dirname, '../scripts/prod-alert-test.sh'), 'utf8')

/** Тело node-вставки из heredoc: именно оно и исполняется в контейнере. */
const SNIPPET = SCRIPT.slice(SCRIPT.indexOf('<<\'NODE\'\n') + '<<\'NODE\'\n'.length, SCRIPT.indexOf('\nNODE\n'))

const TOKEN = '123456:AAHtestTOKENvaluenobodyshouldeversee'
const CHAT = '-1001234567890'

/** Выполнить вставку с подменённым `fetch`, вернуть весь её вывод. */
function runSnippet(env: Record<string, string>, fetchStub: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'alert-'))
  try {
    const file = join(dir, 'snippet.mjs')
    writeFileSync(file, `globalThis.fetch = ${fetchStub}\n${SNIPPET}\n`)
    try {
      // ⚠ Окружение НЕ подменяем целиком: без PATH сам `node` не находится, и вместо вывода
      // вставки тест получил бы пустую строку — первая редакция так и провалилась. Обе переменные
      // канала гасим явно, чтобы прогон не зависел от того, что стоит у разработчика.
      const env2 = { ...process.env, TELEGRAM_ALERT_BOT_TOKEN: '', TELEGRAM_ALERT_CHAT_ID: '', ...env }
      return execFileSync('node', [file], { encoding: 'utf8', env: { ...env2, HOSTNAME: 'backend-1' } })
    } catch (e) {
      const err = e as { stdout?: string, stderr?: string }
      return (err.stdout ?? '') + (err.stderr ?? '')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const FULL = { TELEGRAM_ALERT_BOT_TOKEN: TOKEN, TELEGRAM_ALERT_CHAT_ID: CHAT }
const okFetch = 'async () => ({ status: 200, text: async () => JSON.stringify({ ok: true }) })'
const denyFetch = 'async () => ({ status: 401, text: async () => JSON.stringify('
  + '{ ok: false, error_code: 401, description: "Unauthorized" }) })'
const deadFetch = 'async () => { throw new Error("fetch failed to https://api.telegram.org/bot'
  + TOKEN + '/sendMessage") }'

describe('#466 проба канала: имена переменных не разошлись с боевыми', () => {
  it('вставка читает ровно те переменные, по которым транспорт включает канал', () => {
    // Собираем окружение ИЗ САМОЙ ВСТАВКИ и скармливаем боевому резолверу: переименуй переменную
    // в пробе — резолвер получит пустое окружение и вернёт null.
    const names = [...SNIPPET.matchAll(/process\.env\.([A-Z_]+)/g)].map(m => m[1]!)
    expect(names).toContain('TELEGRAM_ALERT_BOT_TOKEN')
    const env: Record<string, string> = {}
    for (const n of names) env[n] = n.endsWith('CHAT_ID') ? CHAT : TOKEN
    expect(resolveTelegramConfig(env)).not.toBeNull()
  })

  it('адрес тот же, что у боевого транспорта', () => {
    const live = readFileSync(resolve(import.meta.dirname, '../server/utils/telegramAlert.ts'), 'utf8')
    expect(live).toContain('https://api.telegram.org/bot')
    expect(live).toContain('/sendMessage')
    expect(SNIPPET).toContain('https://api.telegram.org/bot')
    expect(SNIPPET).toContain('/sendMessage')
  })
})

describe('#466 проба канала: три состояния различаются', () => {
  it('обе переменные пусты — канал ВЫКЛЮЧЕН, а не сломан', () => {
    const out = runSnippet({}, okFetch)
    expect(out).toContain('КАНАЛ ВЫКЛЮЧЕН')
  })

  it.each([
    ['только токен', { TELEGRAM_ALERT_BOT_TOKEN: TOKEN }],
    ['только чат', { TELEGRAM_ALERT_CHAT_ID: CHAT }]
  ])('%s — отдельное состояние «наполовину», а не «выключен»', (_n, env) => {
    // ⚠ Половина настройки выглядит включённой и роняет каждую тревогу. Слить её с «выключен»
    // значило бы спрятать самое опасное из трёх состояний.
    const out = runSnippet(env, okFetch)
    expect(out).toContain('НАПОЛОВИНУ')
    expect(out).not.toContain('КАНАЛ ВЫКЛЮЧЕН')
  })

  it('Telegram принял — «ДОШЛО»', () => {
    expect(runSnippet(FULL, okFetch)).toContain('ДОШЛО')
  })

  it('Telegram отверг — «НЕ ДОШЛО» с причиной', () => {
    const out = runSnippet(FULL, denyFetch)
    expect(out).toContain('НЕ ДОШЛО')
    expect(out).toContain('401')
    expect(out).toContain('токен бота неверен или отозван')
  })

  it('сеть молчит — «НЕ ДОШЛО», а не «дошло»', () => {
    expect(runSnippet(FULL, deadFetch)).toContain('НЕ ДОШЛО')
  })
})

describe('#466 проба канала: токен не попадает в вывод НИ НА ОДНОЙ ветке', () => {
  it.each([
    ['успех', okFetch],
    ['отказ Telegram', denyFetch],
    ['ошибка сети (текст исключения несёт URL с токеном)', deadFetch]
  ])('%s', (_n, stub) => {
    const out = runSnippet(FULL, stub)
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain('api.telegram.org/bot1')
  })
})
