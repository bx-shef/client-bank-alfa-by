// `make doctor` без крипто-шлюза (#767).
//
// С 2026-08-19 прод ходит в Приорбанк напрямую на :9344 (#522), и отсутствие шлюза — штатное
// состояние. Прежняя строка «crypto-gw не запущен — прод Приорбанка недоступен» печаталась на
// КАЖДОМ таком сервере: человек, проверяющий стек по чек-листу, читал ложную тревогу и либо поднимал
// шлюз зря, либо переставал доверять рабочей установке.
//
// Тест гоняет настоящий `scripts/prod-doctor.sh` с подставным `docker` в PATH: шлюза в списке
// сервисов нет, а backend на `exec` отдаёт `PRIOR_OAUTH_API_BASE` из окружения теста (или падает).
// Остальные проверки скрипта при этом краснеют — нам нужна только строка про шлюз.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const DOCTOR = resolve(__dirname, '../scripts/prod-doctor.sh')

let dir = ''

const FAKE_DOCKER = `#!/usr/bin/env bash
if [ "$1" = compose ]; then
  shift
  while [ "$1" = -f ]; do shift 2; done
  case "$1" in
    ps)
      # Список сервисов без crypto-gw — ветка «шлюз не развёрнут».
      case "$*" in *"{{.Service}}"*) printf 'app\\nbackend\\nworker\\ndb\\nredis\\n' ;; esac
      exit 0 ;;
    exec)
      case "$*" in
        *PRIOR_OAUTH_API_BASE*)
          [ "\${FAKE_EXEC_RC:-0}" = 0 ] || exit "$FAKE_EXEC_RC"
          printf '%s' "\${FAKE_PRIOR_BASE-}"
          exit 0 ;;
      esac
      exit 1 ;;
  esac
fi
exit 0
`

function doctor(env: Record<string, string>): string {
  try {
    return execFileSync('bash', [DOCTOR], {
      cwd: dir,
      env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, COMPOSE_FILE: 'docker-compose.prod.yml', ...env },
      encoding: 'utf8',
      timeout: 30_000
    })
  } catch (e) {
    // Скрипт выходит с ненулевым кодом, если что-то «ПЛОХО», — здесь это ожидаемо: нас
    // интересует вывод, а не код.
    return String((e as { stdout?: string }).stdout ?? '')
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'doctor-gw-'))
  writeFileSync(join(dir, 'docker-compose.prod.yml'), 'services: {}\n')
  execFileSync('mkdir', ['-p', join(dir, 'bin')])
  writeFileSync(join(dir, 'bin', 'docker'), FAKE_DOCKER)
  chmodSync(join(dir, 'bin', 'docker'), 0o755)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('make doctor без крипто-шлюза', () => {
  it('Приорбанк напрямую — это норма, а не «прод недоступен»', () => {
    const out = doctor({ FAKE_PRIOR_BASE: 'https://api.priorbank.by:9344' })
    expect(out).toContain('crypto-gw не используется — Приорбанк напрямую (api.priorbank.by:9344)')
    expect(out).not.toContain('прод Приорбанка недоступен')
  })

  it('backend настроен на шлюз, а шлюза нет — это авария', () => {
    const out = doctor({ FAKE_PRIOR_BASE: 'http://crypto-gw:1080' })
    expect(out).toMatch(/ПЛОХО.*PRIOR_OAUTH_API_BASE ведёт на шлюз \(http:\/\/crypto-gw:1080\), а crypto-gw не запущен/)
  })

  it('Приорбанк не настроен — так и сказано', () => {
    const out = doctor({ FAKE_PRIOR_BASE: '' })
    expect(out).toContain('crypto-gw не используется — Приорбанк на этом сервере не настроен')
  })

  it('backend не ответил — «не проверить», а не «не настроен»', () => {
    const out = doctor({ FAKE_EXEC_RC: '1' })
    expect(out).toContain('нужен ли он, не проверить — backend не ответил на exec')
    expect(out).not.toContain('Приорбанк на этом сервере не настроен')
  })
})
