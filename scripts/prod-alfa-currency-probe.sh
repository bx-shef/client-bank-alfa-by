#!/usr/bin/env bash
# One-off probe: what the Alfa API returns for a FOREIGN-currency account (#735).
#
# The FILE path was measured and fixed in #733: in Alfa's `Type=6` statement the plain `Deb`/`Cre`
# fields hold the ACCOUNT currency and `DebQ`/`CreQ` the BYN equivalent — the opposite of the
# other banks, so the parser took the BYN equivalent for the account-currency amount; and 22 of 23
# rows a month were "revaluation of the opening balance". The API path has never been measured on a
# currency account — every live measurement of the automatic poll used a BYN account. This probe
# answers the four questions of #735 without printing a single amount:
#   1. Is `amount` in the account currency or the BYN equivalent? The per-direction sums of every
#      numeric row field are compared with every numeric field of `statistics[]`, and only the
#      NAMES of the matching fields are printed (the name tells which turnover it is).
#   2. Do revaluation rows come through the API — and with what amount? Rows are recognised by the
#      bank's operation name and by a zero amount, and counted.
#   3. What does `statistics[]` hold for a currency account? Its keys.
#   4. Is `currIso` the operation currency or the account currency? Compared with the account
#      currency reported by `GET /accounts/`.
#
# ⚠ READ-ONLY. `GET /accounts/` once per stored Alfa key, then the statement of each currency
# account, walked page by page exactly as production does (#561/#566: whether `pageRowCount=0`
# really means «all» is not proven, so a single page could silently be partial). The access tokens
# are the ones already stored in `bank_tokens`; the refresh token is never selected, let alone used:
# the bank rotates it on refresh, and a manual refresh would put our database and the bank out of
# sync (#505/#509) — the same rule as `prod-alfa-page-probe.sh`.
#
# ⚠ Tokens never reach a command line. The bank calls run in node inside the `backend` container (it
# already has the bank's CA chain and the API base in its environment), and the tokens are handed
# over on STDIN. Arguments are visible to every process via `/proc/<pid>/cmdline` and end up in the
# `execve` audit log on the host.
#
# ⚠ By default the output carries NO amounts, purposes or counterparties, and account numbers are
# masked: operator output gets copied into a chat for help (docs/PRIVACY.md, «Остаточные риски»).
# Printed are counts, currency codes, the bank's operation-code names, field NAMES and yes/no
# reconciliation results.
# Ratios between fields were printed in the first draft and removed: with one paid row, «UNP /
# amount» gives the amount back to anyone who knows the payer's public UNP.
# `AMOUNTS=1` is the explicit plan B for question 1 when `statistics[]` gives no answer: it adds the
# date, direction and amount of each paid row, under a warning not to forward the output.
#
# Usage (from the stack directory; normally through `make alfa-currency-probe`):
#   bash prod-alfa-currency-probe.sh "docker compose -f docker-compose.prod.yml"
# Environment:
#   FROM, TO — the period, YYYY-MM-DD (default: the 30 days up to yesterday, UTC)
#   B24      — the portal's address, required when several portals have an Alfa connection
#   AMOUNTS  — `1` to print the amounts of paid rows (do not forward that output)

set -u

MAX_SPAN_DAYS=93

# ── Pure functions (tests/prodAlfaCurrencyProbe.test.ts loads them through a sed range) ─────────

# 0 when the value is a real YYYY-MM-DD calendar day.
valid_day() {
  case "${1:-}" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) return 1 ;;
  esac
  # GNU date rejects 2026-02-30; the round trip also catches a date `date` silently normalises.
  [ "$(date -u -d "$1" +%Y-%m-%d 2>/dev/null)" = "$1" ]
}

# Days from $1 to $2 (both YYYY-MM-DD).
span_days() {
  local a b
  a="$(date -u -d "$1" +%s 2>/dev/null)" || return 1
  b="$(date -u -d "$2" +%s 2>/dev/null)" || return 1
  printf '%s' $(( (b - a) / 86400 ))
}

# YYYY-MM-DD → DD.MM.YYYY (the only date format the Alfa API accepts).
alfa_day() {
  printf '%s' "$1" | awk -F- '{print $3"."$2"."$1}'
}

