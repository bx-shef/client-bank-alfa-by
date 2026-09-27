// `make doctor` и крипто-шлюз (#767).
//
// С 2026-08-19 прод ходит в Приорбанк напрямую на :9344 (#522), и отсутствие шлюза — штатное
// состояние. Прежняя строка «crypto-gw не запущен — прод Приорбанка недоступен» печаталась на
// КАЖДОМ таком сервере, а остановленный руками шлюз (`make gw-stop`) давал ложные «ПЛОХО» проб:
// человек, проверяющий стек по чек-листу, либо поднимал шлюз зря, либо переставал доверять рабочей
// установке.
//
// Тест гоняет настоящий `scripts/prod-doctor.sh` с подставным `docker` в PATH. Состояние шлюза
// задаёт FAKE_GW, адреса Приорбанка — FAKE_API/FAKE_TOKEN: подставной `exec` исполняет НАСТОЯЩИЙ
// разбор адресов из доктора обычным node, только с этими значениями в окружении. Остальные
// проверки скрипта при этом краснеют — нам нужны только строки про шлюз.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
      case "$*" in
        *"{{.Service}} {{.State}}"*)
          printf 'app running\\nbackend running\\n'
          [ -z "\${FAKE_GW:-}" ] || printf 'crypto-gw %s\\n' "$FAKE_GW" ;;
      esac
      exit 0 ;;
    exec)
      case "$*" in
        *PRIOR_OAUTH_API_BASE*)
          # Шум, который настоящий docker печатает в stderr, — оператору его видеть незачем.
          echo 'OCI-NOISE: connection refused' >&2
          [ "\${FAKE_EXEC_RC:-0}" = 0 ] || exit "$FAKE_EXEC_RC"
          while [ $# -gt 0 ] && [ "$1" != -e ]; do shift; done
          PRIOR_OAUTH_API_BASE="\${FAKE_API-}" PRIOR_OAUTH_TOKEN_URL="\${FAKE_TOKEN-}" exec node -e "$2" ;;
        *crypto-gw:1080/open-banking*) echo 401; exit 0 ;;
        *crypto-gw:1080/no-such-route*) echo 404; exit 0 ;;
      esac
      exit 1 ;;
  esac
