// POST /api/feedback — employee 👍/👎 + comment on the import result → a GitHub issue in the
// configured PRIVATE receiving repo (docs/FEEDBACK.md, channel «сотрудник»). Frame-token
// authenticated (Bearer + X-B24-Domain, member_id from the verified domain — same model as
// /api/app-rating). Channel-gated: no config → 503 (the widget is hidden client-side too).

import { handleFeedbackSubmit, type FeedbackSubmitDeps } from '../utils/feedbackHandler'
import { resolveFeedbackConfig } from '../utils/feedbackConfig'
import { postFeedbackIssue, type FeedbackFetchFn } from '../utils/feedbackGithub'
import { buildFeedbackIssue } from '../../app/utils/feedback'
import { bearerToken } from '../utils/settingsHandler'
import { frameRestCall } from '../utils/liveDeps'
import { getMemberIdByDomain } from '../utils/tokenStore'
import { dbQuery } from '../db/client'

function liveSubmitDeps(): FeedbackSubmitDeps {
  const config = resolveFeedbackConfig()
  const fetchImpl = globalThis.fetch as unknown as FeedbackFetchFn
  return {
    config,
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const id = (res?.result as { ID?: unknown } | undefined)?.ID
      return id != null ? String(id) : ''
    },
    // Only invoked when config is non-null (the handler gates on config first).
    postIssue: (kind, comment, context) =>
      postFeedbackIssue(config!, buildFeedbackIssue(kind, comment, context), fetchImpl)
  }
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  const raw = await readBody(event).catch(() => null) as
    { kind?: unknown, comment?: unknown, context?: { fileName?: unknown, appVersion?: unknown } } | null
  const { status, body } = await handleFeedbackSubmit(liveSubmitDeps(), {
    accessToken: token,
    domain,
    kind: raw?.kind,
    comment: raw?.comment,
    context: { fileName: raw?.context?.fileName, appVersion: raw?.context?.appVersion }
  })
  if (status === 500 || status === 502) {
    // Only a real GitHub transport failure (not the 503 config-gate) — log the numeric class for
    // ops. Never surface GitHub's body/URL/token.
    console.warn('[feedback] github submission failed with status %d', status)
  }
  setResponseStatus(event, status)
  return body
})
