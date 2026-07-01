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
  return await $fetch(restUrl(host, method), {
    method: 'POST',
    body: { ...params, auth: accessToken }
  })
}