# ── Input ───────────────────────────────────────────────────────────────────────────────────────

DC="${1:-docker compose -f docker-compose.prod.yml}"

# ⚠ TO is checked BEFORE FROM is derived from it: a bad TO would otherwise surface as an error
# about an EMPTY day — a value the operator never typed.
TO_DAY="${TO:-}"
[ -n "$TO_DAY" ] || TO_DAY="$(date -u -d 'yesterday' +%Y-%m-%d 2>/dev/null)"
if ! valid_day "$TO_DAY"; then
  echo "✗ TO: день «$TO_DAY» — нужен формат ГГГГ-ММ-ДД: FROM=2026-08-01 TO=2026-08-31 make alfa-currency-probe"
  exit 2
fi
FROM_DAY="${FROM:-}"
[ -n "$FROM_DAY" ] || FROM_DAY="$(date -u -d "$TO_DAY -29 days" +%Y-%m-%d 2>/dev/null)"
if ! valid_day "$FROM_DAY"; then
  echo "✗ FROM: день «$FROM_DAY» — нужен формат ГГГГ-ММ-ДД: FROM=2026-08-01 TO=2026-08-31 make alfa-currency-probe"
  exit 2
fi
SPAN="$(span_days "$FROM_DAY" "$TO_DAY")"
if [ "$SPAN" -lt 0 ]; then
  echo "✗ FROM ($FROM_DAY) позже TO ($TO_DAY)"
  exit 2
fi
if [ "$SPAN" -ge "$MAX_SPAN_DAYS" ]; then
  echo "✗ период $FROM_DAY … $TO_DAY длиннее $MAX_SPAN_DAYS дней — возьмите месяц-другой"
  exit 2
fi
case "${AMOUNTS:-}" in
  ''|0) SHOW_AMOUNTS=false ;;
  1) SHOW_AMOUNTS=true ;;
  *) echo "✗ AMOUNTS — только 1 (показать суммы) или пусто"; exit 2 ;;
esac

echo "Период: $FROM_DAY … $TO_DAY"

# ── Access tokens from the database (READ-ONLY) — one per stored Alfa key ──────────────────────
# ⚠ One token PER GRANT (key), not one per portal: a portal may hold several Alfa keys — one per
# legal entity — and each key sees only its own accounts. Rows of one grant share their tokens, so
# the newest row of each grant is enough; an unmarked row (empty grant_id) is its own grant.
# ⚠ `~pending:` rows are included: the probe never uses the stored account, and a freshly connected
# key whose account is not chosen yet is exactly the one an operator might want to look at.
# ⚠ Portals, not rows, decide whether the target is ambiguous: a BYN and a USD account of one
# company are two rows of ONE portal. Two portals with Alfa — then whose keys to use is unclear.
# ⚠ stderr is kept: a failed psql (the `db` container is down) must not read as «no connection».
PSQL_ERR="$(mktemp /tmp/alfa-currency-probe-err.XXXXXX)"
cleanup() { rm -f "$PSQL_ERR"; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP

PORTAL_DOMAIN="${B24:-}"
if [ -n "$PORTAL_DOMAIN" ]; then
  DOM_SQL="$(printf '%s' "$PORTAL_DOMAIN" | sed "s/'/''/g")"
  PORTAL_WHERE="AND b.member_id = (SELECT member_id FROM portal_tokens WHERE domain = '$DOM_SQL')"
else
  PORTAL_WHERE=""
fi
# shellcheck disable=SC2086 # $DC is a command line on purpose (`docker compose -f …`)
RAW_ROWS="$($DC exec -T db psql -U app -d app -At -F'|' -c \
  "SELECT k.account_key, k.access_token,
          (SELECT count(DISTINCT member_id) FROM bank_tokens WHERE provider = 'alfa-by')
     FROM (SELECT DISTINCT ON (COALESCE(NULLIF(b.grant_id, ''), b.id::text))
                  b.account_key, b.access_token, b.updated_at
             FROM bank_tokens b
            WHERE b.provider = 'alfa-by' $PORTAL_WHERE
            ORDER BY COALESCE(NULLIF(b.grant_id, ''), b.id::text), b.updated_at DESC) k
    ORDER BY k.updated_at DESC
    LIMIT 10" 2>"$PSQL_ERR")"
PSQL_RC=$?
ROWS="$(printf '%s' "$RAW_ROWS" | tr -d '\r')"

if [ "$PSQL_RC" -ne 0 ]; then
  printf '\033[31m✗ не смог прочитать базу (код %s)\033[0m\n' "$PSQL_RC"
  sed 's/^/  /' "$PSQL_ERR" | head -5
  exit 1
fi
if [ -z "$ROWS" ]; then
  if [ -n "$PORTAL_DOMAIN" ]; then
    printf '\033[33m✗ у портала %s нет подключения Альфы — проверьте адрес\033[0m\n' "$PORTAL_DOMAIN"
  else
    printf '\033[33m✗ подключений Альфы на сервере нет — спрашивать банк нечем\033[0m\n'
  fi
  exit 1
fi
PORTALS="${ROWS%%$'\n'*}"
PORTALS="${PORTALS##*|}"
if [ -z "$PORTAL_DOMAIN" ] && [ "${PORTALS:-1}" != "1" ]; then
  printf '\033[33m✗ Альфа подключена на %s порталах — чьими ключами спрашивать, неясно\033[0m\n' "$PORTALS"
  echo "  Назовите портал его адресом (ПЕРЕД make — параметр после make исполняет подставленное):"
  echo "    B24=xxx.bitrix24.by make alfa-currency-probe"
  exit 1
fi

# JSON by hand: tokens and account keys are opaque strings, and anything outside the expected
# alphabet is refused instead of escaped — a token with a quote in it is not a token.
KEYS_JSON=""
while IFS='|' read -r ACCOUNT TOKEN _; do
  [ -n "$TOKEN" ] || continue
  case "$TOKEN$ACCOUNT" in
    *[!A-Za-z0-9._~+/=:-]*) echo "✗ в токене или ключе подключения неожиданные символы — проба остановлена"; exit 1;;
  esac
  KEYS_JSON="${KEYS_JSON:+$KEYS_JSON,}{\"token\":\"$TOKEN\",\"account\":\"$ACCOUNT\"}"
