import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MAX_ONEC_EXCHANGE_CHARS, isOneCExchange, parseOneCExchange } from '~/utils/oneCExchange'
import { currencyFromAccount, normalizeOneC, normalizeOneCDocument } from '~/utils/oneCStatement'
import { detectManualFormat, normalizeManualStatement } from '~/utils/manualImport'

// 1CClientBankExchange (issue #21): the 1C accounting exchange format. A synthetic
// file with one outgoing (debit) and one incoming (credit) document; RU 20-digit
// account (currency code 810 → RUB). Values are Cyrillic; a real upload is CP1251
// and decoded to a string before parsing (here we pass a UTF-8 string directly).
const OUR = '40702810900000000001'
const ONE_C = [
  '1CClientBankExchange',
  'ВерсияФормата=1.02',
  'Кодировка=Windows',
  'Отправитель=Банк Клиент Онлайн',
  'Получатель=1С:Предприятие',
  'ДатаНачала=18.01.2018',
  'ДатаКонца=29.01.2018',
  `РасчСчет=${OUR}`,
  'СекцияРасчСчет',
  `РасчСчет=${OUR}`,
  'НачальныйОстаток=1000.00',
  'КонецРасчСчет',
  'СекцияДокумент=Платежное поручение',
  'Номер=4',
  'Дата=25.01.2018',
  'Сумма=1500.50',
  `ПлательщикСчет=${OUR}`,
  'ДатаСписано=25.01.2018',
  'ПлательщикИНН=7718881750',
  'Плательщик1=ООО Моя компания',
  'ПолучательСчет=40702810900000000999',
  'ПолучательИНН=7712345678',
  'Получатель1=ООО Ромашка',
  'ПолучательБанк1=Банк Икс',
  'ПолучательБИК=044525225',
  'НазначениеПлатежа=Оплата по счёту №1 = аванс',
  'КонецДокумента',
  'СекцияДокумент=Платежное поручение',
  'Номер=5',
  'Дата=26.01.2018',
  'Сумма=2000.00',
  'ПлательщикСчет=40702810900000000888',
  'ПлательщикИНН=7787654321',
  'Плательщик1=ООО Клиент',
  `ПолучательСчет=${OUR}`,
  'ДатаПоступило=26.01.2018',
  'НазначениеПлатежа=Оплата за товар',
  'КонецДокумента',
  'КонецФайла'
].join('\r\n')

describe('parseOneCExchange', () => {
  const parsed = parseOneCExchange(ONE_C)

  it('reads the header, one balance section, two documents', () => {
    expect(parsed.header['ВерсияФормата']).toBe('1.02')
    expect(parsed.header['РасчСчет']).toBe(OUR)
    expect(parsed.accounts).toHaveLength(1)
    expect(parsed.accounts[0]!['НачальныйОстаток']).toBe('1000.00')
    expect(parsed.documents).toHaveLength(2)
    expect(parsed.documents[0]!['Вид']).toBe('Платежное поручение')
    expect(parsed.documents[0]!['Номер']).toBe('4')
  })

  it('keeps "=" inside a value (splits on the first "=" only)', () => {
    expect(parsed.documents[0]!['НазначениеПлатежа']).toBe('Оплата по счёту №1 = аванс')
  })

  it('rejects an oversized input before parsing (DoS guard, #19)', () => {
    // Guard is `>` (boundary length === maxChars is allowed), throws before splitting.
    expect(() => parseOneCExchange(ONE_C, ONE_C.length - 1)).toThrow(/too large/)
    expect(() => parseOneCExchange(ONE_C, ONE_C.length)).not.toThrow()
    expect(MAX_ONEC_EXCHANGE_CHARS).toBeGreaterThan(1_000_000)
  })

  it('throws on a non-1C file and sniffs the marker', () => {
    expect(() => parseOneCExchange('***** ^Type=4^')).toThrow(/1CClientBankExchange/)
    expect(isOneCExchange(ONE_C)).toBe(true)
    expect(isOneCExchange('***** ^Type=4^')).toBe(false)
  })
})

describe('currencyFromAccount', () => {
  it('reads the RU 20-digit currency code, BY account → BYN, else undefined', () => {
    expect(currencyFromAccount('40702810900000000001')).toBe('RUB') // 810
    expect(currencyFromAccount('40702840900000000001')).toBe('USD') // 840
    expect(currencyFromAccount('BY79ALFA30130000000000000000')).toBe('BYN')
    expect(currencyFromAccount('LT121000011101001000')).toBeUndefined()
  })

  it('a 20-digit account with an unknown currency code → undefined', () => {
    expect(currencyFromAccount('40702999900000000001')).toBeUndefined() // 999 not mapped
  })
})

