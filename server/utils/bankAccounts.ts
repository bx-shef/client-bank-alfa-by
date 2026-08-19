// Connected bank accounts for the settings UI — list + disconnect (#404). Pure logic over
// injected I/O (DI), unit-testable without DB/B24; the thin routes
// (server/api/bank/accounts.get.ts, server/api/bank/disconnect.post.ts) wire live transports.
//
// Why this exists: after a successful connect the UI showed NOTHING — no bank, no account, no
// way to remove a wrong one. The data was already in `bank_tokens`; it just had no read path.
//
// Auth mirrors /api/bank/connect exactly, because this is the same capability seen from the other
// side: listing reveals which accounts a portal has bound, and disconnecting stops its imports.
//   1. portal key check (do we hold tokens for this domain at all)
//   2. frame-token validation against THAT domain — blocks X-B24-Domain spoofing
//   3. ADMIN gate — bank credentials are portal-wide, so only an admin sees or removes them
// Secrets NEVER leave: the list carries identity + freshness only (no access/refresh token).

import { BANK_LABELS } from '../../app/utils/bankLabels'
import { isPendingAccountKey } from '../../app/utils/bankAccountKey'
import type { BankAccountInfo } from './bankTokenStore'
import type { BankProviderId } from '../../app/types/statement'

export interface BankAccountsResult {
  status: number
  body: Record<string, unknown>
}

export interface BankAccountsDeps {
  /** member_id of the portal we hold tokens for, by domain; null if not installed. */
  memberIdByDomain: (domain: string) => Promise<string | null>
  /** Validate the frame token against `domain` (`profile`), returning the admin flag, or THROWING
   *  if the token isn't valid for that portal (blocks domain spoofing). */
  validateFrame: (domain: string, accessToken: string) => Promise<{ userId: string, isAdmin: boolean }>
}

export interface ListAccountsDeps extends BankAccountsDeps {
  list: (memberId: string) => Promise<BankAccountInfo[]>
}

export interface DisconnectDeps extends BankAccountsDeps {
  remove: (memberId: string, id: number, expectedAccountKey: string) => Promise<'removed' | 'gone' | 'stale'>
}

/**
 * Исход переименования. `busy` — не ошибка, а «строку сейчас держит обновление токена, повторите»
 * (#509): выбор счёта и обновление пишут в одну строку и сериализованы одним локом, а ждать его
 * можно меньше, чем длится сетевой POST к банку.
 */
export type RenameOutcome = 'renamed' | 'not-found' | 'conflict' | 'busy'

export interface SetAccountDeps extends BankAccountsDeps {
  rename: (memberId: string, provider: BankProviderId, fromKey: string, toKey: string) => Promise<RenameOutcome>
}

export interface BankAccountsInput {
  accessToken: string
  domain: string
}

export interface DisconnectInput extends BankAccountsInput {
  provider: string
  accountKey: string
  /** Неизменяемый адрес строки (#517). `accountKey` едет рядом как ОЖИДАНИЕ вызывающего: он
   *  описывает, что было на экране, и расхождение означает «список устарел». */
  id: number
}

export interface SetAccountInput extends BankAccountsInput {
  provider: string
  /** Временный ключ подключения, которому назначаем счёт. */
  pendingKey: string
  /** Настоящий номер счёта. */
  accountKey: string
}

/** Тот же формат, что и на старте подключения (`isValidAccountKey`) — буквы и цифры. */
const ACCOUNT_KEY_RE = /^[A-Za-z0-9]{1,64}$/

/** Providers a client may name. Anything else is rejected before it reaches SQL — the value is
 *  caller-controlled and is used as a lookup key, so it gets an allowlist, not a cast. Derived from
 *  `BANK_LABELS` (a `Record<BankProviderId, string>`) rather than hand-listed: a hand-listed copy
 *  would silently go stale when a provider is added, and its stored rows would become undeletable
 *  from the UI (400 «unknown provider») with nothing failing at compile time. */
const KNOWN_PROVIDERS: readonly string[] = Object.keys(BANK_LABELS)

function isKnownProvider(v: string): v is BankProviderId {
  return KNOWN_PROVIDERS.includes(v)
}

/** Shared gate: portal installed + frame token proven for that portal + caller is an admin.
 *  Returns the resolved memberId, or the error result to hand straight back. */
async function authorize(deps: BankAccountsDeps, input: BankAccountsInput): Promise<{ memberId: string } | { error: BankAccountsResult }> {
  const { accessToken, domain } = input
  if (!accessToken || !domain) {
    return { error: { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } } }
  }
  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { error: { status: 409, body: { error: 'portal not installed (no key)' } } }

  let frame: { userId: string, isAdmin: boolean }
  try {
    frame = await deps.validateFrame(domain, accessToken)
  } catch {
    return { error: { status: 403, body: { error: 'invalid frame token for this portal' } } }
  }
  if (!frame.isAdmin) {
    return { error: { status: 403, body: { error: 'bank connections are administrator-only' } } }
  }
  return { memberId }
}

