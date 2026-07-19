// UI labels + option lists for the «карта сопоставления» recognition editor (#109,
// PROCESSING.md §4). Pure data — no DOM — so the exhaustiveness is unit-tested and the
// component just renders these. Everything is portal-configured; no hard-coded numbers.

import type { Alphabet, IdentifierKind, MatchMatrix } from '~/utils/purposeMatch'

/**
 * RU label per recognized identifier kind — WHICH CRM entity a matched number points to.
 * A `Record<IdentifierKind, string>` forces a label for EVERY kind (compile-time exhaustive:
 * a new `IdentifierKind` won't build until it's labeled here — mirrors the settings
 * `IDENTIFIER_KIND_TABLE` guard). Shown as the «вид» dropdown in the matrix editor.
 */
export const IDENTIFIER_KIND_LABELS: Record<IdentifierKind, string> = {
  'invoice-number': 'Смарт-счёт — по номеру',
  'invoice-id': 'Смарт-счёт — по ID',
  'deal-id': 'Сделка — по ID',
  'deal-field': 'Сделка — по настроенному полю',
  'order-id': 'Заказ — по ID (→ оплата сделки)',
  'order-number': 'Заказ — по номеру (→ оплата сделки)',
  'payment-id': 'Оплата сделки — по ID',
  'payment-number': 'Оплата сделки — по номеру',
  'smart-id': 'Смарт-процесс — по ID',
  'smart-field': 'Смарт-процесс — по настроенному полю',
  'document-number': 'Документ (мост → привязанная сущность)'
}

/** `{label, value}` items for a `B24Select` of identifier kinds (declaration order).
 *  Mutable array (not `readonly`) — b24ui's `B24Select :items` expects a mutable `SelectItem[]`. */
export const IDENTIFIER_KIND_ITEMS: Array<{ label: string, value: IdentifierKind }>
  = (Object.keys(IDENTIFIER_KIND_LABELS) as IdentifierKind[]).map(k => ({ label: IDENTIFIER_KIND_LABELS[k], value: k }))

/** Alphabet the recognizer folds homoglyphs to before matching (`ВОРС`↔`BOPC`, §4). Mutable
 *  for the same `B24Select :items` reason. */
export const ALPHABET_ITEMS: Array<{ label: string, value: Alphabet }> = [
  { label: 'Кириллица (ВОРС)', value: 'cyrillic' },
  { label: 'Латиница (BOPC)', value: 'latin' }
]

/** The configurable field-map rows (`RecognitionSettings.configFields`) the editor exposes —
 *  key matches the `intentResolver` config keys (`smart-entity`/`deal-field`/`smart-field`). */
export const CONFIG_FIELD_ROWS: ReadonlyArray<{ key: string, label: string, hint: string }> = [
  { key: 'smart-entity', label: 'entityTypeId смарт-процесса', hint: 'Числовой тип объекта смарт-процесса (напр. 1044) — нужен для видов «Смарт-процесс».' },
  { key: 'deal-field', label: 'Поле сделки', hint: 'Имя пользовательского поля сделки (UF_CRM_…) для вида «Сделка — по настроенному полю».' },
  { key: 'smart-field', label: 'Поле смарт-процесса', hint: 'Имя поля смарт-процесса (UF_CRM_…) для вида «Смарт-процесс — по настроенному полю».' }
]

/** A fresh blank matrix row for the editor — default «вид» is the most common (invoice number). */
export function blankMatrix(): MatchMatrix {
  return { mask: '', kind: 'invoice-number' }
}
