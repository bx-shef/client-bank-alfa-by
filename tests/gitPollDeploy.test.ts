// Автообновление ВМ Битрикс24 держит локальный `:latest` на развёрнутой версии (#766).
//
// `.env` на ВМ ссылается на `:latest`, а скрипт поднимает стек тегом коммита через оверлей
// окружения. Пока `:latest` не перетегировался, любой ручной `docker compose up -d` (правка `.env`,
// `make feedback-on`) пересоздавал контейнеры из образа, скачанного один раз в шаге 4 рантбука, —
// то есть тихо откатывал версию, а автообновление, сравнивая коммиты, видело «изменений нет».
//
// Тест гоняет настоящий `deploy/bitrixvm/git-poll-deploy.sh` с подставными `git`, `docker`, `curl`
// и `flock` в PATH. Подставные `docker`, `git` и `flock` пишут каждый вызов в журнал — по нему
// видно, что и в каком порядке сделал скрипт. `flock` подставной ещё и потому, что у macOS его нет.
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
echo "git $1" >> "$FAKE_LOG"
[ -z "\${FAKE_GIT_RC:-}" ] || { echo 'fatal: unable to access' >&2; exit "$FAKE_GIT_RC"; }
printf '%s\\trefs/heads/main\\n' "$FAKE_SHA"
`

// Каждый вызов — строка журнала; у `compose up` к ней дописываются образы из окружения, ведь
// скрипт передаёт тег коммита именно оверлеем окружения.
// FAKE_IDS — «ссылка=идентификатор» через пробел: что отвечает `docker image inspect`.
// FAKE_TAG_FAIL — подстрока: `docker tag`, в чьих аргументах она есть, завершается отказом.
// FAKE_ORDER_CHECK — отметить в журнале перетегирование, случившееся ПОСЛЕ записи deployed_sha.
// FAKE_ROLLBACK_COMPOSE_RC — код выхода `compose up` при откате (образы по идентификатору).
// FAKE_PULL_MISSING — реестр отвечает «manifest unknown»: CI ещё собирает образы коммита.
const FAKE_DOCKER = `#!/usr/bin/env bash
line="$*"
case "$*" in *"compose up"*) line="$line APP_IMAGE=$APP_IMAGE BACKEND_IMAGE=$BACKEND_IMAGE" ;; esac
printf '%s\\n' "$line" >> "$FAKE_LOG"
case "$1" in
  pull)
    if [ -n "\${FAKE_PULL_MISSING:-}" ]; then echo 'Error response from daemon: manifest unknown' >&2; exit 1; fi
    exit 0 ;;
  tag)
    if [ -n "\${FAKE_ORDER_CHECK:-}" ] && [ -e "$BANK_APP_DEPLOY_STATE/deployed_sha" ]; then
      echo ORDER-VIOLATION >> "$FAKE_LOG"
    fi
    if [ -n "\${FAKE_TAG_FAIL:-}" ]; then
      case "$*" in *"$FAKE_TAG_FAIL"*) exit 1 ;; esac
    fi
    exit 0 ;;
  image)
    ref="\${@: -1}"
    for pair in \${FAKE_IDS:-}; do
      if [ "\${pair%%=*}" = "$ref" ]; then echo "\${pair#*=}"; exit 0; fi
    done
    echo "Error: No such image: $ref" >&2
    exit 1 ;;
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
      *"compose up"*)
        case "$APP_IMAGE" in sha256:*) exit "\${FAKE_ROLLBACK_COMPOSE_RC:-0}" ;; esac ;;
    esac
    exit 0 ;;
esac
exit 0
`

const FAKE_CURL = `#!/usr/bin/env bash
[ "\${FAKE_HEALTHY:-1}" = 1 ] && exit 0
exit 22
`

// FAKE_FLOCK_BUSY — замок держит другой прогон: `-n` отказывает, `-w` ждёт и отвечает
// FAKE_FLOCK_WAIT_RC (0 — дождался, 1 — не дождался).
const FAKE_FLOCK = `#!/usr/bin/env bash
echo "flock $*" >> "$FAKE_LOG"
[ -n "\${FAKE_FLOCK_BUSY:-}" ] || exit 0
case "$1" in
  -n) exit 1 ;;
  -w) exit "\${FAKE_FLOCK_WAIT_RC:-0}" ;;
esac
exit 0
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

/** Сервер уже на коммите `sha` (по умолчанию — на последнем: тик «изменений нет»). */
function alreadyDeployed(sha = SHA) {
  mkdirSync(join(dir, 'state'), { recursive: true })
  writeFileSync(join(dir, 'state', 'deployed_sha'), `${sha}\n`)
}

