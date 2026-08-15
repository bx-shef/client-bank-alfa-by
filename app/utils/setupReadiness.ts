// «Что настроено, а что нет» — pure SETUP-readiness model (#409 + #405).
//
// NB: distinct from `server/utils/readiness.ts`, which probes INFRASTRUCTURE health (Postgres/Redis
// for `/api/ready`). This one is about a portal's configuration, hence the `setup` prefix.
//
// Why: the app had no single place answering «почему ничего не приходит?». Bank connection lived in
// one card, the chat in another, smart processes in a third, and the poll schedule NOWHERE — a
// portal could sit half-configured forever with every screen looking normal. This turns the scattered
// state into one ordered checklist plus the poll schedule, so the gap is visible at a glance.
//
// Pure: takes an already-loaded snapshot and returns what to render. No I/O, no clock reading beyond
// the `nowMs` handed in — so it is fully testable and the same model serves the server response and
// the UI.

import { paymentSpEtid, distributionSpEtid } from '~/config/distributionSp'
import type { PortalSettings } from '~/utils/settings'

/** One checklist line. `ok` drives the icon; `hint` is what to DO when it isn't ok. */
export interface ReadinessItem {
  key: 'my-company' | 'bank' | 'chat' | 'error-chat' | 'recognition' | 'smart-process' | 'poll'
  title: string
  ok: boolean
  /** Short state description («2 счёта», «не выбран»). */
  detail: string
  /** Action to take when not ok. Empty when everything is fine. */
  hint: string
}

/** Everything the checklist needs, gathered by the caller. */
export interface ReadinessSnapshot {
  settings: PortalSettings
  /** How many bank accounts the portal has connected (online import). */
  connectedAccounts: number
  /** Подключения, у которых счёт так и не выбран (#407). Ноль по умолчанию. */
  pendingAccounts?: number
  /**
   * Подключения, которые приложение уже считает нерабочими — `expired`/`no-refresh` (#504).
   *
   * ⚠ Отдельно от `connectedAccounts` намеренно: строка в БД есть, а импорта нет. Зелёная галочка
   * по факту наличия строки — та же ложь, что и на ожидающем подключении, только дороже: там
   * настройка не закончена, здесь она была закончена и сломалась.
   */
  unhealthyAccounts?: number
  /** Server-side poll gate (`CRON_REAL_POLL`) — OFF means no automatic polling at all. */
  pollEnabled: boolean
  /** Poll period in minutes (`CRON_INTERVAL_MIN`). */
  pollIntervalMin: number
  /** Epoch ms of the last finished import run, or null if it never ran. */
  lastRunMs: number | null
  /** Есть ли в CRM компания «моя» с расчётным счётом (#493). `undefined` — не спрашивали
   *  (старый сервер / проверка не прошла), и тогда строка не показывается вовсе: пустая
   *  галочка честнее выдуманной. */
  myCompany?: 'ok' | 'no-company' | 'no-account'
}

/** Plural «счёт/счёта/счетов» — the checklist reads as a sentence, not as «2 счет». */
function accountsWord(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'счёт'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'счёта'
  return 'счетов'
}

/** Склонение «шаблон/шаблона/шаблонов» — строка читается фразой, а не «2 шаблон». */
function matrixWord(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'шаблон'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'шаблона'
  return 'шаблонов'
}

/**
 * Build the readiness checklist. Order is the order an admin must act in: connect a bank (or accept
 * manual upload), pick a chat, provision smart processes, then confirm polling is on. Manual upload
 * never depends on any of this, which the bank hint says out loud.
 */
