// Single source of the distribution feature gate (#109 §9). The payment-distribution contour
// (provisioning smart processes + writing the ledger + the «Распределение» UI) is OFF unless the
// owner turns it on with DISTRIBUTION_PROVISION_ENABLED=1. Kept in one place so the three routes
// (provision / ledger / recompute) can't drift on the default.
//
// ⚠ IT USED TO BE ON BY DEFAULT, and that was right for a dev stage and wrong for a client's
// portal. This feature CREATES SMART PROCESSES in someone else's CRM, and default-on meant the
// «Настроить смарт-процессы» button sat in the settings of every portal that installed us —
// including the ones that will never need distribution — with nothing warning the admin what the
// click does. Turning it off was an item on a checklist, and a checklist item that has to be
// remembered for every stand is a defect waiting for the one time it isn't.
//
// ⚠ The default now matches EVERY other mutating switch in this codebase — `autoDistribute` (writes
// to CRM), `CRON_REAL_POLL` (talks to the bank), `MANUAL_POLL_ENABLED` — all of them opt-in. A
// feature that changes a client's CRM should not be the single exception, however convenient that
// was while only we had portals.

/** Whether the distribution feature is enabled. Default OFF; enabled ONLY when the env var is '1'. */
export function distributionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DISTRIBUTION_PROVISION_ENABLED === '1'
}
