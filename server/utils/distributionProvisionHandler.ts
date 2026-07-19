// Orchestrates provisioning the two distribution smart processes and PERSISTING their
// entityTypeIds to the portal settings (#109, PROCESSING.md §9.1, provisioning-execution slice).
// Pure over injected deps — fully unit-testable with fakes; the live route wires the SDK RestCall,
// the pg advisory lock (single-flight) and the telemetry span.
//
// The WHOLE op runs under `withLock` so concurrent provision requests for one portal can't both
// miss the title probe and create DUPLICATE SPs: the first holder provisions + stores the ids; a
// second holder, entering after COMMIT, re-reads settings (now carrying the ids) and short-circuits
// via the `known`-id path inside `provision`. That is the single-flight the transport's docstring
// demands (there is no lock in `provisionDistributionSp` itself).
//
// This rests on two wiring-level assumptions (the LIVE deps must honour them):
//  1. `withLock` uses a PER-PORTAL key (member_id-scoped) — else unrelated portals serialize
//     (harmless) or, if the key weren't portal-stable, the guarantee would weaken.
//  2. `app.option` is read-your-writes (holder-2's REST read reflects holder-1's committed write).
// Even if (2) lagged, duplicates are still prevented: `provisionDistributionSp` is idempotent BY
// STABLE TITLE (probes `crm.type.list` before creating), so a stale read recovers the existing SPs
// rather than creating new ones — the title probe is the backstop behind the lock.

import type { PortalSettings } from '../../app/utils/settings'
import {
  DISTRIBUTION_SP_CONFIG_KEY,
  PAYMENT_SP_CONFIG_KEY,
  distributionSpEtid,
  paymentSpEtid,
  withSpEtids
} from '../../app/config/distributionSp'
import type { KnownSpIds, ProvisionResult } from './distributionSpProvision'

/** Injected side effects for {@link handleProvisionDistribution}. */
export interface ProvisionDistributionDeps {
  /** Read the portal's current parsed settings blob (from `app.option`). */
  loadSettings: () => Promise<PortalSettings>
  /** Persist the updated settings blob (to `app.option`). Called only when the stored ids change. */
  saveSettings: (settings: PortalSettings) => Promise<void>
  /** Provision (or self-heal) the SPs given the already-stored ids; returns the resolved etids.
   *  The live dep wraps `provisionDistributionSp(sdkCall, known)` in the telemetry span. */
  provision: (known: KnownSpIds) => Promise<ProvisionResult>
  /** Single-flight wrapper: run `fn` under a per-portal advisory lock (live: `withAdvisoryLock`). */
  withLock: <T>(fn: () => Promise<T>) => Promise<T>
}

/** Result of a provisioning-execution run: the resolved ids + what changed. */
export interface ProvisionDistributionOutcome extends ProvisionResult {
  /** Whether this run wrote the settings blob (the stored ids differed / were absent). */
  storedChanged: boolean
}

/**
 * Provision the distribution SPs and persist their entityTypeIds to portal settings, single-flight.
 * Idempotent: a re-run after both ids are stored short-circuits provisioning to the `known` path
 * and writes nothing (`storedChanged=false`). A transport/persist error propagates (the caller —
 * install/route — surfaces it for retry). Never mutates the loaded settings object in place.
 */
export async function handleProvisionDistribution(deps: ProvisionDistributionDeps): Promise<ProvisionDistributionOutcome> {
  return deps.withLock(async () => {
    const settings = await deps.loadSettings()
    const configFields = settings.recognition.configFields
    const known: KnownSpIds = {
      paymentSpEtid: paymentSpEtid(configFields),
      distributionSpEtid: distributionSpEtid(configFields)
    }

    const result = await deps.provision(known)

    const merged = withSpEtids(configFields, result.paymentSpEtid, result.distributionSpEtid)
    const storedChanged
      = merged[PAYMENT_SP_CONFIG_KEY] !== configFields[PAYMENT_SP_CONFIG_KEY]
        || merged[DISTRIBUTION_SP_CONFIG_KEY] !== configFields[DISTRIBUTION_SP_CONFIG_KEY]

    if (storedChanged) {
      await deps.saveSettings({
        ...settings,
        recognition: { ...settings.recognition, configFields: merged }
      })
    }

    return { ...result, storedChanged }
  })
}
