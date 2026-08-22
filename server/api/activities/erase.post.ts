// POST /api/activities/erase — стереть дела, созданные приложением (#576 п.4). НЕОБРАТИМО.
// Auth = фрейм-токен B24 + X-B24-Domain, только админ портала: действие затрагивает CRM всего
// портала, а не того, кто нажал.
//
// ⚠ Показ количества живёт в ОТДЕЛЬНОМ маршруте (`erasable.get.ts`), а не во флаге «сухой прогон»
// у этого: флаг означал бы, что один неверный булев в клиенте превращает показ в удаление.
//
// ⚠ Читаем и удаляем ХРАНИМЫМ токеном портала, а не фрейм-токеном сотрудника. Иначе права
// конкретного человека молча сузили бы выборку, и «стёрли 12 из 300» выглядело бы поломкой
// приложения, а не следствием его прав. По той же причине тем же токеном считает и подсчёт —
// показанное число обязано совпасть с удалённым.

import { handleEraseActivities, type EraseDeps } from '../../utils/eraseRequest'
import { eraseActivities } from '../../utils/eraseActivitiesWrite'
import { periodLabel } from '../../../app/utils/eraseActivities'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall, liveLeaseDeps, livePortalSdk } from '../../utils/liveDeps'
import { eraseLeaseKey, SINGLE_FLIGHT_LEASE_SEC, withSingleFlightLease } from '../../utils/singleFlightLease'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { useServerLogger } from '../../utils/serverLogger'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'

const log = useServerLogger('activity')

function liveDeps(): EraseDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    erase: async (memberId, selection) => {
      // ⚠ ОДИН клиент на оба транспорта (находка ревью): два независимых клиента дали бы два ведра
      // лимитера и две загрузки токена, а обновление токена одним из них посреди НЕОБРАТИМОГО
      // удаления оставило бы второго со старым.
      const sdk = await livePortalSdk(memberId)
      if (!sdk) throw new Error(`erase: no portal token for ${memberId}`)
      // ⚠ Аренда «одно стирание на портал» (#538): без неё два параллельных запроса сдвигают
      // offset-пагинацию друг другу и часть дел молча не попадает в список.
      return withSingleFlightLease(
        liveLeaseDeps(), eraseLeaseKey(memberId), SINGLE_FLIGHT_LEASE_SEC,
        () => eraseActivities(selection, sdk.call, sdk.batch)
      )
    },
    // ⚠ Необратимое действие обязано оставлять запись. Своей таблицы аудита нет, поэтому строка в
    // журнале — единственный способ ответить постфактум на «кто удалил дела за август».
    // ⚠ В строку идут ТОЛЬКО счётчики, период и номера НАШИХ счетов — ни контрагентов, ни сумм,
    // ни назначений (PRIVACY.md §Логи).
    audit: ({ memberId, userId, selection, outcome }) => {
      const scope = selection.accounts.length > 0 ? `счета: ${selection.accounts.join(', ')}` : 'все счета'
      log.info(`portal ${memberId}: стёрто дел ${outcome.deleted} (${periodLabel(selection.period)}, ${scope}), осталось ${outcome.remaining} — пользователь ${userId || '—'}`)
    }
  }
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  type Raw = { from?: unknown, to?: unknown, accounts?: unknown }
  const raw = await readBody<Raw>(event).catch(() => ({} as Raw))
  return withFrameRouteSpan(
    { name: 'http.activities-erase.post', method: 'POST', op: 'activities.erase', domain },
    async (span) => {
      const { status, body } = await handleEraseActivities(liveDeps(), {
        accessToken: token, domain, from: raw?.from, to: raw?.to, accounts: raw?.accounts
      })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
