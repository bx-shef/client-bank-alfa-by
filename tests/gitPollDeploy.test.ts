// Автообновление ВМ Битрикс24 держит локальный `:latest` на развёрнутой версии (#766).
//
// `.env` на ВМ ссылается на `:latest`, а скрипт поднимает стек тегом коммита через оверлей
// окружения. Пока `:latest` не перетегировался, любой ручной `docker compose up -d` (правка `.env`,
// `make feedback-on`) пересоздавал контейнеры из образа, скачанного один раз в шаге 4 рантбука, —
// то есть тихо откатывал версию, а автообновление, сравнивая коммиты, видело «изменений нет».
//
// Тест гоняет настоящий `deploy/bitrixvm/git-poll-deploy.sh` с подставными `git`, `docker` и
// `curl` в PATH. Подставной `docker` пишет каждый вызов в журнал — по нему видно, что и в каком
// порядке сделал скрипт.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = resolve(__dirname, '../deploy/bitrixvm/git-poll-deploy.sh')
const SHA = 'abcdef1234567890abcdef1234567890abcdef12'
const TAG = 'sha-abcdef1'
const APP = 'ghcr.io/o/r'
const BACKEND = 'ghcr.io/o/r-backend'

let dir = ''

const FAKE_GIT = `#!/usr/bin/env bash
printf '%s\\trefs/heads/main\\n' "$FAKE_SHA"
`

// Каждый вызов — строка журнала; у `compose up` к ней дописываются образы из окружения, ведь
// скрипт передаёт тег коммита именно оверлеем окружения.
const FAKE_DOCKER = `#!/usr/bin/env bash
line="$*"
case "$*" in *"compose up"*) line="$line APP_IMAGE=$APP_IMAGE BACKEND_IMAGE=$BACKEND_IMAGE" ;; esac
printf '%s\\n' "$line" >> "$FAKE_LOG"
case "$1" in
  pull) exit 0 ;;
  tag) exit "\${FAKE_TAG_RC:-0}" ;;
  inspect)
    case "$*" in
      *cid-app*) echo sha256:prevapp ;;
      *cid-backend*) echo sha256:prevbackend ;;
    esac
    exit 0 ;;
  compose)
    case "$*" in
      *"ps -q app"*) echo cid-app ;;
      *"ps -q backend"*) echo cid-backend ;;
    esac
    exit 0 ;;
esac
exit 0
`

const FAKE_CURL = `#!/usr/bin/env bash
[ "\${FAKE_HEALTHY:-1}" = 1 ] && exit 0
exit 22
`

function install(name: string, body: string) {
  const path = join(dir, 'bin', name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function deploy(env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT], {
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      BANK_APP_DEPLOY_CONFIG: join(dir, 'deploy.env'),
      BANK_APP_DEPLOY_STATE: join(dir, 'state'),
      FAKE_SHA: SHA,
      FAKE_LOG: join(dir, 'docker.log'),
      ...env
    },
    encoding: 'utf8',
    timeout: 30_000
  })
  const log = existsSync(join(dir, 'docker.log')) ? readFileSync(join(dir, 'docker.log'), 'utf8').trim().split('\n') : []
  const deployed = existsSync(join(dir, 'state', 'deployed_sha')) ? readFileSync(join(dir, 'state', 'deployed_sha'), 'utf8').trim() : null
  return { code: r.status, out: `${r.stdout}${r.stderr}`, log, deployed }
}

const indexOf = (log: string[], needle: string) => log.findIndex(l => l.includes(needle))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'poll-deploy-'))
  mkdirSync(join(dir, 'bin'))
  mkdirSync(join(dir, 'stack'))
  install('git', FAKE_GIT)
  install('docker', FAKE_DOCKER)
  install('curl', FAKE_CURL)
  writeFileSync(join(dir, 'deploy.env'), [
    'GIT_URL=git@example.invalid:o/r.git',
    `STACK_DIR=${join(dir, 'stack')}`,
    `IMAGE_APP=${APP}`,
    `IMAGE_BACKEND=${BACKEND}`,
    'HEALTH_ATTEMPTS=1',
    'HEALTH_INTERVAL_SEC=0'
  ].join('\n') + '\n')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('автообновление ВМ и локальный :latest (#766)', () => {
  it('здоровый выкат: :latest перетегирован на развёрнутый коммит — после подъёма стека', () => {
    const r = deploy()
    expect(r.code, r.out).toBe(0)
    const up = indexOf(r.log, `compose up -d --remove-orphans APP_IMAGE=${APP}:${TAG} BACKEND_IMAGE=${BACKEND}:${TAG}`)
    const tagApp = indexOf(r.log, `tag ${APP}:${TAG} ${APP}:latest`)
    const tagBackend = indexOf(r.log, `tag ${BACKEND}:${TAG} ${BACKEND}:latest`)
    expect(up).toBeGreaterThanOrEqual(0)
    expect(tagApp).toBeGreaterThan(up)
    expect(tagBackend).toBeGreaterThan(up)
    expect(r.deployed).toBe(SHA)
  })

  it('откат: :latest возвращается на прежние образы, а не остаётся на сломанной версии', () => {
    const r = deploy({ FAKE_HEALTHY: '0' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('откат выполнен')
    const rollback = indexOf(r.log, 'APP_IMAGE=sha256:prevapp BACKEND_IMAGE=sha256:prevbackend')
    expect(rollback).toBeGreaterThanOrEqual(0)
    expect(indexOf(r.log, `tag sha256:prevapp ${APP}:latest`)).toBeGreaterThan(rollback)
    expect(indexOf(r.log, `tag sha256:prevbackend ${BACKEND}:latest`)).toBeGreaterThan(rollback)
    // Сломанная версия в :latest не попадает ни на миг.
    expect(indexOf(r.log, `tag ${APP}:${TAG}`)).toBe(-1)
    expect(r.deployed).toBeNull()
  })

  it('перетегирование не удалось — выкат всё равно засчитан, но это сказано в логе', () => {
    const r = deploy({ FAKE_TAG_RC: '1' })
    expect(r.code, r.out).toBe(0)
    expect(r.deployed).toBe(SHA)
    expect(r.out).toContain('не удалось перетегировать :latest')
  })

  it('изменений нет — стек и теги не трогаются', () => {
    mkdirSync(join(dir, 'state'))
    writeFileSync(join(dir, 'state', 'deployed_sha'), `${SHA}\n`)
    const r = deploy()
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('изменений нет')
    expect(r.log).toEqual([])
  })
})
