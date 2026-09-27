#!/usr/bin/env bash
# One-off probe: what the Alfa API returns for a FOREIGN-currency account (#735).
#
# The FILE path was measured and fixed in #733: in a `Type=6` statement the plain amount field is
# the BYN equivalent, and 22 of 23 rows a month are "revaluation of the opening balance". The API
# path has never been measured on a currency account — every live measurement of the automatic poll
# used a BYN account. This probe answers the four questions of #735 without printing a single
# amount:
#   1. Is `amount` in the account currency or the BYN equivalent? The per-direction sums of the
#      rows are compared with every numeric field of `statistics[]`, and only the NAMES of the
#      matching fields are printed (the name tells which turnover it is).
#   2. Do revaluation rows come through the API? Rows with a zero amount, counted per
#      `operCodeName`.
#   3. What does `statistics[]` hold for a currency account? Its keys.
#   4. Is `currIso` the operation currency or the account currency? Compared with the account
#      currency reported by `GET /accounts/`.
#
# ⚠ READ-ONLY. One `GET /accounts/` and one `GET /accounts/statement` per currency account, with the
# access token that is already stored in `bank_tokens`. The refresh token is never selected, let
# alone used: the bank rotates it on refresh, and a manual refresh would put our database and the
# bank out of sync (#505/#509) — the same rule as `prod-alfa-page-probe.sh`.
#
# ⚠ The token never reaches a command line. The bank calls run in node inside the `backend`
# container (it already has the bank's CA chain and the API base in its environment), and the token
# is handed over on STDIN. Arguments are visible to every process via `/proc/<pid>/cmdline` and end
# up in the `execve` audit log on the host.
#
# ⚠ The output carries NO amounts, purposes or counterparties, and account numbers are masked:
# operator output gets forwarded as screenshots (docs/PRIVACY.md). Printed are counts, currency
# codes, the bank's operation-code names, field NAMES and yes/no reconciliation results.
#
# Usage (from the stack directory; normally through `make alfa-currency-probe`):
#   bash prod-alfa-currency-probe.sh "docker compose -f docker-compose.prod.yml"
# Environment:
#   FROM, TO — the period, YYYY-MM-DD (default: the 30 days up to yesterday, UTC)
#   B24      — the portal's address, required when several portals have an Alfa connection

set -u

MAX_SPAN_DAYS=93

# ── Pure functions (tests/prodAlfaCurrencyProbe.test.ts loads them through a sed range) ─────────

# 0 when the value is a real YYYY-MM-DD calendar day.
valid_day() {
  case "${1:-}" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) return 1 ;;
  esac
  # GNU date rejects 2026-02-30; the round trip catches a date that `date` silently normalises.
  [ "$(date -u -d "$1" +%Y-%m-%d 2>/dev/null)" = "$1" ]
}

# Days from $1 to $2 (both YYYY-MM-DD), or empty when either is not a day.
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
TO_DAY="${TO:-}"
FROM_DAY="${FROM:-}"
[ -n "$TO_DAY" ] || TO_DAY="$(date -u -d 'yesterday' +%Y-%m-%d 2>/dev/null)"
[ -n "$FROM_DAY" ] || FROM_DAY="$(date -u -d "$TO_DAY -29 days" +%Y-%m-%d 2>/dev/null)"

# ⚠ The FINAL values are checked, not only the arguments: if `date` failed, an empty day would go
# to the bank as `dateFrom=&dateTo=` — a request that looks sensible and means nothing.
for d in "$FROM_DAY" "$TO_DAY"; do
  if ! valid_day "$d"; then
    echo "✗ день «$d» — нужен формат ГГГГ-ММ-ДД: FROM=2026-08-01 TO=2026-08-31 make alfa-currency-probe"
    exit 2
  fi
done
SPAN="$(span_days "$FROM_DAY" "$TO_DAY")"
if [ "$SPAN" -lt 0 ]; then
  echo "✗ FROM ($FROM_DAY) позже TO ($TO_DAY)"
  exit 2
