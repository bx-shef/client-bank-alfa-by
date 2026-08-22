// POST /api/bank/pause — приостановить или возобновить АВТООПРОС одного подключения (#576).
// Auth = фрейм-токен B24 + X-B24-Domain, только админ: тот же гейт, что у connect/disconnect —
// банковские креды портало-широкие, и кто может их привязать, тот же и распоряжается опросом.
// Тонкий ввод-вывод над server/utils/bankAccounts.ts.
//
// ⚠ Это НЕ «Отключить». Отключение стирает грант, и вернуть его может только владелец счёта,
// заново войдя в интернет-банк. Пауза не трогает ни грант, ни продление токена (#489) — приложение
// просто перестаёт ходить за выпиской. До этой ручки выбор был бинарным, и «слишком много
// операций» лечилось единственным способом, который стоил повторной авторизации в банке.
//
// ⚠ Адресуется неизменяемым `id` строки, а не номером счёта (#517): номер МЕНЯЕТСЯ, когда админ
// выбирает счёт незавершённому подключению, поэтому адрес из отрисованного списка может описывать
// уже другую строку. Номер едет рядом как ОЖИДАНИЕ вызывающего — расхождение это 409 «список
// устарел», а не тихое переключение не того подключения.

import { handlePauseBankPoll, type PausePollDeps } from '../../utils/bankAccounts'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall } from '../../utils/liveDeps'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { setBankPollPaused } from '../../utils/bankTokenStore'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'

function liveDeps(): PausePollDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    setPaused: (memberId, id, expectedAccountKey, paused) => setBankPollPaused(dbQuery, memberId, id, expectedAccountKey, paused)
  }
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  type Raw = { provider?: unknown, accountKey?: unknown, id?: unknown, paused?: unknown }
  // Кривое/отсутствующее тело не должно давать 500 — проваливаемся в честный 400 обработчика.
  const raw = await readBody<Raw>(event).catch(() => ({} as Raw))
  return withFrameRouteSpan(
    { name: 'http.bank-pause.post', method: 'POST', op: 'bank.poll.pause', domain },
    async (span) => {
      const { status, body } = await handlePauseBankPoll(liveDeps(), {
        accessToken: token,
        domain,
        provider: typeof raw?.provider === 'string' ? raw.provider : '',
        accountKey: typeof raw?.accountKey === 'string' ? raw.accountKey : '',
        id: Number(raw?.id),
        // ⚠ Передаём СЫРОЕ значение, без приведения: обработчик требует строго булев, и `'false'`
        // из кривого клиента обязан получить 400, а не молча стать `true`.
        paused: raw?.paused as boolean
      })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