/** List the caller portal's connected bank accounts (identity + freshness, no secrets). */
export async function handleListBankAccounts(deps: ListAccountsDeps, input: BankAccountsInput): Promise<BankAccountsResult> {
  const auth = await authorize(deps, input)
  if ('error' in auth) return auth.error

  const accounts = await deps.list(auth.memberId)
  // `memberId` is stripped: the client already knows its own portal, and echoing the internal id
  // into a browser response serves nothing.
  return {
    status: 200,
    body: {
      accounts: accounts.map(a => ({
        // Неизменяемый адрес строки (#517) — им браузер адресует «Отключить». Внутренним
        // идентификатором портала он не является: это порядковый номер строки в НАШЕЙ таблице,
        // осмысленный только вместе с уже доказанным `member_id`, поэтому отдавать его безопасно.
        id: a.id,
        provider: a.provider,
        accountKey: a.accountKey,
        connectedAt: a.connectedAt,
        expiresAt: a.expiresAt,
        hasRefresh: a.hasRefresh,
        // Срок согласия банка (#503). 0 — банк его не выдаёт (Альфа) либо подключение сделано до
        // этой правки; интерфейс тогда о согласии молчит, а не рисует прочерк.
        consentExpiresAt: a.consentExpiresAt
      }))
    }
  }
}

/**
 * Назначить счёт подключению, сделанному без него (#407): порядок «сначала банк, потом счёт»
 * оставляет строку под временным ключом, и этот вызов заменяет его на настоящий номер.
 * Переименовывать разрешено ТОЛЬКО временный ключ — иначе это была бы возможность подменить счёт
 * у живого подключения, то есть перенаправить чужие операции на другой номер.
 */
export async function handleSetBankAccount(deps: SetAccountDeps, input: SetAccountInput): Promise<BankAccountsResult> {
  const auth = await authorize(deps, input)
  if ('error' in auth) return auth.error

  const provider = input.provider?.trim() ?? ''
  const pendingKey = input.pendingKey?.trim() ?? ''
  const accountKey = input.accountKey?.trim() ?? ''
  if (!provider || !pendingKey || !accountKey) {
    return { status: 400, body: { error: 'provider, pendingKey and accountKey are required' } }
  }
  if (!isKnownProvider(provider)) return { status: 400, body: { error: 'unknown provider' } }
  if (!isPendingAccountKey(pendingKey)) {
    return { status: 400, body: { error: 'only a pending connection can be assigned an account' } }
  }
  if (!ACCOUNT_KEY_RE.test(accountKey)) {
    return { status: 400, body: { error: 'a valid account number is required' } }
  }

  const res = await deps.rename(auth.memberId, provider, pendingKey, accountKey)
  if (res === 'conflict') return { status: 409, body: { error: 'this account is already connected' } }
  if (res === 'not-found') return { status: 404, body: { error: 'pending connection not found' } }
  // ⚠ 503, а не 409: конфликт — это «так не будет никогда» (номер занят), а здесь «сейчас занято,
  // через несколько секунд пройдёт». Смешать их значит показать человеку тупик там, где нужен
  // повтор, — и наоборот, приучить повторять там, где повтор не поможет.
  if (res === 'busy') {
    return { status: 503, body: { error: 'connection is being refreshed right now, retry in a few seconds' } }
  }
  return { status: 200, body: { ok: true } }
}

/** Disconnect one account of the caller's portal. Idempotent — removing an already-gone account
 *  answers 200 `{removed:false}` rather than 404, so a double-click isn't an error. */
export async function handleDisconnectBankAccount(deps: DisconnectDeps, input: DisconnectInput): Promise<BankAccountsResult> {
  const auth = await authorize(deps, input)
  if ('error' in auth) return auth.error

  const provider = input.provider?.trim() ?? ''
  const accountKey = input.accountKey?.trim() ?? ''
  if (!provider || !accountKey) {
    return { status: 400, body: { error: 'provider and accountKey are required' } }
  }
  if (!isKnownProvider(provider)) {
    return { status: 400, body: { error: 'unknown provider' } }
  }
  const id = Number(input.id)
  if (!Number.isInteger(id) || id <= 0) {
    return { status: 400, body: { error: 'a connection id is required' } }
  }

  // ⚠ Адресуем по `id`, а не по номеру счёта. Номер МЕНЯЕТСЯ (выбор счёта переименовывает
  // `~pending:`-ключ), поэтому удаление по адресу из отрисованного списка не находило строку и
  // отвечало `200 {removed:false}` — тем же, что и честное «уже отключено». Снаружи это выглядело
  // успехом, а приложение продолжало ходить в банк клиента вопреки явному запрету.
  const outcome = await deps.remove(auth.memberId, id, accountKey)
  // ⚠ 409, а не тихий успех и не 404: строка ЕСТЬ, просто она уже не та, что была на экране.
  // Единственный честный ответ — «список устарел», потому что удалять по такому клику значит
  // снести подключение, которое за это время стало рабочим.
  if (outcome === 'stale') {
    return { status: 409, body: { error: 'the connection changed since the list was loaded, reload it' } }
  }
  // ⚠ `gone` остаётся УСПЕХОМ с `removed:false` — это идемпотентность из #404: двойной клик и
  // повтор из другой вкладки не ошибка. Теперь она означает ровно «строки нет», а не «мы не туда
  // посмотрели».
  return { status: 200, body: { removed: outcome === 'removed' } }
}
