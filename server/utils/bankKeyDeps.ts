// Живые транспорты подключения КЛЮЧОМ API (#488, #19): обмен ключа у банка, сохранение, портал.
//
// ⚠ Вынесено из маршрута `connect-key.post.ts` потому, что вызывающих стало ДВА: администратор
// вводит ключ у себя, а владелец счёта — на своём экране по ссылке из чата. Вторая сборка тех же
// зависимостей означала бы второй набор решений (таймаут обмена, куда сохраняем, чем логируем) —
// и они разошлись бы молча.

import { bankConnectConfigFromEnv } from './bankConnectStart'
import type { ConnectKeyDeps } from './bankConnectKey'
import type { KeySubmitDeps } from './bankKeySubmit'
import { findMyCompanyAccounts, myCompanyGate } from './myCompanyRequisites'
import { frameRestCall, livePortalSdkCall } from './liveDeps'
import { getMemberIdByDomain } from './tokenStore'
import { saveBankToken } from './bankTokenStore'
import { resolveAuthConfig } from './session'
import { buildBankConnectedEvent } from '../../app/utils/settingsSync'
import { pickAppCode } from '../../app/utils/appUriLink'
import { LANDING_MARKET_CODE } from '../../app/utils/landing'
import { dbQuery } from '../db/client'
import { useServerLogger } from './serverLogger'

const log = useServerLogger('bank-connect')

/** Код приложения на портале — он же `MODULE_ID` канала pull. Та же цепочка, что у `useAppCode`
 *  на клиенте: одна переменная сборки, затем зашитый слаг. */
export function appModuleIdFromEnv(): string {
  return pickAppCode([(process.env.NUXT_PUBLIC_B24_APP_CODE || '').trim(), LANDING_MARKET_CODE]) ?? ''
}

/** Таймаут обмена — тот же, что у обмена кода на токены: это шаг, отказ которого настигает
 *  человека, уже сходившего в кабинет банка за ключом. */
const KEY_EXCHANGE_TIMEOUT_MS = 45_000

export function liveKeyDeps(): ConnectKeyDeps {
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

/**
 * Зависимости экрана ВЛАДЕЛЬЦА СЧЁТА. Отличий от админских три, и каждое по делу:
 *
 * 1. `myCompanyGate` НЕ передаётся: предусловие «у портала есть моя компания со счётом» проверил
 *    администратор, когда отправлял приглашение. Переспрашивать тем же фрейм-токеном нельзя —
 *    у сотрудника может не быть прав читать реквизиты, и исправный портал отвечал бы отказом.
 * 2. `secret` + `clientId` — грант и то, что показываем на экране.
 * 3. `notifyConnected` — сообщение открытым экранам, что подключение появилось.
 */
export function liveKeySubmitDeps(): KeySubmitDeps {
  const base = liveKeyDeps()
  return {
    memberIdByDomain: base.memberIdByDomain,
    validateFrame: base.validateFrame,
    config: base.config,
    clientSecret: base.clientSecret,
    exchange: base.exchange,
    save: base.save,
    log: base.log,
    secret: resolveAuthConfig(process.env).secret,
    clientId: () => (process.env.ALFA_OAUTH_CLIENT_ID || '').trim(),
    notifyConnected: async (memberId, provider) => {
      const call = await livePortalSdkCall(memberId)
      if (!call) return
      // ⚠ На СОХРАНЁННОМ токене портала, а не фрейм-токеном владельца счёта: без `USER_ID` событие
      // уходит в ОБЩИЙ канал приложения, а произвольного адресата вправе указать только админ.
      // Значит фрейм-токен сотрудника годится лишь для события «самому себе» — то есть не тому,
      // кому оно нужно.
      await call('pull.application.event.add', buildBankConnectedEvent(appModuleIdFromEnv(), provider) as unknown as Record<string, unknown>)
    }
  }
}
