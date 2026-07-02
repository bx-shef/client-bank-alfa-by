// Thin Bitrix24 REST caller. `restUrl` and `b24ErrorMessage` are pure (testable);
// `callRest` does the actual $fetch (Nitro global) and is injected into the pure
// settings handler, so business logic stays testable without the network.

/** REST endpoint URL for a portal host + method (`x.bitrix24.by` + `app.option.get`). */
export function restUrl(host: string, method: string): string {
  const h = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return `https://${h}/rest/${method}`
}

/** A human-readable message if a REST body carries a Bitrix24 error, else null.
 *  B24 returns HTTP 200 with `{error, error_description}` for many failures (bad
 *  params, missing scope, rights) — so callers must inspect the body, not only the
 *  HTTP status. Used by `callRest` to fail loudly instead of returning an error
 *  body that downstream code would misread as an empty/absent result. */
export function b24ErrorMessage(resp: Record<string, unknown>): string | null {
  const err = resp?.error
  if (err === undefined || err === null || err === '') return null
  const desc = resp?.error_description
  return desc ? `${err}: ${desc}` : `${err}`
}

/** Call a REST method on the portal with an access token in the body. */
export async function callRest(
  host: string,
  accessToken: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  // $fetch's route-typed overloads try to match a request URL against Nitro's
  // generated internal route table. With a dynamic (non-literal) URL that matching
  // recurses over every route and overflows the checker (TS2321) as the table grows.
  // This is a plain external POST to a portal host, so cast $fetch to a simple
  // signature to opt out of route inference (runtime behaviour is unchanged). The
  // reference stays inside the function so importing this module (e.g. for restUrl
  // in unit tests) doesn't touch the Nitro-only $fetch global.
  const fetchJson = $fetch as unknown as (
    url: string,
    opts: { method: string, body: Record<string, unknown> }
  ) => Promise<Record<string, unknown>>
  const json = await fetchJson(restUrl(host, method), {
    method: 'POST',
    body: { ...params, auth: accessToken }
  })
  // B24 signals many failures as HTTP 200 + {error} — surface them as throws so
  // callers (company lookup, activity write, settings) don't mistake an error body
  // for an empty result and silently swallow it.
  const err = b24ErrorMessage(json)
  if (err) throw new Error(`B24 REST ${method} failed — ${err}`)
  return json
}
