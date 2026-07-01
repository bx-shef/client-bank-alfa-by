// Thin Bitrix24 REST caller. `restUrl` is pure (testable); `callRest` does the
// actual $fetch (Nitro global) and is injected into the pure settings handler,
// so business logic stays testable without the network.

/** REST endpoint URL for a portal host + method (`x.bitrix24.by` + `app.option.get`). */
export function restUrl(host: string, method: string): string {
  const h = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return `https://${h}/rest/${method}`
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
  return await fetchJson(restUrl(host, method), {
    method: 'POST',
    body: { ...params, auth: accessToken }
  })
}
