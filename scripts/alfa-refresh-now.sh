#!/usr/bin/env bash
# Форсировать обновление токена Альфы ПРЯМО СЕЙЧАС и показать, что мы шлём и что отвечает банк (#488).
#
# ЗАЧЕМ. Замер 2026-09-06: банк отверг штатное продление словами
# `invalid_grant: User session not alive` на 5 ч 48 мин после подключения — ВНУТРИ документированного
# срока refresh-токена (36000 с). По документации запрос обязан был сработать. Значит одно из двух:
#   • дело во ВРЕМЕНИ (грант умирает раньше срока) — тогда обновление СРАЗУ после подключения пройдёт;
#   • дело в том, ЧТО МЫ ШЛЁМ — тогда оно не пройдёт и через десять минут.
# Различить их рассуждением нельзя, а одним запросом — можно. Ради этого проба и написана.
#
# ⚠ ПРОБА ПИШЕТ В БАЗУ, И ЭТО ОСОЗНАННО — в отличие от `bank-history`, который только читает.
# Банк РОТИРУЕТ refresh при каждом обновлении: удачный обмен делает хранимый токен недействительным.
# Проба, не сохранившая новую пару, убила бы живое подключение — лечится это только повторным входом
# владельца счёта в интернет-банк (#505/#509). Поэтому на успехе новая пара сразу ложится в строку,
# тем же шифром и в том же формате, что пишет приложение.
#
# ⚠ СЕКРЕТЫ В ВЫВОД НЕ ПОПАДАЮТ. Ни сам refresh-токен, ни новый, ни `client_secret`. Про
# отправляемый токен печатаются ПРИЗНАКИ — длина, контрольная сумма, есть ли пробелы по краям,
# весь ли он из безопасных символов: этого хватает, чтобы поймать порчу при хранении, и не хватает,
# чтобы токеном воспользоваться.
#
# Использование (из /home/bitrix/bank-import):
#   make alfa-refresh-now
set -u

COMPOSE="${1:-docker-compose.prod.yml}"
cd /home/bitrix/bank-import 2>/dev/null || true

echo "== Форсированное обновление токена Альфы (#488) =="
echo

# ⚠ Берём САМУЮ СВЕЖУЮ строку Альфы. Их бывает несколько (каждое подключение заводит свою), и
# продлевать надо ту, которой пользуется приложение, — иначе проба ответит про чужой, мёртвый грант.
row=$(docker compose -f "$COMPOSE" exec -T db \
        sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F"|"' 2>/tmp/arn-err.$$ <<'SQL'
  SELECT id, account_key, refresh_token_enc,
         to_char(updated_at,'YYYY-MM-DD HH24:MI'),
         round(extract(epoch FROM (now() - updated_at))/60)::int
    FROM bank_tokens
   WHERE provider = 'alfa-by'
   ORDER BY updated_at DESC, id DESC
   LIMIT 1;
SQL
)
if [ -z "${row:-}" ]; then
  echo "Подключений Альфы в базе нет. Что ответил Postgres (если ошибка):"
  sed 's/^/  /' /tmp/arn-err.$$ 2>/dev/null
  rm -f /tmp/arn-err.$$
  exit 0
fi
rm -f /tmp/arn-err.$$

id=$(echo "$row" | cut -d'|' -f1)
acct=$(echo "$row" | cut -d'|' -f2)
blob=$(echo "$row" | cut -d'|' -f3)
ok_at=$(echo "$row" | cut -d'|' -f4)
ok_min=$(echo "$row" | cut -d'|' -f5)

# ⚠ Имена переменных — ЛАТИНИЦЕЙ. Кириллическое имя bash в общем случае не принимает:
# на боевом стенде это дало `акк=…: command not found` и `bad substitution`, то есть
# строка подключения не отобразилась вовсе. Держит `tests/shellAsciiVars.test.ts`.
case "$acct" in ~pending:*) shown='(счёт не выбран)' ;; *) shown="${acct:0:6}…${acct: -4}" ;; esac
echo "строка              : #$id  $shown"
echo "последняя удачная   : $ok_at  ($ok_min мин назад)"
echo "⚠ Именно эта давность и есть предмет опыта: сработает — дело было во времени."
echo

js=$(mktemp /tmp/arn.XXXXXX.js) && trap 'rm -f "$js"' EXIT
cat > "$js" <<'NODE'
const crypto = require('node:crypto')

