/** Pure helpers for embedding a Bitrix24 CRM web-form.
 *
 * The form is loaded inside a dedicated same-origin iframe document
 * (`/b24-form.html`), which nginx serves with a form-scoped CSP so the strict
 * page-level CSP stays intact. This module only builds/validates the iframe
 * `src`; the guards below mirror the checks the static page repeats at runtime. */

const ID_RE = /^[a-zA-Z0-9_-]+$/

/** Hosts the official B24 form loader script may live on. */
export const B24_FORM_HOST_ALLOWLIST = [
  '.bitrix24.com',
  '.bitrix24.by',
  '.bitrix24.ru',
  '.bitrix24.kz',
  '.bitrix24.tech'
] as const

/** True when `rawUrl` is an https URL on an allow-listed Bitrix24 host. */
export function isAllowedB24FormHost(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'https:') return false
    return B24_FORM_HOST_ALLOWLIST.some(suffix => u.hostname.endsWith(suffix))
  } catch {
    return false
  }
}

/**
 * Build the iframe `src` for the form host page (`/b24-form.html`) from the
 * public config, or return `null` when the form isn't configured / the inputs
 * fail validation (host allow-list, id/secret shape). `null` ⇒ render a
 * placeholder slot instead of the form.
 */
export function buildB24FormSrc(
  scriptUrl: string,
  formId: string,
  formSecret: string
): string | null {
  if (!scriptUrl || !formId || !formSecret) return null
  if (!isAllowedB24FormHost(scriptUrl)) return null
  if (!ID_RE.test(formId) || !ID_RE.test(formSecret)) return null

  const params = new URLSearchParams({
    script: scriptUrl,
    form: `inline/${formId}/${formSecret}`
  })
  return `/b24-form.html?${params.toString()}`
}
