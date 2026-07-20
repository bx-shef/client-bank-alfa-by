// Single source of the distribution feature gate (#109 §9). The payment-distribution contour
// (provisioning smart processes + writing the ledger + the «Распределение» UI) is ON BY DEFAULT at
// this stage — the owner opts OUT by setting DISTRIBUTION_PROVISION_ENABLED=0. Any other value (unset,
// '1', anything) ⇒ enabled. Kept in one place so the three routes (provision / ledger / recompute)
// can't drift on the default.

/** Whether the distribution feature is enabled. Default ON; disabled ONLY when the env var is '0'. */
export function distributionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DISTRIBUTION_PROVISION_ENABLED !== '0'
}
