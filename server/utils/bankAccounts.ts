// Connected bank accounts for the settings UI — list + disconnect (#404). Pure logic over
// injected I/O (DI), unit-testable without DB/B24; the thin routes
// (server/api/bank/accounts.get.ts, server/api/bank/disconnect.post.ts) wire live transports.
//
// Why this exists: after a successful connect the UI showed NOTHING — no bank, no account, no
// way to remove a wrong one. The data was already in `bank_tokens`; it just had no read path.
//
// Auth mirrors /api/bank/connect exactly, because this is the same capability seen from the other
// side: listing reveals which accounts a portal has bound, and disconnecting stops its imports.
//   1. portal key check (do we hold tokens for this domain at all)
//   2. frame-token validation against THAT domain — blocks X-B24-Domain spoofing
//   3. ADMIN gate — bank credentials are portal-wide, so only an admin sees or removes them
// Secrets NEVER leave: the list carries identity + freshness only (no access/refresh token).

import type { BankAccountInfo } from './bankTokenStore'
import type { BankProviderId } from '../../app/types/statement'

export interface BankAccountsResult {
  status: number
  body: Record<string, unknown>
}

export interface BankAccountsDeps {
  /** member_id of the portal we hold tokens for, by domain; null if not installed. */
  memberIdByDomain: (domain: string) => Promise<string | null>
  /** Validate the frame token against `domain` (`profile`), returning the admin flag, or THROWING
   *  if the token isn't valid for that portal (blocks domain spoofing). */
  validateFrame: (domain: string, accessToken: string) => Promise<{ userId: string, isAdmin: boolean }>
}

export interface ListAccountsDeps extends BankAccountsDeps {
  list: (memberId: string) => Promise<BankAccountInfo[]>
}

export interface DisconnectDeps extends BankAccountsDeps {
  remove: (memberId: string, provider: BankProviderId, accountKey: string) => Promise<boolean>
}

export interface BankAccountsInput {
  accessToken: string
  domain: string
}

export interface DisconnectInput extends BankAccountsInput {
  provider: string
  accountKey: string
}

/** Providers a client may name. Anything else is rejected before it reaches SQL — the value is
 *  caller-controlled and is used as a lookup key, so it gets an allowlist, not a cast. */
const KNOWN_PROVIDERS: readonly string[] = ['alfa-by', 'prior-by', 'manual']

function isKnownProvider(v: string): v is BankProviderId {
  return KNOWN_PROVIDERS.includes(v)
}

/** Shared gate: portal installed + frame token proven for that portal + caller is an admin.
 *  Returns the resolved memberId, or the error result to hand straight back. */
async function authorize(deps: BankAccountsDeps, input: BankAccountsInput): Promise<{ memberId: string } | { error: BankAccountsResult }> {
  const { accessToken, domain } = input
  if (!accessToken || !domain) {
    return { error: { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } } }
  }
  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { error: { status: 409, body: { error: 'portal not installed (no key)' } } }

  let frame: { userId: string, isAdmin: boolean }
  try {
    frame = await deps.validateFrame(domain, accessToken)
  } catch {
    return { error: { status: 403, body: { error: 'invalid frame token for this portal' } } }
  }
  if (!frame.isAdmin) {
    return { error: { status: 403, body: { error: 'bank connections are administrator-only' } } }
  }
  return { memberId }
}

/** List the caller portal's connected bank accounts (identity + freshness, no secrets). */
export async function handleListBankAccounts(deps: ListAccountsDeps, input: BankAccountsInput): Promise<BankAccountsResult> {
  const auth = await authorize(deps, input)
  if ('error' in auth) return auth.error

  const accounts = await deps.list(auth.memberId)
  // `memberId` is stripped: the client already knows its own portal, and echoing the internal id
  // into a browser response serves nothing.
  return {
    status: 200,
    body: {
      accounts: accounts.map(a => ({
        provider: a.provider,
        accountKey: a.accountKey,
        connectedAt: a.connectedAt,
        expiresAt: a.expiresAt,
        hasRefresh: a.hasRefresh
      }))
    }
  }
}

/** Disconnect one account of the caller's portal. Idempotent — removing an already-gone account
 *  answers 200 `{removed:false}` rather than 404, so a double-click isn't an error. */
export async function handleDisconnectBankAccount(deps: DisconnectDeps, input: DisconnectInput): Promise<BankAccountsResult> {
  const auth = await authorize(deps, input)
  if ('error' in auth) return auth.error

  const provider = input.provider?.trim() ?? ''
  const accountKey = input.accountKey?.trim() ?? ''
  if (!provider || !accountKey) {
    return { status: 400, body: { error: 'provider and accountKey are required' } }
  }
  if (!isKnownProvider(provider)) {
    return { status: 400, body: { error: 'unknown provider' } }
  }

  const removed = await deps.remove(auth.memberId, provider, accountKey)
  return { status: 200, body: { removed } }
}
