// POST /api/bank/connect-key — подключить Альфу КЛЮЧОМ API (Password Grant, #488). Авторизация та
// же, что у `/api/bank/connect`: фрейм-токен портала (`Authorization: Bearer`) + `X-B24-Domain`.
// Тело: `{ provider, apiKey }`. Тонкий ввод-вывод над чистым `bankConnectKey.ts`.
//
// ⚠ ОТДЕЛЬНЫЙ МАРШРУТ, а не флаг на `/api/bank/connect`, потому что механика противоположная: тот
// ОТДАЁТ адрес, по которому человеку идти в банк, а этот ЗАВЕРШАЕТ подключение здесь и сейчас.
// Один маршрут с двумя формами ответа заставлял бы вызывающего гадать, что он получил.
//
// ⚠ КЛЮЧ ПРИХОДИТ В ТЕЛЕ POST, и только так: в строке запроса он осел бы в логе nginx, в истории
// браузера и в заголовке Referer. `Referrer-Policy` ставим по той же причине, что у соседа.

import { randomBytes } from 'node:crypto'
import { handleBankConnectKey } from '../../utils/bankConnectKey'
import { liveKeyDeps } from '../../utils/bankKeyDeps'
import { bearerToken } from '../../utils/settingsHandler'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import type { BankProviderId } from '../../../app/types/statement'

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.bank-connect-key.post', method: 'POST', op: 'bank.connect-key', domain },
    async (span) => {
      const body = await readBody(event).catch(() => null) as { provider?: string, apiKey?: string } | null
      const provider = (body?.provider || '').trim() as BankProviderId
      // ⚠ Ключ НЕ триммим здесь — это делает чистое ядро, и там же покрыто тестом. Две точки
      // обрезки означали бы, что одна однажды пропадёт незамеченной.
      const apiKey = String(body?.apiKey ?? '')

      setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
      const { status, body: out } = await handleBankConnectKey(liveKeyDeps(), {
        accessToken: token,
        domain,
        provider,
        apiKey,
        nonce: randomBytes(16).toString('hex'),
        nowMs: Date.now()
      })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return out
    }
  )
})
