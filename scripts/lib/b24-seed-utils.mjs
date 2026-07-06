// Pure helpers for the Bitrix24 test-data seed script (scripts/seed-test-b24.mjs).
// Kept here (not inline) so the string/logic bits are unit-tested without a live
// portal — same split as scripts/lib/demo-utils.mjs for the bank demo scripts.

/**
 * Normalize + validate an incoming-webhook base URL. Trims, ensures a single
 * trailing slash, and requires the `https://<host>/rest/<userId>/<token>/` shape.
 * @param {string|undefined} raw
 * @returns {string|null} the normalized URL, or null if it isn't a valid webhook
 */
export function validateTestWebhook(raw) {
  const url = (raw || '').trim().replace(/\/?$/, '/')
  if (!url) return null
  return /^https:\/\/.+\/rest\/\d+\/[^/]+\/$/.test(url) ? url : null
}

/**
 * Pick the first free CRM entityTypeId for a new smart process. Bitrix reserves
 * even ids from 1030 up for custom dynamic types, so we step by 2 from `start`
 * and skip anything already taken.
 * @param {Array<number|string>} usedIds  entityTypeIds already on the portal
 * @param {number} [start=1030]
 * @param {number} [step=2]
 * @returns {number}
 */
export function pickFreeEntityTypeId(usedIds, start = 1030, step = 2) {
  const used = new Set((usedIds || []).map(Number))
  let etid = start
  while (used.has(etid)) etid += step
  return etid
}