done <<EOF
$ROWS
EOF
if [ -z "$KEYS_JSON" ]; then
  echo "✗ не удалось прочитать ни одного access-токена — дождитесь очередного опроса и повторите"
  exit 1
fi

# ── The bank, from node inside the backend container ───────────────────────────────────────────
# ⚠ `NODE_OPTIONS` is cleared for this one process: the image preloads the telemetry loader, which
# prints its own line to stdout on every node start and would be mixed into the report.
# The program reads {keys:[{token, account}], from, to, amounts} from STDIN.
PROBE_JS="$(cat <<'JS'
const input = JSON.parse(await new Promise((resolve, reject) => {
  let s = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', c => { s += c })
  process.stdin.on('end', () => resolve(s))
  process.stdin.on('error', reject)
}))

const MAX_ACCOUNTS = 5
// Same walk limits as production (server/utils/bankFetch.ts: MAX_ALFA_STATEMENT_PAGES,
// ALFA_PAGE_DELAY_MS) — the probe must see the same rows the poll sees.
const MAX_PAGES = 20
const PAGE_DELAY_MS = 500
// Revaluation is recognised by the bank's operation name as well as by a zero amount: if `amount`
// turned out to be the BYN equivalent, revaluation rows would carry money, and a zero test alone
// would report them as absent — the dangerous case, since such rows pass our amount gate.
const REVALUATION = /переоцен/i

const say = (line = '') => console.log(line)
const mask = n => {
  const s = String(n)
  if (s.startsWith('~pending:')) return 'без выбранного счёта'
  return s.length >= 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : '****'
}
const section = t => say(`\n\x1b[1m── ${t} ──\x1b[0m`)
const count = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n)
const listed = map => [...map].sort((a, b) => b[1] - a[1]).map(([k, n]) => `«${k}» ×${n}`).join(', ')
// Money in minor units, so that sums are compared exactly and not through float noise.
const cents = v => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d+(?:[.,]\d+)?$/.test(v.trim()) ? Number(v.replace(',', '.')) : NaN)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}
// Only the NAMES of a response's keys: the bank's own text is not ours to print and may carry an
// account number in the clear (see prod-alfa-page-probe.sh).
const keysOf = j => (j && typeof j === 'object' ? Object.keys(j).join(' ') : '<не JSON>')

