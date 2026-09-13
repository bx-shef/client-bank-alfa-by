// Живые транспорты для подключения банка (#19): портал, конфигурация Приора, его преамбула.
//
// ⚠ Вынесено из маршрута `connect.post.ts` потому, что вызывающих стало ДВА — кнопка «Подключить»
// и отправка приглашения владельцу счёта (`send-link.post.ts`). Вторая сборка тех же зависимостей
// означала бы второй набор решений о том, как мы ходим в банк и в портал, и разошлась бы молча:
// поправили бы таймаут в одном месте, а второй путь продолжил бы жить со старым.

import { randomUUID } from 'node:crypto'
import type { ConnectStartDeps } from './bankConnectStart'
import { findMyCompanyAccounts, myCompanyGate } from './myCompanyRequisites'
import { buildPriorConnectUrl, priorConnectConfigFromEnv } from './priorConnectStart'
import { signPriorJwt } from './priorJwt'
import { priorWriteHeaders } from '../../app/utils/priorOauth'
import { resolveAuthConfig } from './session'
import { frameRestCall } from './liveDeps'
import { getMemberIdByDomain } from './tokenStore'
import { dbQuery } from '../db/client'
import { useServerLogger } from './serverLogger'

const log = useServerLogger('bank-connect')

export function liveConnectDeps(): ConnectStartDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      // `profile` (basic scope) proves the token works for THIS portal (else B24 throws) and
      // returns the user's id + ADMIN flag in one call — both membership and the admin gate.
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    priorConfig: priorConnectConfigFromEnv,
    // Prior's live preamble (A5b): token Б → consent → RS256-signed `request` JWT. Client
    // authentication for the token call is resolved upstream by `resolvePriorTokenAuth` +
    // `priorTokenRequest` (#444) — this transport just sends what it is given: under
    // client_secret_basic `headers` carries the Authorization header, under private_key_jwt the
    // signed assertion rides in `body`. Neither is ever logged or put in the URL.
    buildPriorUrl: (config, state) => buildPriorConnectUrl(config, state, {
      postToken: (url, body, headers) => {
        const fetchJson = $fetch as unknown as (
          url: string,
          opts: { method: string, body: string, headers: Record<string, string>, timeout: number }
        ) => Promise<unknown>
        return fetchJson(url, {
          method: 'POST',
          body,
          headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
          timeout: 15_000
        })
      },
      postConsent: (url, accessToken, body) => {
        const fetchJson = $fetch as unknown as (
          url: string,
          opts: { method: string, body: unknown, headers: Record<string, string>, timeout: number }
        ) => Promise<unknown>
        return fetchJson(url, {
          method: 'POST',
          body,
          headers: priorWriteHeaders(accessToken, randomUUID(), randomUUID()),
          timeout: 15_000
        })
      },
      signJwt: signPriorJwt,
      nowSec: () => Math.floor(Date.now() / 1000),
      newId: () => randomUUID()
    }),
    secret: resolveAuthConfig(process.env).secret,
    // «Моя компания» с расчётным счётом (#493): проверяем ДО того, как человек пойдёт в банк
    // вводить пароль. Тем же фрейм-токеном администратора, который уже проверен выше.
    myCompanyGate: async (domain, accessToken) =>
      myCompanyGate(await findMyCompanyAccounts((method, params) => frameRestCall(domain, accessToken, method, params))),
    // Sanitized already (the handler passes text through sanitizeForLog) — keeps a failed Prior
    // preamble diagnosable instead of one opaque 502.
    log: msg => log.info(msg)
  }
}
