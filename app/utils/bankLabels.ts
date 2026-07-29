// Human labels for bank providers — one source for every UI that names a bank (the connect picker
// and the connected-accounts list, #404), so the two can't drift into calling the same provider
// differently. Pure data; `manual` is here because a stored row could in principle carry it and the
// list must never render a raw id at the user.

import type { BankProviderId } from '~/types/statement'

export const BANK_LABELS: Record<BankProviderId, string> = {
  'alfa-by': 'Альфа-Банк',
  'prior-by': 'Приорбанк',
  'manual': 'Ручная загрузка'
}
