// POST /api/bank/set-account — назначить счёт подключению, сделанному без него (#407).
// Auth = фрейм-токен + X-B24-Domain, admin-only: тот же гейт, что у /api/bank/connect, потому что
// это продолжение того же действия — привязки банковского доступа к порталу.
//
// Переименовывается ТОЛЬКО временный ключ: подменить счёт у живого подключения нельзя, иначе это
// был бы способ увести операции чужого счёта на другой номер.

import { handleSetBankAccount, type SetAccountDeps } from '../../utils/bankAccounts'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall } from '../../utils/liveDeps'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { renameBankTokenAccount } from '../../utils/bankTokenStore'
import { withAdvisoryLock } from '../../utils/dbLock'
import { makeLockedRename } from '../../utils/bankAccountRename'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'

function liveDeps(): SetAccountDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    // Переименование сериализовано с обновлением токена — почему и как, см. `makeLockedRename` (#509).
    rename: makeLockedRename({ withLock: withAdvisoryLock, rename: renameBankTokenAccount })
  }
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  const raw = await readBody<{ provider?: unknown, pendingKey?: unknown, accountKey?: unknown }>(event)
    .catch(() => ({} as { provider?: unknown, pendingKey?: unknown, accountKey?: unknown }))
  return withFrameRouteSpan(
    { name: 'http.bank-set-account.post', method: 'POST', op: 'bank.accounts.assign', domain },
    async (span) => {
      const { status, body } = await handleSetBankAccount(liveDeps(), {
        accessToken: token,
        domain,
        provider: typeof raw?.provider === 'string' ? raw.provider : '',
        pendingKey: typeof raw?.pendingKey === 'string' ? raw.pendingKey : '',
        accountKey: typeof raw?.accountKey === 'string' ? raw.accountKey : ''
      })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
