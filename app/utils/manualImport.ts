// Manual-upload entry point: sniff the statement file format and dispatch to the
// right parser + normalizer, producing the unified StatementItem[]. This is what
// the `manual` provider (UI file upload / backend) calls after decoding the file
// to a string (files are CP1251; decode first). Two formats today (issue #19/#21):
//   - `1CClientBankExchange` — the 1C accounting exchange format;
//   - `***** ^Type=` — the client-bank text export (Приорбанк / Альфа `Type=4`).

import type { NormalizeContext, StatementItem } from '~/types/statement'
import { isOneCExchange, parseOneCExchange } from '~/utils/oneCExchange'
import { normalizeOneC } from '~/utils/oneCStatement'
import { parseClientBankText } from '~/utils/clientBankText'
import { normalizeClientBank } from '~/utils/clientBankStatement'

/** Supported manual-upload formats. */
export type ManualFormat = '1c-exchange' | 'client-bank-text' | 'unknown'

const CLIENT_BANK_MARKER = '***** ^Type='

/** Detect the manual-upload format by its leading marker. */
export function detectManualFormat(text: string): ManualFormat {
  if (isOneCExchange(text)) return '1c-exchange'
  if (text.slice(0, 64).trimStart().startsWith(CLIENT_BANK_MARKER)) return 'client-bank-text'
  return 'unknown'
}

/**
 * Parse + normalize a manually-uploaded statement (already decoded to a string)
 * into StatementItem[]. Throws on an unrecognized format. `ctx.account` overrides
 * the file's own account; `ctx.currency` seeds currency detection.
 */
export function normalizeManualStatement(text: string, ctx: NormalizeContext): StatementItem[] {
  switch (detectManualFormat(text)) {
    case '1c-exchange':
      return normalizeOneC(parseOneCExchange(text), ctx)
    case 'client-bank-text':
      return normalizeClientBank(parseClientBankText(text), ctx)
    default:
      throw new Error('Неизвестный формат выписки (ожидается 1CClientBankExchange или client-bank «***** ^Type=»)')
  }
}
