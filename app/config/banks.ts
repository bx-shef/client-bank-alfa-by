import type { BankProviderId, Statement } from '~/types/statement'

// Bank-provider abstraction. The engine talks to a `BankProvider`, never to a
// specific bank directly, so Alfa today and Prior / manual import later plug in
// without touching call sites. This file holds the provider-agnostic metadata
// and the interface; concrete clients (AlfaProvider, …) implement it elsewhere
// (backend) against these contracts.

/** Static, presentational metadata for a provider (no secrets, no runtime). */
export interface BankProviderMeta {
  id: BankProviderId
  /** User-facing name. */
  title: string
  /** Auth model — drives the settings UI. */
  auth: 'oauth' | 'manual'
  /** Whether automatic polling (cron) is possible for this provider. */
  canPoll: boolean
  /** Implemented yet? Lets the UI show "coming soon" without branching logic. */
  implemented: boolean
}

/** Parameters for fetching a statement, provider-agnostic. */
export interface StatementQuery {
  accounts: string[]
  /** ISO date (inclusive). Defaults are the provider's responsibility. */
  dateFrom?: string
  dateTo?: string
  /** Opaque pagination cursor from a previous `Statement.nextCursor`. Optional
   * now (mock returns everything); lets providers page large statements without
   * breaking the contract later. */
  cursor?: string
}

/**
 * Contract every bank integration implements. Kept here (frontend) as the
 * single source of truth for the shape; the backend implements it per bank.
 */
export interface BankProvider {
  readonly meta: BankProviderMeta
  listAccounts(): Promise<string[]>
  getStatement(query: StatementQuery): Promise<Statement>
}

/** Registry of known providers. `implemented` gates UI without code branches. */
export const BANK_PROVIDERS: readonly BankProviderMeta[] = [
  { id: 'alfa-by', title: 'Альфа-Банк Беларусь', auth: 'oauth', canPoll: true, implemented: false },
  { id: 'prior-by', title: 'Приорбанк Беларусь', auth: 'oauth', canPoll: true, implemented: false },
  { id: 'manual', title: 'Ручная загрузка выписки', auth: 'manual', canPoll: false, implemented: false }
]

/** Look up provider metadata by id. */
export function getProviderMeta(id: BankProviderId): BankProviderMeta | undefined {
  return BANK_PROVIDERS.find(p => p.id === id)
}
