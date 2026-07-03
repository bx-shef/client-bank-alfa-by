import { describe, expect, it } from 'vitest'
import { buildVCard } from '~/utils/vcard'

const FIELDS = {
  fullName: 'Игорь Шевчик',
  lastName: 'Шевчик',
  firstName: 'Игорь',
  middleName: 'Сергеевич',
  org: 'ИП Шевчик И. С.',
  title: 'Роль',
  phoneTel: '+375297360126',
  email: 'offer@bx-shef.by',
  url: 'https://offer.bx-shef.by',
  note: 'Заметка.'
}

describe('buildVCard', () => {
  it('wraps the payload in BEGIN/END and VERSION 3.0', () => {
    const v = buildVCard(FIELDS)
    expect(v.startsWith('BEGIN:VCARD\r\nVERSION:3.0')).toBe(true)
    expect(v.endsWith('END:VCARD')).toBe(true)
  })

  it('uses CRLF line breaks (RFC 2426)', () => {
    expect(buildVCard(FIELDS).includes('\n')).toBe(true)
    // No bare LF without a preceding CR.
    expect(/[^\r]\n/.test(buildVCard(FIELDS))).toBe(false)
  })

  it('renders the structured name and the fields', () => {
    const v = buildVCard(FIELDS)
    expect(v).toContain('N:Шевчик;Игорь;Сергеевич;;')
    expect(v).toContain('FN:Игорь Шевчик')
    expect(v).toContain('TEL;TYPE=CELL:+375297360126')
    expect(v).toContain('EMAIL:offer@bx-shef.by')
    expect(v).toContain('URL:https://offer.bx-shef.by')
    expect(v).toContain('NOTE:Заметка.')
  })
})
