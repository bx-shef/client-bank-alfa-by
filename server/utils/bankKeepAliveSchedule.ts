// Планирование продления банковских токенов (#489).
//
// ⚠ Вынесено из `server/plugins/queue.ts` НЕ ради красоты, а чтобы его можно было запустить ВНЕ
// гейта Redis. Плагин очередей начинается с `if (!queueEnabled()) return`, и продление жило внутри
// — то есть простой Redis уносил с собой и банковские подключения. Банку до нашей очереди дела
// нет: продлению нужны Postgres и сам банк, и ничего больше.
//
// Цена промаха несимметрична и измерена: у Альфы refresh живёт ~10 часов, а лечится его смерть
// походом ВЛАДЕЛЬЦА СЧЁТА в интернет-банк. То есть каждый пропущенный тик оплачивает не сервис, а
// клиент — и оплачивает действием, которое нельзя сделать за него.

import { BANK_KEEP_ALIVE_MINUTES, bankKeepAliveIntervalMs, runBankKeepAlive } from './bankTokenKeepAlive'
import { runKeepAliveTick } from './keepAliveTick'
import { markKeepAliveStarted, recordKeepAlivePulse } from './keepAliveState'
import { ensureBankToken } from './ensureBankToken'
import { getBankToken, listAllBankAccountInfo, markBankRefreshAttempt, type BankAccountRef, type BankToken } from './bankTokenStore'
import { dbQuery } from '../db/client'
import { withSpan } from './telemetrySpan'
import { useServerLogger } from './serverLogger'

const log = useServerLogger('bank-keepalive')

/** Живая проводка движка продления на БД и банк. */
export function liveBankKeepAliveDeps() {
  return {
    now: Date.now,
    listAccounts: () => listAllBankAccountInfo(dbQuery),
    getToken: (ref: BankAccountRef) => getBankToken(dbQuery, ref.memberId, ref.provider, ref.accountKey),
    // ⚠ Отметка попытки — не деталь учёта, а то, что делает редкие повторы для просроченных
    // подключений редкими: без неё «пробовать раз в 6 часов» превращается в «пробовать каждый тик».
    markAttempt: (ref: BankAccountRef, nowMs: number) => markBankRefreshAttempt(dbQuery, ref, nowMs),
    // ⚠ `force` обязателен. Без него `ensureBankToken` смотрит на срок ACCESS-токена — ровно не тот
    // сигнал: access бывает свежим, пока refresh за ним доживает последние часы. Именно поэтому
    // обновление «по дороге» никогда не спасало.
    refresh: (token: BankToken) => ensureBankToken(token, undefined, { force: true }),
    log: (m: string) => log.info(m),
    warn: (m: string) => log.warning(m)
  }
}

/**
 * Завести таймер продления. Возвращает сам таймер, чтобы вызывающий мог его снять на closing.
 *
 * ⚠ Первый прогон — НЕМЕДЛЕННО, а не через интервал: сервис мог простоять ночь, и подключение за
 * это время как раз доживает. Ждать ещё час после старта означало бы гарантированно опоздать в
 * самом частом сценарии.
 */
export function scheduleBankKeepAlive(minutesRaw?: string): NodeJS.Timeout {
  const ms = bankKeepAliveIntervalMs(Number(minutesRaw || BANK_KEEP_ALIVE_MINUTES))
  const deps = liveBankKeepAliveDeps()
  // Сам тик — в `runKeepAliveTick`, чтобы инвариант «пульс только на ЗАВЕРШЁННОМ прогоне» можно
  // было проверить тестом: пока он жил try/catch'ем в плагине, его можно было вывернуть наизнанку
  // (писать пульс в `catch`), не уронив ни одного теста, — погасив ровно ту тревогу, ради которой
  // пульс и заведён.
  const tick = () => runKeepAliveTick({
    run: () => withSpan('cron.bank-keep-alive', { 'job.queue': 'cron.bank-keep-alive' }, () => runBankKeepAlive(deps)),
    record: recordKeepAlivePulse,
    now: Date.now,
    error: (m: string) => log.error(m)
  })
  // Отмечаем, что таймер ЗАПЛАНИРОВАН: иначе «прогонов ещё не было» неотличимо от «не
  // запускается», и регрессия, при которой продление падает с первого же тика, молчала бы вечно.
  markKeepAliveStarted(Date.now())
  const timer = setInterval(tick, ms)
  // ⚠ `unref` — эшелонированная защита к пререндер-гейту в плагине. Живой таймер держит процесс
  // Node открытым, и один забытый `setInterval` превращает любую разовую команду (сборку, скрипт,
  // миграцию) в вечно висящую — причём УЖЕ после того, как она сделала всё, что должна была.
  // На работающем сервере ничего не меняет: процесс держит слушающий сокет, и таймер тикает как
  // обычно. ⚠ Не заменяет гейт, а страхует его: гейт про «не запускать не там», это — про «не
  // мешать выходу».
  timer.unref?.()
  void tick()
  log.info(`bank token keep-alive scheduled (every ${ms / 60_000} min, #489) — вне зависимости от Redis`)
  return timer
}
