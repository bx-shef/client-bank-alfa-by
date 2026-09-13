// POST /api/bank/submit-key — владелец счёта вводит ключ API на своём экране (#19).
//
// ⚠ Ключ приходит в ТЕЛЕ POST и никуда больше не попадает: он бессрочен и не ротируется, а в
// строке запроса осел бы в логе nginx, в истории браузера и в заголовке Referer.
// ⚠ Гейт — подписанный грант + совпадение портала и личности с фрейм-токеном (см. шапку
// `server/utils/bankKeySubmit.ts`), а не `profile.ADMIN`: экран адресован НЕ администратору.

import { randomBytes } from 'node:crypto'
import { handleSubmitBankKey } from '../../utils/bankKeySubmit'
import { liveKeySubmitDeps } from '../../utils/bankKeyDeps'
import { bearerToken } from '../../utils/settingsHandler'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.bank-submit-key.post', method: 'POST', op: 'bank.submit_key', domain },
    async (span) => {
      const body = await readBody(event).catch(() => null) as { t?: string, apiKey?: string } | null
      setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
      const { status, body: out } = await handleSubmitBankKey(liveKeySubmitDeps(), {
        accessToken: token,
        domain,
        token: (body?.t || '').trim(),
        apiKey: String(body?.apiKey ?? ''),
        nonce: randomBytes(16).toString('hex'),
        nowMs: Date.now()
      })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return out
    }
  )
})
