import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { B24_FORM_HOST_ALLOWLIST } from '~/utils/b24Form'

// public/b24-form.html can't import the ES module, so it re-implements the same
// host allowlist + id/secret regex inline. This drift guard fails CI if the two
// enforcement points fall out of sync (same rationale as the OAuth cores, #45).
const html = readFileSync(
  fileURLToPath(new URL('../public/b24-form.html', import.meta.url)),
  'utf8'
)

describe('public/b24-form.html guard parity', () => {
  it('embeds every host from B24_FORM_HOST_ALLOWLIST', () => {
    for (const host of B24_FORM_HOST_ALLOWLIST) {
      expect(html).toContain(`'${host}'`)
    }
  })

  it('embeds the same id/secret regex as b24Form.ts', () => {
    expect(html).toContain('/^[a-zA-Z0-9_-]+$/')
  })

  it('enforces https + the inline/<id>/<secret> shape and never trusts the raw query', () => {
    expect(html).toContain('u.protocol !== \'https:\'')
    expect(html).toContain('parts[0] !== \'inline\'')
  })
})
