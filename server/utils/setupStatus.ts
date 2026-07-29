// Server-side facts for the setup-readiness checklist (#409/#405). Pure over injected I/O (DI).
//
// Split of responsibilities: the CLIENT already holds portal settings (chat, smart-process ids) via
// useChatSettings, so re-sending them here would just create a second source of truth that can
// disagree. This endpoint returns ONLY what the browser cannot know — how many bank accounts are
// connected, whether the server-side poll gate is on, its period, and when the last run finished.
// `app/utils/setupReadiness.ts` then composes both halves into the checklist.
//
// Auth mirrors the other bank routes (portal installed → frame token proven for THAT domain →
// admin): the answer describes the portal's configuration posture, which is admin business.

export interface SetupStatusResult {
  status: number
  body: Record<string, unknown>
}

export interface SetupStatusDeps {
  memberIdByDomain: (domain: string) => Promise<string | null>
  validateFrame: (domain: string, accessToken: string) => Promise<{ userId: string, isAdmin: boolean }>
  /** How many bank accounts this portal has connected. */
  countAccounts: (memberId: string) => Promise<number>
  /** Server gate `CRON_REAL_POLL` — automatic polling runs at all. */
  pollEnabled: boolean
  /** Cron period in minutes (`CRON_INTERVAL_MIN`). */
  pollIntervalMin: number
  /** Epoch ms the last import run finished, or null if it never ran. */
  lastRunMs: (memberId: string) => Promise<number | null>
}

export async function handleSetupStatus(
  deps: SetupStatusDeps,
  input: { accessToken: string, domain: string }
): Promise<SetupStatusResult> {
  const accessToken = (input.accessToken || '').trim()
  const domain = (input.domain || '').trim()
  if (!accessToken || !domain) {
    return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }
  }

  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { status: 409, body: { error: 'portal not installed (no key)' } }

  let frame: { userId: string, isAdmin: boolean }
  try {
    frame = await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 403, body: { error: 'invalid frame token for this portal' } }
  }
  if (!frame.isAdmin) return { status: 403, body: { error: 'setup status is administrator-only' } }

  const [connectedAccounts, lastRunMs] = await Promise.all([
    deps.countAccounts(memberId),
    deps.lastRunMs(memberId)
  ])

  return {
    status: 200,
    body: {
      connectedAccounts,
      pollEnabled: deps.pollEnabled,
      pollIntervalMin: deps.pollIntervalMin,
      lastRunMs
    }
  }
}
