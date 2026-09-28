import { describe, expect, it } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildRegistrationMetadata } from '../app/utils/priorOauth'

// Своя регистрация Приорбанка на сервере клиента (`make prior-register`). Та же форма покрытия,
// что у prodFeedbackOn: чистые функции ИСПОЛНЯЮТСЯ, а сквозной прогон идёт через псевдотерминал
// с подставным docker и поддельным банком на localhost.
//
// ⚠ Цена ошибки здесь необратима: регистрацию у банка не поправить (`PUT /register` отвечает 500),
// а битый ключ всплывает на последнем шаге — после того как владелец счёта ввёл пароль от банка.
// Поэтому проверяется ТЕЛО, которое уходит в банк (против `buildRegistrationMetadata` — копия
// разошлась бы молча), то, что записанный в .env ключ — ровно зарегистрированный, и что при
// несовпадении сверки .env не трогается вовсе.

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/prod-prior-register.sh')

function callFn(fn: string, args: string[] = []): string {
  return execFileSync('bash', ['-c',
    `source <(sed -n '/^${fn}()/,/^}/p' "$1"); ${fn} "\${@:2}"`, '_', SCRIPT_PATH, ...args
  ], { encoding: 'utf8' })
}

function fnStatus(fn: string, args: string[]): number {
  return spawnSync('bash', ['-c',
    `source <(sed -n '/^${fn}()/,/^}/p' "$1"); ${fn} "\${@:2}"`, '_', SCRIPT_PATH, ...args
  ]).status ?? -1
}

