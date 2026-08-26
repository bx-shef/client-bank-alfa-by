// Server-side facts for the setup-readiness checklist (#409/#405). Pure over injected I/O (DI).
//
// Split of responsibilities: the CLIENT already holds portal settings (chat, smart-process ids) via
// useChatSettings, so re-sending them here would just create a second source of truth that can
// disagree. This endpoint returns ONLY what the browser cannot know — how many bank accounts are
// connected, whether the server-side poll gate is on, its period, and when the last run finished.
// `app/utils/setupReadiness.ts` then composes both halves into the checklist.
//
// Auth mirrors the other bank routes (portal installed → frame token proven for THAT domain →
// admin): the answer describes the portal's configuration posture, which is admin business.

import { parseMisconfigReason } from '../../app/utils/setupReadiness'

export interface SetupStatusResult {
  status: number
  body: Record<string, unknown>
}

export interface SetupStatusDeps {
  memberIdByDomain: (domain: string) => Promise<string | null>
  validateFrame: (domain: string, accessToken: string) => Promise<{ userId: string, isAdmin: boolean }>
  /** Счета портала: подключённые (с выбранным номером) и ожидающие выбора (#407). */
  countAccounts: (memberId: string) => Promise<{ connected: number, pending: number, unhealthy?: number, paused?: number }>
  /** Server gate `CRON_REAL_POLL` — automatic polling runs at all. */
  pollEnabled: boolean
  /** Cron period in minutes (`CRON_INTERVAL_MIN`). */
  pollIntervalMin: number
  /** Epoch ms the last import run finished, or null if it never ran. */
  lastRunMs: (memberId: string) => Promise<number | null>
  /** Есть ли компания «моя» с расчётным счётом (#493). Отсутствует ⇒ строку не показываем.
   *  ⚠ Отказ REST здесь НЕ роняет весь ответ: экран готовности — самое место, где «половина
   *  сведений» полезнее пустого экрана, а строка без данных просто не рисуется. */
  myCompany?: (domain: string, accessToken: string) => Promise<'ok' | 'no-company' | 'no-account'>
  /** Persistent-признак «последний прогон упёрся в неверную карту распознавания» (#595) — сырая
   *  причина `what|param|detail`, или null если чисто. Разбирается ЗДЕСЬ в слот; английский
   *  `detail` клиенту не уходит. Отсутствует ⇒ строка карты зависит только от числа шаблонов. */
  recognitionMisconfig?: (memberId: string) => Promise<string | null>
  /** Имена полей, которые смарт-процесс «Платежи» реально несёт (#46) — `crm.item.fields`.
   *  `null`/отказ ⇒ ключ в ответе не появится, и строка смарт-процессов ведёт себя как раньше:
   *  «не спросили» не имеет права красить её красным. */
  spFieldNames?: (memberId: string) => Promise<string[] | null>
}

export async function handleSetupStatus(
  deps: SetupStatusDeps,
  input: { accessToken: string, domain: string, wantFields?: boolean }
): Promise<SetupStatusResult> {
  const accessToken = (input.accessToken || '').trim()
  const domain = (input.domain || '').trim()
  if (!accessToken || !domain) {
    return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }
  }

  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { status: 409, body: { error: 'portal not installed (no key)' } }

  let frame: { userId: string, isAdmin: boolean }
  try {
    frame = await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 403, body: { error: 'invalid frame token for this portal' } }
  }
  if (!frame.isAdmin) return { status: 403, body: { error: 'setup status is administrator-only' } }

  const [counts, lastRunMs, myCompany, misconfigReason, spFieldNames] = await Promise.all([
    deps.countAccounts(memberId),
    deps.lastRunMs(memberId),
    deps.myCompany?.(domain, accessToken).catch(() => undefined),
    deps.recognitionMisconfig?.(memberId).catch(() => null),
    // ⚠ Отказ проглатывается так же, как у «моей компании»: экран готовности полезнее с половиной
    // сведений, чем пустой, а недостающая строка просто ведёт себя по-старому.
    // ⚠ Спрашиваем ТОЛЬКО когда попросили (`wantFields`): проверка стоит двух REST в портал, а
    // нужна одному экрану — карточке готовности. `/app` зовёт тот же маршрут на каждом открытии и
    // строки смарт-процессов не показывает вовсе; платить за неё он не должен.
    input.wantFields ? deps.spFieldNames?.(memberId).catch(() => null) : null
  ])
  const misconfigSlot = parseMisconfigReason(misconfigReason ?? null)

  return {
    status: 200,
    body: {
      connectedAccounts: counts.connected,
      // Подключения без выбранного счёта видны только в списке внутри карточки банка, поэтому
      // забытое (авторизовался и закрыл вкладку) не всплывало нигде. Отдаём счётчик, чтобы экран
      // готовности о нём напомнил — иначе это тихая дыра.
      pendingAccounts: counts.pending,
      unhealthyAccounts: counts.unhealthy ?? 0,
      // Приостановленные подключения (#576). ⚠ Считаются ОТДЕЛЬНО от «не работает»: это выбор
      // администратора, а не поломка. Но и молчать нельзя — при всех счетах на паузе строка
      // «Автоопрос: каждые N мин» была бы просто ложью, и человек искал бы причину тишины в банке.
      pausedAccounts: counts.paused ?? 0,
      pollEnabled: deps.pollEnabled,
      pollIntervalMin: deps.pollIntervalMin,
      lastRunMs,
      // Ключ появляется только когда мы действительно спросили и получили ответ: пустая галочка
      // на экране готовности честнее выдуманной, а выдуманная тут особенно дорога — именно этот
      // экран человек открывает, чтобы понять, почему ничего не работает.
      ...(myCompany ? { myCompany } : {}),
      // Слот сломанной настройки карты распознавания (#595). Английский `detail` портала СЮДА не
      // едет — он остаётся в логе, клиенту показываем только «какое поле чинить».
      ...(misconfigSlot ? { recognitionMisconfig: misconfigSlot } : {}),
      // Фактические поля СП «Платежи» (#46). Ключ появляется ТОЛЬКО когда портал действительно
      // ответил: иначе клиент не должен отличать «полей нет» от «мы не спросили».
      ...(spFieldNames ? { spFieldNames } : {})
    }
  }
}
