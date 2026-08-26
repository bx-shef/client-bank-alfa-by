// POST /api/bank/disconnect — remove ONE connected bank account of the caller's portal (#404).
// Auth = B24 frame access token + X-B24-Domain, admin-only (same gate as connect: whoever may bind
// portal-wide bank credentials may unbind them). Thin I/O over server/utils/bankAccounts.ts.
//
// The frame token is itself the CSRF defense — only the in-portal iframe holds it. Deletion is
// member-scoped in SQL, so a forged id/accountKey can only ever hit the caller's own rows.
//
// ⚠ Addressed by the row's immutable `id`, not by the account number (#517): the number CHANGES
// when the admin picks an account for a pending connection, so a delete aimed at the number the
// browser rendered found nothing and answered the same `200 {removed:false}` as honest
// idempotency — reporting success while the app kept reaching into the client's bank.

import { handleDisconnectBankAccount, type DisconnectDeps } from '../../utils/bankAccounts'
import { useServerLogger } from '../../utils/serverLogger'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall } from '../../utils/liveDeps'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { deleteBankTokenById } from '../../utils/bankTokenStore'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'

// ⚠ Канал ПЕРЕИСПОЛЬЗУЕТСЯ (`bank-connect`), как у паузы: имена каналов — маркеры, по которым
// грепает рантбук, и новый канал на одно действие пришлось бы заводить во все инструменты.
const bankLog = useServerLogger('bank-connect')

function liveDeps(): DisconnectDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    remove: (memberId, id, expectedAccountKey) => deleteBankTokenById(dbQuery, memberId, id, expectedAccountKey),
    // ⚠ След в журнале: КТО оборвал связь с банком (#641). До этого ОБРАТИМАЯ пауза писала имя
    // нажавшего, а НЕОБРАТИМОЕ отключение — ничего: живой разбор упёрся ровно в это, строк
    // `bank_tokens` не осталось, а кто их убрал, было неоткуда узнать. Номера счёта в строке НЕТ —
    // лог живёт до вытеснения по объёму (#617), а `id` строки для разбора достаточно.
    audit: ({ memberId, userId, provider, id }) =>
      bankLog.warning(`portal ${memberId}: ${provider} #${id} — подключение ОТКЛЮЧЕНО пользователем ${userId || '—'} (необратимо, нужен повторный вход в интернет-банк)`)
  }
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  // A malformed/absent body must not 500 — it falls through to the handler's 400.
  const raw = await readBody<{ provider?: unknown, accountKey?: unknown, id?: unknown }>(event)
    .catch(() => ({} as { provider?: unknown, accountKey?: unknown, id?: unknown }))
  return withFrameRouteSpan(
    { name: 'http.bank-disconnect.post', method: 'POST', op: 'bank.accounts.remove', domain },
    async (span) => {
      const { status, body } = await handleDisconnectBankAccount(liveDeps(), {
        accessToken: token,
        domain,
        provider: typeof raw?.provider === 'string' ? raw.provider : '',
        accountKey: typeof raw?.accountKey === 'string' ? raw.accountKey : '',
        // The row's immutable address (#517); `accountKey` rides along as the caller's EXPECTATION —
        // a mismatch is how we learn the on-screen list has gone stale.
        id: Number(raw?.id)
      })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