fi
if [ "$SPAN" -ge "$MAX_SPAN_DAYS" ]; then
  echo "✗ период $FROM_DAY … $TO_DAY длиннее $MAX_SPAN_DAYS дней — возьмите месяц-другой"
  exit 2
fi

section() { printf '\n\033[1m── %s ──\033[0m\n' "$1"; }

echo "Период: $FROM_DAY … $TO_DAY"

# ── Access token from the database (READ-ONLY) ──────────────────────────────────────────────────
# ⚠ `~pending:` rows are skipped: a connection without a chosen account has nothing to poll.
# ⚠ stderr is kept: a failed psql (the `db` container is down) must not read as «no connection».
# ⚠ Portals, not rows, decide whether the target is ambiguous: one company with a BYN and a USD
# account is two rows of ONE portal, and refusing there would only make the operator type B24= for
# nothing. Two portals with Alfa — then which key is probed would depend on token refresh order.
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
RAW_ROW="$($DC exec -T db psql -U app -d app -At -F'|' -c \
  "SELECT b.account_key, b.access_token,
          (SELECT count(DISTINCT member_id) FROM bank_tokens
             WHERE provider = 'alfa-by' AND account_key NOT LIKE '~pending:%')
     FROM bank_tokens b
    WHERE b.provider = 'alfa-by' AND b.account_key NOT LIKE '~pending:%' $PORTAL_WHERE
    ORDER BY b.updated_at DESC LIMIT 1" 2>"$PSQL_ERR")"
PSQL_RC=$?
ROW="$(printf '%s' "$RAW_ROW" | tr -d '\r')"

if [ "$PSQL_RC" -ne 0 ]; then
  printf '\033[31m✗ не смог прочитать базу (код %s)\033[0m\n' "$PSQL_RC"
  sed 's/^/  /' "$PSQL_ERR" | head -5
  exit 1
fi
if [ -z "$ROW" ]; then
  if [ -n "$PORTAL_DOMAIN" ]; then
    printf '\033[33m✗ у портала %s нет подключения Альфы — проверьте адрес\033[0m\n' "$PORTAL_DOMAIN"
  else
    printf '\033[33m✗ подключений Альфы на сервере нет — спрашивать банк нечем\033[0m\n'
  fi
  exit 1
fi
ACCOUNT="${ROW%%|*}"
REST="${ROW#*|}"
TOKEN="${REST%%|*}"
PORTALS="${REST##*|}"
if [ -z "$PORTAL_DOMAIN" ] && [ "${PORTALS:-1}" != "1" ]; then
  printf '\033[33m✗ Альфа подключена на %s порталах — какой ключ спрашивать, неясно\033[0m\n' "$PORTALS"
  echo "  Назовите портал его адресом (ПЕРЕД make — параметр после make исполняет подставленное):"
  echo "    B24=xxx.bitrix24.by make alfa-currency-probe"
  exit 1
fi
if [ -z "$TOKEN" ] || [ "$TOKEN" = "$ACCOUNT" ]; then
  echo "✗ не удалось прочитать access-токен — дождитесь очередного опроса и повторите"
  exit 1
fi

# ── The bank, from node inside the backend container ───────────────────────────────────────────
# ⚠ `NODE_OPTIONS` is cleared for this one process: the image preloads the telemetry loader, which
# prints its own line to stdout on every node start and would be mixed into the report.
# The program reads {token, account, from, to} from STDIN; everything it prints is safe to forward.
PROBE_JS="$(cat <<'JS'
const input = JSON.parse(await new Promise((resolve, reject) => {
  let s = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', c => { s += c })
  process.stdin.on('end', () => resolve(s))
  process.stdin.on('error', reject)
}))

