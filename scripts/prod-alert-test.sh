#!/usr/bin/env bash
# Послать в канал оповещений одно тестовое сообщение и сказать, дошло ли (#466 §3).
#
# ЗАЧЕМ. Канал молчит ОДИНАКОВО в трёх разных случаях: всё хорошо, он выключен (нет переменных),
# и он включён, но не доходит (бот отозван, неверный `chat_id`, заблокирован). Первые два `make
# doctor` теперь различает по наличию переменных, а третий по переменным НЕ определить в принципе —
# ответить может только сам Telegram. Разница не теоретическая: ради этого канала он и заведён,
# и «настроен» вместо «доходит» — ровно то обещание, на которое потом полагаются молча.
#
# ⚠ ТОКЕН НЕ ПЕЧАТАЕТСЯ НИКОГДА. Он стоит в URL каждого вызова, поэтому наружу идут только
# HTTP-статус и поля `ok`/`error_code`/`description` разобранного ответа, а ошибка сети печатается
# фиксированной строкой — текст исключения повторяет запрошенный URL вместе с токеном.
#
# ⚠ Шлём ЧЕРЕЗ КОНТЕЙНЕР, а не с хоста: проверять надо тот доступ в сеть, который есть у процесса,
# отправляющего настоящие тревоги. У хоста он может быть шире (у контейнера свой резолвер, свои
# корни доверия, свой выход наружу), и проба с хоста ответила бы про чужой путь.
#
#   bash scripts/prod-alert-test.sh
set -uo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DC="docker compose -f $COMPOSE_FILE"
[ -f "$COMPOSE_FILE" ] || { echo "Нет $COMPOSE_FILE — запускать из каталога развёртывания"; exit 2; }

echo "== Проверка канала оповещений оператору =="
echo

js=$(mktemp /tmp/alert-test.XXXXXX.js) && trap 'rm -f "$js"' EXIT
cat > "$js" <<'NODE'
// ⚠ Имена переменных и адрес — те же, что у боевого транспорта `server/utils/telegramAlert.ts`;
// расхождение стерёг бы `tests/prodAlertTest.test.ts`. Отдельный код здесь потому, что боевой
// живёт внутри собранного бандла и снаружи не вызывается.
const token = (process.env.TELEGRAM_ALERT_BOT_TOKEN || '').trim()
const chatId = (process.env.TELEGRAM_ALERT_CHAT_ID || '').trim()

if (!token && !chatId) {
  console.log('КАНАЛ ВЫКЛЮЧЕН: не заданы TELEGRAM_ALERT_BOT_TOKEN и TELEGRAM_ALERT_CHAT_ID.')
  console.log('Это нормальное состояние развёртывания, но тревоги о падении очередей и о мёртвых')
  console.log('подключениях банка никуда не уйдут — их увидит только тот, кто откроет /queues.')
  process.exit(3)
}
// ⚠ Половина настройки ХУЖЕ выключенного канала: снаружи выглядит включённым, а роняет каждую
// тревогу молча. Отдельная ветка, а не «не задан один из двух».
if (!token || !chatId) {
  console.log('КАНАЛ НАСТРОЕН НАПОЛОВИНУ: задан только '
    + (token ? 'TELEGRAM_ALERT_BOT_TOKEN' : 'TELEGRAM_ALERT_CHAT_ID') + '.')
  console.log('Приложение в таком виде канал НЕ включает, и каждая тревога будет потеряна.')
  process.exit(3)
}

const host = process.env.HOSTNAME || 'backend'
const text = 'Проверка канала оповещений (' + host + ', ' + new Date().toISOString() + ').'
  + '\nЭто тест по команде оператора, реакции не требует.'

;(async () => {
  let res
  try {
    res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // parse_mode не ставим — как и боевой транспорт: из простого текста нечему сбегать.
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    // Текст исключения повторяет URL, а URL несёт токен.
    console.log('НЕ ДОШЛО: до api.telegram.org не достучались (сеть, DNS или таймаут 10 с).')
    process.exit(1)
  }
  let body = {}
  try { body = JSON.parse(await res.text()) } catch { /* ниже по статусу */ }
  if (res.status === 200 && body.ok) {
    console.log('ДОШЛО: Telegram принял сообщение (HTTP 200). Загляните в чат — оно там.')
    process.exit(0)
  }
  console.log('НЕ ДОШЛО: HTTP ' + res.status
    + (body.error_code ? ', код ' + body.error_code : '')
    + (body.description ? ', ' + body.description : ''))
  // Самые частые причины — чтобы не идти за ними в документацию Telegram.
  if (res.status === 401) console.log('  401 — токен бота неверен или отозван.')
  if (res.status === 400) console.log('  400 — обычно неверный chat_id (у группы он с минусом).')
  if (res.status === 403) console.log('  403 — бот не в чате либо заблокирован получателем.')
  process.exit(1)
})()
NODE

$DC exec -T backend node < "$js"
rc=$?
echo
case "$rc" in
  0) echo "Итог: канал работает." ;;
  3) echo "Итог: канал не настроен — тревоги никуда не идут." ;;
  *) echo "Итог: канал настроен, но сообщение НЕ доставлено (см. причину выше)." ;;
esac
exit "$rc"
