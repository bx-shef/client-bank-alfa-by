/**
 * Bitrix24 integration constants. Plain data, no SDK import — so the
 * required-scopes contract is unit-testable without the b24jssdk runtime.
 */

/**
 * Scopes the app needs in a portal. The app reads statements and writes them into
 * CRM as universal activities, optionally announcing payments to a chat — so:
 * `crm` — create activities / look up companies by corr-account;
 * `im` — post chat messages about incoming payments;
 * `user_brief` — the diagnostics block on the install page (current user);
 * `placement` — reserved for future placement.bind (in-portal embedding).
 *
 * The live REST calls run server-side (backend) by the stored OAuth token, not
 * from the iframe — see docs/REFACTOR_PLAN.md "Хранение настроек и вызовы B24".
 */
export const B24_REQUIRED_SCOPES = ['crm', 'im', 'user_brief', 'placement'] as const
