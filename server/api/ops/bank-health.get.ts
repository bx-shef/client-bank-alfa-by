// GET /api/ops/bank-health — сводка состояния банковских подключений ПО ВСЕМ порталам, для
// оператора (#497 §3). Гейт — та же сессионная кука, что у `/api/ops/queues`.
//
// ЗАЧЕМ. Админ портала видит свои подключения; мы не видим ничего. Умирающее подключение сегодня
// узнаётся по факту неработающего импорта — то есть позже клиента, тогда как критерий приёмки
// тестовой эксплуатации сформулирован ровно наоборот: «бухгалтер видит свои платежи, а МЫ видим
// его проблемы». Этот экран — «открыл и увидел»; сам стучится по тем же данным `bankHealthAlert.ts`.
//
// ⚠ ОТДАЮТСЯ ТОЛЬКО СЧЁТЧИКИ И НЕОБРАТИМЫЕ МЕТКИ (`portalHash`). Ни номеров счетов, ни доменов, ни
// `member_id`. Токены не расшифровываются вовсе: `listAllBankAccountInfo` их и не выбирает.
//
// Решение (в т.ч. 503 при недоступной базе) — в чистом `handleBankHealth`; здесь только I/O.

import { SESSION_COOKIE, operatorAllowed, resolveAuthConfig } from '../../utils/session'
import { listAllBankAccountInfo } from '../../utils/bankTokenStore'
import { handleBankHealth } from '../../utils/bankHealthHandler'
import { portalHash } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'

export default defineEventHandler(async (event) => {
  const cfg = resolveAuthConfig(process.env)
  if (!operatorAllowed(cfg, getCookie(event, SESSION_COOKIE), Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  const { status, body } = await handleBankHealth({
    listRows: () => listAllBankAccountInfo(dbQuery),
    now: Date.now,
    hashPortal: portalHash,
    warn: (m: string) => console.error(m)
  })
  setResponseStatus(event, status)
  return body
})
