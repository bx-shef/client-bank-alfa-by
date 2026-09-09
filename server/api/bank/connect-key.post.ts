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
import { bankConnectConfigFromEnv } from '../../utils/bankConnectStart'
import { handleBankConnectKey, type ConnectKeyDeps } from '../../utils/bankConnectKey'
import { findMyCompanyAccounts, myCompanyGate } from '../../utils/myCompanyRequisites'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall } from '../../utils/liveDeps'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { saveBankToken } from '../../utils/bankTokenStore'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'
import type { BankProviderId } from '../../../app/types/statement'
import { useServerLogger } from '../../utils/serverLogger'

const log = useServerLogger('bank-connect')

/** Таймаут обмена — тот же, что у обмена кода на токены: это шаг, отказ которого настигает
 *  человека, уже сходившего в кабинет банка за ключом. */
const KEY_EXCHANGE_TIMEOUT_MS = 45_000

function liveKeyDeps(): ConnectKeyDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    config: bankConnectConfigFromEnv,
    clientSecret: () => (process.env.ALFA_OAUTH_CLIENT_SECRET || '').trim(),
    exchange: (baseUrl, body) => {
      const fetchJson = $fetch as unknown as (
        url: string,
        opts: { method: string, body: string, headers: Record<string, string>, timeout: number }
      ) => Promise<unknown>
      return fetchJson(`${baseUrl}/token`, {
        method: 'POST',
        body: body.toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        timeout: KEY_EXCHANGE_TIMEOUT_MS
      })
    },
    save: token => saveBankToken(dbQuery, token),
    myCompanyGate: async (domain, accessToken) =>
      myCompanyGate(await findMyCompanyAccounts((method, params) => frameRestCall(domain, accessToken, method, params))),
    log: msg => log.info(msg)
  }
}

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
