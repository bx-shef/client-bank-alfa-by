#!/usr/bin/env bash
# Обновить OAuth-токен ЛЮБОГО из трёх поставщиков и показать, что шлём и что ответили (#488).
#
# ЗАЧЕМ ОДИН СКРИПТ НА ТРОИХ. У Альфы измерено: обмен `grant_type=refresh_token` проходит, пока жив
# ACCESS-токен, и отвергается через три секунды после его истечения — при заявленных для refresh
# десяти часах. Продление всех трёх поставщиков мы строили по образцу Bitrix24, где refresh живёт
# 180 дней, поэтому у Приора стоит тот же порог «половина срока refresh» = 6 часов при часовом
# access. Ведёт ли себя Приор как Альфа — НЕ ИЗМЕРЕНО. Общая проба нужна, чтобы ответ получался
# одинаковым способом, а не тремя разными скриптами, которые потом не сравнить.
#
# ⚠ ПИШЕТ В БАЗУ. Все три поставщика РОТИРУЮТ refresh при обмене: удачный запрос делает хранимый
# токен недействительным. Проба, не сохранившая новую пару, убила бы живое подключение — у банков
# это лечится только повторным входом ВЛАДЕЛЬЦА СЧЁТА в интернет-банк.
#
# ⚠ СЕКРЕТЫ В ВЫВОД НЕ ПОПАДАЮТ: ни токены, ни `client_secret`, ни приватный ключ. Печатаются
# длины, контрольные суммы и выбранные безопасные поля ответа.
#
#   bash oauth-refresh-probe.sh alfa|prior|b24
set -u

P="${1:-alfa}"
COMPOSE="${2:-docker-compose.prod.yml}"
cd /home/bitrix/bank-import 2>/dev/null || true

case "$P" in
  alfa)  TITLE='Альфа-Банк'; SQL_WHERE="FROM bank_tokens WHERE provider='alfa-by'" ;;
  prior) TITLE='Приорбанк';  SQL_WHERE="FROM bank_tokens WHERE provider='prior-by'" ;;
  b24)   TITLE='Bitrix24';   SQL_WHERE="FROM portal_tokens" ;;
  *) echo "поставщик: alfa | prior | b24"; exit 2 ;;
esac

echo "== Форсированное обновление токена: $TITLE (#488) =="
echo

# ⚠ Берём САМУЮ СВЕЖУЮ строку: их бывает несколько, и проба по чужой ответила бы про мёртвый грант.
row=$(docker compose -f "$COMPOSE" exec -T db \
        sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F"|"' 2>/tmp/orp-err.$$ <<SQL
  SELECT refresh_token_enc,
         to_char(updated_at,'YYYY-MM-DD HH24:MI'),
         round(extract(epoch FROM (now() - updated_at))/60)::int,
         expires_at,
         round(extract(epoch FROM now()) - expires_at/1000.0)::int
    $SQL_WHERE
   ORDER BY updated_at DESC
   LIMIT 1;
SQL
)
if [ -z "${row:-}" ]; then
  # ⚠ «Строк нет» — это НЕ отказ банка, а невозможность попробовать. Лестница обязана различать
  # их машинной меткой, а не наличием слова в прозе: 2026-09-07 она объявила «банк не терпит 1m»
  # на отсутствующем подключении Альфы, то есть выдала уверенный вердикт о банке, которого не
  # спрашивали.
  echo "VERDICT|not-attempted"
  echo "подключения нет в базе — обмен не выполнялся. Что ответил Postgres (если ошибка):"
  sed 's/^/  /' /tmp/orp-err.$$ 2>/dev/null
  rm -f /tmp/orp-err.$$; exit 2
fi
rm -f /tmp/orp-err.$$

blob=$(echo "$row" | cut -d'|' -f1)
ok_at=$(echo "$row" | cut -d'|' -f2)
ok_min=$(echo "$row" | cut -d'|' -f3)
acc_age=$(echo "$row" | cut -d'|' -f5)

echo "последняя удачная пара : $ok_at UTC  ($ok_min мин назад)"
if [ "${acc_age:-0}" -gt 0 ] 2>/dev/null; then
  echo "access-токен           : ИСТЁК $acc_age с назад"
else
  echo "access-токен           : ещё жив (${acc_age#-} с в запасе)"
fi
echo "⚠ Вот это соотношение и есть предмет опыта: работает ли обмен после смерти access."
echo

