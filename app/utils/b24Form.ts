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

/** The lead form of OUR landing (portal b37817748). Public identifiers, not secrets. */
export const DEFAULT_B24_FORM = {
  scriptUrl: 'https://cdn-ru.bitrix24.by/b37817748/crm/form/loader_1.js',
  formId: '1',
  formSecret: '3c735r'
} as const

export interface B24FormConfig {
  scriptUrl: string
  formId: string
  formSecret: string
}

/**
 * Which form to embed: the configured one, or ours — ours only outside local mode.
 *
 * ⚠ The default is applied HERE; the config keys in `nuxt.config.ts` are empty. An empty build
 * variable overrides a config default, and the `Dockerfile` sets it empty whenever the repository
 * variable is unset. That is how, from #701 (2026-09-13), production showed the «Слот под
 * CRM-форму» placeholder instead of the lead form (measured 2026-09-27: `b24FormId:""` in
 * `__NUXT__.config`).
 *
 * ⚠ In local mode (a client's clone) there is no form of ours: leads from someone else's
 * deployment would land in OUR CRM, so the placeholder stays there as before. If any part is set,
 * the given values are used as they are: `buildB24FormSrc` rejects an incomplete setup, which shows
 * up as the placeholder instead of being silently replaced by ours.
 */
export function resolveB24Form(
  value: { scriptUrl: unknown, formId: unknown, formSecret: unknown },
  localMode: boolean
): B24FormConfig {
  // Values come through `destr`, so `1` is a number: stringify rather than call `.trim()` on it.
  // ⚠ Stringifying does NOT restore a value destr rewrote: `1e5` arrives as 100000 and `12e345` as
  // Infinity. A secret that looks like a number must be quoted in the variable (`"12e345"`) —
  // destr returns the text inside the quotes as is.
  const scriptUrl = String(value.scriptUrl ?? '').trim()
  const formId = String(value.formId ?? '').trim()
  const formSecret = String(value.formSecret ?? '').trim()
  if (scriptUrl || formId || formSecret) return { scriptUrl, formId, formSecret }
  return localMode ? { scriptUrl: '', formId: '', formSecret: '' } : { ...DEFAULT_B24_FORM }
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
