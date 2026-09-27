import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Включение канала обратной связи (#499) — та же форма покрытия, что у соседних серверных скриптов:
// чистые функции вырезаются из файла `sed`-диапазоном и ИСПОЛНЯЮТСЯ, а не грепаются.
//
// ⚠ Цена ошибки здесь не «канал не включился», а обратная: канал выглядит включённым и молча теряет
// отзывы (4xx от GitHub outbox считает окончательным), либо финансовые данные клиентов уезжают в
// ПУБЛИЧНЫЙ репозиторий. Поэтому проверяются именно вердикты и запись `.env`, а не упоминания.

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/prod-feedback-on.sh')

/** Вызвать одну функцию скрипта, вырезав её `sed`-диапазоном (приём из prodAlfaPageProbe.test.ts). */
function callFn(fn: string, args: string[] = [], cwd?: string): string {
  return execFileSync('bash', ['-c',
    `source <(sed -n '/^${fn}()/,/^}/p' "$1"); ${fn} "\${@:2}"`, '_', SCRIPT_PATH, ...args
  ], { encoding: 'utf8', cwd })
}

/** Код возврата функции-предиката. */
function fnStatus(fn: string, args: string[]): number {
  return spawnSync('bash', ['-c',
    `source <(sed -n '/^${fn}()/,/^}/p' "$1"); ${fn} "\${@:2}"`, '_', SCRIPT_PATH, ...args
  ]).status ?? -1
}

const FINE = `github_pat_${'A1b2C3d4E5'.repeat(8)}xy`

describe('чистые функции', () => {
  it('имя репозитория: владелец/имя, без выхода из пути', () => {
    expect(fnStatus('valid_repo', ['bx-shef/client-bank-feedback'])).toBe(0)
    expect(fnStatus('valid_repo', ['bx-shef/client-bank-feedback-x.y_z'])).toBe(0)
    // ⚠ `..` уходит в путь запроса, а curl схлопывает `/../` сам — токен ушёл бы на другой адрес API.
    for (const bad of ['bx-shef/..', 'bx-shef/../x', '../x', 'bx-shef/.', 'bx-shef', 'a/b/c',
      'bx-shef/имя', 'bx-shef/a b', '', 'bx-shef/a"b']) {
      expect(fnStatus('valid_repo', [bad]), bad || '<пусто>').toBe(1)
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

  it('репозиторий: «ок» только при ЯВНОМ private:true', () => {
    expect(callFn('repo_verdict', ['200', '{"id":1,\n  "private": true,\n  "name":"x"}'])).toBe('ok')
    expect(callFn('repo_verdict', ['200', '{"private": false}'])).toBe('public')
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

  it('тело проверочной задачи — валидный JSON при любом DOMAIN', () => {
    const ok = JSON.parse(callFn('issue_json', ['bank-import.example.by']))
    expect(ok.body).toContain('bank-import.example.by')
    // Значение из `.env` с кавычкой не должно ломать JSON — вместо него нейтральная подпись.
    const odd = JSON.parse(callFn('issue_json', ['x"y']))
    expect(odd.body).not.toContain('x"y')
    expect(JSON.parse(callFn('issue_json', ['']))).toHaveProperty('title')
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
})

describe('запись .env', () => {
  it('старые строки канала заменяются, остальное цело, права сохраняются', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-env-'))
    try {
      const env = join(dir, '.env')
      // Последняя строка БЕЗ перевода строки — её нельзя склеить с добавленной.
      writeFileSync(env, 'DOMAIN=x.by\nGITHUB_FEEDBACK_REPO=old/repo\n  export GITHUB_FEEDBACK_TOKEN = github_pat_old\nLAST=1')
      chmodSync(env, 0o600)
      callFn('rewrite_env', [env, 'bx-shef/client-bank-feedback', FINE])
      const lines = readFileSync(env, 'utf8').split('\n')
      expect(lines).toEqual(['DOMAIN=x.by', 'LAST=1',
        'GITHUB_FEEDBACK_REPO=bx-shef/client-bank-feedback', `GITHUB_FEEDBACK_TOKEN=${FINE}`, ''])
      expect(statSync(env).mode & 0o777).toBe(0o600)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

/** Запустить скрипт целиком в каталоге `dir` (stdin — не терминал, как у тестового процесса). */
function run(dir: string, env: Record<string, string> = {}, args: string[] = []) {
  const r = spawnSync('bash', [SCRIPT_PATH, ...args], {
    cwd: dir, encoding: 'utf8', input: '', env: { ...process.env, REPO: '', ...env }
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('отказы до ввода токена', () => {
  it('без .env — отказ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-noenv-'))
    try {
      const r = run(dir)
      expect(r.code).toBe(1)
      expect(r.out).toContain('.env не найден')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('кривое имя репозитория — отказ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-repo-'))
    try {
      writeFileSync(join(dir, '.env'), 'DOMAIN=x.by\n')
      const r = run(dir, { REPO: 'bx-shef/../other' })
      expect(r.code).toBe(2)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('сервер клиента с общим репозиторием — отказ: токен читал бы чужие отзывы', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-client-'))
    try {
      writeFileSync(join(dir, '.env'), 'DOMAIN=x.by\n')
      mkdirSync(join(dir, 'src', '.git'), { recursive: true })
      const shared = run(dir)
      expect(shared.code).toBe(2)
      expect(shared.out).toContain('СВОЙ приватный репозиторий')
      // Свой репозиторий этот запрет проходит и упирается уже в ввод токена.
      const own = run(dir, { REPO: 'bx-shef/client-bank-feedback-x' })
      expect(own.out).not.toContain('СВОЙ приватный репозиторий')
      expect(own.out).toContain('с клавиатуры')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('без терминала токен не спрашивается — иначе его подали бы пайпом, через историю', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-tty-'))
    try {
      writeFileSync(join(dir, '.env'), 'DOMAIN=x.by\n')
      const r = run(dir)
      expect(r.code).toBe(2)
      expect(r.out).toContain('с клавиатуры')
      // До записи дело не дошло.
      expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('DOMAIN=x.by\n')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('проверка после перезапуска (--verify)', () => {
  /** Подставной `docker`: отвечает за backend и worker так, как велит окружение. */
  function withFakeDocker(backend: string, workerOk: boolean, fn: (dir: string, path: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'fb-verify-'))
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'docker'), [
        '#!/usr/bin/env bash',
        'case " $* " in',
        `  *" backend node "*) printf '%s' '${backend}' ;;`,
        `  *" worker sh "*) exit ${workerOk ? 0 : 1} ;;`,
        '  *) exit 3 ;;',
        'esac'
      ].join('\n'))
      chmodSync(join(bin, 'docker'), 0o755)
      fn(dir, `${bin}:${process.env.PATH}`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('оба контейнера получили переменные — успех', () => {
    withFakeDocker('{"enabled":true}', true, (dir, path) => {
      const r = run(dir, { PATH: path, VERIFY_TRIES: '1' }, ['--verify', 'docker compose'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('✓ backend')
      expect(r.out).toContain('✓ worker')
    })
  })

  it('backend говорит «выключен» — провал, а не зелёная строка', () => {
    withFakeDocker('{"enabled":false}', true, (dir, path) => {
      const r = run(dir, { PATH: path, VERIFY_TRIES: '1' }, ['--verify', 'docker compose'])
      expect(r.code).toBe(1)
      expect(r.out).toContain('ВЫКЛЮЧЕН')
    })
  })

  it('до воркера переменные не дошли — провал: включённый наполовину канал выглядит включённым', () => {
    withFakeDocker('{"enabled":true}', false, (dir, path) => {
      const r = run(dir, { PATH: path, VERIFY_TRIES: '1' }, ['--verify', 'docker compose'])
      expect(r.code).toBe(1)
      expect(r.out).toContain('✗ worker')
    })
  })
})

describe('цель make', () => {
  const MAKEFILE = readFileSync(resolve(import.meta.dirname, '../Makefile'), 'utf8')
  const start = MAKEFILE.indexOf('\nfeedback-on:')
  const end = MAKEFILE.indexOf('\n\n', start + 1)
  // Только сама цель: цель, дописанная следом, не должна ни ронять, ни проходить эти проверки.
  const recipe = MAKEFILE.slice(start, end === -1 ? undefined : end)

  it('перезапуск — up -d обоих контейнеров, затем проверка', () => {
    // ⚠ `restart` не перечитывает `.env` — канал остался бы выключенным при зелёной команде.
    expect(recipe).toMatch(/\$\(DC\) up -d backend worker/)
    expect(recipe).not.toMatch(/restart/)
    expect(recipe).toContain('--verify "$(DC)"')
  })

  it('токен в рецепт не передаётся ничем, кроме клавиатуры', () => {
    expect(recipe).not.toMatch(/TOKEN/)
  })
})

// ── Сквозной прогон: псевдотерминал + подставной curl ─────────────────────────────────────────
// ⚠ Токен читается только с терминала (`[ -t 0 ]`), поэтому основной поток без терминала не
// запустить вовсе. Терминал даёт python3 (`pty`), а не `script(1)`: тот пишет ввод в терминал
// сразу, раньше, чем `read -s` выключит эхо, — и токен попадал бы в вывод НАШИМ ЖЕ стендом
// (замерено). Здесь эхо выключено до запуска скрипта, поэтому токен в выводе означал бы одно:
// его напечатал сам скрипт.
const PTY_HARNESS = String.raw`
import os, pty, select, sys, termios, time
script, token = sys.argv[1], sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    a = termios.tcgetattr(0); a[3] &= ~termios.ECHO; termios.tcsetattr(0, termios.TCSANOW, a)
    os.execvp('bash', ['bash', script])
buf, sent, deadline = b'', False, time.time() + 30
while time.time() < deadline:
    if select.select([fd], [], [], 0.1)[0]:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        if not sent and 'не отображается'.encode() in buf:
            os.write(fd, token.encode() + b'\n'); sent = True
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

interface E2eOpts { repoCode?: string, repoBody?: string, issueCode?: string, closeCode?: string, token?: string }

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
    const r = spawnSync('python3', ['-c', PTY_HARNESS, SCRIPT_PATH, opts.token ?? FINE], {
      cwd: stack, encoding: 'utf8', timeout: 60_000,
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, REPO: '', FAKE_LOG: log,
        FAKE_REPO_CODE: opts.repoCode ?? '200', FAKE_REPO_BODY: opts.repoBody ?? '{"id": 1, "private": true}',
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
    expect(r.env).toBe(`DOMAIN=bank.example.by\nGITHUB_FEEDBACK_REPO=bx-shef/client-bank-feedback\nGITHUB_FEEDBACK_TOKEN=${FINE}\n`)
    expect(r.backups).toEqual([ENV_BEFORE])
    expect(r.configs).toContain('url = "https://api.github.com/repos/bx-shef/client-bank-feedback/issues/7"')
    expect(r.data).toContain('bank.example.by')
    expect(r.data).toContain('"state":"closed"')
    // ⚠ Токен: не в выводе, не в аргументах curl (их видит любой процесс), только в заголовке конфига.
    expect(r.out).not.toContain(FINE)
    expect(r.out).toContain(`длина ${FINE.length}`)
    expect(r.argv.trim().split('\n')).toEqual(['-K -', '-K -', '-K -'])
    const withToken = r.configs.split('\n').filter(l => l.includes(FINE))
    expect(withToken).toEqual(Array(3).fill(`header = "Authorization: Bearer ${FINE}"`))
  })

  it('публичный репозиторий — ни задачи в нём, ни записи в .env', () => {
    const r = e2e({ repoBody: '{"private": false}' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('ПУБЛИЧНЫЙ')
    expect(r.methods).toEqual(['GET'])
    expect(r.env).toBe(ENV_BEFORE)
    expect(r.backups).toEqual([])
  })

  it('нет права заводить задачи — .env не тронут: иначе outbox молча терял бы каждый отзыв', () => {
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
})