js=$(mktemp /tmp/orp.XXXXXX.js) && trap 'rm -f "$js"' EXIT
cat > "$js" <<'NODE'
const crypto = require('node:crypto')
const P = process.env.P
// ⚠ Любой выход ДО ответа банка — «не состоялось», а не отказ: нет ключа, не расшифровался блоб,
// не хватает env, не достучались по сети. Смешивать их с отказом банка нельзя — вердикт лестницы
// строится на этом различии.
const fail = (m) => { console.log('VERDICT|not-attempted'); console.log('РЕЗУЛЬТАТ: ' + m); process.exit(0) }
const env = (n) => (process.env[n] || '').trim()
const sum = (v) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 12)

const rawKey = env('B24_TOKEN_ENC_KEY')
if (!rawKey) fail('в контейнере нет B24_TOKEN_ENC_KEY — расшифровать нечем')
const key = /^[0-9a-fA-F]{64}$/.test(rawKey) ? Buffer.from(rawKey, 'hex') : Buffer.from(rawKey, 'base64')

const parts = (process.env.BLOB || '').split(':')
if (parts.length !== 3) fail('блоб не в формате iv:tag:ciphertext — строка испорчена')
let token
try {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64'))
  d.setAuthTag(Buffer.from(parts[1], 'base64'))
  token = Buffer.concat([d.update(Buffer.from(parts[2], 'base64')), d.final()]).toString('utf8')
} catch (e) { fail('НЕ РАСШИФРОВЫВАЕТСЯ: ' + e.message) }
if (!token) fail('refresh-токен пустой — продлевать нечем, нужно переподключение')

// ⚠ Форма запроса у трёх поставщиков РАЗНАЯ, и в этом весь смысл сравнения:
//   Bitrix24 и Альфа — креды в ТЕЛЕ (4 поля);
//   Приор — креды ОТДЕЛЬНО (тело из 2 полей): либо Basic-заголовок, либо подписанный
//   `client_assertion` (private_key_jwt) — так требует его профиль FAPI.
let url, body, headers = { 'content-type': 'application/x-www-form-urlencoded' }, authNote
if (P === 'b24') {
  url = 'https://oauth.bitrix.info/oauth/token/'
  const id = env('B24_CLIENT_ID'), sec = env('B24_CLIENT_SECRET')
  if (!id || !sec) fail('нет B24_CLIENT_ID/_CLIENT_SECRET')
  body = new URLSearchParams({ grant_type: 'refresh_token', client_id: id, client_secret: sec, refresh_token: token }).toString()
  authNote = 'client_id + client_secret В ТЕЛЕ'
  console.log('  client_id     : длина ' + id.length + ', sha256 ' + sum(id))
} else if (P === 'alfa') {
  url = env('ALFA_OAUTH_TOKEN_URL')
  const id = env('ALFA_OAUTH_CLIENT_ID'), sec = env('ALFA_OAUTH_CLIENT_SECRET')
  if (!url || !id || !sec) fail('нет ALFA_OAUTH_TOKEN_URL/_CLIENT_ID/_CLIENT_SECRET')
  body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: id, client_secret: sec }).toString()
  authNote = 'client_id + client_secret В ТЕЛЕ'
  console.log('  client_id     : длина ' + id.length + ', sha256 ' + sum(id))
} else {
  url = env('PRIOR_OAUTH_TOKEN_URL')
  const id = env('PRIOR_OAUTH_CLIENT_ID')
  if (!url || !id) fail('нет PRIOR_OAUTH_TOKEN_URL/_CLIENT_ID')
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token })
  const method = env('PRIOR_OAUTH_AUTH_METHOD') || 'client_secret_basic'
  if (method === 'private_key_jwt') {
    // ⚠ Подписываем ТОТ ЖЕ assertion, что и продукт: iss=sub=client_id, aud из env, RS256, kid в
    // заголовке. Иначе проба мерила бы не наш путь аутентификации, а свой.
    const pk = env('PRIOR_OAUTH_PRIVATE_KEY').replace(/\\n/g, '\n')
    const kid = env('PRIOR_OAUTH_KID'), aud = env('PRIOR_OAUTH_AUDIENCE')
    if (!pk || !kid || !aud) fail('нет PRIOR_OAUTH_PRIVATE_KEY/_KID/_AUDIENCE для private_key_jwt')
    const now = Math.floor(Date.now() / 1000)
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const head = b64({ alg: 'RS256', typ: 'JWT', kid })
    const payload = b64({ iss: id, sub: id, aud, jti: crypto.randomUUID(), iat: now, exp: now + 300 })
    const sig = crypto.sign('RSA-SHA256', Buffer.from(head + '.' + payload), pk).toString('base64url')
    form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
    form.set('client_assertion', head + '.' + payload + '.' + sig)
    authNote = 'private_key_jwt — подписанный client_assertion В ТЕЛЕ, секрета нет'
  } else {
    const sec = env('PRIOR_OAUTH_CLIENT_SECRET')
    if (!sec) fail('нет PRIOR_OAUTH_CLIENT_SECRET для client_secret_basic')
    headers.authorization = 'Basic ' + Buffer.from(id + ':' + sec).toString('base64')
    authNote = 'client_secret_basic — креды в ЗАГОЛОВКЕ Authorization'
  }
  body = form.toString()
  console.log('  client_id     : длина ' + id.length + ', sha256 ' + sum(id))
}

