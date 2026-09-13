// Shared money helpers — one place for the "round once after summing, no IEEE-754 drift"
// rule so the display aggregators (demoExtract «суммы по валютам», importStats #62) don't
// each carry their own copy. Pure, no DOM.

/**
 * Round a money amount to 2 decimals (kopecks), avoiding float drift
 * (`0.1 + 0.2 → 0.3`, not `0.30000000000000004`). A non-finite input (NaN/Infinity — a bad
 * row) is coerced to `0` so it can't poison a total shown to the user.
 */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Сумма из банковской записи: `1054,89`, `1 800,00`, `10 000.00`.
 *
 * ⚠ Разделители У КАЖДОГО БАНКА СВОИ, и это ЗАМЕРЕНО на боевых выгрузках (#707): звёздочный
 * формат и CSV Приорбанка пишут копейки через ЗАПЯТУЮ, CSV Альфа-Банка — через ТОЧКУ, тысячи оба
 * отбивают пробелом. Поэтому правило одно на все форматы: пробелы убираем, запятую приводим к
 * точке, и лишь затем проверяем МАСКОЙ.
 *
 * ⚠ Маска обязательна — `parseFloat` здесь не годится: он читает `18,28abc` как 18, `1e3` как
 * 1000, а `--18` как `NaN` лишь случайно. Мусор обязан быть отличим от нуля, иначе нечитаемая
 * сумма превращается в операцию «0,00» либо в служебную запись банка.
 *
 * Возвращает `NaN` на всём, что не разобралось; что это значит — решает вызывающий.
 */
export function parseBankAmount(raw: string): number {
  const t = (raw ?? '').trim().replace(/\s/g, '').replace(/,/g, '.')
  if (!/^-?\d+(\.\d+)?$/.test(t)) return Number.NaN
  return Number(t)
}
