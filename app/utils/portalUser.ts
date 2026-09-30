// Strict parsing of a portal user id — its own module, with no dependencies.
//
// ⚠ Separate because modules unrelated to activities read it too: Bitrix24 event parsing
// (`b24Events.ts`, the app's system user id) and the token store. Living in `activity.ts`, it
// dragged activity formatting and money formatting into all of them (review of #783: session
// modules import `b24Events.ts` for nothing but `safeEqual`).

/**
 * A portal user id as the portal sends it — a positive safe integer, or its plain digit string —
 * else `null`.
 *
 * ⚠ ONE strict parser for every place a user id reaches the portal as a responsible (activities,
 * smart-process elements) or arrives from it (the app's system user of ONAPPUSERREADY, the token
 * owner), because the portal does NOT validate the activity responsible:
 * `crm.activity.todo.add` stores whatever it is given (box code reading 2026-09-28; a probe stored
 * 0). `Number()` alone is not a check — it turns `true` into 1, `[17]` into 17, `'0x11'` into 17
 * and `'1e1'` into 10, and a value past 2^53 silently loses digits. Each of those would become an
 * activity on the wrong person, or on nobody.
 */
export function portalUserId(raw: unknown): number | null {
  let n: number
  if (typeof raw === 'number') n = raw
  else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) n = Number(raw.trim())
  else return null
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
