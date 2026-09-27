import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { QueueGetters, QueueKeys } from 'bullmq'
import { QUEUE_NAMES } from '../server/queue/topology'

// `make queue-stats` (#757): счётчики очередей читаются redis-cli ВНУТРИ контейнера redis, без
// токена. Скрипт держит две копии чужой правды — имена очередей и раскладку ключей BullMQ, — и обе
// сверяются здесь: с QUEUE_NAMES и с УСТАНОВЛЕННЫМ пакетом bullmq. Иначе очередь, забытая в списке,
// не показывалась бы никогда, а обновление bullmq с другой раскладкой дало бы неверные числа при
// зелёных тестах (подставной redis-cli отвечает тем, чего ждёт сам скрипт).

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPT_PATH = join(ROOT, 'scripts/queue-stats.sh')
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8')
const listVar = (name: string) => SCRIPT.match(new RegExp(`^${name}="([^"]*)"`, 'm'))![1].split(' ')
const QUEUES = listVar('QUEUES')
const STATES = listVar('STATES')

it('список очередей в скрипте совпадает с QUEUE_NAMES', () => {
  expect([...QUEUES].sort()).toEqual([...QUEUE_NAMES].sort())
})

describe('раскладка ключей — та же, что у установленного bullmq', () => {
  it('состояния — ровно те, что bullmq считает по умолчанию (состоянию waiting соответствует ключ wait)', () => {
    const sanitize = (QueueGetters.prototype as unknown as { sanitizeJobTypes: (t: string[]) => string[] }).sanitizeJobTypes
    const defaults = sanitize.call({}, []).map(t => t === 'waiting' ? 'wait' : t)
    expect([...STATES].sort()).toEqual([...defaults].sort())
  })

  it('ключ состояния — bull:<очередь>:<состояние>, как строит сам bullmq', () => {
    // Префикс в connection.ts не задан — значит действует умолчание bullmq.
    expect(readFileSync(join(ROOT, 'server/queue/connection.ts'), 'utf8')).not.toMatch(/\bprefix\s*:/)
    const keys = new QueueKeys().getKeys('crm-sync') as Record<string, string>
    for (const s of STATES) expect(keys[s]).toBe(`bull:crm-sync:${s}`)
  })

  it('списки и множества — как в скрипте подсчёта самого bullmq (LLEN для wait/active, иначе ZCARD)', () => {
    const cmdDir = join(dirname(createRequire(import.meta.url).resolve('bullmq')), 'commands')
    const lua = readdirSync(cmdDir).find(f => /^getCounts-\d+\.lua$/.test(f))
    expect(lua).toBeDefined()
    const src = readFileSync(join(cmdDir, lua!), 'utf8')
    expect(src).toMatch(/ARGV\[i\] == "wait"/)
    expect(src).toMatch(/ARGV\[i\] == "active" then\s+results\[#results\+1\] = rcall\("LLEN", stateKey\)/)
    expect(src).toMatch(/else\s+results\[#results\+1\] = rcall\("ZCARD", stateKey\)/)
  })
})

describe('прогон с подставными docker и redis-cli', () => {
  /**
   * `docker` исполняет скрипт, переданный `sh -c`, так, как это сделал бы контейнер; `redis-cli`
   * отвечает счётчиками из FAKE_COUNTS («ключ=число» через пробел) и пишет, какой командой его
   * спросили: списки BullMQ читаются LLEN, множества — ZCARD, и перепутанная команда на живом
   * Redis дала бы WRONGTYPE вместо числа. FAKE_FAIL=1 — redis-cli не отвечает (как при упавшем
   * сервере: пустой вывод и ненулевой код).
   */
  function run(counts: string, opts: { arg?: string, fail?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'queue-stats-'))
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'docker'), String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" > "$FAKE_DIR/docker.args"
while [ "$#" -gt 0 ] && [ "$1" != "-c" ]; do shift; done
exec sh -c "$2"
`)
      writeFileSync(join(bin, 'redis-cli'), String.raw`#!/usr/bin/env bash
# redis-cli --raw <CMD> <key>
printf '%s %s\n' "$2" "$3" >> "$FAKE_DIR/redis.log"
[ -n "${'$'}{FAKE_FAIL:-}" ] && { echo "Could not connect to Redis" >&2; exit 1; }
for kv in $FAKE_COUNTS; do
  if [ "${'$'}{kv%%=*}" = "$3" ]; then echo "${'$'}{kv#*=}"; exit 0; fi
done
echo 0
`)
      chmodSync(join(bin, 'docker'), 0o755)
      chmodSync(join(bin, 'redis-cli'), 0o755)
      const r = spawnSync('bash', [SCRIPT_PATH, opts.arg ?? 'docker compose -f x.yml'], {
        encoding: 'utf8',
        env: {
          ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: dir, FAKE_COUNTS: counts,
          FAKE_FAIL: opts.fail ? '1' : ''
        }
      })
      return {
        code: r.status,
        out: r.stdout,
        err: r.stderr,
        args: readFileSync(join(dir, 'docker.args'), 'utf8').trim(),
        redis: readFileSync(join(dir, 'redis.log'), 'utf8').trim().split('\n')
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('одна строка на очередь, только ненулевые состояния, пустая названа пустой', () => {
    const r = run('bull:crm-sync:completed=12 bull:crm-sync:failed=2 bull:bank-fetch:wait=3')
    expect(r.code, r.out + r.err).toBe(0)
    const lines = r.out.trim().split('\n')
    expect(lines).toHaveLength(QUEUE_NAMES.length)
    expect(lines).toContain('crm-sync: failed=2 completed=12')
    // Ключ `wait` печатается как `waiting` — так его называют рантбук, /queues и getJobCounts.
    expect(lines).toContain('bank-fetch: waiting=3')
    expect(lines).toContain('b24-events: пусто')
  })

  it('Redis не отвечает — ошибка, а не «пусто»', () => {
    const r = run('', { fail: true })
    expect(r.code).toBe(1)
    expect(r.out).not.toContain('пусто')
    expect(r.out).toContain('crm-sync: waiting=?')
    expect(r.err).toContain('счётчики выше неполные')
  })

  it('заходит в контейнер redis через переданный compose и без токена', () => {
    const r = run('')
    expect(r.args).toMatch(/^compose -f x\.yml exec -T redis sh -c /)
    expect(r.args).not.toMatch(/TOKEN/)
  })

  it('старый Makefile передаёт имя файла, а не команду — это тоже работает', () => {
    // Скрипт качается свежим из main при каждом вызове, а Makefile на сервере меняется только
    // `make self-update`; до него прежний рецепт зовёт `bash queue-stats.sh docker-compose.prod.yml`.
    const r = run('', { arg: 'docker-compose.prod.yml' })
    expect(r.code, r.out + r.err).toBe(0)
    expect(r.args).toMatch(/^compose -f docker-compose\.prod\.yml exec -T redis sh -c /)
  })

  it('списки — LLEN, остальное — ZCARD, ключи с префиксом bull:', () => {
    const r = run('')
    expect(r.redis).toContain('LLEN bull:crm-sync:wait')
    expect(r.redis).toContain('LLEN bull:crm-sync:active')
    for (const s of ['prioritized', 'delayed', 'waiting-children', 'failed', 'completed']) {
      expect(r.redis).toContain(`ZCARD bull:crm-sync:${s}`)
    }
    expect(r.redis).toHaveLength(QUEUE_NAMES.length * STATES.length)
  })
})

describe('цель make', () => {
  const MAKEFILE = readFileSync(join(ROOT, 'Makefile'), 'utf8')
  const start = MAKEFILE.indexOf('\nqueue-stats:')
  const recipe = MAKEFILE.slice(start, MAKEFILE.indexOf('\n\n', start + 1))

  // Что `$(DC)` действительно уважает COMPOSE_FILE, проверяет настоящий make -n в
  // tests/makefileCompose.test.ts; здесь — что токен не вернулся.
  it('зовёт скрипт без токена', () => {
    expect(recipe).toContain('bash "$$t" "$(DC)"')
    expect(recipe).not.toMatch(/TOKEN/)
  })
})
