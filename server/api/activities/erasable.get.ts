// GET /api/activities/erasable — сколько дел, созданных приложением, попадёт под удаление (#576 п.4).
// Ничего не меняет. Auth = фрейм-токен B24 + X-B24-Domain, только админ портала.
//
// ⚠ ОТДЕЛЬНЫЙ маршрут, а не флаг «сухой прогон» у стирания: флаг означал бы, что один неверный
// булев в клиенте превращает показ количества в необратимое удаление. Этот обработчик структурно
// не умеет удалять — ему не передают ни батч, ни метод удаления.

import { handleCountErasable, type CountDeps } from '../../utils/eraseRequest'
import { countErasableActivities } from '../../utils/eraseActivitiesWrite'
import { bearerToken } from '../../utils/settingsHandler'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { frameRestCall, livePortalSdkCall } from '../../utils/liveDeps'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'

function liveDeps(): CountDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    count: async (memberId, selection) => {
      // ⚠ Список дел читается ХРАНИМЫМ токеном портала, а не фрейм-токеном сотрудника: удалять
      // приложение будет своим токеном (иначе права конкретного человека молча сузили бы выборку,
      // и «стёрли 12 из 300» выглядело бы поломкой), значит и считать надо им же — иначе показанное
      // число не совпало бы с удалённым.
      const call = await livePortalSdkCall(memberId)
      if (!call) throw new Error(`countErasable: no portal token for ${memberId}`)
      return countErasableActivities(selection, call)
    }
  }
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  const q = getQuery(event)
  return withFrameRouteSpan(
    { name: 'http.activities-erasable.get', method: 'GET', op: 'activities.erasable', domain },
    async (span) => {
      const { status, body } = await handleCountErasable(liveDeps(), {
        accessToken: token,
        domain,
        from: q.from,
        to: q.to,
        // Счета приходят повторяющимся параметром; одиночное значение нормализуем в массив.
        accounts: q.accounts === undefined ? undefined : (Array.isArray(q.accounts) ? q.accounts : [q.accounts]),
        counterpartyAccounts: q.counterpartyAccounts === undefined
          ? undefined
          : (Array.isArray(q.counterpartyAccounts) ? q.counterpartyAccounts : [q.counterpartyAccounts])
      })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
