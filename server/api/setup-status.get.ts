// GET /api/setup-status — server-side half of the setup-readiness checklist (#409/#405): how many
// bank accounts are connected, whether automatic polling is on and with what period, and when the
// last run finished. Auth = B24 frame token + X-B24-Domain, admin-only (same model as the bank
// routes). Thin I/O over the pure handler (server/utils/setupStatus.ts).
//
// Portal settings are deliberately NOT echoed here — the client already has them; duplicating them
// would create a second source of truth that can disagree with the settings form.

import { handleSetupStatus, type SetupStatusDeps } from '../utils/setupStatus'
import { bearerToken } from '../utils/settingsHandler'
import { frameRestCall } from '../utils/liveDeps'
import { getMemberIdByDomain } from '../utils/tokenStore'
import { listBankAccountsForPortal } from '../utils/bankTokenStore'
import { getImportResult } from '../utils/importResultStore'
import { queueEnabled } from '../queue/connection'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../utils/telemetryAttributes'
import { dbQuery } from '../db/client'

function liveDeps(): SetupStatusDeps {
  const interval = Number(process.env.CRON_INTERVAL_MIN ?? NaN)
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    countAccounts: async memberId => (await listBankAccountsForPortal(dbQuery, memberId)).length,
    // BOTH conditions the cron actually needs, not just the flag: the scheduler returns early
    // without Redis (`queueEnabled`), so reporting the flag alone would show a confident green
    // «опрос включён» while nothing polls at all — the exact silent gap this screen exists to
    // expose, and the worst possible thing for it to get wrong.
    pollEnabled: (process.env.CRON_REAL_POLL ?? '0') === '1' && queueEnabled(),
    pollIntervalMin: Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 5,
    lastRunMs: async (memberId) => {
      const run = await getImportResult(dbQuery, memberId)
      if (!run?.lastSyncAt) return null
      const ms = Date.parse(run.lastSyncAt)
      return Number.isFinite(ms) ? ms : null
    }
  }
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.setup-status.get', method: 'GET', op: 'setup.status', domain },
    async (span) => {
      const { status, body } = await handleSetupStatus(liveDeps(), { accessToken: token, domain })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
