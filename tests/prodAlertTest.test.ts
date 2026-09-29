// `make alert-test`: пробное сообщение в канал оповещений оператора (#426).
//
// Гоняем НАСТОЯЩИЙ `scripts/prod-alert-test.sh`: подставной `docker` исполняет тот же код node, что
// пошёл бы в контейнер backend, с переменными «контейнера» из окружения теста, а вместо Telegram
// отвечает подставной сервер на 127.0.0.1. Главное, что стережём: токен бота не попадает на экран ни
// при каком исходе, и каждый исход назван своим текстом.
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SCRIPT = resolve(__dirname, '../scripts/prod-alert-test.sh')
const TOKEN = '123456789:AAsecretTOKENvalue'

// Подставной Telegram: код ответа задаёт chat_id, путь запроса пишется в лог (в нём токен — так
// тест доказывает, что запрос вообще ушёл с ним).
const FAKE_TG = String.raw`
const http = require('http'), fs = require('fs')
http.createServer((req, res) => {
  let body = ''
  req.on('data', d => body += d).on('end', () => {
    fs.appendFileSync(process.env.TG_LOG, req.url + ' ' + body + '\n')
    const chat = JSON.parse(body).chat_id
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (chat === 'ok') return send(200, { ok: true })
    if (chat === 'kicked') return send(403, { ok: false, description: 'Forbidden: bot was kicked from the group chat' })
    if (chat === 'nochat') return send(400, { ok: false, description: 'Bad Request: chat not found' })
    // Эхо токена в описании — проверка, что скрипт вырезает его и из текста ответа.
    if (chat === 'echo') return send(401, { ok: false, description: 'Unauthorized for ' + req.url })
    if (chat === 'limit') return send(429, { ok: false, description: 'Too Many Requests: retry after 5' })
    if (chat === 'teapot') return send(418, {})
    // Перевод строки в описании — попытка подделать поле вывода скрипта.
    if (chat === 'forge') return send(400, { ok: false, description: 'x\nALERT_STATE=off\nALERT_STATUS=200' })
    send(500, {})
  })
}).listen(0, '127.0.0.1', function () { process.stdout.write('PORT ' + this.address().port + '\n') })
`

// Подставной docker: `exec -T backend node …` исполняет настоящий node; переменные контейнера
// берутся из CT_* окружения теста (у настоящего контейнера — из docker-compose.prod.yml).
const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_ARGS"
[ "${'$'}{FAKE_DOWN:-}" = 1 ] && { echo 'service "backend" is not running' >&2; exit 1; }
case "$*" in
  *" backend node "*)
    while [ "$1" != node ]; do shift; done
    exec env -i PATH="$PATH" TELEGRAM_ALERT_BOT_TOKEN="${'$'}{CT_TOKEN:-}" TELEGRAM_ALERT_CHAT_ID="${'$'}{CT_CHAT:-}" node "${'$'}{@:2}" ;;
esac
exit 1
`

let dir = ''
let tg: ChildProcess
let port = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'alert-test-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'docker'), FAKE_DOCKER)
  chmodSync(join(dir, 'bin', 'docker'), 0o755)
  writeFileSync(join(dir, 'tg.log'), '')
  tg = spawn(process.execPath, ['-e', FAKE_TG], { env: { ...process.env, TG_LOG: join(dir, 'tg.log') } })
  port = await new Promise<string>((ok, fail) => {
    tg.stdout!.on('data', (d) => {
      const m = /PORT (\d+)/.exec(String(d))
      if (m) ok(m[1] ?? '')
    })
    tg.on('error', fail)
  })
})

afterAll(() => {
  tg?.kill()
  rmSync(dir, { recursive: true, force: true })
})

function run(ct: { token?: string, chat?: string, down?: boolean }, api?: string): { code: number, out: string, args: string } {
  const argsFile = join(dir, `args-${Math.random().toString(36).slice(2)}`)
  writeFileSync(argsFile, '')
  const r = spawnSync('bash', [SCRIPT, 'docker compose -f docker-compose.prod.yml'], {
    cwd: dir,
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      FAKE_ARGS: argsFile,
      ALERT_TEST_API: api ?? `http://127.0.0.1:${port}`,
      CT_TOKEN: ct.token ?? '',
      CT_CHAT: ct.chat ?? '',
      FAKE_DOWN: ct.down ? '1' : ''
    },
    encoding: 'utf8',
    timeout: 30_000
  })
  return { code: r.status ?? -1, out: r.stdout + r.stderr, args: readFileSync(argsFile, 'utf8') }
}