describe('чистые функции', () => {
  it('домен: только имя хоста с точкой, без перевода строки и пути', () => {
    expect(fnStatus('valid_domain', ['bank-app.standartno.by'])).toBe(0)
    for (const bad of ['', 'localhost', 'a.by/x', 'a.by\nX=1', '-a.by', 'a..by', 'https://a.by'])
      expect(fnStatus('valid_domain', [bad]), bad).not.toBe(0)
  })

  it('ключи: ни кавычек, ни пробелов, ни $ — иначе строка .env поменяла бы смысл', () => {
    expect(fnStatus('valid_cred', ['EpHkoFUK4ZXWPKcOkTQBT21Gmxwa'])).toBe(0)
    expect(fnStatus('valid_cred', ['a+b/c=_-.~'])).toBe(0)
    for (const bad of ['', 'a b', 'a"b', 'a$b', 'a\'b', 'a\nb'])
      expect(fnStatus('valid_cred', [bad]), JSON.stringify(bad)).not.toBe(0)
  })

  it('адрес возврата — в зарегистрированной форме, со слешем на конце', () => {
    expect(callFn('redirect_uri', ['bank-app.standartno.by'])).toBe('https://bank-app.standartno.by/oauth-priorbank-by/')
  })

  it('.env: старый блок Приора снят целиком (и многострочный ключ), чужие строки на месте', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prior-env-'))
    try {
      const f = join(dir, '.env')
      writeFileSync(f, [
        'DOMAIN=x.by',
        'PRIOR_OAUTH_CLIENT_ID=old',
        'PRIOR_OAUTH_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
        'AAAA',
        '-----END PRIVATE KEY-----"',
        'ALFA_OAUTH_CLIENT_ID=alfa',
        'export PRIOR_OAUTH_KID=k0',
        'PRIOR_OAUTH_REQUEST_TYP=JWT',
        'PRIOR_OAUTH_AUTHORIZE_BASE=https://old'
      ].join('\n'))
      execFileSync('bash', ['-c',
        `source <(sed -n '/^rewrite_env()/,/^}/p' "$1"); ENV_TMP=; rewrite_env "$2" "$3"`,
        '_', SCRIPT_PATH, f, 'PRIOR_OAUTH_CLIENT_ID=new'])
      expect(readFileSync(f, 'utf8')).toBe(
        'DOMAIN=x.by\nALFA_OAUTH_CLIENT_ID=alfa\nPRIOR_OAUTH_REQUEST_TYP=JWT\nPRIOR_OAUTH_CLIENT_ID=new\n')
      expect(readdirSync(dir)).toEqual(['.env'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('.env: однострочный ключ с \\n снимается одной строкой, следующая строка цела', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prior-env-'))
    try {
      const f = join(dir, '.env')
      writeFileSync(f, 'PRIOR_OAUTH_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nAA\\n-----END PRIVATE KEY-----\\n"\nNEXT=1\n')
      execFileSync('bash', ['-c',
        `source <(sed -n '/^rewrite_env()/,/^}/p' "$1"); ENV_TMP=; rewrite_env "$2" "$3"`,
        '_', SCRIPT_PATH, f, 'X=1'])
      expect(readFileSync(f, 'utf8')).toBe('NEXT=1\nX=1\n')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ── Поддельный банк: отдельный процесс, потому что сквозной прогон блокирует event loop ────────
const FAKE_BANK = String.raw`
const http = require('http'), fs = require('fs')
const log = process.env.BANK_LOG, mode = process.env.BANK_MODE || 'ok'
let stored = null
http.createServer((req, res) => {
  let body = ''
  req.on('data', d => body += d).on('end', () => {
    fs.appendFileSync(log + '/requests', req.method + ' ' + req.url + ' ' + (req.headers.authorization || '') + '\n')
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (req.url === '/open-banking-authorize/v1.0/oauth2/token') {
      if (mode === 'badtech') return send(401, { error: 'invalid_client' })
      return send(200, { access_token: 'tokA', token_type: 'Bearer' })
    }
    if (req.method === 'POST' && req.url === '/open-banking-dcr/v1.0/register') {
      fs.writeFileSync(log + '/register', body)
      if (mode === 'dup') return send(409, { error: 'conflict' })
      stored = JSON.parse(body)
      if (mode === 'otherkey') stored.jwks = JSON.stringify({ keys: [{ kty: 'RSA', kid: 'client-key-1', n: 'x'.repeat(342), e: 'AQAB' }] })
      return send(201, { client_id: 'NEWclientID123', client_secret: 'NEWsecret456' })
    }
    if (req.method === 'GET' && req.url === '/open-banking-dcr/v1.0/register/NEWclientID123') return send(200, stored)
    send(404, {})
  })
}).listen(0, '127.0.0.1', function () { process.stdout.write('PORT ' + this.address().port + '\n') })
`

// Подставной docker: `exec -T backend node …` исполняет настоящий node (тот же код, что пойдёт в
// контейнер), `exec -T db …` отвечает числом подключённых счетов.
const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG/docker"
case "$*" in
  *" db "*) printf '%s\n' "$FAKE_CONNECTED" ;;
  *" backend node "*) while [ "$1" != node ]; do shift; done; exec node "${'$'}{@:2}" ;;
esac
`

const PTY_HARNESS = String.raw`
import json, os, pty, select, sys, termios, time
script, answers = sys.argv[1], json.loads(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    a = termios.tcgetattr(0); a[3] &= ~termios.ECHO; termios.tcsetattr(0, termios.TCSANOW, a)
    os.execvp('bash', ['bash', '-c', 'exec 3>"$FP_OUT"; exec bash "$0" "docker compose"', script])
buf, pos, k, deadline = b'', 0, 0, time.time() + 60
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

const TECH_SECRET = 'TechSecretQwerty789'
const ENV_BEFORE = 'DOMAIN=bank-app.example.by\nPRIOR_OAUTH_CLIENT_ID=OURS\nPRIOR_OAUTH_KID=prior-key-1\nALFA_OAUTH_CLIENT_ID=alfa\n'

async function e2e(opts: { mode?: string, connected?: string, confirm?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prior-reg-'))
  const bin = join(dir, 'bin'), log = join(dir, 'log'), stack = join(dir, 'stack')
  for (const d of [bin, log, stack]) mkdirSync(d)
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER)
  chmodSync(join(bin, 'docker'), 0o755)
  writeFileSync(join(stack, '.env'), ENV_BEFORE)
  const bank = spawn(process.execPath, ['-e', FAKE_BANK], { env: { ...process.env, BANK_LOG: log, BANK_MODE: opts.mode ?? 'ok' } })
  try {
    const port = await new Promise<string>((ok, fail) => {
      bank.stdout.on('data', (d) => {
        const m = /PORT (\d+)/.exec(String(d))
        if (m) ok(m[1])
      })
      bank.on('error', fail)
    })
    const answers = [
      ['«да»', opts.confirm ?? 'да'],
      ['Имя приложения', ''],
      ['client_id техприложения', 'TechID123'],
      ['не отображается', TECH_SECRET]
    ]
    const fp = join(dir, 'fp')
    const r = spawnSync('python3', ['-c', PTY_HARNESS, SCRIPT_PATH, JSON.stringify(answers)], {
      cwd: stack, encoding: 'utf8', timeout: 90_000,
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log,
        FAKE_CONNECTED: opts.connected ?? '0', PRIOR_DCR_BASE: `http://127.0.0.1:${port}`, FP_OUT: fp
      }
    })
    const read = (f: string) => {
      try {
        return readFileSync(f, 'utf8')
      } catch {
        return ''
      }
    }
    return {
      code: r.status, out: r.stdout,
      env: read(join(stack, '.env')),
      backups: readdirSync(stack).filter(f => f.startsWith('.env.bak.')).map(f => read(join(stack, f))),
      leftovers: readdirSync(stack).filter(f => f.startsWith('.env.') && !f.startsWith('.env.bak.')),
      register: read(join(log, 'register')), requests: read(join(log, 'requests')),
      docker: read(join(log, 'docker')), fp: read(fp)
    }
  } finally {
    bank.kill()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Значение строки .env; ключ — со снятыми кавычками и развёрнутыми `\n`, как это делает compose. */
function envVal(env: string, key: string): string {
  const line = env.split('\n').find(l => l.startsWith(`${key}=`)) ?? ''
  return line.slice(key.length + 1).replace(/^"(.*)"$/, '$1').replace(/\\n/g, '\n')
}

describe('сквозной прогон', () => {
  it('регистрация: тело = buildRegistrationMetadata, в .env ровно зарегистрированный ключ, секреты не на экране', async () => {
    const r = await e2e()
    expect(r.code, r.out).toBe(0)

    // Тело регистрации — то же, что собрал бы код приложения.
    const sent = JSON.parse(r.register)
    const jwks = JSON.parse(sent.jwks)
    expect(sent).toEqual(buildRegistrationMetadata({
      clientName: 'Импорт выписки в Bitrix24 (bank-app.example.by)',
      redirectUri: 'https://bank-app.example.by/oauth-priorbank-by/',
      jwks,
      tokenEndpointAuthMethod: 'private_key_jwt'
    }))
    expect(jwks.keys[0].kid).toBe('client-key-1')

    // Токен A — Basic техприложения; чтение обратно — по токену A и со слешем перед id.
    expect(r.requests).toContain(`POST /open-banking-authorize/v1.0/oauth2/token Basic ${Buffer.from(`TechID123:${TECH_SECRET}`).toString('base64')}`)
    expect(r.requests).toContain('GET /open-banking-dcr/v1.0/register/NEWclientID123 Bearer tokA')

    // .env: старый блок Приора снят, чужие строки на месте, ключ — тот, чей модуль ушёл в банк.
    expect(r.env).toContain('ALFA_OAUTH_CLIENT_ID=alfa\n')
    expect(r.env).not.toContain('OURS')
    expect(r.env).not.toContain('prior-key-1')
    expect(envVal(r.env, 'PRIOR_OAUTH_CLIENT_ID')).toBe('NEWclientID123')
    expect(envVal(r.env, 'PRIOR_OAUTH_CLIENT_SECRET')).toBe('NEWsecret456')
    expect(envVal(r.env, 'PRIOR_OAUTH_AUTH_METHOD')).toBe('private_key_jwt')
    expect(envVal(r.env, 'PRIOR_OAUTH_REDIRECT_URI')).toBe('https://bank-app.example.by/oauth-priorbank-by/')
    expect(envVal(r.env, 'PRIOR_OAUTH_AUDIENCE')).toBe('https://api.priorbank.by:9544/oauth2/token')
    expect(envVal(r.env, 'PRIOR_OAUTH_KID')).toBe('client-key-1')
    const pem = envVal(r.env, 'PRIOR_OAUTH_PRIVATE_KEY')
    const n = createPublicKey(createPrivateKey(pem)).export({ format: 'jwk' }).n ?? ''
    expect(n).toBe(jwks.keys[0].n)
    expect(r.backups).toEqual([ENV_BEFORE])
    expect(r.leftovers).toEqual([])
    expect(r.fp).toMatch(/^[0-9a-f]{16}$/)

    // На экран — client_id, но не секреты и не ключ.
    expect(r.out).toContain('NEWclientID123')
    for (const secret of [TECH_SECRET, 'NEWsecret456', 'PRIVATE KEY', n.slice(0, 40)]) expect(r.out).not.toContain(secret)
    // Секрет техприложения не ушёл в аргументы docker (они видны через /proc).
    expect(r.docker).not.toContain(TECH_SECRET)
  }, 120_000)

  it('в банке оказался другой ключ — .env не тронут', async () => {
    const r = await e2e({ mode: 'otherkey' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('ДРУГОЙ ключ')
    expect(r.env).toBe(ENV_BEFORE)
    expect(r.backups).toEqual([])
  }, 120_000)

  it('имя занято (409) — подсказка про имя, .env не тронут', async () => {
    const r = await e2e({ mode: 'dup' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('другое имя')
    expect(r.env).toBe(ENV_BEFORE)
  }, 120_000)

  it('неверные ключи техприложения — до регистрации не доходит', async () => {
    const r = await e2e({ mode: 'badtech' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('ПРОМЫШЛЕННЫЕ')
    expect(r.register).toBe('')
    expect(r.env).toBe(ENV_BEFORE)
  }, 120_000)

  it('подключённые счета — предупреждает, без «да» ничего не делает', async () => {
    const r = await e2e({ connected: '2', confirm: 'нет' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('Подключённых счетов Приорбанка: 2')
    expect(r.requests).toBe('')
    expect(r.env).toBe(ENV_BEFORE)
  }, 120_000)
})

// Однострочный ключ с `\n` должен дойти до контейнера НАСТОЯЩИМ PEM — это делает docker compose,
// а не мы. Проверяется самим compose (`config` работает без демона); где его нет — пропуск.
const hasCompose = spawnSync('docker', ['compose', 'version']).status === 0
describe.skipIf(!hasCompose)('docker compose разворачивает ключ из .env', () => {
  it('env_block → compose → читаемый ключ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prior-compose-'))
    try {
      const pem = execFileSync(process.execPath, ['-e',
        'process.stdout.write(require("crypto").generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}))'
      ], { encoding: 'utf8' })
      const line = `${pem.trim().split('\n').join('\\n')}\\n`
      const block = execFileSync('bash', ['-c',
        `source <(sed -n '/^env_block()/,/^}/p;/^redirect_uri()/,/^}/p;/^PRIOR_[A-Z_]*=/p' "$1"); env_block ID SEC x.by "$2"`,
        '_', SCRIPT_PATH, line], { encoding: 'utf8' })
      writeFileSync(join(dir, '.env'), `${block}\n`)
      writeFileSync(join(dir, 'docker-compose.yml'),
        'services:\n  a:\n    image: x\n    environment:\n      K: ${PRIOR_OAUTH_PRIVATE_KEY:-}\n      T: ${PRIOR_OAUTH_TOKEN_URL:-}\n')
      const cfg = JSON.parse(execFileSync('docker', ['compose', 'config', '--format', 'json'], { cwd: dir, encoding: 'utf8' }))
      expect(cfg.services.a.environment.K).toBe(pem)
      expect(cfg.services.a.environment.T).toBe('https://api.priorbank.by:9344/open-banking-authorize/v1.0/oauth2/token')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// После перезапуска: ключ в контейнерах — именно зарегистрированный (отпечаток сравнивается).
describe('--verify', () => {
  function verify(want: string, env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'prior-verify-'))
    try {
      writeFileSync(join(dir, 'docker'),
        '#!/usr/bin/env bash\nwhile [ "$1" != node ]; do shift; done; exec node "${@:2}"\n')
      chmodSync(join(dir, 'docker'), 0o755)
      return spawnSync('bash', [SCRIPT_PATH, '--verify', 'docker compose', want], {
        encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, VERIFY_TRIES: '1', ...env }
      })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  const pem = execFileSync(process.execPath, ['-e',
    'process.stdout.write(require("crypto").generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}))'
  ], { encoding: 'utf8' })
  const fp = execFileSync(process.execPath, ['-e',
    'const c=require("crypto");const n=c.createPublicKey(c.createPrivateKey(process.env.K)).export({format:"jwk"}).n;process.stdout.write(c.createHash("sha256").update(n).digest("hex").slice(0,16))'
  ], { encoding: 'utf8', env: { ...process.env, K: pem } })
  const good = { PRIOR_OAUTH_PRIVATE_KEY: pem, PRIOR_OAUTH_AUTH_METHOD: 'private_key_jwt', PRIOR_OAUTH_CLIENT_ID: 'id' }

  it('ключ тот — зелёный, дальше подсказка про подписки', () => {
    const r = verify(fp, good)
    expect(r.status, r.stdout).toBe(0)
    expect(r.stdout).toContain('✓ backend')
    expect(r.stdout).toContain('✓ worker')
    expect(r.stdout).toContain('make prior-probe')
  })

  it('ключ другой / не читается / метод не тот — красный', () => {
    expect(verify('0000000000000000', good).stdout).toContain('НЕ тот')
    expect(verify(fp, { ...good, PRIOR_OAUTH_PRIVATE_KEY: 'мусор' }).stdout).toContain('не читается')
    expect(verify(fp, { ...good, PRIOR_OAUTH_AUTH_METHOD: 'client_secret_basic' }).status).toBe(1)
  })
})
