// How long a bank connect link stays usable. Lives in `app/utils` (browser-safe, no I/O) because
// BOTH sides need the same number and they sit on opposite sides of the client/server line:
//
//   - the server stamps it into the signed connect state (`bankConnectStart.ts`, `exp`);
//   - the UI tells the admin how long the link they are about to forward will work
//     (`BankConnectCard.vue`) — the account holder is often not the admin, so the link gets sent
//     over a messenger and the stated lifetime is the only thing they have to plan around.
//
// Keeping the UI copy as its own literal is how the two drift: tune the state window and the card
// keeps quoting the old figure, so the admin either re-presses «Подключить» (invalidating a link
// that was still good) or waits on one that has already expired. Neither failure says what it is.

/**
 * Connect-state lifetime in ms — the whole OAuth round-trip window.
 *
 * ⚠ This is a HUMAN's window, not a protocol one, so it is sized by what that human actually has to
 * do: open a link that reached them over a messenger, find credentials for an internet bank they may
 * not log into daily, get past its own second factor, and read a consent screen listing access to
 * their company's money. Ten minutes turned out to be too tight for exactly that — and the failure
 * is cruel: it fires at the END, after all the work, and reads as «ссылка недействительна», which
 * looks like the app is broken rather than like a stopwatch nobody mentioned ran out.
 *
 * The cost of a longer window is a signed state that stays replayable for longer. That is bounded:
 * the state carries no authority of its own — it only names the portal, the provider and a nonce,
 * and the bank's own `code` is single-use and short-lived independently of this.
 */
export const CONNECT_STATE_TTL_MS = 900_000

/** The same window in whole minutes, for user-facing copy. */
export const CONNECT_STATE_TTL_MIN = Math.round(CONNECT_STATE_TTL_MS / 60_000)