const fail = (m) => { console.log('РЕЗУЛЬТАТ: ' + m); process.exit(0) }
const raw = (process.env.B24_TOKEN_ENC_KEY || '').trim()
if (!raw) fail('в контейнере нет B24_TOKEN_ENC_KEY — расшифровать нечем')
const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')

const blob = process.env.BLOB || ''
const parts = blob.split(':')
if (parts.length !== 3) fail('блоб не в формате iv:tag:ciphertext — строка испорчена')

let token
try {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64'))
  d.setAuthTag(Buffer.from(parts[1], 'base64'))
  token = Buffer.concat([d.update(Buffer.from(parts[2], 'base64')), d.final()]).toString('utf8')
} catch (e) {
  fail('НЕ РАСШИФРОВЫВАЕТСЯ: ' + e.message + ' — ключ сменился или строка испорчена')
}
if (!token) fail('refresh-токен пустой — продлевать нечем, нужно переподключение')

// ⚠ Признаки, а не значение. Их достаточно, чтобы поймать порчу при хранении (обрезка, пробелы,
// подмена кодировки), и недостаточно, чтобы токеном воспользоваться.
const sum = crypto.createHash('sha256').update(token).digest('hex').slice(0, 12)
const trimmed = token.trim()
console.log('ЧТО МЫ ОТПРАВЛЯЕМ')
console.log('  refresh_token : длина ' + token.length + ', sha256 ' + sum)
console.log('  пробелы по краям: ' + (trimmed === token ? 'нет' : 'ЕСТЬ — это порча хранения'))
console.log('  символы       : ' + (/^[A-Za-z0-9._~+/=-]+$/.test(token)
  ? 'обычные для токена' : 'ЕСТЬ НЕОБЫЧНЫЕ — возможна порча кодировки'))

const clientId = (process.env.ALFA_OAUTH_CLIENT_ID || '').trim()
const clientSecret = (process.env.ALFA_OAUTH_CLIENT_SECRET || '').trim()
const tokenUrl = (process.env.ALFA_OAUTH_TOKEN_URL || '').trim()
if (!clientId || !clientSecret || !tokenUrl) fail('в контейнере не хватает ALFA_OAUTH_CLIENT_ID/_CLIENT_SECRET/_TOKEN_URL')
console.log('  client_id     : длина ' + clientId.length + ', sha256 '
  + crypto.createHash('sha256').update(clientId).digest('hex').slice(0, 12))
console.log('  адрес         : ' + tokenUrl)
console.log('  тело          : grant_type=refresh_token, refresh_token, client_id, client_secret')
console.log('  заголовок     : content-type: application/x-www-form-urlencoded')
console.log('')

// ⚠ URLSearchParams кодирует тело по тому же правилу, что требует документация Альфы
// (RFC 6749 Appendix B) — и ровно так же его строит приложение. Проба обязана слать ТО ЖЕ САМОЕ,
// иначе она отвечала бы на вопрос о себе, а не о продукте.
const body = new URLSearchParams({
  grant_type: 'refresh_token', refresh_token: token, client_id: clientId, client_secret: clientSecret
}).toString()

// ⚠ Две ступени. Первая вырезает то, что мы ОТПРАВИЛИ. Вторая — любую длинную строку из
// алфавита токенов: апстрим волен процитировать в ошибке значение, которого мы не посылали.
const redact = (s) => String(s)
  .split(clientSecret).join('***')
  .split(token).join('***')
  .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '***')