console.log('ЧТО МЫ ОТПРАВЛЯЕМ')
console.log('  refresh_token : длина ' + token.length + ', sha256 ' + sum(token))
console.log('  пробелы по краям: ' + (token.trim() === token ? 'нет' : 'ЕСТЬ — порча хранения'))
console.log('  адрес         : ' + url)
console.log('  аутентификация: ' + authNote)
console.log('  поля тела     : ' + [...new URLSearchParams(body).keys()].join(', '))
console.log('  заголовки     : ' + Object.keys(headers).join(', '))
console.log('')

const redact = (s) => String(s).split(token).join('***')
  .replace(/[A-Za-z0-9+/_.-]{40,}={0,2}/g, '***')

;(async () => {
  let res, text
  try {
    res = await fetch(url, { method: 'POST', headers, body })
    text = await res.text()
  } catch (e) { fail('до сервера не достучались: ' + redact(e.message)) }

  console.log('ЧТО ОТВЕТИЛИ')
  console.log('  HTTP ' + res.status)
  if (res.status === 200) {
    let j = {}
    try { j = JSON.parse(text) } catch { /* ниже */ }
    console.log('  expires_in=' + (j.expires_in ?? '?') + ' token_type=' + (j.token_type ?? '?')
      + (j.scope ? ' scope=' + j.scope : ''))
    console.log('  access_token : ' + (j.access_token ? 'получен, длина ' + j.access_token.length : 'НЕТ'))
    console.log('  refresh_token: ' + (j.refresh_token ? 'получен, длина ' + j.refresh_token.length : 'НЕ выдан'))
    console.log('')
    if (!j.access_token) fail('200 без access_token')
    console.log('VERDICT|ok')
    console.log('РЕЗУЛЬТАТ: ✅ ОБНОВЛЕНИЕ ПРОШЛО.')

    // ⚠ ПОСЛЕ ОБНОВЛЕНИЯ — ОДИН РЕАЛЬНЫЙ ВЫЗОВ API (только Альфа). Замер 8 сентября показал: 19
    // обменов по полчаса проходят, 20-й — через 10 ч 03 мин от подключения — отвергается. Потолок
    // сессии в 10 часов, о котором говорит банк, оказался настоящим. Но та лестница НИ РАЗУ не
    // обращалась к API: счёт не был выбран, выписка не запрашивалась, мы только меняли токены.
    // А в августе, когда подключение прожило шестеро суток, опрос ходил за выпиской каждые пять
    // минут. Это единственное различие между двумя случаями, и оно превращается в вопрос:
    // ПРОДЛЕВАЕТ ЛИ СЕССИЮ ИСПОЛЬЗОВАНИЕ access-токена. У шлюзов этого класса так бывает.
    //
    // ⚠ Ответ меняет всё: продлевает — потолок бьёт только по простаивающим подключениям, и
    // продукт работоспособен; не продлевает — владелец счёта обязан входить в интернет-банк каждые
    // 10 часов, и это уже не лечится кодом.
    //
    // ⚠ Исход вызова НА ВЕРДИКТ СТУПЕНИ НЕ ВЛИЯЕТ: лестница отвечает на вопрос «принимает ли банк
    // обмен», а этот вызов — отдельное действие, чьё влияние мы и меряем. Смешать их значило бы
    // получить отказ API, записанный как отказ в продлении.
    //
    // ⚠ НОМЕРА СЧЕТОВ НЕ ПЕЧАТАЕМ — только код ответа и количество. Вывод пробы копируют в
    // переписку, а номер счёта это персональные данные (docs/PRIVACY.md).
    if (P === 'alfa') {
      const apiBase = (env('ALFA_OAUTH_API_BASE') || '').replace(/\/+$/, '')
      const prefix = '/' + (env('ALFA_OAUTH_API_PREFIX') || '/partner/1.2.0').replace(/^\/+/, '').replace(/\/+$/, '')
      if (!apiBase) {
        console.log('ИСПОЛЬЗУЕМ ТОКЕН: пропущено — нет ALFA_OAUTH_API_BASE')
      } else {
        const accUrl = apiBase + prefix + '/accounts/'
        console.log('ИСПОЛЬЗУЕМ ТОКЕН (проверяем, продлевает ли сессию обращение к API)')
        console.log('  GET ' + accUrl)
        try {
          const ar = await fetch(accUrl, {
            headers: { authorization: 'Bearer ' + j.access_token },
            signal: AbortSignal.timeout(20_000),
          })
          let n = '?'
          try {
            const body = JSON.parse(await ar.text())
            if (Array.isArray(body.accounts)) n = String(body.accounts.length)
          } catch { /* тело не разобралось — хватит кода ответа */ }
          console.log('  HTTP ' + ar.status + ', счетов в ответе: ' + n)
        } catch {
          // Текст исключения повторяет URL и может нести заголовок — наружу не отдаём.
          console.log('  НЕ ДОСТУЧАЛИСЬ (сеть или таймаут 20 с)')
        }
      }
      console.log('')
    }

    const keep = j.refresh_token || token
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', key, iv)
    const enc = Buffer.concat([c.update(keep, 'utf8'), c.final()])
    console.log('SAVE|' + j.access_token + '|'
      + [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':')
      + '|' + (Date.now() + (Number(j.expires_in) || 3600) * 1000))
  } else {
    console.log('  ' + redact(text).slice(0, 600))
    console.log('')
    console.log('VERDICT|bank-refused')
    console.log('РЕЗУЛЬТАТ: обновление НЕ прошло — банк ОТВЕТИЛ отказом.')
  }
})()
NODE

