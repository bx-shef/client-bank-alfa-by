// GET /api/bank/key-request?t=… — годна ли ссылка на экран ввода ключа и что на нём показать (#19).
// Тонкий I/O над `handleKeyRequestInfo`.
//
// ⚠ НЕ админский, и это не упущение: экран для того и заведён, чтобы им пользовался НЕ
// администратор. Право даёт подписанный грант + совпадение личности с фрейм-токеном — разбор в
// шапке `server/utils/bankKeySubmit.ts`.

import { handleKeyRequestInfo } from '../../utils/bankKeySubmit'
import { liveKeySubmitDeps } from '../../utils/bankKeyDeps'
import { bearerToken } from '../../utils/settingsHandler'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.bank-key-request.get', method: 'GET', op: 'bank.key_request', domain },
    async (span) => {
      const t = String(getQuery(event).t ?? '').trim()
      const { status, body } = await handleKeyRequestInfo(liveKeySubmitDeps(), {
        accessToken: token, domain, token: t, nowMs: Date.now()
      })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