fi
exit 0
`

function doctor(env: Record<string, string>): { out: string, err: string } {
  const r = spawnSync('bash', [DOCTOR], {
    cwd: dir,
    env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, COMPOSE_FILE: 'docker-compose.prod.yml', ...env },
    encoding: 'utf8',
    timeout: 30_000
  })
  // Скрипт выходит с ненулевым кодом, если что-то «ПЛОХО», — здесь это ожидаемо: нас интересует
  // вывод, а не код.
  return { out: r.stdout, err: r.stderr }
}

const DIRECT = 'https://api.priorbank.by:9344'
const DIRECT_TOKEN = 'https://api.priorbank.by:9344/oauth2/token'
const GW = 'http://crypto-gw:1080'

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'doctor-gw-'))
  writeFileSync(join(dir, 'docker-compose.prod.yml'), 'services: {}\n')
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'docker'), FAKE_DOCKER)
  chmodSync(join(dir, 'bin', 'docker'), 0o755)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Метка строки — отдельное утверждение: «это норма» и «это авария» различаются именно ею, а текст
// при подмене `ok` на `bad` остаётся прежним. Между меткой и текстом стоит код сброса цвета.
describe('шлюза нет или он остановлен — вердикт по настройке backend', () => {
  it('Приорбанк напрямую — это норма, а не «прод недоступен»', () => {
    const { out } = doctor({ FAKE_API: DIRECT, FAKE_TOKEN: DIRECT_TOKEN })
    expect(out).toMatch(/OK.*crypto-gw не используется — Приорбанк напрямую \(api\.priorbank\.by:9344\)/)
    expect(out).not.toContain('прод Приорбанка недоступен')
  })

  it('шлюз остановлен руками (gw-stop), Приорбанк напрямую — норма, и пробы через шлюз не идут', () => {
    const { out } = doctor({ FAKE_GW: 'exited', FAKE_API: DIRECT, FAKE_TOKEN: DIRECT_TOKEN })
    expect(out).toMatch(/OK.*Приорбанк напрямую/)
    // Ветка запущенного шлюза печатает строки про allowlist и про неразрешённый путь при любом
    // исходе — по их отсутствию и видно, что её не было.
    expect(out).not.toContain('allowlist')
    expect(out).not.toContain('неразрешённый путь')
  })

  it('backend настроен на шлюз, а шлюза нет — авария', () => {
    const { out } = doctor({ FAKE_API: GW, FAKE_TOKEN: `${GW}/token` })
    expect(out).toMatch(/ПЛОХО.*Приорбанк настроен через шлюз, а crypto-gw не развёрнут — Приорбанк стоит/)
    expect(out).toContain('API_BASE — через шлюз crypto-gw:1080')
  })

  it('шлюз остановлен, а backend на него настроен — авария, и состояние названо', () => {
    const { out } = doctor({ FAKE_GW: 'exited', FAKE_API: GW, FAKE_TOKEN: `${GW}/token` })
    expect(out).toMatch(/ПЛОХО.*а crypto-gw остановлен \(exited\)/)
  })

  it('половинчатый переезд: опрос напрямую, а продление через шлюз — авария, а не «напрямую»', () => {
    const { out } = doctor({ FAKE_API: DIRECT, FAKE_TOKEN: `${GW}/token` })
    expect(out).toMatch(/ПЛОХО.*Приорбанк настроен через шлюз/)
    expect(out).toContain('API_BASE — напрямую api.priorbank.by:9344, TOKEN_URL — через шлюз crypto-gw:1080')
    expect(out).not.toMatch(/OK.*Приорбанк напрямую/)
  })

  it('схема в верхнем регистре — тот же шлюз (URL её нормализует, как и приложение)', () => {
    const { out } = doctor({ FAKE_API: 'HTTP://CRYPTO-GW:1080', FAKE_TOKEN: DIRECT_TOKEN })
    expect(out).toMatch(/ПЛОХО.*через шлюз crypto-gw:1080/)
  })

  it('печатается только хост: учётные данные, путь и запрос из адреса в терминал не попадают', () => {
    const { out } = doctor({ FAKE_API: 'https://someone:s3cret@api.priorbank.by:9344/api?k=v', FAKE_TOKEN: DIRECT_TOKEN })
    expect(out).toMatch(/OK.*Приорбанк напрямую \(api\.priorbank\.by:9344\)/)
    expect(out).not.toContain('s3cret')
    expect(out).not.toContain('someone')
    expect(out).not.toContain('k=v')
  })

  it('адрес не разбирается — авария с объяснением, а не «напрямую»', () => {
    const { out } = doctor({ FAKE_API: 'api.priorbank.by:9344', FAKE_TOKEN: DIRECT_TOKEN })
    expect(out).toMatch(/ПЛОХО.*адрес Приорбанка не разбирается/)
    expect(out).toContain('API_BASE — не разбирается как адрес')
  })

  it('Приорбанк не настроен — так и сказано, это норма', () => {
    const { out } = doctor({ FAKE_API: '', FAKE_TOKEN: '' })
    expect(out).toMatch(/OK.*crypto-gw не используется — Приорбанк на этом сервере не настроен/)
  })

  it('задан только один адрес — предупреждение о половинчатой настройке', () => {
    const { out } = doctor({ FAKE_API: DIRECT, FAKE_TOKEN: '' })
    expect(out).toContain('Приорбанк настроен наполовину (API_BASE — напрямую api.priorbank.by:9344, TOKEN_URL — не задан)')
    expect(out).not.toMatch(/OK.*Приорбанк/)
  })

  it('backend не ответил — «не проверить», а не «не настроен»; шум docker в терминал не идёт', () => {
    const { out, err } = doctor({ FAKE_EXEC_RC: '1' })
    expect(out).toContain('crypto-gw не развёрнут; нужен ли он, не проверить — backend не ответил на exec')
    expect(out).not.toContain('Приорбанк на этом сервере не настроен')
    expect(err).not.toContain('OCI-NOISE')
  })
})

describe('шлюз запущен — проверяется сам шлюз', () => {
  it.each(['running', 'restarting'])('%s: пробы идут, вердикт «шлюза нет» не печатается', (state) => {
    const { out } = doctor({ FAKE_GW: state, FAKE_API: GW, FAKE_TOKEN: `${GW}/token` })
    expect(out).toContain('банк отвечает через шлюз')
    expect(out).toContain('неразрешённый путь отбивается шлюзом')
    expect(out).not.toContain('crypto-gw не используется')
    expect(out).not.toContain('Приорбанк настроен через шлюз, а crypto-gw')
  })
})
