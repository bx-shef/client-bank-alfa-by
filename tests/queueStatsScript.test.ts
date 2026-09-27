import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { QUEUE_NAMES } from '../server/queue/topology'

// `make queue-stats` (#757): счётчики очередей читаются redis-cli ВНУТРИ контейнера redis, без
// токена. Скрипт сам знает имена очередей и раскладку ключей BullMQ — обе вещи проверяются здесь
// исполнением, а не чтением: очередь, забытая в списке, не показывалась бы никогда и молча.

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPT_PATH = join(ROOT, 'scripts/queue-stats.sh')
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8')

it('список очередей в скрипте совпадает с QUEUE_NAMES', () => {
  const m = SCRIPT.match(/^QUEUES="([^"]*)"/m)
  expect(m).not.toBeNull()
  expect(m![1].split(' ').sort()).toEqual([...QUEUE_NAMES].sort())
})

describe('прогон с подставными docker и redis-cli', () => {
  /**
   * `docker` исполняет скрипт, переданный `sh -c`, так, как это сделал бы контейнер; `redis-cli`
   * отвечает счётчиками из FAKE_COUNTS («ключ=число» через пробел) и пишет, какой командой его
   * спросили: списки BullMQ читаются LLEN, множества — ZCARD, и перепутанная команда на живом
   * Redis дала бы WRONGTYPE вместо числа.
   */
  function run(counts: string) {
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
for kv in $FAKE_COUNTS; do
  if [ "${'$'}{kv%%=*}" = "$3" ]; then echo "${'$'}{kv#*=}"; exit 0; fi
done
echo 0
`)
      chmodSync(join(bin, 'docker'), 0o755)
      chmodSync(join(bin, 'redis-cli'), 0o755)
      const r = spawnSync('bash', [SCRIPT_PATH, 'docker compose -f x.yml'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: dir, FAKE_COUNTS: counts }
      })
      return {
        code: r.status,
        out: r.stdout,
        args: readFileSync(join(dir, 'docker.args'), 'utf8').trim(),
        redis: readFileSync(join(dir, 'redis.log'), 'utf8').trim().split('\n')
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('одна строка на очередь, только ненулевые состояния, пустая названа пустой', () => {
    const r = run('bull:crm-sync:completed=12 bull:crm-sync:failed=2 bull:bank-fetch:wait=3')
    expect(r.code, r.out).toBe(0)
    const lines = r.out.trim().split('\n')
    expect(lines).toHaveLength(QUEUE_NAMES.length)
    expect(lines).toContain('crm-sync: failed=2 completed=12')
    expect(lines).toContain('bank-fetch: wait=3')
    expect(lines).toContain('b24-events: пусто')
  })

  it('заходит в контейнер redis через переданный compose и без токена', () => {
    const r = run('')
    expect(r.args).toMatch(/^compose -f x\.yml exec -T redis sh -c /)
    expect(r.args).not.toMatch(/TOKEN/)
  })

  it('списки — LLEN, остальное — ZCARD, ключи с префиксом bull:', () => {
    const r = run('')
    expect(r.redis).toContain('LLEN bull:crm-sync:wait')
    expect(r.redis).toContain('LLEN bull:crm-sync:active')
    for (const s of ['prioritized', 'delayed', 'waiting-children', 'failed', 'completed']) {
      expect(r.redis).toContain(`ZCARD bull:crm-sync:${s}`)
    }
    expect(r.redis).toHaveLength(QUEUE_NAMES.length * 7)
  })
})

describe('цель make', () => {
  const MAKEFILE = readFileSync(join(ROOT, 'Makefile'), 'utf8')
  const start = MAKEFILE.indexOf('\nqueue-stats:')
  const recipe = MAKEFILE.slice(start, MAKEFILE.indexOf('\n\n', start + 1))

  it('зовёт скрипт с $(DC) и без токена', () => {
    // ⚠ `$(DC)`, а не голый `-f`: на ВМ Битрикс24 файлы стека заданы COMPOSE_FILE в `.env`.
    expect(recipe).toContain('bash "$$t" "$(DC)"')
    expect(recipe).not.toMatch(/TOKEN/)
  })
})
