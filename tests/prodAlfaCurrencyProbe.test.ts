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
// - в выводе НЕТ сумм, назначений, контрагентов и полных номеров — его пересылают;
// - токены не попадают ни в одну командную строку, а уходят через stdin.
//
// ⚠ Сервер живёт в процессе теста, поэтому скрипт запускается АСИНХРОННО: синхронный запуск
// заблокировал бы цикл событий, и сервер не ответил бы ни на один запрос.
// ⚠ Обход страниц — как у боевого опроса, с паузой 500 мс между страницами, поэтому каждый прогон
// с операциями длится около секунды.

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/prod-alfa-currency-probe.sh')

const TOKEN = 'tok-SECRET-access-0123456789'
const TOKEN_B = 'tok-SECRET-second-key-98765'
const BYN = 'BY11ALFA30120000000000000001'
const USD = 'BY22ALFA30120000000000000002'
const EUR = 'BY33ALFA30120000000000000003'

type Json = Record<string, unknown>
interface Scenario {
  /** Счета по токену; по умолчанию у TOKEN — BYN и USD. */
  accounts?: Record<string, unknown>
  /** Тело выписки по номеру счёта и странице; по умолчанию USD как в #733, страницы ≥1 пусты. */
  statement?: (number: string, pageNo: number) => { status?: number, body: unknown }
}

let server: Server
let base = ''
let scenario: Scenario = {}
let requests: { path: string, auth: string | undefined }[] = []

function revaluation(n: number, amount = 0) {
  return Array.from({ length: n }, (_, i) => ({
    number: USD, operType: 'C', amount, currIso: 'USD',
    operCodeName: 'Переоценка входящего остатка', docId: `R${i}`, operDate: `0${i + 1}.08.2026`
  }))
}

/** Валютный счёт как в файле #733: один настоящий приход и переоценки, обороты в двух валютах. */
function usdStatement(): Json {
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

const defaultAccounts = (): Record<string, unknown> => ({ [TOKEN]: { accounts: [{ number: BYN, currIso: 'BYN' }, { number: USD, currIso: 'USD' }] } })

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', auth: req.headers.authorization })
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    const accounts = scenario.accounts ?? defaultAccounts()
    if (!(token in accounts)) return send(401, { error: 'invalid_token' })
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/partner/1.2.0/accounts/') return send(200, accounts[token])
    if (url.pathname === '/partner/1.2.0/accounts/statement') {
      const number = url.searchParams.get('number') ?? ''
      const pageNo = Number(url.searchParams.get('pageNo'))
      const r = scenario.statement?.(number, pageNo) ?? { body: pageNo === 0 ? usdStatement() : { page: [], errors: [] } }
      return send(r.status ?? 200, r.body)
    }
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
 * отвечает строками `rows` (ключ подключения|токен|порталов), а на node — запускает настоящий node
 * с тем же stdin, предварительно напечатав строку `[otel]`, как это делает образ.
 * ⚠ Адрес банка — `https://` для скрипта (иначе проба откажется слать токен), а фактически запросы
 * уходят на локальный http-сервер: подменяется в подставном docker.
 */
async function run(opts: { rows?: string, env?: Record<string, string>, psqlFail?: boolean, apiBase?: string } = {}): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'alfa-currency-probe-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'docker'), String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_DIR/docker.args"
case " $* " in
  *" db psql "*)
    if [ -n "${'$'}{FAKE_PSQL_FAIL:-}" ]; then echo "psql: could not connect to server" >&2; exit 2; fi
    printf '%s\n' "$FAKE_ROWS"; exit 0;;
  *" backend node "*)
    while [ "$#" -gt 0 ] && [ "$1" != backend ]; do shift; done; shift
    echo "[otel] disabled — no endpoint configured"
    ALFA_OAUTH_API_BASE="$FAKE_API_BASE" ALFA_OAUTH_API_PREFIX=/partner/1.2.0 \
      NODE_OPTIONS="--import $FAKE_DIR/redirect.mjs" exec "$@";;
esac
echo "unexpected docker call: $*" >&2
exit 99
`)
    // The probe refuses a non-https base; the test bank is plain http on loopback. The redirect is
    // installed into node itself, so the probe's own code (including the https check) runs as is.
    writeFileSync(join(dir, 'redirect.mjs'), `const real = globalThis.fetch
