// GET /api/ops/bank-health — сводка состояния банковских подключений ПО ВСЕМ порталам, для
// оператора (#497 §3). Гейт — та же сессионная кука, что у `/api/ops/queues`.
//
// ЗАЧЕМ. Админ портала видит свои подключения; мы не видим ничего. Умирающее подключение сегодня
// узнаётся по факту неработающего импорта — то есть позже клиента, тогда как критерий приёмки
// тестовой эксплуатации сформулирован ровно наоборот: «бухгалтер видит свои платежи, а МЫ видим
// его проблемы».
//
// ⚠ ОТДАЮТСЯ ТОЛЬКО СЧЁТЧИКИ. Ни номеров счетов, ни доменов, ни `member_id` — оператору нужно
// понять «что-то ломается и у скольких», а не читать реквизиты чужих компаний. Токены не
// расшифровываются вовсе: `listAllBankAccountInfo` их и не выбирает.

import { SESSION_COOKIE, operatorAllowed, resolveAuthConfig } from '../../utils/session'
import { listAllBankAccountInfo } from '../../utils/bankTokenStore'
import { summarizeBankHealth } from '../../../app/utils/bankHealthOverview'
import { dbQuery } from '../../db/client'

export default defineEventHandler(async (event) => {
  const cfg = resolveAuthConfig(process.env)
  if (!operatorAllowed(cfg, getCookie(event, SESSION_COOKIE), Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  try {
    const rows = await listAllBankAccountInfo(dbQuery)
    return { ok: true, ...summarizeBankHealth(rows, Date.now()) }
  } catch (e) {
    // База недоступна — это НЕ «подключений нет». Пустая сводка читалась бы как «всё спокойно»
    // ровно тогда, когда спокойно точно не всё.
    setResponseStatus(event, 503)
    return { ok: false, error: 'не удалось прочитать состояние подключений', detail: (e as Error)?.message ?? '' }
  }
})
