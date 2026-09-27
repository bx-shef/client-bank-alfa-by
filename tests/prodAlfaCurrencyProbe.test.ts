import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'

// `make alfa-currency-probe` (#735): что API Альфы отдаёт по ВАЛЮТНОМУ счёту.
//
// Скрипт гоняется целиком: подставной `docker` отвечает за базу и запускает НАСТОЯЩИЙ node
// с программой пробы, а вместо банка — локальный HTTP-сервер. Так проверяется то, ради чего проба
// написана, а не текст скрипта:
// - ответы на четыре вопроса #735 (сверка сумм со statistics[], строки переоценки, ключи
//   statistics[], currIso против валюты счёта);
// - в выводе НЕТ сумм, назначений, контрагентов и полных номеров — его пересылают снимком;
// - токен не попадает ни в одну командную строку, а уходит через stdin.
//
// ⚠ Сервер живёт в процессе теста, поэтому скрипт запускается АСИНХРОННО: синхронный запуск
// заблокировал бы цикл событий, и сервер не ответил бы ни на один запрос.

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/prod-alfa-currency-probe.sh')

const TOKEN = 'tok-SECRET-access-0123456789'
const BYN = 'BY11ALFA30120000000000000001'
const USD = 'BY22ALFA30120000000000000002'

interface Scenario {
  accounts?: unknown
  accountsStatus?: number
  statement?: unknown
}

let server: Server
let base = ''
let scenario: Scenario = {}
let requests: { path: string, auth: string | undefined }[] = []

function revaluation(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    number: USD, operType: 'C', amount: 0, currIso: 'USD',
    operCodeName: 'Переоценка входящего остатка', docId: `R${i}`, operDate: '0' + (i + 1) + '.08.2026'
  }))
}

/** Валютный счёт как в файле #733: один настоящий приход и переоценки, обороты в двух валютах. */
function usdStatement() {
  return {
    page: [
      {
        number: USD, operType: 'C', amount: 560, currIso: 'USD', operCodeName: 'Зачисление',
        purpose: 'ОПЛАТА ПО ДОГОВОРУ СЕКРЕТ-42', corrName: 'ООО Контрагент-Тайна', corrNumber: 'BY99XXXX00000000000000000009',
        docId: 'D1', operDate: '12.08.2026'
      },
      ...revaluation(3)
    ],
    statistics: [{ number: USD, inRest: 3300, outRest: 3860, debTurnover: 0, credTurnover: 560, inRestEq: 9591.78, credTurnoverEq: 1619.86 }],
    errors: []
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', auth: req.headers.authorization })
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'invalid_token' })
    if (req.url === '/partner/1.2.0/accounts/') {
      return send(scenario.accountsStatus ?? 200, scenario.accounts ?? { accounts: [{ number: BYN, currIso: 'BYN' }, { number: USD, currIso: 'USD' }] })
    }
    if (req.url?.startsWith('/partner/1.2.0/accounts/statement?')) return send(200, scenario.statement ?? usdStatement())
    send(404, { error: 'not found' })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>(r => server.close(() => r())))

beforeEach(() => {
  scenario = {}
  requests = []
})

interface Run { code: number, out: string, err: string, dockerArgs: string }

/**
 * Прогнать скрипт с подставным `docker`. Он пишет каждый свой вызов в `docker.args`, на psql
 * отвечает строкой `row` (счёт|токен|порталов), а на node — запускает настоящий node с тем же
 * stdin, предварительно напечатав строку `[otel]`, как это делает образ.
 */
async function run(opts: { row?: string, env?: Record<string, string>, psqlFail?: boolean, apiBase?: string } = {}): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'alfa-currency-probe-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'docker'), String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_DIR/docker.args"
case " $* " in
  *" db psql "*)
    if [ -n "${'$'}{FAKE_PSQL_FAIL:-}" ]; then echo "psql: could not connect to server" >&2; exit 2; fi
    printf '%s\n' "$FAKE_ROW"; exit 0;;
  *" backend node "*)
    while [ "$#" -gt 0 ] && [ "$1" != backend ]; do shift; done; shift
    echo "[otel] disabled — no endpoint configured"
    ALFA_OAUTH_API_BASE="$FAKE_API_BASE" ALFA_OAUTH_API_PREFIX=/partner/1.2.0 exec "$@";;