res=$(docker compose -f "$COMPOSE" exec -T -e BLOB="$blob" -e P="$P" backend node < "$js" 2>&1)
echo "$res" | grep -vE '^(SAVE|VERDICT)\|'
save=$(echo "$res" | grep '^SAVE|' | head -1)

if [ -n "${save:-}" ]; then
  at=$(echo "$save" | cut -d'|' -f2); enc=$(echo "$save" | cut -d'|' -f3); exp=$(echo "$save" | cut -d'|' -f4)
  case "$P" in
    b24) TBL='portal_tokens'; SEL="(SELECT member_id FROM portal_tokens ORDER BY updated_at DESC LIMIT 1)"; KEYCOL='member_id' ;;
    *)   TBL='bank_tokens';   SEL="(SELECT id FROM bank_tokens WHERE provider='$( [ "$P" = alfa ] && echo alfa-by || echo prior-by )' ORDER BY updated_at DESC LIMIT 1)"; KEYCOL='id' ;;
  esac
  upd=$(docker compose -f "$COMPOSE" exec -T -e AT="$at" -e ENC="$enc" -e EXP="$exp" db \
          sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -c \"
            UPDATE $TBL SET access_token='\$AT', refresh_token_enc='\$ENC',
                            expires_at=\$EXP, updated_at=now()
             WHERE $KEYCOL = $SEL RETURNING 1;\"" 2>&1)
  if echo "$upd" | grep -qx '1'; then
    echo "  новая пара СОХРАНЕНА — подключение осталось рабочим."
  else
    echo "  ⚠ НОВАЯ ПАРА НЕ СОХРАНИЛАСЬ, а прежняя уже потрачена. Что ответил Postgres:"
    echo "$upd" | sed 's/^/    /'
  fi
fi

# ⚠ КОД ВОЗВРАТА — ЕДИНСТВЕННЫЙ КАНАЛ ДЛЯ ЛЕСТНИЦЫ, и он выводится из машинной метки, а не из
# кода возврата `docker compose`: тот отдаёт 1 и на «сервис не поднят», то есть на аварии стенда
# лестница объявила бы отказ банка. Метку печатает только наш код и только после того, как
# HTTP-статус банка реально прочитан.
#   0 — банк обновил пару
#   1 — банк ОТВЕТИЛ отказом (это ответ опыта)
#   2 — обмена не было вовсе (нет строки, нет ключа, нет env, не достучались) — НЕ вердикт о банке
verdict_code() {
  case "$(printf '%s\n' "$1" | grep '^VERDICT|' | head -1 | cut -d'|' -f2)" in
    ok)           return 0 ;;
    bank-refused) return 1 ;;
    *)            return 2 ;;
  esac
}

verdict_code "$res"
exit $?
