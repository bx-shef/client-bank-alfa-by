/**
 * Pure builder for the `crm.automation.trigger.add` call the install script runs so
 * the portal gains the app's «деньги пришли» automation trigger (#79). A portal admin
 * then attaches that trigger to an automation rule; when a payment is allocated to a
 * deal/smart-process, the worker fires the same CODE (`crm.automation.trigger.execute`).
 *
 * `crm.automation.trigger.add` is IDEMPOTENT (re-adding an existing CODE just updates
 * its NAME), so the install flow can call it on every (re)install unconditionally.
 * It needs APPLICATION CONTEXT (the install iframe provides it) + admin rights, and it
 * CANNOT be batched (`ERROR_BATCH_METHOD_NOT_ALLOWED`) — so it is a STANDALONE call,
 * separate from the `event.bind` batch. No SDK import — unit-testable; the transport
 * (the actual `actions.v2.call.make`) is the caller's (install.vue), like b24EventBind.ts.
 */

import type { B24Call } from './b24EventBind'

/** The API mask for a trigger CODE (`crm.automation.trigger.add`): lowercase
 *  latin, digits, dot, hyphen, underscore. Same mask as `allocation.triggerCode`. */
const TRIGGER_CODE_RE = /^[a-z0-9.\-_]+$/

/**
 * Build the `crm.automation.trigger.add` call, or `null` when the inputs are invalid
 * (empty/mask-failing CODE, or empty NAME) — fail-safe, so the install script never
 * sends a malformed registration the API would reject with «Wrong trigger code!».
 *
 * @param code trigger CODE (must match `[a-z0-9.\-_]`)
 * @param name human-readable trigger name (non-empty after trim)
 */
export function buildTriggerRegisterCall(code: string, name: string): B24Call | null {
  const cleanCode = (code ?? '').trim()
  const cleanName = (name ?? '').trim()
  if (!cleanCode || !TRIGGER_CODE_RE.test(cleanCode)) return null
  if (!cleanName) return null
  return { method: 'crm.automation.trigger.add', params: { CODE: cleanCode, NAME: cleanName } }
}