const base = (process.env.ALFA_OAUTH_API_BASE ?? '').trim().replace(/\/+$/, '')
const prefix = `/${(process.env.ALFA_OAUTH_API_PREFIX ?? '').trim().replace(/^\/+|\/+$/g, '') || 'partner/1.2.0'}`
if (!base) {
  say('✗ ALFA_OAUTH_API_BASE в контейнере backend пуст — опрос Альфы на этом сервере выключен')
  process.exit(1)
}
// ⚠ https only: the Bearer token goes to this address. Production accepts plain http solely towards
// an internal gateway (normalizeBankApiBase), which Alfa does not have — and a typo'd `http://`
// that production refuses must not become the one path that sends a live token in clear text.
if (!/^https:\/\//i.test(base)) {
  say('✗ ALFA_OAUTH_API_BASE не https — токен по такому адресу проба не отправит')
  process.exit(1)
}

async function get(token, path) {
  try {
    const r = await fetch(`${base}${prefix}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(45000)
    })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON — reported by keys */ }
    return { status: r.status, json, text }
  } catch (e) {
    return { status: 0, json: null, text: '', error: e?.name === 'TimeoutError' ? 'банк не ответил за 45 с' : 'сетевая ошибка' }
  }
}

const rejected = r => r.status === 401 || r.status === 403 || (r.status !== 200 && /invalid_token|expired_token|Unauthorized/.test(r.text))
const failure = r => r.error ?? `HTTP ${r.status} — ключи ответа: ${keysOf(r.json)}`

// ── Accounts, per key ──
section('Счета, которые видят ключи')
const foreign = new Map()
let working = 0
let rejectedKeys = 0
for (const k of input.keys) {
  const r = await get(k.token, '/accounts/')
  if (rejected(r)) { rejectedKeys++; say(`  ключ подключения ${mask(k.account)}: токен отвергнут банком`); continue }
  if (r.status !== 200 || !Array.isArray(r.json?.accounts)) { say(`  ключ подключения ${mask(k.account)}: ${failure(r)}`); continue }
  working++
  say(`  ключ подключения ${mask(k.account)}:`)
  for (const raw of r.json.accounts) {
    const number = String(raw?.number ?? '').trim()
    if (!number) continue
    const currency = String(raw?.currIso ?? raw?.currency ?? '').trim().toUpperCase()
    const isForeign = currency !== '' && currency !== 'BYN'
    say(`    ${mask(number)}  ${currency || '?'}${isForeign ? '   ← валютный' : ''}`)
    if (isForeign && !foreign.has(number)) foreign.set(number, { number, currency, token: k.token })
  }
}
if (!working) {
  if (rejectedKeys) {
    say('\n\x1b[31m✗ банк отверг токены всех ключей\x1b[0m')
    say('  Дождитесь очередного опроса (он обновит токены сам) и повторите.')
    say('  ⚠ Обновлять токен руками НЕЛЬЗЯ — банк ротирует refresh, база и банк разъедутся (#505/#509).')
    process.exit(2)
  }
  say('\n\x1b[31m✗ список счетов не получен ни по одному ключу\x1b[0m')
  process.exit(1)
}
if (!foreign.size) {
  say('\n\x1b[33mВалютных счетов ключи не видят — мерить нечего.\x1b[0m')
  say('Если валютный счёт у компании на другом портале: B24=xxx.bitrix24.by make alfa-currency-probe')
  process.exit(3)
}
if (foreign.size > MAX_ACCOUNTS) say(`  (валютных ${foreign.size}, спрашиваю первые ${MAX_ACCOUNTS})`)

// ── Statements ──
// Walked like production's fetchAlfaStatementPages: stop on an empty page or on a page seen before
// (a bank that ignores `pageNo` repeats itself), and treat a non-empty `errors[]` as a FAILURE —
// an errored response is not «no operations», even when `page[]` comes back empty beside it.
async function walk(a) {
  const rows = []
  const seen = new Set()
  const sigs = new Set()
  let statistics
  let pages = 0
  for (let n = 0; n < MAX_PAGES; n++) {
    if (n) await new Promise(r => setTimeout(r, PAGE_DELAY_MS))
    const q = `number=${encodeURIComponent(a.number)}&dateFrom=${input.from}&dateTo=${input.to}&transactions=0&pageNo=${n}&pageRowCount=0`
    const r = await get(a.token, `/accounts/statement?${q}`)
    if (rejected(r)) return { fail: 'токен отвергнут банком', rejected: true }
    if (r.status !== 200 || !r.json || typeof r.json !== 'object') return { fail: failure(r) }
    const body = r.json
    if (Array.isArray(body.errors) && body.errors.length) {
      const fields = [...new Set(body.errors.flatMap(e => (e && typeof e === 'object' ? Object.keys(e) : [])))].sort().join(' ')
      return { fail: `банк ответил ошибкой по счёту (поля errors[]: ${fields || '—'}) — это не «операций нет»` }
    }
    if (!Array.isArray(body.page)) return { fail: `в ответе нет page[] — ключи: ${keysOf(body)}` }
    pages++
    if (n === 0) statistics = body.statistics
    if (!body.page.length) return { rows, pages, statistics, complete: true }
    const sig = JSON.stringify(body.page)
    if (sigs.has(sig)) return { rows, pages, statistics, complete: true }
    sigs.add(sig)
    for (const row of body.page) {
      const key = row?.docId ? `d:${row.docId}` : `j:${JSON.stringify(row)}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(row)
    }
  }
  return { rows, pages, statistics, complete: false }
}

