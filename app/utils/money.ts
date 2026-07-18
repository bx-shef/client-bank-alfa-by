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