esac
echo "unexpected docker call: $*" >&2
exit 99
`)
    chmodSync(join(bin, 'docker'), 0o755)
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_DIR: dir,
      FAKE_ROW: opts.row ?? `${USD}|${TOKEN}|1`,
      FAKE_PSQL_FAIL: opts.psqlFail ? '1' : '',
      FAKE_API_BASE: opts.apiBase ?? base,
      FROM: '', TO: '', B24: '',
      ...opts.env
    }
    const r = await new Promise<{ code: number, out: string, err: string }>((done) => {
      execFile('bash', [SCRIPT_PATH, 'docker compose -f x.yml'], { env, encoding: 'utf8' }, (e, out, err) => {
        done({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out, err })
      })
    })
    const argsFile = join(dir, 'docker.args')
    return { ...r, dockerArgs: existsSync(argsFile) ? readFileSync(argsFile, 'utf8') : '' }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('ответы на вопросы #735', () => {
  it('валютный счёт: переоценка, валюта, statistics и сверка сумм', async () => {
    const r = await run({ env: { FROM: '2026-08-01', TO: '2026-08-31' } })
    expect(r.code, r.out + r.err).toBe(0)
    // Видны оба счёта, валютный помечен.
    expect(r.out).toContain('BY11…0001  BYN')
    expect(r.out).toMatch(/BY22…0002 {2}USD {3}← валютный/)
    // Вопрос 2: строки переоценки приходят и названы кодом операции.
    expect(r.out).toContain('операций: 4 — приходов 4, расходов 0')
    expect(r.out).toContain('с нулевой суммой: 3 — «Переоценка входящего остатка» ×3')
    expect(r.out).toContain('Переоценка: через API ПРИХОДИТ — 3 из 4')
    // Вопрос 4: currIso против валюты счёта.
    expect(r.out).toContain('валюта операций (currIso): «USD» ×4')
    expect(r.out).toContain('4. currIso: во всех строках валюта счёта (USD)')
    // Вопросы 1 и 3: сумма прихода сошлась с оборотом в валюте счёта, а НЕ с эквивалентом.
    expect(r.out).toMatch(/statistics\[\]: ключи — credTurnover credTurnoverEq debTurnover inRest inRestEq number outRest/)
    expect(r.out).toContain('сверка приходов: совпала с credTurnover')
    expect(r.out).not.toMatch(/совпала с [^\n]*credTurnoverEq/)
    expect(r.out).toContain('сходится для inRest → outRest')
    expect(r.out).toContain('1. Валюта суммы: суммы сошлись с полями statistics')
  })

  it('в выводе нет сумм, назначений, контрагентов, полных номеров и токена', async () => {
    const r = await run()
    expect(r.code, r.out + r.err).toBe(0)
    for (const secret of ['560', '1619', '3300', '3860', '9591', 'СЕКРЕТ', 'Контрагент-Тайна', USD, BYN, 'BY99XXXX', TOKEN]) {
      expect(r.out + r.err, secret).not.toContain(secret)
    }
  })

  it('токен уходит только через stdin: ни в одной командной строке его нет', async () => {
    const r = await run()
    expect(r.code, r.out + r.err).toBe(0)
    expect(r.dockerArgs).toContain('exec -T db psql')
    expect(r.dockerArgs).not.toContain(TOKEN)
    // И банк получил именно его — то есть он действительно доехал, а не пропал по дороге.
    expect(requests.every(q => q.auth === `Bearer ${TOKEN}`)).toBe(true)
  })

  it('строка телеметрии образа не попадает в отчёт, а сама загрузка выключена', async () => {
    const r = await run()
    expect(r.dockerArgs).toContain('exec -T -e NODE_OPTIONS= backend node')
    expect(r.out).not.toContain('[otel]')
  })

  it('период уходит в банк в его формате, по одному запросу на счёт', async () => {
    await run({ env: { FROM: '2026-08-01', TO: '2026-08-31' } })
    const st = requests.filter(q => q.path.includes('/accounts/statement?'))
    expect(st).toHaveLength(1)
    expect(st[0]!.path).toContain(`number=${USD}&dateFrom=01.08.2026&dateTo=31.08.2026&transactions=0&pageNo=0&pageRowCount=0`)
    // Рублёвый счёт выписку не спрашивает: лимит банка общий на всех.
    expect(requests.some(q => q.path.includes(BYN))).toBe(false)
  })

  it('currIso не совпал с валютой счёта — названо', async () => {
    const st = usdStatement()
    st.page = st.page.map(p => ({ ...p, currIso: 'BYN' }))
    scenario.statement = st
    const r = await run()
    expect(r.out).toContain('4. currIso: отличается от валюты счёта в строках: «BYN» ×4')
  })

  it('суммы не сошлись ни с одним полем statistics — так и сказано', async () => {
    const st = usdStatement()
    st.statistics = [{ number: USD, inRest: 1, outRest: 2, debTurnover: 0, credTurnover: 7, inRestEq: 1, credTurnoverEq: 9 }]
    scenario.statement = st
    const r = await run()
    expect(r.out).toContain('сверка приходов: ни с одним полем statistics')
    expect(r.out).toContain('с полями statistics не сошлась ни одна сумма')
  })
})

describe('отказы', () => {
  it('токен отвергнут — код 2 и совет не обновлять руками', async () => {
    const r = await run({ row: `${USD}|tok-stale-0000|1` })
    expect(r.code).toBe(2)
    expect(r.out).toContain('токен отвергнут банком')
    expect(r.out).toContain('Обновлять токен руками НЕЛЬЗЯ')
  })

  it('валютных счетов ключ не видит — код 3', async () => {
    scenario.accounts = { accounts: [{ number: BYN, currIso: 'BYN' }] }
    const r = await run()
    expect(r.code).toBe(3)
    expect(r.out).toContain('Валютных счетов этот ключ не видит')
  })

  it('Альфа на нескольких порталах, портал не назван — отказ до похода в банк', async () => {
    const r = await run({ row: `${USD}|${TOKEN}|2` })
    expect(r.code).toBe(1)
    expect(r.out).toContain('Альфа подключена на 2 порталах')
    expect(r.dockerArgs).not.toContain('backend node')
  })

  it('упавшая база — не «подключений нет»', async () => {
    const r = await run({ psqlFail: true })
    expect(r.code).toBe(1)
    expect(r.out).toContain('не смог прочитать базу')
    expect(r.out).toContain('could not connect')
  })

  it('опрос Альфы на сервере выключен — сказано прямо', async () => {
    const r = await run({ apiBase: '' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('ALFA_OAUTH_API_BASE в контейнере backend пуст')
  })

  it.each([
    ['2026-13-01', '2026-08-31', 'нужен формат'],
    ['2026-02-30', '2026-03-31', 'нужен формат'],
    ['2026-09-01', '2026-08-01', 'позже TO'],
    ['2026-01-01', '2026-06-30', 'длиннее 93 дней']
  ])('период %s … %s — отказ до базы и банка', async (from, to, text) => {
    const r = await run({ env: { FROM: from, TO: to } })
    expect(r.code).toBe(2)
    expect(r.out).toContain(text)
    expect(r.dockerArgs).toBe('')
  })
})

describe('чистые функции (исполнением)', () => {
  const call = (fn: string, ...args: string[]) => execFileSync('bash', ['-c',
    `source <(sed -n '/^${fn}()/,/^}/p' "$1"); ${fn} "\${@:2}" && echo ok || echo no`, '_', SCRIPT_PATH, ...args
  ], { encoding: 'utf8' }).trim()

  it('valid_day отличает настоящий день от похожего', () => {
    expect(call('valid_day', '2026-02-28')).toBe('ok')
    expect(call('valid_day', '2026-02-30')).toBe('no')
    expect(call('valid_day', '2026-8-1')).toBe('no')
    expect(call('valid_day', '')).toBe('no')
  })

  it('alfa_day переводит в формат банка', () => {
    expect(call('alfa_day', '2026-08-01')).toBe('01.08.2026\nok')
  })
})
