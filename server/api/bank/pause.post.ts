// POST /api/bank/pause — pause or resume the AUTOMATIC poll of ONE connection (#576).
// Auth = B24 frame token + X-B24-Domain, admin-only: the same gate as connect/disconnect — bank
// credentials are portal-wide, so whoever may bind them also governs the polling. Thin I/O over
// server/utils/bankAccounts.ts.
//
// ⚠ This is NOT «Отключить». Disconnecting destroys the grant, and only the ACCOUNT OWNER can
// restore it by signing into their internet bank again. Pausing touches neither the grant nor the
// token keep-alive (#489) — the app simply stops fetching statements. Until this route the choice
// was binary, and «too many operations» had exactly one cure: the one that cost a re-authorisation
// at the bank.
//
// ⚠ Addressed by the row's immutable `id`, not by the account number (#517): the number CHANGES
// when an admin assigns an account to a pending connection, so an address taken from the rendered
// list may describe a different row by now. The number rides along as the caller's EXPECTATION — a
// mismatch is a 409 «list is stale», not a silent toggle of the wrong connection.

import { handlePauseBankPoll, type PausePollDeps } from '../../utils/bankAccounts'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall } from '../../utils/liveDeps'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { setBankPollPaused } from '../../utils/bankTokenStore'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'
import { useServerLogger } from '../../utils/serverLogger'

// ⚠ Канал ПЕРЕИСПОЛЬЗУЕТСЯ (`bank-connect`), а не заводится новый. Имена каналов — это маркеры, по
// которым грепает рантбук, и оператор, разбирающий «импорт встал», смотрит жизненный цикл
// подключения. Отдельный `[bank-pause]` означал бы второй маркер, о существовании которого надо
// знать заранее, — а такой маркер хуже отсутствующего. Сама строка достаточно отличима внутри канала.
const bankLog = useServerLogger('bank-connect')

function liveDeps(): PausePollDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    setPaused: (memberId, id, expectedAccountKey, paused) => setBankPollPaused(dbQuery, memberId, id, expectedAccountKey, paused),
    // Audit trail: WHO stopped the import. Pausing is the cheapest way to silently halt a client's
    // feed — unlike disconnecting it needs no re-auth at the bank and looks from outside like «the
    // statement stopped arriving». We have no audit column, so a log line is the record.
    audit: ({ memberId, userId, provider, id, paused }) =>
      bankLog.info(`portal ${memberId}: ${provider} #${id} — автоопрос ${paused ? 'ПРИОСТАНОВЛЕН' : 'возобновлён'} пользователем ${userId || '—'}`)
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
