// POST /api/poll-now — manual «Опросить сейчас» on-demand bank poll for testing (#54). Auth = the
// B24 frame access token (Authorization: Bearer) + X-B24-Domain, same model as /api/bank/connect.
// Enqueues one bank-fetch job per connected pollable account of the CALLER's portal for a rolling
// window. Thin I/O over the pure handler (server/utils/pollNow.ts), which enforces the feature gate,
// admin gate, per-portal cooldown, and app-side-only frequency control (#54).
//
// The frame token is itself the CSRF defense (only the in-portal iframe holds it). Feature is OFF
// unless MANUAL_POLL_ENABLED=1 AND queues are enabled (fail-closed) — the owner opts portals in.

import { DEFAULT_MANUAL_POLL_COOLDOWN_SEC, handlePollNow, type PollNowDeps } from '../utils/pollNow'
import { bearerToken } from '../utils/settingsHandler'
import { frameRestCall } from '../utils/liveDeps'
import { getMemberIdByDomain } from '../utils/tokenStore'
import { listBankAccountsForPortal } from '../utils/bankTokenStore'
import { enqueueFetch } from '../queue/producers'
import { claimCooldownSlot, queueEnabled } from '../queue/connection'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../utils/telemetryAttributes'
import { dbQuery } from '../db/client'

function livePollNowDeps(): PollNowDeps {
  const cooldownSec = Number(process.env.MANUAL_POLL_COOLDOWN_SEC ?? NaN)
  return {
    // App-side gate (#54): default OFF; also requires queues (else enqueue no-ops silently).
    enabled: process.env.MANUAL_POLL_ENABLED === '1' && queueEnabled(),
    cooldownSec: Number.isFinite(cooldownSec) && cooldownSec > 0 ? Math.floor(cooldownSec) : DEFAULT_MANUAL_POLL_COOLDOWN_SEC,
    lookbackDays: Number(process.env.CRON_LOOKBACK_DAYS || 1),
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      // `profile` (basic scope) proves the token works for THIS portal (else B24 throws) and
      // returns the user's ADMIN flag — both membership and the admin gate in one call.
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    listAccounts: memberId => listBankAccountsForPortal(dbQuery, memberId),
    claimSlot: (memberId, ttlSec) => claimCooldownSlot(`manual-poll:${memberId}`, ttlSec),
    enqueue: enqueueFetch,
    nowMs: Date.now()
  }
}

// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + PII-safe outcome (incl. the
// admin-gate `forbidden`) + hashed portal id.
export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.poll-now.post', method: 'POST', op: 'poll-now.enqueue', domain },
    async (span) => {
      const { status, body } = await handlePollNow(livePollNowDeps(), { accessToken: token, domain })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
