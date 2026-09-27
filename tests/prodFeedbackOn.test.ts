import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Включение канала обратной связи (#499) — та же форма покрытия, что у соседних серверных скриптов:
// чистые функции вырезаются из файла `sed`-диапазоном и ИСПОЛНЯЮТСЯ, а не грепаются.
//
// ⚠ Цена ошибки здесь не «канал не включился», а обратная: канал выглядит включённым и теряет
// отзывы (сотрудник упирается в ошибку, сигналы программы пропадают без следа), либо финансовые
// данные клиентов уезжают в ПУБЛИЧНЫЙ репозиторий. Поэтому проверяются вердикты, запись `.env` и
// сквозной прогон, а не упоминания.
// ⚠ Сквозной прогон требует python3 (модуль `pty`): он есть в ubuntu-24.04, на котором идёт CI.

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/prod-feedback-on.sh')

/** Вызвать одну функцию скрипта, вырезав её `sed`-диапазоном (приём из prodAlfaPageProbe.test.ts). */
function callFn(fn: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('bash', ['-c',
    `source <(sed -n '/^${fn}()/,/^}/p' "$1"); ${fn} "\${@:2}"`, '_', SCRIPT_PATH, ...args
  ], { encoding: 'utf8', env })
}

/** Код возврата функции-предиката. */
function fnStatus(fn: string, args: string[]): number {
  return spawnSync('bash', ['-c',
    `source <(sed -n '/^${fn}()/,/^}/p' "$1"); ${fn} "\${@:2}"`, '_', SCRIPT_PATH, ...args
  ]).status ?? -1
}

const FINE = `github_pat_${'A1b2C3d4E5'.repeat(8)}xy`
// Имя репозитория — вымышленное: настоящее имя приёмника в публичный репозиторий не пишем.
const REPO = 'acme/feedback-inbox'

describe('чистые функции', () => {
  it('срезаются \\r и пробелы по краям — их приносит вставка с телефона', () => {
    expect(callFn('trim', ['  acme/feedback-inbox \r'])).toBe(REPO)
    expect(callFn('trim', ['\tx y\n'])).toBe('x y')
    expect(callFn('trim', [''])).toBe('')
  })

  it('имя репозитория: владелец/имя, без выхода из пути и без перевода строки', () => {
    expect(fnStatus('valid_repo', [REPO])).toBe(0)
    expect(fnStatus('valid_repo', ['acme/feedback-inbox-x.y_z'])).toBe(0)
    // ⚠ `..` уходит в путь запроса, а curl схлопывает `/../` сам — токен ушёл бы на другой адрес API.
    // ⚠ Перевод строки дописал бы директиву в конфиг curl и строку в .env.
    for (const bad of ['acme/..', 'acme/../x', '../x', 'acme/.', 'acme', 'a/b/c',
      'acme/имя', 'acme/a b', '', 'acme/a"b', 'acme/x\nGITHUB_FEEDBACK_TOKEN=evil']) {
      expect(fnStatus('valid_repo', [bad]), JSON.stringify(bad)).toBe(1)
    }
  })

  it('токен: только fine-grained, алфавит проверяется явно', () => {
    expect(callFn('token_kind', [FINE])).toBe('fine')
    // Классический токен действует на весь аккаунт — сюда не годится.
    expect(callFn('token_kind', [`ghp_${'a'.repeat(36)}`])).toBe('classic')
    // ⚠ Кавычка, пробел или перевод строки внутри значения меняли бы смысл конфига curl и `.env`.
    for (const bad of [`${FINE}"`, `${FINE} x`, `${FINE}\nX=1`, 'github_pat_short', '', 'token']) {
      expect(callFn('token_kind', [bad]), JSON.stringify(bad)).toBe('bad')
    }
  })

  it('репозиторий: «ок» только у приватного, не internal и не в архиве', () => {
    expect(callFn('repo_verdict', ['200', '{"id":1,\n  "private": true,\n  "name":"x"}'])).toBe('ok')
    expect(callFn('repo_verdict', ['200', '{"private": false}'])).toBe('public')
    // ⚠ Публичный репозиторий из приватного шаблона: `"private":true` есть, но во вложенном объекте.
    const fromTemplate = '{"id":1,"owner":{"login":"o","type":"Organization"},"private":false,'
      + '"description":"x","visibility":"public","template_repository":{"id":2,"private":true,"visibility":"private"}}'
    expect(callFn('repo_verdict', ['200', fromTemplate])).toBe('public')
    // ⚠ internal отвечает private:true, но его читает весь enterprise.
    expect(callFn('repo_verdict', ['200', '{"private":true,"archived":false,"visibility":"internal"}'])).toBe('internal')
    expect(callFn('repo_verdict', ['200', '{"private":true,"archived":true,"visibility":"private"}'])).toBe('archived')
    // Вложенный объект в архиве, сам репозиторий — нет.
    expect(callFn('repo_verdict', ['200', '{"private":true,"archived":false,"visibility":"private","parent":{"archived":true}}'])).toBe('ok')
    // ⚠ Нечитаемое тело — не повод считать репозиторий приватным.
    expect(callFn('repo_verdict', ['200', '<html>'])).toBe('unexpected')
    expect(callFn('repo_verdict', ['401', ''])).toBe('unauthorized')
    expect(callFn('repo_verdict', ['403', ''])).toBe('forbidden')
    expect(callFn('repo_verdict', ['404', ''])).toBe('notfound')
    expect(callFn('repo_verdict', ['000', ''])).toBe('unreachable')
    expect(callFn('repo_verdict', ['', ''])).toBe('unreachable')
    expect(callFn('repo_verdict', ['500', ''])).toBe('unexpected')
  })

  it('задача: права и выключенные задачи различаются', () => {
    expect(callFn('issue_verdict', ['201'])).toBe('ok')
    expect(callFn('issue_verdict', ['403'])).toBe('noperm')
    expect(callFn('issue_verdict', ['410'])).toBe('disabled')
    expect(callFn('issue_verdict', ['404'])).toBe('notfound')
    expect(callFn('issue_verdict', ['000'])).toBe('unreachable')
    expect(callFn('issue_verdict', ['422'])).toBe('unexpected')
  })

  it('номер задачи берётся из ответа GitHub', () => {
    // `cut` печатает перевод строки; скрипт читает значение через `$(…)`, которая его снимает.
    expect(callFn('issue_number', ['{"url":"u",\n  "id": 9001,\n  "number": 42,\n  "title":"t"}']).trim()).toBe('42')
    expect(callFn('issue_number', ['{"message":"Not Found"}']).trim()).toBe('')
  })

  it('тело проверочной задачи — валидный JSON без данных сервера', () => {
    const body = JSON.parse(callFn('issue_json'))
    expect(body.title).toContain('make feedback-on')
    expect(Object.keys(body)).toEqual(['title', 'body'])
  })

  it('конфиг curl: токен только в заголовке Authorization, адрес — api.github.com', () => {
    const conf = callFn('gh_config', ['POST', '/repos/o/r/issues', FINE, '/tmp/out', '/tmp/data'])
    const lines = conf.split('\n')
    expect(lines.filter(l => l.includes(FINE))).toEqual([`header = "Authorization: Bearer ${FINE}"`])
    expect(conf).toContain('url = "https://api.github.com/repos/o/r/issues"')
    expect(conf).toContain('request = "POST"')
    expect(conf).toContain('data-binary = "@/tmp/data"')
    // ⚠ Одинарный `%`: двойной ушёл бы в curl буквально, и код ответа не напечатался бы вовсе.
    expect(conf).toContain('write-out = "%{http_code}"')
    expect(conf).toContain('show-error')
    // Без тела запроса — без заголовка типа и без data.
    const get = callFn('gh_config', ['GET', '/repos/o/r', FINE, '/tmp/out'])
    expect(get).not.toContain('data-binary')
  })

  it('поле строки PROBE из контейнера', () => {
    const line = 'PROBE env=ok github=200 feedback={"enabled":true}'
    expect(callFn('probe_field', [line, 'env']).trim()).toBe('ok')
    expect(callFn('probe_field', [line, 'github']).trim()).toBe('200')
    expect(callFn('probe_field', [line, 'feedback']).trim()).toBe('{"enabled":true}')
    expect(callFn('probe_field', ['', 'feedback']).trim()).toBe('')
  })
})

describe('запись .env', () => {
  /** Каталог с `.env` и подставным `chown`, который пишет свои аргументы в журнал. */
  function withEnvFile(content: string, mode: number, fn: (env: string, chownLog: string, path: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'fb-env-'))
    try {
      const env = join(dir, '.env')
      writeFileSync(env, content)
      chmodSync(env, mode)
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      const chownLog = join(dir, 'chown.log')
      writeFileSync(join(bin, 'chown'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${chownLog}'\n`)
      chmodSync(join(bin, 'chown'), 0o755)
      fn(env, chownLog, `${bin}:${process.env.PATH}`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('старые строки канала заменяются, остальное цело, права — 600', () => {
    // Последняя строка БЕЗ перевода строки — её нельзя склеить с добавленной. Режим 644 — чтобы
    // проверка прав не совпадала с тем, что mktemp даёт и так.
    withEnvFile('DOMAIN=x.by\nGITHUB_FEEDBACK_REPO=old/repo\n  export GITHUB_FEEDBACK_TOKEN = github_pat_old\nLAST=1', 0o644,
      (env, _log, path) => {
        callFn('rewrite_env', [env, REPO, FINE], { ...process.env, PATH: path })
        expect(readFileSync(env, 'utf8').split('\n')).toEqual(['DOMAIN=x.by', 'LAST=1',
          `GITHUB_FEEDBACK_REPO=${REPO}`, `GITHUB_FEEDBACK_TOKEN=${FINE}`, ''])
        // ⚠ Файл теперь хранит ещё один секрет — шире 600 он не наследуется.
        expect(statSync(env).mode & 0o777).toBe(0o600)
      })
  })

  it('владелец переносится со старого файла — иначе запуск от root отнял бы .env у bitrix', () => {
    withEnvFile('A=1\n', 0o600, (env, chownLog, path) => {
      callFn('rewrite_env', [env, REPO, FINE], { ...process.env, PATH: path })
      expect(readFileSync(chownLog, 'utf8').trim()).toMatch(new RegExp(`^--reference=${env} ${env}\\.\\w{6}$`))
    })
  })

  // Настоящая смена владельца — только от root (в CI тесты идут не от root; подставной chown выше
  // проверяет вызов везде).
  it.skipIf(process.getuid?.() !== 0)('от root владелец .env не меняется', () => {
    withEnvFile('A=1\n', 0o600, (env) => {
      chownSync(env, 65534, 65534)
      callFn('rewrite_env', [env, REPO, FINE])
      expect(statSync(env).uid).toBe(65534)
      expect(statSync(env).gid).toBe(65534)
    })
  })
})

/** Запустить скрипт целиком в каталоге `dir` (stdin — не терминал, как у тестового процесса). */
function run(dir: string, env: Record<string, string> = {}, args: string[] = []) {
  const r = spawnSync('bash', [SCRIPT_PATH, ...args], {
    cwd: dir, encoding: 'utf8', input: '', env: { ...process.env, ...env }
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('отказы до вопросов', () => {
  it('без .env — отказ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-noenv-'))
    try {
      const r = run(dir)
      expect(r.code).toBe(1)
      expect(r.out).toContain('.env не найден')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('без терминала ничего не спрашивается — иначе токен подали бы пайпом, через историю', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-tty-'))
    try {
      writeFileSync(join(dir, '.env'), 'DOMAIN=x.by\n')
      const r = run(dir)
      expect(r.code).toBe(2)
      expect(r.out).toContain('с клавиатуры')
      expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('DOMAIN=x.by\n')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ── Сквозной прогон: псевдотерминал + подставной curl ─────────────────────────────────────────
// ⚠ Имя и токен читаются только с терминала (`[ -t 0 ]`), поэтому основной поток без терминала не
// запустить вовсе. Терминал даёт python3 (`pty`), а не `script(1)`: тот пишет ввод в терминал
// сразу, раньше, чем `read -s` выключит эхо, — и токен попадал бы в вывод НАШИМ ЖЕ стендом
// (замерено). Здесь эхо выключено до запуска скрипта, поэтому токен в выводе означал бы одно:
// его напечатал сам скрипт. Ответы подаются по одному, когда в выводе появляется свой вопрос.
const PTY_HARNESS = String.raw`
import json, os, pty, select, sys, termios, time
script, answers = sys.argv[1], json.loads(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    a = termios.tcgetattr(0); a[3] &= ~termios.ECHO; termios.tcsetattr(0, termios.TCSANOW, a)
    os.execvp('bash', ['bash', script])
buf, pos, k, deadline = b'', 0, 0, time.time() + 30
while time.time() < deadline:
    if select.select([fd], [], [], 0.1)[0]:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        while k < len(answers):
            i = buf.find(answers[k][0].encode(), pos)
            if i < 0:
                break
            pos = i + 1
            os.write(fd, answers[k][1].encode() + b'\n'); k += 1
else:
    os.kill(pid, 9)
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(buf)
sys.exit(os.waitstatus_to_exitcode(status))
`

// Подставной curl: пишет свои аргументы и конфиг в журнал и отвечает кодами из окружения.
const FAKE_CURL = String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG/argv"
conf="$(cat)"
printf '%s\n' "$conf" >> "$FAKE_LOG/configs"
method="$(printf '%s\n' "$conf" | sed -n 's/^request = "\(.*\)"$/\1/p')"
out="$(printf '%s\n' "$conf" | sed -n 's/^output = "\(.*\)"$/\1/p')"
data="$(printf '%s\n' "$conf" | sed -n 's/^data-binary = "@\(.*\)"$/\1/p')"
[ -n "$data" ] && { cat "$data"; echo; } >> "$FAKE_LOG/data"
printf '%s\n' "$method" >> "$FAKE_LOG/methods"
case "$method" in
  GET)   printf '%s' "$FAKE_REPO_BODY" > "$out"; printf '%s' "$FAKE_REPO_CODE" ;;
  POST)  printf '{"number": 7}' > "$out"; printf '%s' "$FAKE_ISSUE_CODE" ;;
  PATCH) printf '{}' > "$out"; printf '%s' "$FAKE_CLOSE_CODE" ;;
esac
`

const ENV_BEFORE = 'DOMAIN=bank.example.by\nGITHUB_FEEDBACK_TOKEN=github_pat_old\n'
const REPO_Q = 'владелец/имя'
const TOKEN_Q = 'не отображается'

interface E2eOpts {
  repo?: string
  token?: string
  repoCode?: string
  repoBody?: string
  issueCode?: string
  closeCode?: string
  clientServer?: boolean
}

function e2e(opts: E2eOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fb-e2e-'))
  try {
    const bin = join(dir, 'bin')
    const log = join(dir, 'log')
    const stack = join(dir, 'stack')
    for (const d of [bin, log, stack]) mkdirSync(d)
    writeFileSync(join(bin, 'curl'), FAKE_CURL)
    chmodSync(join(bin, 'curl'), 0o755)
    writeFileSync(join(stack, '.env'), ENV_BEFORE)
    if (opts.clientServer) mkdirSync(join(stack, 'src', '.git'), { recursive: true })
    const answers = [[REPO_Q, opts.repo ?? REPO], [TOKEN_Q, opts.token ?? FINE]]
    const r = spawnSync('python3', ['-c', PTY_HARNESS, SCRIPT_PATH, JSON.stringify(answers)], {
      cwd: stack, encoding: 'utf8', timeout: 60_000,
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log,
        FAKE_REPO_CODE: opts.repoCode ?? '200',
        FAKE_REPO_BODY: opts.repoBody ?? '{"id": 1, "private": true, "archived": false, "visibility": "private"}',
        FAKE_ISSUE_CODE: opts.issueCode ?? '201', FAKE_CLOSE_CODE: opts.closeCode ?? '200'
      }
    })
    // Журнала нет — подставной curl не вызывали ни разу.
    const logged = (f: string) => {
      try {
        return readFileSync(join(log, f), 'utf8')
      } catch {
        return ''
      }
    }
    const backups = readdirSync(stack).filter(f => f.startsWith('.env.bak.'))
    return {
      code: r.status, out: r.stdout,
      env: readFileSync(join(stack, '.env'), 'utf8'),
      // Временных файлов записи .env не осталось.
      leftovers: readdirSync(stack).filter(f => f.startsWith('.env.') && !f.startsWith('.env.bak.')),
      backups: backups.map(f => readFileSync(join(stack, f), 'utf8')),
      argv: logged('argv'), configs: logged('configs'), data: logged('data'),
      methods: logged('methods').split('\n').filter(Boolean)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('сквозной прогон', () => {
  it('обе проверки прошли — .env переписан, проверочная задача закрыта, токен нигде не напечатан', () => {
    const r = e2e()
    expect(r.code, r.out).toBe(0)
    expect(r.methods).toEqual(['GET', 'POST', 'PATCH'])
    expect(r.env).toBe(`DOMAIN=bank.example.by\nGITHUB_FEEDBACK_REPO=${REPO}\nGITHUB_FEEDBACK_TOKEN=${FINE}\n`)
    expect(r.backups).toEqual([ENV_BEFORE])
    expect(r.leftovers).toEqual([])
    expect(r.configs).toContain(`url = "https://api.github.com/repos/${REPO}/issues/7"`)
    expect(r.data).toContain('"state":"closed"')
    // Из .env в задачу не уходит ничего.
    expect(r.data).not.toContain('bank.example.by')
    // ⚠ Токен: не в выводе, не в аргументах curl (их видит любой процесс), только в заголовке конфига.
    expect(r.out).not.toContain(FINE)
    expect(r.out).toContain(`длина ${FINE.length}`)
    expect(r.argv.trim().split('\n')).toEqual(['-K -', '-K -', '-K -'])
    const withToken = r.configs.split('\n').filter(l => l.includes(FINE))
    expect(withToken).toEqual(Array(3).fill(`header = "Authorization: Bearer ${FINE}"`))
  })

  it('кривое имя репозитория — отказ до токена и до GitHub', () => {
    const r = e2e({ repo: 'acme/../other' })
    expect(r.code).toBe(2)
    expect(r.out).not.toContain(TOKEN_Q)
    expect(r.methods).toEqual([])
    expect(r.env).toBe(ENV_BEFORE)
  })

  it('публичный репозиторий — ни задачи в нём, ни записи в .env', () => {
    const r = e2e({ repoBody: '{"private": false, "visibility": "public"}' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('ПУБЛИЧНЫЙ')
    expect(r.methods).toEqual(['GET'])
    expect(r.env).toBe(ENV_BEFORE)
    expect(r.backups).toEqual([])
  })

  it('internal — тоже отказ: его читает весь enterprise', () => {
    const r = e2e({ repoBody: '{"private": true, "visibility": "internal"}' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('internal')
    expect(r.methods).toEqual(['GET'])
    expect(r.env).toBe(ENV_BEFORE)
  })

  it('нет права заводить задачи — .env не тронут', () => {
    const r = e2e({ issueCode: '403' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('Issues: Read and write')
    expect(r.env).toBe(ENV_BEFORE)
    expect(r.backups).toEqual([])
  })

  it('не закрылась проверочная задача — канал всё равно включается, номер назван', () => {
    const r = e2e({ closeCode: '500' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('закройте #7 руками')
    expect(r.env).toContain(`GITHUB_FEEDBACK_TOKEN=${FINE}`)
  })

  it('классический токен — отказ до первого запроса к GitHub', () => {
    const r = e2e({ token: `ghp_${'a'.repeat(36)}` })
    expect(r.code).toBe(2)
    expect(r.out).toContain('классический')
    expect(r.methods).toEqual([])
    expect(r.env).toBe(ENV_BEFORE)
  })

  // `\r` сюда не подаём: в терминале с ICRNL (умолчание) он превращается в конец строки раньше,
  // чем его увидит скрипт, — тест проверял бы не то, что написано в названии.
  it('вставка с телефона: пробелы по краям имени и токена срезаются', () => {
    const r = e2e({ repo: `  ${REPO} `, token: `  ${FINE} ` })
    expect(r.code, r.out).toBe(0)
    expect(r.env).toContain(`GITHUB_FEEDBACK_REPO=${REPO}\n`)
    expect(r.env).toContain(`GITHUB_FEEDBACK_TOKEN=${FINE}\n`)
  })

  it('на сервере клиента — напоминание про отдельный репозиторий до вопросов', () => {
    const r = e2e({ clientServer: true })
    expect(r.code, r.out).toBe(0)
    const reminder = r.out.indexOf('Это сервер клиента')
    expect(reminder).toBeGreaterThan(-1)
    expect(reminder).toBeLessThan(r.out.indexOf(REPO_Q))
  })
})

describe('проверка после перезапуска (--verify)', () => {
  const OK = 'PROBE env=ok github=200 feedback={"enabled":true}'
  // Баннер предзагрузки otel печатается в stdout при КАЖДОМ запуске node в образе (NODE_OPTIONS).
  const BANNER = '[otel] disabled (no OTEL_EXPORTER_OTLP_ENDPOINT) — telemetry off'

  /**
   * Подставной `docker`: печатает баннер и строку PROBE, заданную для сервиса. `FAKE_<СЕРВИС>_FIRST`
   * — ответ на первый вызов (например, пока сервис ещё стартует), дальше — `FAKE_<СЕРВИС>`.
   */
  function withFakeDocker(env: Record<string, string>, fn: (dir: string, env: Record<string, string>) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'fb-verify-'))
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'docker'), String.raw`#!/usr/bin/env bash
case " $* " in *" backend node "*) svc=BACKEND ;; *" worker node "*) svc=WORKER ;; *) exit 3 ;; esac
count="$FAKE_DIR/$svc.count"; n=$(( $(cat "$count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$count"
first="FAKE_${'$'}{svc}_FIRST"; main="FAKE_${'$'}{svc}"
echo "$FAKE_BANNER"
if [ "$n" -eq 1 ] && [ -n "${'$'}{!first+set}" ]; then printf '%s\n' "${'$'}{!first}"; else printf '%s\n' "${'$'}{!main:-}"; fi
`)
      chmodSync(join(bin, 'docker'), 0o755)
      fn(dir, { PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: dir, FAKE_BANNER: BANNER, VERIFY_TRIES: '1', ...env })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('оба контейнера видят переменные и достают до GitHub — успех', () => {
    withFakeDocker({ FAKE_BACKEND: OK, FAKE_WORKER: OK }, (dir, env) => {
      const r = run(dir, env, ['--verify', 'docker compose'])
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('✓ backend')
      expect(r.out).toContain('✓ worker')
    })
  })

  it('баннер otel — ещё не ответ: пока сервис стартует, проверка повторяется', () => {
    // ⚠ Прежняя проверка считала «ответил» любой вывод и сдавалась на первой попытке.
    withFakeDocker({ FAKE_BACKEND_FIRST: '', FAKE_BACKEND: OK, FAKE_WORKER: OK, VERIFY_TRIES: '3' }, (dir, env) => {
      const r = run(dir, env, ['--verify', 'docker compose'])
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(join(dir, 'BACKEND.count'), 'utf8').trim()).toBe('2')
    })
  })

  it('backend так и не ответил — провал с понятной причиной', () => {
    withFakeDocker({ FAKE_BACKEND: '', FAKE_WORKER: OK }, (dir, env) => {
      const r = run(dir, env, ['--verify', 'docker compose'])
      expect(r.code).toBe(1)
      expect(r.out).toContain('backend не ответил')
    })
  })

  it('backend говорит «выключен» — провал, а не зелёная строка', () => {
    withFakeDocker({ FAKE_BACKEND: 'PROBE env=ok github=200 feedback={"enabled":false}', FAKE_WORKER: OK }, (dir, env) => {
      const r = run(dir, env, ['--verify', 'docker compose'])
      expect(r.code).toBe(1)
      expect(r.out).toContain('канал выключен')
    })
  })

  it('до воркера переменные не дошли — провал: включённый наполовину канал выглядит включённым', () => {
    withFakeDocker({ FAKE_BACKEND: OK, FAKE_WORKER: 'PROBE env=missing github=- feedback={"enabled":false}' }, (dir, env) => {
      const r = run(dir, env, ['--verify', 'docker compose'])
      expect(r.code).toBe(1)
      expect(r.out).toContain('✗ worker: переменных канала нет')
    })
  })

  it('из контейнера нет связи с GitHub — провал, хотя с хоста проверка прошла', () => {
    withFakeDocker({ FAKE_BACKEND: OK, FAKE_WORKER: 'PROBE env=ok github=000 feedback={"enabled":true}' }, (dir, env) => {
      const r = run(dir, env, ['--verify', 'docker compose'])
      expect(r.code).toBe(1)
      expect(r.out).toContain('✗ worker: GitHub из контейнера ответил 000')
    })
  })
})

describe('цель make', () => {
  const MAKEFILE = readFileSync(resolve(import.meta.dirname, '../Makefile'), 'utf8')
  const start = MAKEFILE.indexOf('\nfeedback-on:')
  const end = MAKEFILE.indexOf('\n\n', start + 1)
  // Только сама цель: цель, дописанная следом, не должна ни ронять, ни проходить эти проверки.
  const recipe = MAKEFILE.slice(start, end === -1 ? undefined : end)

  it('перезапуск — up -d обоих контейнеров с прежним числом воркеров, затем проверка', () => {
    // ⚠ `restart` не перечитывает `.env` — канал остался бы выключенным при зелёной команде.
    // ⚠ Без `--scale` голый `up -d` вернул бы воркеров к одной реплике.
    expect(recipe).toMatch(/\$\(DC\) up -d --scale worker=.+ backend worker/)
    expect(recipe).not.toMatch(/restart/)
    expect(recipe).toContain('--verify "$(DC)"')
  })

  it('ни имя репозитория, ни токен в рецепт не передаются — только с клавиатуры', () => {
    expect(recipe).not.toMatch(/TOKEN|REPO/)
  })
})
