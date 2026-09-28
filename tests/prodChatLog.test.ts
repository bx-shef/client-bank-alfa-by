// `make chat-log`: чьи строки и в каком порядке (находка ревью #776).
//
// Скрипт читает ДВА контейнера — приглашение владельцу счёта шлёт backend, сообщения о платежах —
// worker. `docker compose logs` отдаёт их двумя потоками, а не одной лентой: без слияния `tail`
// ниже по скрипту брал бы не «последние строки», а хвост того потока, что напечатан последним, и
// строку нельзя было бы отнести к контейнеру. Тест гоняет настоящий `scripts/prod-chat-log.sh` с
// подставным `docker` в PATH, который, как и настоящий, печатает потоки по очереди.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SCRIPT = resolve(__dirname, '../scripts/prod-chat-log.sh')

let dir = ''

// Подставной docker: записывает свои аргументы и печатает сначала ВЕСЬ поток backend, потом ВЕСЬ
// поток worker — хронологически они перемешаны. Метки времени и префиксы — только если их
// попросили, как у настоящего `compose logs`.
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_ARGS"
[ "\${FAKE_MODE:-}" = empty ] && exit 0
if [ "\${FAKE_MODE:-}" = quiet ]; then
  echo 'worker-1  | 2026-09-28T08:00:00.000000000Z [crm-sync] INFO: 3 обработано, 3 создано'
  exit 0
fi
ts=0; prefix=1
case "$*" in *--timestamps*) ts=1 ;; esac
case "$*" in *--no-log-prefix*) prefix=0 ;; esac
line() { # service time text
  out="$3"
  [ "$ts" = 1 ] && out="$2 $out"
  [ "$prefix" = 1 ] && out="$1-1  | $out"
  printf '%s\\n' "$out"
}
line backend 2026-09-28T08:00:00.000000000Z '[chat] INFO: портал не принял вложение: ATTACH_ERROR'
line backend 2026-09-28T10:00:00.000000000Z '[chat] INFO: бот не принял сообщение, сообщение уйдёт от имени владельца токена: REASON-B'
line worker 2026-09-28T09:00:00.000000000Z '[chat] INFO: бот недоступен на портале, сообщение уйдёт от имени владельца токена: REASON-A'
line worker 2026-09-28T11:00:00.000000000Z '[chat] INFO: регистрация бота не удалась, сообщение уйдёт от имени владельца токена: REASON-C'
`

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-log-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'docker'), FAKE_DOCKER)
  chmodSync(join(dir, 'bin', 'docker'), 0o755)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function chatLog(env: Record<string, string> = {}): { out: string, args: string } {
  const argsFile = join(dir, `args-${Math.random().toString(36).slice(2)}`)
  writeFileSync(argsFile, '')
  const r = spawnSync('bash', [SCRIPT, '24h'], {
    cwd: dir,
    env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, FAKE_ARGS: argsFile, ...env },
    encoding: 'utf8',
    timeout: 30_000
  })
  return { out: r.stdout, args: readFileSync(argsFile, 'utf8') }
}

describe('make chat-log: оба контейнера одной лентой', () => {
  it('читает backend И worker — сообщения о платежах шлёт worker', () => {
    const { args } = chatLog()
    expect(args).toMatch(/logs .*\bbackend worker\b/)
  })

  it('строки идут по времени, а не потоками по очереди', () => {
    const { out } = chatLog()
    const order = ['ATTACH_ERROR', 'REASON-A', 'REASON-B', 'REASON-C'].map(needle => out.indexOf(needle))
    expect(order.every(i => i >= 0), out).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('у каждой строки виден контейнер — приглашение отличимо от сообщений о платежах', () => {
    const { out } = chatLog()
    expect(out).toMatch(/backend-1 +\| .*ATTACH_ERROR/)
    expect(out).toMatch(/worker-1 +\| .*бот недоступен на портале/)
  })

  // ⚠ Пустой вывод двусмыслен: «бот принял» и «ничего не отправляли». Отказ бота пишется не чаще
  // раза в час, пока сообщения уходят, — отчёт обязан это сказать, а не только про картинки.
  it('нет строк чата — отчёт объясняет, что значит отсутствие отказов бота', () => {
    const { out } = chatLog({ FAKE_MODE: 'quiet' })
    expect(out).toContain('ни одного отказа бота')
    expect(out).toContain('не чаще раза в час')
  })

  it('лог пуст — совет расширить окно, а не «всё хорошо»', () => {
    const { out } = chatLog({ FAKE_MODE: 'empty' })
    expect(out).toContain('лог пуст')
    expect(out).not.toContain('ни одного отказа бота')
  })
})
