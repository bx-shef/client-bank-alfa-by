/**
 * Bitrix24 integration constants. Plain data, no SDK import — so the
 * required-scopes contract is unit-testable without the b24jssdk runtime.
 */

/**
 * Scopes the app needs in a portal. The app reads statements and writes them into
 * CRM as universal activities, optionally announcing payments to a chat — so:
 * `crm` — create activities / look up companies by corr-account, invoices, deals, payments;
 * `sale` — resolve an `order-id` from the payment purpose to its payments
 *   (`sale.payment.list` by `orderId`; crm carries no `orderId`), #172. The result is
 *   intersected with the company-scoped crm pool, so `sale` is used only for the id→payments
 *   map, never as the authorization boundary;
 * `im` — post chat messages about incoming payments;
 * `documentgenerator` — resolve a `document-number` from the payment purpose to the CRM
 *   entity a generated document is bound to (`crm.documentgenerator.document.list`,
 *   `via-document` bridge, §4). Each bridged ref is re-scoped to the payer company via
 *   `crm.item.list` (IDOR), so `documentgenerator` is used only for the number→entity map.
 *   Live-verified on the test portal (reverse `filter:{number}` honored);
 * `user_brief` — the diagnostics block on the install page (current user);
 * `placement` — reserved for future placement.bind (in-portal embedding).
 *
 * The live REST calls run server-side (backend) by the stored OAuth token, not
 * from the iframe — see docs/REFACTOR_PLAN.md "Хранение настроек и вызовы B24".
 *
 * ⚠ Adding a scope forces re-consent on already-installed portals — coordinate with
 * the owner before shipping (`documentgenerator` added with the bridge wiring, #109).
 */
export const B24_REQUIRED_SCOPES = ['crm', 'sale', 'im', 'documentgenerator', 'user_brief', 'placement'] as const

/**
 * Backend path that receives Bitrix24 server events. Same origin as the app (the
 * prod nginx proxies `/api/*` to the backend), so the absolute handler URL is
 * `${siteUrl}${B24_EVENT_HANDLER_PATH}` — see server/api/b24/events.post.ts.
 */
export const B24_EVENT_HANDLER_PATH = '/api/b24/events'

/**
 * Server events the install script binds so the backend learns the portal:
 * `ONAPPINSTALL` delivers the `application_token` + OAuth creds (stored write-once),
 * `ONAPPUNINSTALL` lets the backend purge the portal on removal. For a local app
 * these are registered from the install script via `event.bind` (per B24 docs) —
 * there is no separate handler-URL field in the local-app card.
 */
export const B24_BOUND_EVENTS = ['ONAPPINSTALL', 'ONAPPUNINSTALL'] as const

/**
 * The app's own CRM automation trigger (#79). Registered at install via
 * `crm.automation.trigger.add` (idempotent — re-adding the same CODE just updates
 * NAME), so a portal admin can attach it to an automation rule («деньги пришли»).
 * When a payment is allocated to a deal/smart-process, the worker fires THIS CODE
 * (`crm.automation.trigger.execute`) — the admin's rule then does the routing.
 *
 * `code` matches the API mask `[a-z0-9.\-_]`. It is the value a portal admin puts
 * into the settings field `allocation.triggerCode` to arm firing (kept a settings
 * value, not hard-wired, so a portal can point at its own trigger if it prefers).
 */
export const B24_PAYMENT_TRIGGER = {
  code: 'cba_payment_received',
  name: 'Импорт выписки: платёж получен'
} as const

/**
 * Build the portal-relative path to this app's Bitrix24 Market detail page. Passed to the frame
 * SDK's `slider.openPath` so the user lands on the listing where they can leave a rating/review
 * (the «оцените приложение» modal). The path shape is fixed by Bitrix24; `code` is the app's Market
 * listing code (see nuxt.config `b24MarketCode`, defaulting to `LANDING_MARKET_CODE`). Returns null
 * for an empty code (feature off).
 */
export function marketDetailPath(code: string): string | null {
  const c = code.trim()
  return c ? `/marketplace/detail/${c}/` : null
}

/**
 * entityTypeId of a smart-invoice — a fixed CRM constant (`31`). Canonical home here (a plain
 * app-layer constant) so both the server lookup (`invoiceLookup.ts`, re-exports it) and the
 * app-layer deletion parser (`deletionEvent.ts`) share ONE definition instead of duplicating `31`.
 */
export const SMART_INVOICE_ENTITY_TYPE_ID = 31

/**
 * CRM deletion events we bind so the backend reconciles the SP-ledger (#109, PROCESSING.md §9.2):
 * `ONCRMDEALDELETE` (deal), `ONCRMCOMPANYDELETE` (company), `ONCRMDYNAMICITEMDELETE` (any smart
 * process element — our carrier/distributions SPs + smart-invoices, told apart by ENTITY_TYPE_ID).
 * Deals/companies do NOT fire the dynamic event, so all three are needed. Bound at install
 * alongside `B24_BOUND_EVENTS` (both feed the `event.bind` batch). Scope `crm`.
 */
export const B24_DELETION_EVENTS = ['ONCRMDEALDELETE', 'ONCRMCOMPANYDELETE', 'ONCRMDYNAMICITEMDELETE'] as const

/**
 * The FULL set of server events the install script binds to the backend handler in ONE
 * `event.bind` batch: the app lifecycle events (`B24_BOUND_EVENTS`) + the CRM deletion events
 * (`B24_DELETION_EVENTS`, §9.2 ledger reconcile).
 *
 * TARIFF up/downgrade: all deletion events are bound UNCONDITIONALLY and never re-bound. On a
 * tariff without smart processes, `ONCRMDYNAMICITEMDELETE` simply never fires (no SP elements
 * exist) — binding it is harmless; on an upgrade it starts firing with no re-install needed. Deal
 * and company deletions matter to allocation targets regardless of the carrier (СП vs дело). So a
 * single unconditional bound set is the tariff-robust choice — the carrier decision (`chooseCarrier`)
 * stays per-operation, the event subscription is static.
 */
export const B24_ALL_BOUND_EVENTS = [...B24_BOUND_EVENTS, ...B24_DELETION_EVENTS] as const
