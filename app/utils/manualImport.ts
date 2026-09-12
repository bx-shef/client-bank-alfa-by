// Manual-upload entry point: sniff the statement file format and dispatch to the
// right parser + normalizer, producing the unified StatementItem[]. This is what
// the `manual` provider (UI file upload / backend) calls after decoding the file
// to a string — ⚠ КОДИРОВОК НЕСКОЛЬКО, и определяет её `decodeUploadText`
// (`importUpload.ts` → `statementEncoding.ts`) ДО разбора. Три формата (issue #19/#21/#700):
//   - `1CClientBankExchange` — the 1C accounting exchange format;
//   - `***** ^Type=` — the client-bank text export (Приорбанк / Альфа `Type=4`);
//   - `*0*…` — звёздочный построчный экспорт (Паритетбанк, #700). ⚠ Он В ДРУГОЙ КОДИРОВКЕ (CP866),
//     и различает их `detectStatementEncoding` ДО разбора — сюда текст приходит уже декодированным.
//
// The client-bank parser now caps its decoded input (`MAX_CLIENT_BANK_CHARS`,
// DoS guard #19); a real file-upload path (UI/backend) should ALSO cap the raw
// file size before decoding, rather than rely on this single line of defense.

import type { NormalizeContext, StatementItem } from '~/types/statement'
import { isOneCExchange, parseOneCExchange } from '~/utils/oneCExchange'
import { normalizeOneC } from '~/utils/oneCStatement'
import { parseClientBankText } from '~/utils/clientBankText'
import { normalizeClientBank } from '~/utils/clientBankStatement'
import { isParitetText, parseParitetText, normalizeParitetRows } from '~/utils/paritetStatement'

/** Supported manual-upload formats. */
export type ManualFormat = '1c-exchange' | 'client-bank-text' | 'paritet-text' | 'unknown'

/** Разбор файла: операции плюс строки, которые операциями НЕ стали, с разбивкой по причине. */
export interface ManualParseResult {
  items: StatementItem[]
  /** Строки банка, которые не являются платежами (переоценка валютного остатка и т.п.). */
  nonPayment: number
  /** Строки, которые мы не смогли прочитать (неизвестное направление/валюта, нет даты). */
  unreadable: number
}

const CLIENT_BANK_MARKER = '***** ^Type='

/**
 * Detect the manual-upload format by its leading marker.
 *
 * ⚠ Порядок проверок значим: маркер client-bank (`***** ^Type=`) САМ начинается со звёздочек, и
 * проверка звёздочного формата, поставленная раньше, перехватила бы его. Звёздочный требует
 * ровно `*0*` — то есть цифру сразу за первой звёздочкой, — поэтому пересечения нет; но порядок
 * оставлен прежним и закреплён тестом, чтобы перестановка «для красоты» не сломала старый формат.
 */
export function detectManualFormat(text: string): ManualFormat {
  if (isOneCExchange(text)) return '1c-exchange'
  if (text.slice(0, 64).trimStart().startsWith(CLIENT_BANK_MARKER)) return 'client-bank-text'
  if (isParitetText(text)) return 'paritet-text'
  return 'unknown'
}

/**
 * Parse + normalize a manually-uploaded statement (already decoded to a string)
 * into StatementItem[]. Throws on an unrecognized format. `ctx.account` overrides
 * the file's own account; `ctx.currency` seeds currency detection.
 */
export function normalizeManualStatement(text: string, ctx: NormalizeContext): StatementItem[] {
  return parseManualStatement(text, ctx).items
}

/**
 * Разбор с РАЗБИВКОЙ отброшенных строк по причинам — их вызывающий обязан показать.
 *
 * ⚠ Файл, где часть строк не является платежами, иначе выглядит как потеря данных: выписка из 44
 * строк даёт «разобрано: 9», и человеку неоткуда узнать, что 35 из них — переоценка валютного
 * остатка, а не пропавшие платежи.
 * ⚠ Причин ДВЕ, и для человека это разные новости: `nonPayment` — норма (служебные записи банка),
 * `unreadable` — «мы не поняли строку», и об этом стоит сообщить нам. Одним числом их свести
 * значило бы спрятать вторую за первой.
 */
export function parseManualStatement(text: string, ctx: NormalizeContext): ManualParseResult {
  switch (detectManualFormat(text)) {
    case '1c-exchange':
      return { items: normalizeOneC(parseOneCExchange(text), ctx), nonPayment: 0, unreadable: 0 }
    case 'client-bank-text':
      return { items: normalizeClientBank(parseClientBankText(text), ctx), nonPayment: 0, unreadable: 0 }
    case 'paritet-text':
      return normalizeParitetRows(parseParitetText(text), ctx)
    default:
      throw new Error(
        'Неизвестный формат выписки (ожидается 1CClientBankExchange, client-bank «***** ^Type=» '
        + 'или звёздочный «*0*…»)'
      )
  }
}