const verdicts = []
for (const a of [...foreign.values()].slice(0, MAX_ACCOUNTS)) {
  section(`Валютный счёт ${mask(a.number)} (${a.currency})`)
  const w = await walk(a)
  if (w.fail) {
    say(`  \x1b[31m✗ ${w.fail}\x1b[0m`)
    verdicts.push({ account: a, fail: w.fail, rejected: !!w.rejected })
    continue
  }
  const rows = w.rows
  let credit = 0, debit = 0, zero = 0, unreadable = 0, revalZero = 0, revalPaid = 0
  const oddDir = new Map()
  const zeroCodes = new Map(), paidCodes = new Map(), curr = new Map()
  const fields = new Set(), numeric = new Set()
  // Per numeric row field: sums by direction, in minor units. `amount` is one of them; any other
  // money-looking field (an equivalent, if the bank sends one) is matched against statistics too —
  // by NAME only, never printed.
  const sums = new Map()
  const paidRows = []
  for (const r of rows) {
    for (const [k, v] of Object.entries(r ?? {})) {
      fields.add(k)
      if (typeof v === 'number') numeric.add(k)
    }
    // Production's rule (directionFromOperType): `C` after trim/upper-case is a credit, ANYTHING
    // else is a debit. Unexpected values are counted, because production writes them as expenses.
    const t = String(r?.operType ?? '').trim().toUpperCase()
    const dir = t === 'C' ? 'C' : 'D'
    if (dir === 'C') credit++
    else debit++
    if (t !== 'C' && t !== 'D') count(oddDir, t || '—')
    count(curr, String(r?.currIso ?? '').trim().toUpperCase() || '—')
    const code = String(r?.operCodeName ?? '').trim().slice(0, 60) || '—'
    const isReval = REVALUATION.test(code)
    const c = cents(r?.amount)
    if (c === null || c < 0) { unreadable++; continue }
    if (c === 0) {
      zero++
      count(zeroCodes, code)
      if (isReval) revalZero++
      continue
    }
    if (isReval) revalPaid++
    count(paidCodes, code)
    paidRows.push({ date: String(r?.operDate ?? '').trim(), dir, amount: r.amount, currIso: String(r?.currIso ?? '').trim() })
    for (const [k, v] of Object.entries(r)) {
      if (typeof v !== 'number') continue
      const cv = cents(v)
      if (cv === null) continue
      const s = sums.get(k) ?? { C: 0, D: 0 }
      s[dir] += cv
      sums.set(k, s)
    }
  }
  say(`  страниц: ${w.pages}${w.complete ? '' : ` — ⚠ обход остановлен на ${MAX_PAGES}, суммы могут быть неполными`}`)
  say(`  операций: ${rows.length} — приходов ${credit}, расходов ${debit}`)
  if (oddDir.size) say(`  \x1b[33m⚠ operType не C/D: ${listed(oddDir)} — боевой код запишет их расходом\x1b[0m`)
  say(`  с нулевой суммой: ${zero}${zero ? ` — ${listed(zeroCodes)}` : ''}`)
  if (unreadable) say(`  \x1b[33mс нечитаемой или отрицательной суммой: ${unreadable}\x1b[0m`)
  if (paidCodes.size) say(`  с деньгами: ${listed(paidCodes)}`)
  say(`  валюта операций (currIso): ${listed(curr) || '—'}`)
  say(`  поля строки: ${[...fields].sort().join(' ') || '—'}`)
  say(`  числовые поля: ${[...numeric].sort().join(' ') || '—'}`)

  // statistics[]: the entries of THIS account (all of them when entries carry no number).
  const stats = Array.isArray(w.statistics) ? w.statistics.filter(s => s && typeof s === 'object') : []
  const numbered = stats.some(s => 'number' in s)
  const mine = numbered ? stats.filter(s => String(s.number ?? '').trim() === a.number) : stats
  const statNums = new Map()
  for (const s of mine) {
    for (const [k, v] of Object.entries(s)) {
      if (k === 'number') continue
      const c = cents(v)
      if (c !== null) statNums.set(k, c)
      else if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) {
          const c2 = cents(v2)
          if (c2 !== null) statNums.set(`${k}.${k2}`, c2)
        }
      }
    }
  }
  const statsState = !stats.length ? 'empty' : !mine.length ? 'other' : 'ok'
  if (statsState === 'empty') say('  statistics[]: пуст')
  else if (statsState === 'other') say(`  statistics[]: записей ${stats.length}, но ни одной для этого счёта (номера не совпали)`)
  else say(`  statistics[]: ключи — ${[...new Set(mine.flatMap(s => Object.keys(s)))].sort().join(' ')}`)

  const equal = v => [...statNums].filter(([, sv]) => Math.abs(sv) === Math.abs(v)).map(([k]) => k)
  const turnover = new Set()
  const matched = []
  const fieldOrder = [...sums.keys()].sort((x, y) => (x === 'amount' ? -1 : y === 'amount' ? 1 : x.localeCompare(y)))
  for (const k of fieldOrder) {
    const s = sums.get(k)
    const mc = s.C ? equal(s.C) : []
    const md = s.D ? equal(s.D) : []
    if (k === 'amount') {
      mc.forEach(x => turnover.add(x))
      md.forEach(x => turnover.add(x))
      if (s.C) say(`  сверка amount, приходы: ${mc.length ? `совпала с ${mc.join(', ')}` : 'ни с одним полем statistics'}`)
      if (s.D) say(`  сверка amount, расходы: ${md.length ? `совпала с ${md.join(', ')}` : 'ни с одним полем statistics'}`)
      matched.push(...mc, ...md)
    } else if (mc.length || md.length) {
      say(`  сверка ${k}: ${[mc.length ? `приходы — ${mc.join(', ')}` : '', md.length ? `расходы — ${md.join(', ')}` : ''].filter(Boolean).join('; ')}`)
    }
  }
  // Opening + credits − debits = closing, for a pair of fields that are NOT the matched turnovers
  // themselves: when turnovers reconcile, «credTurnover − debTurnover = net» holds by arithmetic
  // and would pass for a balance check with no balance anywhere in the response.
  // ⚠ A balance-only match is kept APART from matched turnovers in the verdict: any two fields that
  // happen to differ by `net` pass this test, so only their names tell a balance from a coincidence.
  const amt = sums.get('amount') ?? { C: 0, D: 0 }
  const net = amt.C - amt.D
  const balance = []
  if (net) {
    for (const [ka, va] of statNums) {
      if (turnover.has(ka)) continue
      for (const [kb, vb] of statNums) {
        if (kb !== ka && !turnover.has(kb) && vb - va === net) balance.push(`${ka} → ${kb}`)
      }
    }
    say(`  сальдо (входящее + приходы − расходы = исходящее): ${balance.length ? `сходится для ${balance.join('; ')}` : 'не сходится ни для одной пары полей'}`)
  }
  verdicts.push({ account: a, rows: rows.length, zero, zeroCodes, revalZero, revalPaid, curr, paid: paidRows.length, matched: matched.length > 0, balance: balance.length > 0, statsState, paidRows })
}

