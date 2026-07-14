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
 * `user_brief` — the diagnostics block on the install page (current user);
 * `placement` — reserved for future placement.bind (in-portal embedding).
 *
 * The live REST calls run server-side (backend) by the stored OAuth token, not
 * from the iframe — see docs/REFACTOR_PLAN.md "Хранение настроек и вызовы B24".
 */
export const B24_REQUIRED_SCOPES = ['crm', 'sale', 'im', 'user_brief', 'placement'] as const

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
