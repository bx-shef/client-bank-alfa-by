import { describe, expect, it } from 'vitest'
import { restUrl } from '../server/utils/b24Rest'

describe('restUrl', () => {
  it('builds https://<host>/rest/<method> from a bare host', () => {
    expect(restUrl('p.bitrix24.by', 'app.option.get')).toBe('https://p.bitrix24.by/rest/app.option.get')
  })
  it('strips a scheme and any path if a full endpoint is passed', () => {
    expect(restUrl('https://p.bitrix24.by/rest/', 'app.option.set')).toBe('https://p.bitrix24.by/rest/app.option.set')
  })
})
