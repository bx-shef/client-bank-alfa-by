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

/** Connect-state lifetime in ms — the OAuth round-trip window (generous: a human has to log into
 *  their internet bank and approve a consent). */
export const CONNECT_STATE_TTL_MS = 600_000

/** The same window in whole minutes, for user-facing copy. */
export const CONNECT_STATE_TTL_MIN = Math.round(CONNECT_STATE_TTL_MS / 60_000)
