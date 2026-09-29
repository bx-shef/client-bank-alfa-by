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
    send(500, {})
  })
}).listen(0, '127.0.0.1', function () { process.stdout.write('PORT ' + this.address().port + '\n') })
`

// Подставной docker: `exec -T backend node …` исполняет настоящий node; переменные контейнера
// берутся из CT_* окружения теста (у настоящего контейнера — из docker-compose.prod.yml).
const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_ARGS"
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

function run(ct: { token?: string, chat?: string }, api?: string): { code: number, out: string, args: string } {
  const argsFile = join(dir, `args-${Math.random().toString(36).slice(2)}`)
  writeFileSync(argsFile, '')
  const r = spawnSync('bash', [SCRIPT, 'docker compose -f docker-compose.prod.yml'], {
    cwd: dir,
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      FAKE_ARGS: argsFile,
      ALERT_TEST_API: api ?? `http://127.0.0.1:${port}`,
      CT_TOKEN: ct.token ?? '',
      CT_CHAT: ct.chat ?? ''
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

  it('контейнер не ответил — просит проверить, запущен ли он', () => {
    const r = spawnSync('bash', [SCRIPT, 'false'], { cwd: dir, encoding: 'utf8', timeout: 30_000 })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('он запущен?')
  })
})