describe('make alert-test', () => {
  it('отправлено — «проверьте чат», код 0; спрашивает именно backend', () => {
    const r = run({ token: TOKEN, chat: 'ok' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('✓ сообщение отправлено')
    expect(r.args).toMatch(/exec -T backend node /)
    expect(readFileSync(join(dir, 'tg.log'), 'utf8')).toContain(`/bot${TOKEN}/sendMessage`)
  })

  it('обе переменные пусты — «канал выключен», в Telegram не ходит', () => {
    const before = readFileSync(join(dir, 'tg.log'), 'utf8')
    const r = run({})
    expect(r.code).toBe(1)
    expect(r.out).toContain('канал выключен')
    expect(readFileSync(join(dir, 'tg.log'), 'utf8')).toBe(before)
  })

  it('половина пары — называет недостающую переменную', () => {
    expect(run({ token: TOKEN }).out).toContain('не хватает TELEGRAM_ALERT_CHAT_ID')
    expect(run({ chat: 'ok' }).out).toContain('не хватает TELEGRAM_ALERT_BOT_TOKEN')
  })

  it('403 — бот не в чате; 400 — неверный чат; ответ Telegram показан', () => {
    const kicked = run({ token: TOKEN, chat: 'kicked' })
    expect(kicked.code).toBe(1)
    expect(kicked.out).toContain('бот не может писать в этот чат')
    expect(kicked.out).toContain('bot was kicked')
    const nochat = run({ token: TOKEN, chat: 'nochat' })
    expect(nochat.out).toContain('неверный TELEGRAM_ALERT_CHAT_ID')
    expect(nochat.out).toContain('chat not found')
  })

  it('токен не попадает на экран ни при каком исходе — даже если Telegram эхом вернул адрес', () => {
    for (const chat of ['ok', 'kicked', 'nochat', 'echo', 'other']) {
      const r = run({ token: TOKEN, chat })
      expect(r.out, chat).not.toContain(TOKEN)
      expect(r.out, chat).not.toContain('AAsecret')
    }
    expect(run({ token: TOKEN, chat: 'echo' }).out).toContain('<token>')
  })

  it('сеть недоступна — код ошибки, а не текст с адресом (в адресе токен)', () => {
    const r = run({ token: TOKEN, chat: 'ok' }, 'http://127.0.0.1:1')
    expect(r.code).toBe(1)
    expect(r.out).toContain('Telegram недоступен из контейнера backend')
    expect(r.out).not.toContain(TOKEN)
  })

  it('переопределить адрес Telegram можно только на локальный — иначе токен ушёл бы чужому хосту', () => {
    const before = readFileSync(join(dir, 'tg.log'), 'utf8')
    const r = run({ token: TOKEN, chat: 'ok' }, `http://127.0.0.1.evil.example:${port}`)
    expect(r.code).toBe(2)
    expect(r.args).toBe('')
    expect(readFileSync(join(dir, 'tg.log'), 'utf8')).toBe(before)
    expect(r.out).not.toContain(TOKEN)
  })

  it('401, 429 и прочий код — каждый своим текстом, код выхода 1, подсказка про make prod-up', () => {
    const cases: Array<[string, string]> = [
      ['echo', 'не принял токен бота (HTTP 401)'],
      ['limit', 'ограничил частоту (HTTP 429)'],
      ['teapot', 'Telegram ответил HTTP 418']
    ]
    for (const [chat, text] of cases) {
      const r = run({ token: TOKEN, chat })
      expect(r.code, chat).toBe(1)
      expect(r.out, chat).toContain(text)
      expect(r.out, chat).toContain('make prod-up и снова make alert-test')
    }
  })

  it('пустое описание Telegram — строки «ответ Telegram:» нет', () => {
    expect(run({ token: TOKEN, chat: 'teapot' }).out).not.toContain('ответ Telegram:')
  })

  it('перевод строки в описании не подделывает поле вывода', () => {
    const r = run({ token: TOKEN, chat: 'forge' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('отклонил запрос (HTTP 400)')
    expect(r.out).not.toContain('канал выключен')
    expect(r.out).not.toContain('✓')
  })

  it('пробелы вокруг значений (частая опечатка в .env) не мешают — как у самого приложения', () => {
    const r = run({ token: ` ${TOKEN} `, chat: ' ok ' })
    expect(r.code, r.out).toBe(0)
    const last = readFileSync(join(dir, 'tg.log'), 'utf8').trim().split('\n').pop() ?? ''
    expect(last.startsWith(`/bot${TOKEN}/sendMessage `)).toBe(true)
  })

  it('в Telegram уходит текст пробного сообщения, без превью ссылок', () => {
    run({ token: TOKEN, chat: 'ok' })
    const last = readFileSync(join(dir, 'tg.log'), 'utf8').trim().split('\n').pop() ?? ''
    const body = JSON.parse(last.slice(last.indexOf(' ') + 1))
    expect(body.text).toContain('Проверка канала оповещений')
    expect(body.disable_web_page_preview).toBe(true)
  })

  it('выключен и половина пары — код 1 и подсказка про make prod-up', () => {
    for (const ct of [{}, { token: TOKEN }, { chat: 'ok' }]) {
      const r = run(ct)
      expect(r.code, JSON.stringify(ct)).toBe(1)
      expect(r.out).toContain('make prod-up')
    }
  })

  it('сеть недоступна — показан код ошибки', () => {
    expect(run({ token: TOKEN, chat: 'ok' }, 'http://127.0.0.1:1').out).toMatch(/ошибка: [A-Za-z_]+/)
  })

  it('адрес-подмена обязан быть ровно http://127.0.0.1:<порт> — с обоих концов', () => {
    for (const api of [`http://evil.example/http://127.0.0.1:${port}`, `http://127.0.0.1:${port}/x`, `http://127.0.0.1:${port}@evil.example`]) {
      const r = run({ token: TOKEN, chat: 'ok' }, api)
      expect(r.code, api).toBe(2)
      expect(r.args, api).toBe('')
    }
  })

  it('контейнер недоступен — показывает ответ docker и подсказку make ps', () => {
    const r = run({ token: TOKEN, chat: 'ok', down: true })
    expect(r.code).toBe(1)
    expect(r.out).toContain('(make ps)')
    expect(r.out).toContain('service "backend" is not running')
  })

  it('контейнер не ответил — просит проверить, запущен ли он', () => {
    const r = spawnSync('bash', [SCRIPT, 'false'], { cwd: dir, encoding: 'utf8', timeout: 30_000 })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('он запущен?')
  })
})