describe('normalizeOneC', () => {
  const items = normalizeOneC(parseOneCExchange(ONE_C), { account: '' })

  it('infers direction from our-account payer/payee and picks the RUB currency', () => {
    expect(items).toHaveLength(2)
    expect(items[0]!.direction).toBe('debit') // we are the payer
    expect(items[1]!.direction).toBe('credit') // we are the payee
    expect(items.every(i => i.currency === 'RUB')).toBe(true)
  })

  it('debit: counterparty is the payee, with bank name + BIC + ИНН', () => {
    const op = items[0]!
    expect(op.amount).toBe(1500.5)
    expect(op.counterparty.name).toBe('ООО Ромашка')
    expect(op.counterparty.unp).toBe('7712345678')
    expect(op.counterparty.account).toBe('40702810900000000999')
    expect(op.counterparty.bank).toBe('Банк Икс')
    expect(op.counterparty.bic).toBe('044525225')
    expect(op.docId).toBe('4|25.01.2018') // "account+type+date+number" identity
    expect(op.docNum).toBe('4')
    expect(op.acceptDate).toBe('2018-01-25')
  })

  it('credit: counterparty is the payer', () => {
    const op = items[1]!
    expect(op.counterparty.name).toBe('ООО Клиент')
    expect(op.counterparty.unp).toBe('7787654321')
    expect(op.amount).toBe(2000)
  })

  it('direction flips when our account names the payee of doc 0', () => {
    const doc0 = parseOneCExchange(ONE_C).documents[0]!
    const asPayee = normalizeOneCDocument(doc0, '40702810900000000999', 'RUB')
    expect(asPayee.direction).toBe('credit') // now WE are the payee on doc 0
  })

  it('falls back to ДатаСписано/ДатаПоступило when our account matches neither side', () => {
    const other = 'OTHER-ACCOUNT'
    // Only ДатаСписано present → расход; only ДатаПоступило → приход.
    expect(normalizeOneCDocument({ Номер: '1', Дата: '01.01.2018', ДатаСписано: '01.01.2018' }, other, 'RUB').direction).toBe('debit')
    expect(normalizeOneCDocument({ Номер: '1', Дата: '01.01.2018', ДатаПоступило: '01.01.2018' }, other, 'RUB').direction).toBe('credit')
    // Both present → списание wins; no signal at all → default расход.
    expect(normalizeOneCDocument({ Номер: '1', Дата: '01.01.2018', ДатаСписано: '01.01.2018', ДатаПоступило: '01.01.2018' }, other, 'RUB').direction).toBe('debit')
    expect(normalizeOneCDocument({ Номер: '1', Дата: '01.01.2018' }, other, 'RUB').direction).toBe('debit')
  })

  it('a document with no Номер/Дата yields an empty docId, not "|"', () => {
    expect(normalizeOneCDocument({ Сумма: '1.00' }, 'A', 'RUB').docId).toBe('')
  })

  it('an empty 1C file (no documents) normalizes to []', () => {
    const empty = '1CClientBankExchange\r\nВерсияФормата=1.02\r\nСекцияРасчСчет\r\nРасчСчет=40702810900000000001\r\nКонецРасчСчет\r\nКонецФайла'
    expect(normalizeOneC(parseOneCExchange(empty), { account: '' })).toEqual([])
  })
})

describe('normalizeManualStatement — format dispatch', () => {
  it('routes a 1C file to the 1C normalizer', () => {
    const items = normalizeManualStatement(ONE_C, { account: '' })
    expect(detectManualFormat(ONE_C)).toBe('1c-exchange')
    expect(items).toHaveLength(2)
  })

  it('routes a client-bank text file to the client-bank normalizer', () => {
    const cb = '***** ^Type=4^ ^Acc=BY79ALFA30130000000000000000^  -  T\n[OUT_PARAM]\n^DocDate=29.03.2018^\n^Num=1^\n^Db=10.00^\n^Credit=0.00^'
    expect(detectManualFormat(cb)).toBe('client-bank-text')
    expect(normalizeManualStatement(cb, { account: '' })[0]!.direction).toBe('debit')
  })

  it('throws on an unknown format', () => {
    expect(detectManualFormat('random text')).toBe('unknown')
    expect(() => normalizeManualStatement('random text', { account: '' })).toThrow(/Неизвестный формат/)
  })
})

// End-to-end against the anonymized CP1251 fixture (the real upload path: decode
// windows-1251 → detect → normalize), mirroring the client-bank fixture tests.
describe('1C exchange — CP1251 fixture', () => {
  const text = new TextDecoder('windows-1251').decode(
    readFileSync(fileURLToPath(new URL('./fixtures/1c-exchange/demo-1c.txt', import.meta.url)))
  )

  it('decodes, detects and normalizes the RUB statement (1 debit + 1 credit)', () => {
    expect(detectManualFormat(text)).toBe('1c-exchange')
    const items = normalizeManualStatement(text, { account: '' })
    expect(items).toHaveLength(2)
    expect(items[0]!.direction).toBe('debit')
    expect(items[0]!.currency).toBe('RUB')
    expect(items[0]!.amount).toBe(15000)
    expect(items[0]!.counterparty.name).toBe('ООО Ромашка')
    expect(items[0]!.docId).toBe('4|25.01.2018')
    expect(items[1]!.direction).toBe('credit')
    expect(items[1]!.counterparty.name).toBe('ООО Клиент')
  })
})
