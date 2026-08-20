// Pure request logic for POST /api/distribution/provision (#109, §9.1 live-обвязка). Gates the
// provisioning-execution behind: a feature flag (default OFF), the caller's B24 FRAME token
// (proves portal membership + carries the ADMIN flag), and portal-installed check. The compound
// provisioning itself is `handleProvisionDistribution` (single-flight + persist), injected as
// `provision`. Thin over DI — unit-testable without pg / network / the SDK.
//
// Auth model mirrors /api/poll-now: the frame access token is itself the CSRF defense (only the
// in-portal iframe holds it); `member_id` is resolved server-side from the domain (never trusted
// from the client), and `validateFrame` re-checks the token against B24 to block a spoofed domain.

import { sanitizeForLog } from './logSanitize'
import { isLockTimeout } from './bankRefreshLock'
import type { ProvisionDistributionOutcome } from './distributionProvisionHandler'

/** Injected side effects + config for {@link handleProvisionRequest}. */
export interface ProvisionRequestDeps {
  /** Feature gate: provisioning is OFF unless the owner opts in (default false, fail-closed). */
  enabled: boolean
  /** Resolve the caller's portal member id from its domain (proves the app is installed). */
  memberIdByDomain: (domain: string) => Promise<string>
  /** Re-check the frame token against B24: returns the user id (membership proof) + admin flag. */
  validateFrame: (domain: string, accessToken: string) => Promise<{ userId: string, isAdmin: boolean }>
  /** Run the single-flight provisioning + persist for this portal. Runs on the portal's STORED
   *  OAuth token (proven app-context for `crm.type.add`/`userfieldconfig.add`), not the frame
   *  token — the frame token above serves only as the membership + admin gate. */
  provision: (memberId: string) => Promise<ProvisionDistributionOutcome>
  /** Optional sink for the RAW portal error (never sent to the client). Injected rather than
   *  `console.*` so this module stays pure/testable — same shape as `ConnectStartDeps.log`. */
  log?: (message: string) => void
}

export interface ProvisionRequestResult {
  status: number
  body: Record<string, unknown>
}

/**
 * Handle one provision request: gate → auth → provision. Order matters — the feature gate is
 * checked first (a disabled feature reveals nothing), then frame auth (400 no creds → 409 not
 * installed → 401 bad token → 403 not admin), then the provisioning. A downstream error maps to
 * 502 (the outcome body is only returned on success). Never throws.
 */
export async function handleProvisionRequest(
  deps: ProvisionRequestDeps,
  input: { accessToken: string, domain: string }
): Promise<ProvisionRequestResult> {
  if (!deps.enabled) return { status: 404, body: { error: 'provisioning disabled' } }

  const accessToken = (input.accessToken || '').trim()
  const domain = (input.domain || '').trim()
  if (!accessToken || !domain) return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }

  let memberId: string
  try {
    memberId = await deps.memberIdByDomain(domain)
  } catch {
    return { status: 502, body: { error: 'upstream error' } }
  }
  if (!memberId) return { status: 409, body: { error: 'portal not installed' } }

  let frame: { userId: string, isAdmin: boolean }
  try {
    frame = await deps.validateFrame(domain, accessToken)
  } catch {
    // The token didn't validate against B24 (expired / wrong domain / spoof) → unauthorized.
    return { status: 401, body: { error: 'invalid frame token' } }
  }
  if (!frame.userId) return { status: 401, body: { error: 'invalid frame token' } }
  if (!frame.isAdmin) return { status: 403, body: { error: 'admin required' } }

  try {
    const outcome = await deps.provision(memberId)
    return {
      status: 200,
      body: {
        ok: true,
        paymentSpEtid: outcome.paymentSpEtid,
        distributionSpEtid: outcome.distributionSpEtid,
        created: outcome.createdPaymentSp || outcome.createdDistributionSp,
        addedFields: outcome.addedFields,
        storedChanged: outcome.storedChanged
      }
    }
  } catch (e) {
    // ⚠ «Busy» is a NORMAL outcome, not a failure (#516). Provisioning is serialized by a per-portal
    // advisory lock, and a concurrent click (a second admin, a double press, a retry from another
    // tab) used to surface the UNHANDLED Postgres `55P03`. That reached the caller as an error,
    // while it means exactly «this operation is already running right now».
    //
    // ⚠ It is worse here than elsewhere: provisioning CREATES smart processes in the client's CRM
    // and there is no rollback button in production. An admin who sees an error cannot tell whether
    // anything was created, and the natural reaction is to press again. The message has to say what
    // NOT to do.
    if (isLockTimeout(e)) {
      return {
        status: 503,
        body: { error: 'Настройка смарт-процессов уже выполняется — подождите и обновите страницу. Повторное нажатие ничего не ускорит и может создать лишние сущности.' }
      }
    }
    // A bare «provisioning failed» left the admin with nothing to act on (#408). Classify what the
    // portal actually said: a missing scope needs a re-install/consent, an access error needs
    // portal rights — completely different actions, and neither is guessable from a generic 502.
    // The RAW message is logged server-side only; the client gets a classified, secret-free text.
    const raw = e instanceof Error ? e.message : String(e)
    // Portal text is external input — CRLF-strip + cap it, like every other log of foreign text
    // (bankConnectStart/bankConnectCallback), so it can't forge extra log lines.
    deps.log?.(`[provision] failed: ${sanitizeForLog(raw, 500)}`)
    return { status: 502, body: { error: classifyProvisionError(raw) } }
  }
}

/** Map a portal/transport error to an actionable Russian message. Pure — the caller logs the raw
 *  text; this only decides what the admin is told. Order matters: scope before access, because a
 *  missing scope also surfaces as an access-ish error on some methods. */
export function classifyProvisionError(raw: string): string {
  const s = raw.toLowerCase()
  // Scope FIRST. The SDK surfaces only `getErrorMessages()`, so the machine-readable
  // `insufficient_scope` is often absent and all we get is the human description «The request
  // requires HIGHER PRIVILEGES than provided by the … token» — the repo's own live script matches
  // exactly these three (scripts/verify-distribution-live.ts `isScopeError`). Dropping
  // `higher privileges` would make this branch miss #408's most common shape, i.e. the very case
  // it exists for. `userfieldconfig` stays narrow — paired with a denial word, not on its own,
  // because a plain field conflict also echoes the method name and must NOT read as «reinstall».
  if (s.includes('insufficient_scope')
    || s.includes('higher privileges')
    || (s.includes('userfieldconfig') && (s.includes('denied') || s.includes('scope') || s.includes('privileg')))) {
    return 'Приложению не выдан доступ «userfieldconfig», без него нельзя создать поля смарт-процессов. Переустановите приложение и подтвердите запрошенные права.'
  }
  if (s.includes('access_denied') || s.includes('access denied') || s.includes('insufficient rights')) {
    return 'Портал отказал в правах: смарт-процессы создаёт только администратор с доступом к CRM.'
  }
  if (s.includes('expired_token') || s.includes('invalid_token')) {
    return 'Истекла авторизация приложения в портале. Переустановите приложение и повторите.'
  }
  if (s.includes('timeout') || s.includes('econn') || s.includes('fetch failed') || s.includes('network')) {
    return 'Портал не ответил вовремя. Повторите попытку — действие идемпотентно, дубликатов не будет.'
  }
  // No «пришлите этот текст»: the raw message stays in the server log, the admin never sees it —
  // promising otherwise sends them looking for something that isn't on screen.
  return 'Портал вернул ошибку при настройке смарт-процессов. Повторите попытку; если повторяется — сообщите время попытки в поддержку, подробности есть в логе сервера.'
}