export function buildReadiness(snap: ReadinessSnapshot): ReadinessItem[] {
  const cfg = snap.settings.recognition?.configFields
  const spReady = paymentSpEtid(cfg) !== null && distributionSpEtid(cfg) !== null

  const chatId = snap.settings.chat?.dialogId ?? ''
  const errorChatId = snap.settings.errorChat?.dialogId ?? ''
  const matrixCount = snap.settings.recognition?.matrices?.length ?? 0

  const pending = snap.pendingAccounts ?? 0
  // ⚠ Дефолт 0, а не «считать сломанным»: старый сервер поля не пришлёт, и красная строка на
  // исправном портале была бы хуже отсутствия проверки.
  const unhealthy = snap.unhealthyAccounts ?? 0

  return [
    // «Моя компания» идёт ПЕРВОЙ, раньше банка, и это порядок действий, а не важности: без неё
    // подключение банка проходит целиком — с паролем от интернет-банка и согласием на доступ к
    // деньгам — и не может создать ни одной записи. На боевом портале это дало «117 обработано,
    // 117 не опознано, 0 создано» при полностью исправном транспорте (#493).
    ...(snap.myCompany
      ? [{
          key: 'my-company' as const,
          title: 'Моя компания в CRM',
          ok: snap.myCompany === 'ok',
          detail: snap.myCompany === 'ok'
            ? 'есть, с расчётным счётом'
            : (snap.myCompany === 'no-company' ? 'не отмечена' : 'без расчётного счёта'),
          hint: snap.myCompany === 'ok'
            ? ''
            : (snap.myCompany === 'no-company'
                ? 'Откройте карточку своей компании в CRM, включите признак «Моя компания» и добавьте в реквизиты расчётный счёт. Без этого платежам не на что приземлиться.'
                : 'Добавьте расчётный счёт в реквизиты своей компании — ровно в том виде, в каком он приходит из банка. Приложение ищет компанию именно по номеру, и лишний пробел делает счёт другим.')
        }]
      : []),
    {
      key: 'bank',
      title: 'Банк подключён',
      // Незавершённое подключение (счёт не выбран) НЕ считается подключённым — с него ничего не
      // забрать. Но и молчать о нём нельзя: админ авторизовался, закрыл вкладку, и такое
      // подключение не всплывало бы нигде, кроме списка внутри карточки банка.
      ok: snap.connectedAccounts > 0 && pending === 0 && unhealthy === 0,
      detail: snap.connectedAccounts > 0
        ? `${snap.connectedAccounts} ${accountsWord(snap.connectedAccounts)}${unhealthy > 0 ? `, из них ${unhealthy} не работает` : ''}${pending > 0 ? `, ещё ${pending} без счёта` : ''}`
        : (pending > 0 ? `${pending} без выбранного счёта` : 'нет подключений'),
      // Нерабочее подключение важнее незавершённого: там настройку не доделали, здесь она была
      // доделана и сломалась — импорт по этому счёту уже стоит.
      hint: unhealthy > 0
        ? 'Подключение больше не продлевается — банк не примет наш токен. Владельцу счёта нужно заново войти в интернет-банк: раздел «Подключение банка», подключить счёт ещё раз.'
        : (pending > 0
            ? 'Есть подключение без выбранного счёта — укажите номер в разделе «Подключение банка», иначе выписка по нему не забирается.'
            : (snap.connectedAccounts > 0
                ? ''
                : 'Подключите счёт в разделе «Подключение банка». Без него работает только ручная загрузка файла выписки.'))
    },
    {
      key: 'chat',
      title: 'Чат для уведомлений выбран',
      ok: chatId !== '',
      detail: chatId !== '' ? (snap.settings.chat?.title || 'выбран') : 'не выбран',
      hint: chatId !== '' ? '' : 'Выберите чат в разделе «Уведомления в чат» — туда приложение пишет о новых операциях.'
    },
    {
      // Чат ошибок — отдельная строка, а не деталь чата уведомлений: именно в него уходит всё, что
      // приложение НЕ смогло разложить само (не опознан плательщик, цель не найдена, неоднозначное
      // разнесение). Не выбран — эти сообщения не пишутся никуда, и портал молча теряет ровно те
      // случаи, которые требуют человека.
      key: 'error-chat',
      title: 'Чат для ошибок выбран',
      ok: errorChatId !== '',
      detail: errorChatId !== '' ? (snap.settings.errorChat?.title || 'выбран') : 'не выбран',
      hint: errorChatId !== ''
        ? ''
        : 'Выберите чат ошибок в разделе «Уведомления в чат». Без него сообщения о неопознанных платежах и неудачном разнесении не приходят никуда.'
    },
    {
      // Без матриц распознавания приложение не видит в назначении платежа НИ ОДНОГО номера, то есть
      // разнесение по счетам/заказам не работает вовсе — дела пишутся, но ни к чему не привязываются.
      key: 'recognition',
      title: 'Карта распознавания заполнена',
      ok: matrixCount > 0,
      detail: matrixCount > 0 ? `${matrixCount} ${matrixWord(matrixCount)}` : 'нет шаблонов',
      hint: matrixCount > 0
        ? ''
        : 'Добавьте шаблоны номеров в разделе «Карта распознавания» — по ним приложение находит в назначении платежа номер счёта или заказа. Есть кнопка «Добавить типовые».'
    },
    {
      key: 'smart-process',
      title: 'Смарт-процессы распределения настроены',
      ok: spReady,
      detail: spReady ? 'созданы' : 'не созданы',
      hint: spReady ? '' : 'Нажмите «Настроить смарт-процессы». Без них приложение не сможет вести учёт распределения оплат.'
    },
    {
      key: 'poll',
      title: 'Автоматический опрос банка включён',
      ok: snap.pollEnabled,
      detail: snap.pollEnabled ? `каждые ${snap.pollIntervalMin} мин` : 'выключен',
      // The gate is server-side, so a portal admin genuinely cannot fix this themselves — say so
      // instead of showing an action they can't perform.
      hint: snap.pollEnabled ? '' : 'Опрос выключен на сервере приложения. Обратитесь к владельцу приложения — из портала это не включается.'
    }
  ]
}

/** True when every checklist line is ok — the app is fully set up. */
export function isFullyReady(items: readonly ReadinessItem[]): boolean {
  return items.every(i => i.ok)
}

// There is deliberately NO «next poll at» here. The obvious formula (last run + interval) is wrong
// twice over: the cron is a bare setInterval anchored at PROCESS BOOT, so it has no relationship to
// when a batch last reached crm-sync; and `lastRunMs` is stamped only when a run actually produced
// operations, so a faithfully-polling quiet portal looks hours stale. Showing the period and being
// honest that the exact moment is unknown beats a confidently wrong prediction.