;(async () => {
  let res, text
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    })
    text = await res.text()
  } catch (e) {
    fail('до банка не достучались: ' + redact(e.message))
  }
  console.log('ЧТО ОТВЕТИЛ БАНК')
  console.log('  HTTP ' + res.status)
  // ⚠ ТЕЛО ОТВЕТА ЦЕЛИКОМ НЕ ПЕЧАТАЕМ. Первая редакция печатала его «с вырезанными секретами», но
  // вырезала только то, что ОТПРАВИЛИ (старый refresh, client_secret) — а в успешном ответе лежит
  // НОВАЯ пара, которой в списке замен быть не могло. Владелец вставил такой вывод в переписку;
  // это и есть цена «отредактируем по значениям». Правило теперь обратное: на успехе печатаем
  // ТОЛЬКО выбранные безопасные поля, на отказе — текст ошибки, из которого вырезаны И отправленные
  // секреты, И всё, что похоже на токен.
  if (res.status === 200) {
    let peek = {}
    try { peek = JSON.parse(text) } catch { /* покажем как есть ниже */ }
    console.log('  scope=' + (peek.scope ?? '?') + ' token_type=' + (peek.token_type ?? '?')
      + ' expires_in=' + (peek.expires_in ?? '?'))
    console.log('  access_token: получен, длина ' + String(peek.access_token || '').length)
    console.log('  refresh_token: ' + (peek.refresh_token
      ? 'получен, длина ' + peek.refresh_token.length : 'НЕ выдан'))
  } else {
    console.log('  ' + redact(text).slice(0, 600))
  }
  console.log('')

  if (res.status !== 200) {
    console.log('РЕЗУЛЬТАТ: обновление НЕ прошло.')
    console.log('  Если давность выше — минуты, то дело НЕ во времени: обновление не работает вовсе,')
    console.log('  и шесть суток жизни держались на чём-то другом. Искать в том, что мы шлём.')
    return
  }

  let j
  try { j = JSON.parse(text) } catch { fail('банк ответил 200, но не JSON') }
  if (!j.access_token || !j.refresh_token) fail('банк ответил 200 без access_token/refresh_token')

  // ⚠ СОХРАНЯЕМ. Банк уже отдал новую пару и старую считает потраченной; не записав её, проба
  // убила бы подключение. Шифруем тем же алгоритмом и в том же формате, что приложение.
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([c.update(j.refresh_token, 'utf8'), c.final()])
  const out = [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':')
  const expiresAt = Date.now() + (Number(j.expires_in) || 3600) * 1000

  console.log('РЕЗУЛЬТАТ: ✅ ОБНОВЛЕНИЕ ПРОШЛО.')
  console.log('  Значит дело было во ВРЕМЕНИ, а не в составе запроса: тот же запрос, что падал')
  console.log('  через шесть часов, проходит сейчас. Каденцию продления надо менять.')
  console.log('  новый access_token: длина ' + j.access_token.length + ', живёт ' + (j.expires_in || '?') + ' с')
  // Последней строкой — машинный хвост для шелла. Сам блоб зашифрован и в терминал НЕ печатается.
  console.log('SAVE|' + j.access_token + '|' + out + '|' + expiresAt)
})()
NODE

# ⚠ Программа едет в node ЧЕРЕЗ STDIN, а не параметром `-e`: иначе кавычки JS пришлось бы
# экранировать через шелл, и одна ошибка молча меняла бы отправляемый запрос.
res=$(docker compose -f "$COMPOSE" exec -T -e BLOB="$blob" backend node < "$js" 2>&1)
# Машинный хвост отделяем и НЕ печатаем: в нём новая пара токенов.
echo "$res" | grep -v '^SAVE|'
save=$(echo "$res" | grep '^SAVE|' | head -1)

if [ -n "${save:-}" ]; then
  at=$(echo "$save" | cut -d'|' -f2)
  enc=$(echo "$save" | cut -d'|' -f3)
  exp=$(echo "$save" | cut -d'|' -f4)
  # ⚠ Пишем ту же строку по неизменяемому `id`, а не по номеру счёта: счёт мог смениться
  # (выбор счёта переименовывает `~pending:`-ключ), и тогда запись легла бы мимо.
  upd=$(docker compose -f "$COMPOSE" exec -T \
          -e AT="$at" -e ENC="$enc" -e EXP="$exp" -e ID="$id" db \
          sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "
            UPDATE bank_tokens
               SET access_token = '"'"'$AT'"'"', refresh_token_enc = '"'"'$ENC'"'"',
                   expires_at = $EXP, updated_at = now()
             WHERE id = $ID
            RETURNING 1;"' 2>&1)
  # ⚠ Ищем строку `1` ГДЕ УГОДНО в выводе, а не последнюю: psql печатает и результат RETURNING, и
  # командный тег `UPDATE 1`, и последней оказывается вторая. Первая редакция сравнивала с хвостом
  # и на успешной записи печатала «НЕ СОХРАНИЛАСЬ» — то есть посылала владельца переподключать
  # рабочее подключение. Ложная тревога здесь дороже молчания.
  if echo "$upd" | grep -qx '1'; then
    echo "  новая пара СОХРАНЕНА в строку #$id — подключение осталось рабочим."
  else
    echo "  ⚠ НОВАЯ ПАРА НЕ СОХРАНИЛАСЬ. Банк её уже выдал, а значит прежняя потрачена:"
    echo "    подключение придётся создать заново. Что ответил Postgres:"
    echo "$upd" | sed 's/^/    /'
  fi
fi