const OLD_SHA = 'fedcba9876543210fedcba9876543210fedcba98'
const OLD_TAG = 'sha-fedcba9'

const indexOf = (log: string[], needle: string) => log.findIndex(l => l.includes(needle))
const tags = (log: string[]) => log.filter(l => l.startsWith('tag '))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'poll-deploy-'))
  mkdirSync(join(dir, 'bin'))
  mkdirSync(join(dir, 'stack'))
  install('git', FAKE_GIT)
  install('docker', FAKE_DOCKER)
  install('curl', FAKE_CURL)
  install('flock', FAKE_FLOCK)
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

describe('выкат и откат: :latest идёт за тем, что работает (#766)', () => {
  it('здоровый выкат: :latest перетегирован на развёрнутый коммит — после подъёма стека и до записи состояния', () => {
    const r = deploy({ FAKE_ORDER_CHECK: '1' })
    expect(r.code, r.out).toBe(0)
    const up = indexOf(r.log, `compose up -d --remove-orphans APP_IMAGE=${APP}:${TAG} BACKEND_IMAGE=${BACKEND}:${TAG}`)
    const tagApp = indexOf(r.log, `tag ${APP}:${TAG} ${APP}:latest`)
    const tagBackend = indexOf(r.log, `tag ${BACKEND}:${TAG} ${BACKEND}:latest`)
    expect(up).toBeGreaterThanOrEqual(0)
    expect(tagApp).toBeGreaterThan(up)
    expect(tagBackend).toBeGreaterThan(up)
    // Запись состояния раньше перетегирования: убей процесс между ними — и тик «изменений нет»
    // решал бы, что всё сделано, при `:latest` на старой версии.
    expect(r.log).not.toContain('ORDER-VIOLATION')
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

  it('откат сам не удался — :latest не трогаем: что сейчас работает, неизвестно', () => {
    const r = deploy({ FAKE_HEALTHY: '0', FAKE_ROLLBACK_COMPOSE_RC: '1' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('ОТКАТ НЕ УДАЛСЯ')
    expect(tags(r.log)).toEqual([])
  })

  it('отказал один из двух — выкат засчитан, а в логе назван именно он и сказано, что ручной up -d сейчас небезопасен', () => {
    const r = deploy({ FAKE_TAG_FAIL: `${BACKEND}:latest` })
    expect(r.code, r.out).toBe(0)
    expect(r.deployed).toBe(SHA)
    expect(r.out).toContain(`не удалось перетегировать ${BACKEND}:latest`)
    expect(r.out).not.toContain(`не удалось перетегировать ${APP}:latest`)
    expect(r.out).toContain('ручной docker compose up -d сейчас небезопасен')
    // Первый отказ не мешает второму: образ приложения перетегирован.
    expect(indexOf(r.log, `tag ${APP}:${TAG} ${APP}:latest`)).toBeGreaterThanOrEqual(0)
  })
})

describe('каждый тик возвращает :latest на развёрнутое (#766)', () => {
  it(':latest совпадает с развёрнутым — стек и теги не трогаются', () => {
    alreadyDeployed()
    const r = deploy({
      FAKE_IDS: `${APP}:${TAG}=sha256:a ${APP}:latest=sha256:a ${BACKEND}:${TAG}=sha256:b ${BACKEND}:latest=sha256:b`
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('изменений нет')
    expect(tags(r.log)).toEqual([])
    expect(r.log.filter(l => l.startsWith('compose') || l.startsWith('pull'))).toEqual([])
  })

  it(':latest разошёлся (скрипт обновили после выката, ручной pull) — возвращается только разошедшийся', () => {
    alreadyDeployed()
    const r = deploy({
      FAKE_IDS: `${APP}:${TAG}=sha256:a ${APP}:latest=sha256:old ${BACKEND}:${TAG}=sha256:b ${BACKEND}:latest=sha256:b`
    })
    expect(r.code, r.out).toBe(0)
    expect(tags(r.log)).toEqual([`tag ${APP}:${TAG} ${APP}:latest`])
    expect(r.out).toContain(`локальный ${APP}:latest возвращён на развёрнутый ${TAG}`)
    expect(r.log.filter(l => l.startsWith('compose'))).toEqual([])
  })

  it(':latest нет вовсе — ставится на развёрнутое', () => {
    alreadyDeployed()
    const r = deploy({ FAKE_IDS: `${APP}:${TAG}=sha256:a ${BACKEND}:${TAG}=sha256:b` })
    expect(r.code, r.out).toBe(0)
    expect(tags(r.log)).toEqual([`tag ${APP}:${TAG} ${APP}:latest`, `tag ${BACKEND}:${TAG} ${BACKEND}:latest`])
  })

  it('образа развёрнутого тега локально нет — сверять не с чем, молчим', () => {
    alreadyDeployed()
    const r = deploy({ FAKE_IDS: `${APP}:latest=sha256:old ${BACKEND}:latest=sha256:old` })
    expect(r.code, r.out).toBe(0)
    expect(tags(r.log)).toEqual([])
    expect(r.out).not.toContain('перетегировать')
  })

  it('новый коммит ещё собирается — сверка уже прошла, по тегу развёрнутого, а не нового', () => {
    alreadyDeployed(OLD_SHA)
    const r = deploy({
      FAKE_PULL_MISSING: '1',
      FAKE_IDS: `${APP}:${OLD_TAG}=sha256:a ${APP}:latest=sha256:stale ${BACKEND}:${OLD_TAG}=sha256:b ${BACKEND}:latest=sha256:b`
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('ещё нет')
    expect(tags(r.log)).toEqual([`tag ${APP}:${OLD_TAG} ${APP}:latest`])
    expect(r.log.filter(l => l.startsWith('compose up'))).toEqual([])
  })

  it('git недоступен — тик падает, но сверка до него уже прошла', () => {
    alreadyDeployed()
    const r = deploy({
      FAKE_GIT_RC: '128',
      FAKE_IDS: `${APP}:${TAG}=sha256:a ${APP}:latest=sha256:stale ${BACKEND}:${TAG}=sha256:b ${BACKEND}:latest=sha256:b`
    })
    expect(r.code).toBe(1)
    expect(r.out).toContain('не удалось опросить репозиторий')
    expect(tags(r.log)).toEqual([`tag ${APP}:${TAG} ${APP}:latest`])
  })

  it('на паузе — сверка идёт, остальное нет: пауза не консервирует устаревший :latest', () => {
    alreadyDeployed()
    writeFileSync(join(dir, 'state', 'paused'), '')
    const r = deploy({
      FAKE_IDS: `${APP}:${TAG}=sha256:a ${APP}:latest=sha256:stale ${BACKEND}:${TAG}=sha256:b ${BACKEND}:latest=sha256:b`
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('на паузе')
    expect(tags(r.log)).toEqual([`tag ${APP}:${TAG} ${APP}:latest`])
    expect(r.log.filter(l => l.startsWith('git '))).toEqual([])
  })

  it('перетегирование отказало — тик не падает, отказ назван', () => {
    alreadyDeployed()
    const r = deploy({
      FAKE_IDS: `${APP}:${TAG}=sha256:a ${APP}:latest=sha256:old ${BACKEND}:${TAG}=sha256:b ${BACKEND}:latest=sha256:b`,
      FAKE_TAG_FAIL: `${APP}:latest`
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`не удалось перетегировать ${APP}:latest — следующий тик попробует снова`)
  })
})

describe('идущий прогон: расписание пропускает, ручной запуск дожидается', () => {
  it('тик по расписанию (без ожидания) — «пропускаю тик», ничего не трогает', () => {
    alreadyDeployed()
    const r = deploy({ FAKE_FLOCK_BUSY: '1' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('обновление уже идёт, пропускаю тик')
    expect(r.log.filter(l => !l.startsWith('flock '))).toEqual([])
  })

  it('ручной запуск ждёт окончания и делает своё дело', () => {
    alreadyDeployed()
    const r = deploy({ FAKE_FLOCK_BUSY: '1', BANK_APP_DEPLOY_LOCK_WAIT: '900' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('обновление уже идёт — жду его окончания (до 900 с)')
    expect(r.log).toContain('flock -w 900 9')
    expect(r.out).toContain('изменений нет')
  })

  it('не дождался — отказ, а не молчаливый успех', () => {
    alreadyDeployed()
    const r = deploy({ FAKE_FLOCK_BUSY: '1', BANK_APP_DEPLOY_LOCK_WAIT: '900', FAKE_FLOCK_WAIT_RC: '1' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('не дождался окончания идущего обновления')
    expect(r.log.filter(l => l.startsWith('git '))).toEqual([])
  })

  it('кривое значение ожидания — как у расписания: пропуск, а не падение', () => {
    alreadyDeployed()
    const r = deploy({ FAKE_FLOCK_BUSY: '1', BANK_APP_DEPLOY_LOCK_WAIT: '15m' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('пропускаю тик')
  })
})