// ── Plan B for question 1: amounts, only on explicit request ──
if (input.amounts) {
  section('СУММЫ (AMOUNTS=1) — ЭТОТ ВЫВОД НЕ ПЕРЕСЫЛАТЬ')
  say('  Сверьте сами с интернет-банком: сумма в валюте счёта или её эквивалент в BYN.')
  for (const v of verdicts) {
    if (!v.paidRows?.length) continue
    say(`  ${mask(v.account.number)} (${v.account.currency}):`)
    for (const p of v.paidRows) say(`    ${p.date || '—'}  ${p.dir === 'C' ? 'приход' : 'расход'}  ${p.amount} ${p.currIso || '?'}`)
  }
}

// ── Verdict ──
const planB = 'план Б: AMOUNTS=1 make alfa-currency-probe и сверить суммы с интернет-банком самому (вывод с суммами не пересылать)'
section('Вердикт (#735)')
for (const v of verdicts) {
  const tag = `${mask(v.account.number)} (${v.account.currency})`
  if (v.fail) { say(`  ${tag}: вердикта нет — ${v.fail}`); continue }
  if (!v.rows) { say(`  ${tag}: за период операций нет — возьмите месяц с движением: FROM=… TO=… make alfa-currency-probe`); continue }
  say(`  ${tag}:`)
  const q1 = !v.paid ? 'операций с деньгами нет — сравнивать нечего'
    : v.matched ? 'суммы сошлись с полями statistics (выше) — по имени поля видно, в какой валюте amount'
      : v.balance ? `обороты не сошлись, сошлось только сальдо (выше) — если это входящий и исходящий остатки, валюту amount назовут их имена; иначе ${planB}`
        : v.statsState === 'empty' ? `statistics[] пуст — сверить не с чем; ${planB}`
          : v.statsState === 'other' ? `записи statistics[] для этого счёта нет; ${planB}`
            : `с полями statistics не сошлась ни одна сумма; ${planB}`
  say(`   1. Валюта суммы: ${q1}`)
  const q2 = v.revalPaid ? `\x1b[31m⚠ приходит С СУММОЙ — ${v.revalPaid} строк; рубеж по сумме их НЕ отсеет, в CRM они попадут как платежи\x1b[0m`
    : v.revalZero ? `приходит с нулевой суммой — ${v.revalZero} из ${v.rows}; в CRM не попадёт: её отсеивает рубеж по сумме`
      : v.zero ? `строк переоценки нет; строк с нулевой суммой ${v.zero} (${listed(v.zeroCodes)}) — в CRM они не попадут`
        : 'строк переоценки и строк с нулевой суммой нет'
  say(`   2. Переоценка: ${q2}`)
  say(`   3. statistics[]: ${v.statsState === 'ok' ? 'ключи выше' : v.statsState === 'empty' ? 'пуст' : 'записи для этого счёта нет'}`)
  const others = new Map([...v.curr].filter(([c]) => c !== v.account.currency))
  say(`   4. currIso: ${others.size ? `отличается от валюты счёта в строках: ${listed(others)}` : `во всех строках валюта счёта (${v.account.currency})`}`)
}
if (!input.amounts) say('\nВывод можно переслать целиком: сумм, назначений и контрагентов в нём нет, номера замаскированы.')
process.exit(verdicts.some(v => v.rejected) ? 2 : verdicts.some(v => v.fail) ? 1 : 0)
JS
)"

FROM_ALFA="$(alfa_day "$FROM_DAY")"
TO_ALFA="$(alfa_day "$TO_DAY")"
# shellcheck disable=SC2086 # $DC is a command line on purpose
printf '{"keys":[%s],"from":"%s","to":"%s","amounts":%s}' "$KEYS_JSON" "$FROM_ALFA" "$TO_ALFA" "$SHOW_AMOUNTS" \
  | $DC exec -T -e NODE_OPTIONS= backend node --input-type=module -e "$PROBE_JS" \
  | grep -v '^\[otel\]'
exit "${PIPESTATUS[1]}"