const say = (line = '') => console.log(line)
const mask = n => (String(n).length >= 12 ? `${String(n).slice(0, 4)}…${String(n).slice(-4)}` : '****')
const section = t => say(`\n\x1b[1m── ${t} ──\x1b[0m`)
const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)
const listed = map => [...map].sort((a, b) => b[1] - a[1]).map(([k, n]) => `«${k}» ×${n}`).join(', ')
// Money in minor units, so that sums are compared exactly and not through float noise.
const cents = v => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d+(?:[.,]\d+)?$/.test(v.trim()) ? Number(v.replace(',', '.')) : NaN)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

const base = (process.env.ALFA_OAUTH_API_BASE ?? '').trim().replace(/\/+$/, '')
const prefix = `/${(process.env.ALFA_OAUTH_API_PREFIX ?? '').trim().replace(/^\/+|\/+$/g, '') || 'partner/1.2.0'}`
if (!base) {
  say('✗ ALFA_OAUTH_API_BASE в контейнере backend пуст — опрос Альфы на этом сервере выключен')
  process.exit(1)
}

async function get(path) {
  try {
    const r = await fetch(`${base}${prefix}${path}`, {
      headers: { Authorization: `Bearer ${input.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(45000)
    })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON — reported by keys below */ }
    return { status: r.status, json, text }
  } catch (e) {
    return { status: 0, json: null, text: '', error: e?.name === 'TimeoutError' ? 'банк не ответил за 45 с' : 'сетевая ошибка' }
  }
}

function rejected(r) {
  return r.status === 401 || r.status === 403 || /invalid_token|expired_token|Unauthorized/.test(r.text)
}

function stop(r, what) {
  if (rejected(r)) {
    say(`\x1b[31m✗ ${what}: токен отвергнут банком\x1b[0m`)
    say('  Дождитесь очередного опроса (он обновит токен сам) и повторите.')
    say('  ⚠ Обновлять токен руками НЕЛЬЗЯ — банк ротирует refresh, база и банк разъедутся (#505/#509).')
    process.exit(2)
  }
  // ⚠ Keys, not the text: the bank's message is not ours to print and may carry an account
  // number in the clear (see prod-alfa-page-probe.sh).
  const keys = r.json && typeof r.json === 'object' ? Object.keys(r.json).join(' ') : '<не JSON>'
  say(`\x1b[31m✗ ${what}: ${r.error ?? `HTTP ${r.status}`}\x1b[0m${r.error ? '' : ` — ключи ответа: ${keys}`}`)
  process.exit(1)
}

say(`Токен: подключение ${mask(input.account)}`)

// ── Accounts ──
const acc = await get('/accounts/')
if (acc.status !== 200 || !Array.isArray(acc.json?.accounts)) stop(acc, 'список счетов')
const accounts = acc.json.accounts
  .map(a => ({ number: String(a?.number ?? '').trim(), currency: String(a?.currIso ?? a?.currency ?? '').trim().toUpperCase() }))
  .filter(a => a.number)
section('Счета, которые видит ключ')
for (const a of accounts) say(`  ${mask(a.number)}  ${a.currency || '?'}${a.currency && a.currency !== 'BYN' ? '   ← валютный' : ''}`)
const foreign = accounts.filter(a => a.currency && a.currency !== 'BYN')
if (!foreign.length) {
  say('\n\x1b[33mВалютных счетов этот ключ не видит — мерить нечего.\x1b[0m')
  say('Если валютный счёт у другой компании, назовите её портал: B24=xxx.bitrix24.by make alfa-currency-probe')
  process.exit(3)
}
const MAX_ACCOUNTS = 5
if (foreign.length > MAX_ACCOUNTS) say(`  (валютных ${foreign.length}, спрашиваю первые ${MAX_ACCOUNTS})`)

// ── Statements ──
const verdicts = []
for (const a of foreign.slice(0, MAX_ACCOUNTS)) {
  section(`Валютный счёт ${mask(a.number)} (${a.currency})`)
  const q = `number=${encodeURIComponent(a.number)}&dateFrom=${input.from}&dateTo=${input.to}&transactions=0&pageNo=0&pageRowCount=0`
  const st = await get(`/accounts/statement?${q}`)
  if (st.status !== 200 || !st.json || typeof st.json !== 'object') stop(st, 'выписка')
  const body = st.json
  const errFields = Array.isArray(body.errors) && body.errors.length
    ? [...new Set(body.errors.flatMap(e => (e && typeof e === 'object' ? Object.keys(e) : [])))].join(' ')
    : ''
  if (!Array.isArray(body.page)) {
    say(`  в ответе нет page[] — ключи: ${Object.keys(body).join(' ')}`)
    verdicts.push({ account: a, rows: null })
    continue
  }
  const rows = body.page
  let credit = 0, debit = 0, other = 0, zero = 0, unreadable = 0
  let sumC = 0, sumD = 0
  const zeroCodes = new Map(), paidCodes = new Map(), curr = new Map()
  const fields = new Set(), numeric = new Set()
  const ratios = new Map()
  for (const r of rows) {
    for (const [k, v] of Object.entries(r ?? {})) {
      fields.add(k)
      if (typeof v === 'number') numeric.add(k)
    }
    const dir = r?.operType === 'C' ? 'C' : r?.operType === 'D' ? 'D' : ''
    if (dir === 'C') credit++
    else if (dir === 'D') debit++
    else other++
    count(curr, String(r?.currIso ?? '').trim().toUpperCase() || '—')
    const code = String(r?.operCodeName ?? '').trim().slice(0, 60) || '—'
    const c = cents(r?.amount)
    if (c === null || c < 0) { unreadable++; continue }
    if (c === 0) { zero++; count(zeroCodes, code); continue }
    count(paidCodes, code)
    if (dir === 'C') sumC += c
    if (dir === 'D') sumD += c
    // A second money field in the row, if the bank sends one: its ratio to `amount` is an exchange
    // rate — public, unlike either amount.
    for (const k of Object.keys(r)) {
      if (k === 'amount') continue
      const second = cents(r[k])
      if (second === null || typeof r[k] !== 'number') continue
      const ratio = second / c
      const seen = ratios.get(k) ?? [ratio, ratio]
      ratios.set(k, [Math.min(seen[0], ratio), Math.max(seen[1], ratio)])
    }
  }
  say(`  операций: ${rows.length} — приходов ${credit}, расходов ${debit}${other ? `, без направления ${other}` : ''}`)
  say(`  с нулевой суммой: ${zero}${zero ? ` — ${listed(zeroCodes)}` : ''}`)
  if (unreadable) say(`  \x1b[33mс нечитаемой или отрицательной суммой: ${unreadable}\x1b[0m`)
  if (paidCodes.size) say(`  с деньгами: ${listed(paidCodes)}`)
  say(`  валюта операций (currIso): ${listed(curr) || '—'}`)
  say(`  поля строки: ${[...fields].sort().join(' ') || '—'}`)
  say(`  числовые поля: ${[...numeric].sort().join(' ') || '—'}`)
  for (const [k, [lo, hi]] of ratios) say(`  отношение ${k} / amount: ${lo.toFixed(4)} … ${hi.toFixed(4)}`)
  if (errFields) say(`  errors[]: поля — ${errFields}`)

  // statistics[]: our account's entries (all of them when entries carry no number).
  const stats = Array.isArray(body.statistics) ? body.statistics.filter(s => s && typeof s === 'object') : []
  const mine = stats.some(s => 'number' in s) ? stats.filter(s => String(s.number ?? '').trim() === a.number) : stats
  const numericStats = new Map()
  for (const s of mine) {
    for (const [k, v] of Object.entries(s)) {
      const c = cents(v)
      if (c !== null && k !== 'number') numericStats.set(k, c)
      else if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) {
          const c2 = cents(v2)
          if (c2 !== null) numericStats.set(`${k}.${k2}`, c2)
        }
      }
    }
  }
  const statKeys = [...new Set(mine.flatMap(s => Object.keys(s)))].sort()
  say(`  statistics[]: ${stats.length ? `ключи — ${statKeys.join(' ') || '—'}` : 'пуст'}`)
  const matchC = sumC ? [...numericStats].filter(([, v]) => Math.abs(v) === sumC).map(([k]) => k) : []
  const matchD = sumD ? [...numericStats].filter(([, v]) => Math.abs(v) === sumD).map(([k]) => k) : []
  // Opening + credits − debits = closing, for any pair of numeric fields.
  const net = sumC - sumD
  const balance = []
  if (net) {
    for (const [ka, va] of numericStats) {
      for (const [kb, vb] of numericStats) if (ka !== kb && vb - va === net) balance.push(`${ka} → ${kb}`)
    }
  }
  if (sumC) say(`  сверка приходов: ${matchC.length ? `совпала с ${matchC.join(', ')}` : 'ни с одним полем statistics'}`)
  if (sumD) say(`  сверка расходов: ${matchD.length ? `совпала с ${matchD.join(', ')}` : 'ни с одним полем statistics'}`)
  if (net) say(`  сальдо (входящее + приходы − расходы = исходящее): ${balance.length ? `сходится для ${balance.join('; ')}` : 'не сходится ни для одной пары полей'}`)
  verdicts.push({ account: a, rows: rows.length, zero, zeroCodes, curr, paid: rows.length - zero - unreadable, matched: matchC.length + matchD.length + balance.length > 0, stats: stats.length })
}

// ── Verdict ──
section('Вердикт (#735)')
for (const v of verdicts) {
  const tag = `${mask(v.account.number)} (${v.account.currency})`
  if (v.rows === null) { say(`  ${tag}: ответ без page[] — см. ключи выше`); continue }
  if (!v.rows) { say(`  ${tag}: за период операций нет — возьмите месяц с движением: FROM=… TO=… make alfa-currency-probe`); continue }
  say(`  ${tag}:`)
  say(`   1. Валюта суммы: ${!v.paid ? 'операций с деньгами за период нет — сравнивать нечего'
    : v.matched ? 'суммы сошлись с полями statistics (выше) — по имени поля видно, в какой валюте amount'
      : v.stats ? 'с полями statistics не сошлась ни одна сумма — пришлите вывод целиком' : 'statistics[] пуст — сверить не с чем'}`)
  say(`   2. Переоценка: ${v.zero ? `через API ПРИХОДИТ — ${v.zero} из ${v.rows} (${listed(v.zeroCodes)}); в CRM не попадёт — её отсеивает рубеж по сумме` : 'строк с нулевой суммой нет'}`)
  say(`   3. statistics[]: ${v.stats ? 'ключи выше' : 'пуст'}`)
  const others = [...v.curr.keys()].filter(c => c !== v.account.currency)
  say(`   4. currIso: ${others.length ? `отличается от валюты счёта в строках: ${listed(new Map([...v.curr].filter(([c]) => c !== v.account.currency)))}` : `во всех строках валюта счёта (${v.account.currency})`}`)
}
say('\nВывод можно переслать целиком: сумм, назначений и контрагентов в нём нет, номера замаскированы.')
JS
)"

FROM_ALFA="$(alfa_day "$FROM_DAY")"
TO_ALFA="$(alfa_day "$TO_DAY")"
# JSON by hand: the token and the account are opaque [A-Za-z0-9._~-] strings, the dates are digits;
# anything else is refused instead of escaped — a token with a quote in it is not a token.
case "$TOKEN$ACCOUNT" in
  *[!A-Za-z0-9._~+/=-]*) echo "✗ в токене или номере счёта неожиданные символы — проба остановлена"; exit 1;;
esac
# shellcheck disable=SC2086 # $DC is a command line on purpose
printf '{"token":"%s","account":"%s","from":"%s","to":"%s"}' "$TOKEN" "$ACCOUNT" "$FROM_ALFA" "$TO_ALFA" \
  | $DC exec -T -e NODE_OPTIONS= backend node --input-type=module -e "$PROBE_JS" \
  | grep -v '^\[otel\]'
exit "${PIPESTATUS[1]}"
