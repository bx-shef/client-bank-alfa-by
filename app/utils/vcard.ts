/** Pure builder for a VCARD 3.0 payload — extracted from BusinessCardModal so
 * the field order / CRLF framing is unit-testable (the DOM/blob/anchor download
 * plumbing stays in the component). */
export interface VCardFields {
  fullName: string
  /** Structured name: N:Last;First;Middle;; */
  lastName: string
  firstName: string
  middleName: string
  org: string
  title: string
  /** Phone in canonical +NNN… form. */
  phoneTel: string
  email: string
  url: string
  note: string
}

/** Serialize `fields` into a VCARD 3.0 string (CRLF line breaks, per RFC 2426). */
export function buildVCard(fields: VCardFields): string {
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${fields.fullName}`,
    `N:${fields.lastName};${fields.firstName};${fields.middleName};;`,
    `ORG:${fields.org}`,
    `TITLE:${fields.title}`,
    `TEL;TYPE=CELL:${fields.phoneTel}`,
    `EMAIL:${fields.email}`,
    `URL:${fields.url}`,
    `NOTE:${fields.note}`,
    'END:VCARD'
  ].join('\r\n')
}