globalThis.fetch = (u, o) => real(String(u).replace(/^https:\\/\\/probe\\.bank\\.test/, ${JSON.stringify(base)}), o)
`)
    chmodSync(join(bin, 'docker'), 0o755)
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_DIR: dir,
      FAKE_ROWS: opts.rows ?? `${USD}|${TOKEN}|1`,
      FAKE_PSQL_FAIL: opts.psqlFail ? '1' : '',
      FAKE_API_BASE: opts.apiBase ?? 'https://probe.bank.test',
      FROM: '', TO: '', B24: '', AMOUNTS: '',
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

const statementRequests = () => requests.filter(q => q.path.includes('/accounts/statement?'))

describe('ответы на вопросы #735', () => {
  it('валютный счёт: переоценка, валюта, statistics и сверка сумм', async () => {
    const r = await run({ env: { FROM: '2026-08-01', TO: '2026-08-31' } })
    expect(r.code, r.out + r.err).toBe(0)
    expect(r.out).toContain('BY11…0001  BYN')
    expect(r.out).toMatch(/BY22…0002 {2}USD {3}← валютный/)
    // Вопрос 2: строки переоценки приходят с нулевой суммой и названы кодом операции.
    expect(r.out).toContain('операций: 4 — приходов 4, расходов 0')
    expect(r.out).toContain('с нулевой суммой: 3 — «Переоценка входящего остатка» ×3')
    expect(r.out).toContain('Переоценка: приходит с нулевой суммой — 3 из 4')
    // Вопрос 4: currIso против валюты счёта.
    expect(r.out).toContain('4. currIso: во всех строках валюта счёта (USD)')
    // Вопросы 1 и 3: сумма прихода сошлась с оборотом в валюте счёта, а НЕ с эквивалентом.
    expect(r.out).toContain('statistics[]: ключи — credTurnover credTurnoverEq debTurnover inRest inRestEq number outRest')
    expect(r.out).toContain('сверка amount, приходы: совпала с credTurnover')
    expect(r.out).not.toMatch(/совпала с [^\n]*credTurnoverEq/)
    expect(r.out).toContain('сходится для inRest → outRest')
    expect(r.out).toContain('1. Валюта суммы: суммы сошлись с полями statistics')
  })

  it('пара оборотов — не сальдо: без остатков сальдо не сходится ни для чего', async () => {
    // Когда обороты сошлись, «приходы − расходы» совпадает с их разностью арифметически, и пара
    // оборотов выдавала себя за сверку остатков, которых в ответе нет вовсе.
    const st = usdStatement()
    st.statistics = [{ number: USD, debTurnover: 0, credTurnover: 560 }]
    scenario.statement = (_n, p) => ({ body: p === 0 ? st : { page: [] } })
    const r = await run()
    expect(r.out).toContain('сверка amount, приходы: совпала с credTurnover')
    expect(r.out).toContain('сальдо (входящее + приходы − расходы = исходящее): не сходится ни для одной пары полей')
  })

  it('сошлось только сальдо — вердикт не выдаёт его за совпавшие обороты', async () => {
    // Сальдо проходит ЛЮБАЯ пара полей, разность которых равна «приходы − расходы», поэтому одно
    // оно ещё не говорит, в какой валюте сумма: это решают имена пары. Засчитать его совпавшими
    // оборотами значило бы написать в вердикте «суммы сошлись» под строкой «ни с одним полем».
    const st = usdStatement()
    st.statistics = [{ number: USD, inRest: 1000, outRest: 1560 }]
    scenario.statement = (_n, p) => ({ body: p === 0 ? st : { page: [] } })
    const r = await run()
    expect(r.out).toContain('сверка amount, приходы: ни с одним полем statistics')
    expect(r.out).toContain('сходится для inRest → outRest')
    expect(r.out).toContain('1. Валюта суммы: обороты не сошлись, сошлось только сальдо')
    expect(r.out).not.toContain('суммы сошлись')
  })

  it('переоценка С СУММОЙ — названа опасной: рубеж по сумме её не отсеет', async () => {
    // Если amount окажется эквивалентом в BYN, у переоценки будет сумма — и по одному нулю её
    // не распознать. Это ровно тот случай, когда она уйдёт в CRM платежом.
    const st = usdStatement()
    st.page = [(st.page as Json[])[0]!, ...revaluation(2, 12.34)]
    scenario.statement = (_n, p) => ({ body: p === 0 ? st : { page: [] } })
    const r = await run()
    expect(r.out).toContain('Переоценка: ')
    expect(r.out).toContain('приходит С СУММОЙ — 2 строк')
  })

  it('платёж в одну копейку — с деньгами, а не нулевая строка', async () => {
    const st = usdStatement()
    st.page = [...st.page as Json[], { number: USD, operType: 'C', amount: 0.01, currIso: 'USD', operCodeName: 'Комиссия', docId: 'D2', operDate: '13.08.2026' }]
    st.statistics = [{ number: USD, credTurnover: 560.01 }]
    scenario.statement = (_n, p) => ({ body: p === 0 ? st : { page: [] } })
    const r = await run()
    expect(r.out).toContain('с нулевой суммой: 3 — «Переоценка входящего остатка» ×3')
    expect(r.out).toContain('«Комиссия» ×1')
    expect(r.out).toContain('сверка amount, приходы: совпала с credTurnover')
  })

  it('currIso не совпал с валютой счёта — названо', async () => {
    const st = usdStatement()
    st.page = (st.page as Json[]).map(p => ({ ...p, currIso: 'BYN' }))
    scenario.statement = (_n, p) => ({ body: p === 0 ? st : { page: [] } })
    const r = await run()
    expect(r.out).toContain('4. currIso: отличается от валюты счёта в строках: «BYN» ×4')
  })

  it('суммы не сошлись ни с одним полем statistics — так и сказано, с планом Б', async () => {
    const st = usdStatement()
    st.statistics = [{ number: USD, inRest: 1, outRest: 2, debTurnover: 0, credTurnover: 7, inRestEq: 1, credTurnoverEq: 9 }]
    scenario.statement = (_n, p) => ({ body: p === 0 ? st : { page: [] } })
    const r = await run()
    expect(r.out).toContain('сверка amount, приходы: ни с одним полем statistics')
    expect(r.out).toContain('с полями statistics не сошлась ни одна сумма; план Б: AMOUNTS=1')
  })

  it('записи statistics для другого счёта — названо, а не «ключи выше» без ключей', async () => {
    const st = usdStatement()
    st.statistics = [{ number: 'BY00ELSE00000000000000000000', credTurnover: 560 }]
    scenario.statement = (_n, p) => ({ body: p === 0 ? st : { page: [] } })
    const r = await run()
    expect(r.out).toContain('statistics[]: записей 1, но ни одной для этого счёта')
    expect(r.out).toContain('записи statistics[] для этого счёта нет')
    expect(r.out).toContain('3. statistics[]: записи для этого счёта нет')
  })

  it('operType не C/D — считается расходом, как в боевом коде, и назван', async () => {
    const st = usdStatement()
    st.page = [...st.page as Json[], { number: USD, operType: 'x', amount: 5, currIso: 'USD', operCodeName: 'Прочее', docId: 'D3' }]
    scenario.statement = (_n, p) => ({ body: p === 0 ? st : { page: [] } })
    const r = await run()
    expect(r.out).toContain('операций: 5 — приходов 4, расходов 1')
    expect(r.out).toContain('operType не C/D: «X» ×1 — боевой код запишет их расходом')
  })
})

describe('приватность', () => {
  it('в выводе нет сумм, назначений, контрагентов, полных номеров и токенов', async () => {
    // Строка с лишними числовыми полями: прежняя редакция печатала их отношение к amount, и
    // по известному УНП плательщика сумма восстанавливалась делением.
    const st = usdStatement()
    st.page = [{ ...(st.page as Json[])[0]!, corrUnp: 190000001, rest: 3860 }, ...revaluation(3)]
    scenario.statement = (_n, p) => ({ body: p === 0 ? st : { page: [] } })
    const r = await run()
    expect(r.code, r.out + r.err).toBe(0)
    for (const secret of ['560', '1619', '3300', '3860', '9591', '190000001', 'СЕКРЕТ', 'Контрагент-Тайна', USD, BYN, 'BY99XXXX', TOKEN]) {
      expect(r.out + r.err, secret).not.toContain(secret)
    }
    expect(r.out).not.toContain('отношение')
    expect(r.out).toContain('Вывод можно переслать целиком')
  })

  it('AMOUNTS=1 — суммы показаны, но под запретом пересылки; без него — нет', async () => {
    const r = await run({ env: { AMOUNTS: '1' } })
    expect(r.code, r.out + r.err).toBe(0)
    expect(r.out).toContain('СУММЫ (AMOUNTS=1) — ЭТОТ ВЫВОД НЕ ПЕРЕСЫЛАТЬ')
    expect(r.out).toContain('12.08.2026  приход  560 USD')
    expect(r.out).not.toContain('Вывод можно переслать целиком')
    // Назначение и контрагент не печатаются и так.
    expect(r.out).not.toContain('СЕКРЕТ')
    expect(r.out).not.toContain('Контрагент-Тайна')
  })

  it('токены уходят только через stdin: ни в одной командной строке их нет', async () => {
    const r = await run()
    expect(r.code, r.out + r.err).toBe(0)
    expect(r.dockerArgs).toContain('exec -T db psql')
    expect(r.dockerArgs).not.toContain(TOKEN)
    // И банк получил именно его — то есть он действительно доехал, а не пропал по дороге.
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every(q => q.auth === `Bearer ${TOKEN}`)).toBe(true)
  })

  it('строка телеметрии образа не попадает в отчёт, а сама загрузка выключена', async () => {
    const r = await run()
    expect(r.dockerArgs).toContain('exec -T -e NODE_OPTIONS= backend node')
    expect(r.out).not.toContain('[otel]')
  })

  it('адрес банка не https — токен не отправляется вовсе', async () => {
    const r = await run({ apiBase: base })
    expect(r.code).toBe(1)
    expect(r.out).toContain('ALFA_OAUTH_API_BASE не https')
    expect(requests).toHaveLength(0)
  })
})

describe('обход и ключи', () => {
  it('период уходит в банк в его формате, выписка — постранично, рублёвый счёт не спрашивается', async () => {
    await run({ env: { FROM: '2026-08-01', TO: '2026-08-31' } })
    const st = statementRequests()
    expect(st.map(q => new URL(q.path, 'http://x').searchParams.get('pageNo'))).toEqual(['0', '1'])
    expect(st[0]!.path).toContain(`number=${USD}&dateFrom=01.08.2026&dateTo=31.08.2026&transactions=0&pageNo=0&pageRowCount=0`)
    // Рублёвый счёт выписку не спрашивает: лимит банка общий на всех.
    expect(requests.some(q => q.path.includes(BYN))).toBe(false)
  })

  it('банк игнорирует pageNo — повтор страницы останавливает обход, строки не удваиваются', async () => {
    scenario.statement = () => ({ body: usdStatement() })
    const r = await run()
    expect(statementRequests()).toHaveLength(2)
    expect(r.out).toContain('операций: 4')
    expect(r.out).toContain('страниц: 2')
  })

  it('вторая страница несёт операции — они учитываются', async () => {
    scenario.statement = (_n, p) => ({
      body: p === 0 ? usdStatement() : p === 1 ? { page: revaluation(2).map((x, i) => ({ ...x, docId: `P2-${i}` })) } : { page: [] }
    })
    const r = await run()
    expect(r.out).toContain('операций: 6')
    expect(r.out).toContain('с нулевой суммой: 5')
  })

  it('страницы пересекаются частично — общая строка не задваивается', async () => {
    // Повтор страницы ЦЕЛИКОМ ловит сравнение страниц, а сдвиг пагинации — нет: сигнатуры
    // страниц разные, и одна операция попала бы в обе. Задвоенная сумма испортила бы сверку
    // со statistics[] — ровно тот ответ, ради которого проба написана.
    const st = usdStatement()
    const overlap = (st.page as Json[])[1]!
    scenario.statement = (_n, p) => ({ body: p === 0 ? st : p === 1 ? { page: [overlap, { ...overlap, docId: 'R3' }] } : { page: [] } })
    const r = await run()
    expect(r.out).toContain('операций: 5')
    expect(r.out).toContain('страниц: 3')
  })

  it('два ключа на портале: валютный счёт второго спрашивается ЕГО токеном', async () => {
    scenario.accounts = {
      [TOKEN]: { accounts: [{ number: BYN, currIso: 'BYN' }] },
      [TOKEN_B]: { accounts: [{ number: USD, currIso: 'USD' }] }
    }
    const r = await run({ rows: `${BYN}|${TOKEN}|1\n~pending:abc123|${TOKEN_B}|1` })
    expect(r.code, r.out + r.err).toBe(0)
    expect(r.out).toContain('ключ подключения без выбранного счёта:')
    expect(statementRequests().every(q => q.auth === `Bearer ${TOKEN_B}`)).toBe(true)
    expect(r.out).toContain('1. Валюта суммы: суммы сошлись')
  })
})

describe('отказы', () => {
  it('токены отвергнуты — код 2 и совет не обновлять руками', async () => {
    const r = await run({ rows: `${USD}|tok-stale-0000|1` })
    expect(r.code).toBe(2)
    expect(r.out).toContain('банк отверг токены всех ключей')
    expect(r.out).toContain('Обновлять токен руками НЕЛЬЗЯ')
  })

  it('токен отвергнут на выписке, после удачного /accounts/ — тоже код 2', async () => {
    scenario.statement = () => ({ status: 401, body: { error: 'invalid_token' } })
    const r = await run()
    expect(r.code).toBe(2)
    expect(r.out).toContain('вердикта нет — токен отвергнут банком')
  })

  it('ответ с errors[] и пустым page[] — ошибка, а не «операций нет»', async () => {
    scenario.statement = () => ({ body: { page: [], errors: [{ number: USD, message: `Token expired for ${USD}` }] } })
    const r = await run()
    expect(r.code).toBe(1)
    expect(r.out).toContain('банк ответил ошибкой по счёту (поля errors[]: message number)')
    expect(r.out).toContain('вердикта нет')
    expect(r.out).not.toContain('за период операций нет')
    // Текст банка не печатается: в нём номер счёта открытым текстом.
    expect(r.out).not.toContain(USD)
  })

  it('errors[] рядом с НЕПУСТЫМ page[] — тоже отказ, а не частичный успех', async () => {
    scenario.statement = () => ({
      body: {
        page: [{ number: USD, operType: 'C', amount: 100, currIso: 'USD', operCodeName: 'Зачисление', docId: 'DX' }],
        errors: [{ number: USD, message: `Token expired for ${USD}` }]
      }
    })
    const r = await run()
    expect(r.code).toBe(1)
    expect(r.out).toContain('банк ответил ошибкой по счёту (поля errors[]: message number)')
    expect(r.out).not.toContain('операций: 1')
    expect(r.out).not.toContain(USD)
  })

  it('отказ по одному счёту не прячет вердикт по остальным', async () => {
    scenario.accounts = { [TOKEN]: { accounts: [{ number: USD, currIso: 'USD' }, { number: EUR, currIso: 'EUR' }] } }
    scenario.statement = (n, p) => (n === EUR ? { status: 503, body: { fault: 'down' } } : { body: p === 0 ? usdStatement() : { page: [] } })
    const r = await run()
    expect(r.code).toBe(1)
    expect(r.out).toContain('BY22…0002 (USD):')
    expect(r.out).toContain('BY33…0003 (EUR): вердикта нет — HTTP 503')
  })

  it('валютных счетов ключи не видят — код 3', async () => {
    scenario.accounts = { [TOKEN]: { accounts: [{ number: BYN, currIso: 'BYN' }] } }
    const r = await run()
    expect(r.code).toBe(3)
    expect(r.out).toContain('Валютных счетов ключи не видят')
  })

  it('Альфа на нескольких порталах, портал не назван — отказ до похода в банк', async () => {
    const r = await run({ rows: `${USD}|${TOKEN}|2` })
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

  it('кривой TO назван сам, а не пустым FROM, выведенным из него', async () => {
    const r = await run({ env: { TO: '2026-13-01' } })
    expect(r.code).toBe(2)
    expect(r.out).toContain('✗ TO: день «2026-13-01»')
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

  it('AMOUNTS — только 1 или пусто', async () => {
    const r = await run({ env: { AMOUNTS: 'yes' } })
    expect(r.code).toBe(2)
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
