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

import { paymentSpEtid, distributionSpEtid, paymentSpTypeId, buildUfFieldNameCamel, PAYMENT_SP_FIELDS } from '~/config/distributionSp'
import type { PortalSettings } from '~/utils/settings'
import { pluralRu } from '~/utils/importStatus'

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
  /**
   * How many connections have their automatic poll PAUSED (#576).
   *
   * ⚠ Kept apart from both `connectedAccounts` and `unhealthyAccounts`: this is an admin's CHOICE,
   * not a fault, so it never paints the bank line red. Staying silent is not an option either —
   * with every account paused, «Автоопрос: каждые N мин» would simply be a lie, and the silence
   * would be hunted down at the bank.
   */
  pausedAccounts?: number
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
  /**
   * Последний прогон упёрся в неверную карту распознавания (#595) — портал отверг поле или
   * смарт-процесс, взятые из настроек. `undefined` — такого наблюдения нет (или старый сервер).
   *
   * ⚠ Признак ПЕРЕЖИВАЕТ закрытие вкладки: раньше это уходило разовым сообщением в чат и нигде не
   * оседало, поэтому открыв настройки назавтра, админ видел зелёный экран при сломанной карте. Здесь
   * `slot` — какой именно слот настройки не принят (`deal-field`/`smart-id`/`smart-field`), чтобы
   * подсказка назвала конкретное поле, а не «что-то в карте». Английский текст портала СЮДА не едет —
   * он бесполезен бухгалтеру и остаётся только в логе.
   */
  recognitionMisconfig?: { slot: string }
  /**
   * Имена полей, которые смарт-процесс «Платежи» РЕАЛЬНО несёт (#46) — как их отдаёт портал
   * (`crm.item.fields`, camelCase). `undefined` — не спрашивали или спросить не удалось.
   *
   * ⚠ Зачем отдельный факт, если id смарт-процесса уже сохранён. Потому что «СП создан» и «СП
   * годится для импорта» — РАЗНЫЕ вещи, и на боевом портале они разошлись: тип существовал, id
   * лежал в настройках, строка светила зелёным, а из тринадцати полей на нём было пять — только
   * денежные. Поля реестра (#575) добавились в код позже, а провижининг их не создал, и
   * `crm.item.add` молча игнорирует неизвестные UF-ключи. Импорт писал контрагента, назначение,
   * дату и направление В ПУСТОТУ: дела создавались, реестр наполнялся, но строки выходили немые,
   * а все операции читались приходом, потому что «Направление» пустое. Ни один экран об этом не
   * говорил — диагноз занял день на живом портале.
   *
   * ⚠ Читается `crm.item.fields`, а НЕ `userfieldconfig.list`: второму нужно право
   * `userfieldconfig`, которого у портала может не быть (оно требует переустановки приложения) —
   * то есть проверка молчала бы ровно там, где чаще всего и ломается.
   */
  spFieldNames?: string[]
}

/**
 * Каких полей реестра НЕ ХВАТАЕТ на смарт-процессе «Платежи» (#46) — человеческими подписями.
 *
 * Пустой массив = всё на месте ЛИБО проверить нечем (нет id смарт-процесса / портал не ответил).
 * ⚠ Незнание не красит строку: «мы не спросили» и «поля нет» — разные вещи, и выдавать первое за
 * второе на экране, который читают в поисках причины поломки, значит послать чинить исправное.
 */
export function missingPaymentSpFields(
  configFields: Record<string, string> | undefined,
  fieldNames: string[] | undefined
): string[] {
  const spTypeId = paymentSpTypeId(configFields)
  if (spTypeId === null || !fieldNames) return []
  // ⚠ Сравнение регистронезависимое: имя приходит от портала, и его форма уже однажды оказалась
  // не той, какой поле создавали (#41). Точное совпадение регистра тут ничего не защищает.
  const present = new Set(fieldNames.map(n => n.toLowerCase()))
  return Object.values(PAYMENT_SP_FIELDS)
    .filter(f => !present.has(buildUfFieldNameCamel(spTypeId, f.postfix).toLowerCase()))
    .map(f => f.label)
}

/**
 * Разобрать структурированную причину misconfig (`what|param|detail` из `intentResolver`) в слот
 * настройки. Пусто/битьё ⇒ `null`. ⚠ Английский `detail` НЕ возвращаем — он для лога, не для UI.
 */
export function parseMisconfigReason(reason: string | null | undefined): { slot: string } | null {
  if (typeof reason !== 'string') return null
  const slot = reason.split('|')[0]?.trim() ?? ''
  if (slot === '') return null
  return { slot }
}

/** Человеческая подсказка «что чинить» по слоту настройки (#595). Неизвестный слот ⇒ общий текст. */
function misconfigHint(slot: string): string {
  const base = 'Последний прогон не смог провести оплату: портал отверг настройку из «Карты распознавания». '
  if (slot === 'deal-field') {
    return base + 'Проверьте имя поля сделки в разделе «Карта распознавания» — такого поля в CRM нет.'
  }
  if (slot === 'smart-id') {
    return base + 'Проверьте выбранный смарт-процесс в разделе «Карта распознавания» — портал его не находит.'
  }
  if (slot === 'smart-field') {
    return base + 'Проверьте смарт-процесс и имя его поля в разделе «Карта распознавания» — портал их не принял.'
  }
  return base + 'Проверьте поля и смарт-процесс в разделе «Карта распознавания».'
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
  const paused = snap.pausedAccounts ?? 0

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
        ? `${snap.connectedAccounts} ${accountsWord(snap.connectedAccounts)}${unhealthy > 0 ? `, из них ${unhealthy} ${pluralRu(unhealthy, ['не работает', 'не работают', 'не работают'])}` : ''}${pending > 0 ? `, ещё ${pending} без счёта` : ''}`
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
    recognitionLine(snap, matrixCount),
    smartProcessLine(snap, spReady),
    pollLine(snap, paused, snap.connectedAccounts)
  ]
}

/**
 * Строка «Смарт-процессы» (#46 добавил проверку ПОЛЕЙ, а не только факта создания).
 *
 * Три состояния вместо двух, и среднее — то, ради которого правка и сделана:
 *   • СП не созданы — как было;
 *   • созданы, но НЕ ХВАТАЕТ полей реестра — импорт при этом идёт и выглядит рабочим, а данные
 *     операции уходят в пустоту (портал молча отбрасывает неизвестные UF-ключи). Именно это
 *     состояние сутки выглядело зелёной галочкой на боевом портале;
 *   • всё на месте.
 *
 * ⚠ Не спросили (`spFieldNames === undefined`) ⇒ ведём себя как раньше: строка зелёная по факту
 * создания. Красить её от незнания нельзя — старый сервер поля не пришлёт вовсе.
 */
function smartProcessLine(snap: ReadinessSnapshot, spReady: boolean): ReadinessItem {
  const missing = spReady ? missingPaymentSpFields(snap.settings.recognition?.configFields, snap.spFieldNames) : []
  if (spReady && missing.length > 0) {
    return {
      key: 'smart-process',
      title: 'Смарт-процессы распределения настроены',
      ok: false,
      detail: `созданы, но нет ${missing.length} ${fieldsWord(missing.length)}`,
      // ⚠ Поля названы ПОИМЕННО: «не хватает полей» отправляет искать наугад, а список сразу
      // показывает, что пропали именно колонки выписки, и объясняет немые строки в реестре.
      hint: `Нажмите «Настроить смарт-процессы» — на смарт-процессе «Платежи» не хватает полей: `
        + `${missing.join(', ')}. Пока их нет, эти данные операции никуда не записываются: `
        + 'портал молча отбрасывает поля, которых у него нет.'
    }
  }
  return {
    key: 'smart-process',
    title: 'Смарт-процессы распределения настроены',
    ok: spReady,
    detail: spReady ? 'созданы' : 'не созданы',
    hint: spReady ? '' : 'Нажмите «Настроить смарт-процессы». Без них приложение не сможет вести учёт распределения оплат.'
  }
}

/** Plural «поля/полей» для строки смарт-процессов. */
function fieldsWord(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'поля'
  return 'полей'
}

/**
 * Строка «Карта распознавания» (#595 добавил persistent-признак misconfig).
 *
 * Два разных «красных», и порядок важен:
 *   misconfig из последнего прогона — портал ОТВЕРГ поле/смарт-процесс из карты. Это важнее пустоты:
 *     карта заполнена, но сломана, импорт по ней уже стоит, и человек об этом иначе не узнал бы —
 *     раньше это было разовым сообщением в чат, которое никуда не оседало.
 *   нет ни одного шаблона — распознавать нечем вовсе.
 *
 * ⚠ misconfig ПЕРЕБИВАЕТ проверку `matrixCount`: у портала с одной рабочей и одной сломанной матрицей
 * шаблоны есть (зелёное по счётчику), но сломанную настройку нужно показать красным.
 */
function recognitionLine(snap: ReadinessSnapshot, matrixCount: number): ReadinessItem {
  const bad = snap.recognitionMisconfig
  if (bad) {
    return {
      key: 'recognition',
      title: 'Карта распознавания заполнена',
      ok: false,
      detail: 'настройка отвергнута порталом',
      hint: misconfigHint(bad.slot)
    }
  }
  return {
    // Без матриц распознавания приложение не видит в назначении платежа НИ ОДНОГО номера, то есть
    // разнесение по счетам/заказам не работает вовсе — дела пишутся, но ни к чему не привязываются.
    key: 'recognition',
    title: 'Карта распознавания заполнена',
    ok: matrixCount > 0,
    detail: matrixCount > 0 ? `${matrixCount} ${matrixWord(matrixCount)}` : 'нет шаблонов',
    hint: matrixCount > 0
      ? ''
      : 'Добавьте шаблоны номеров в разделе «Карта распознавания» — по ним приложение находит в назначении платежа номер счёта или заказа. Есть кнопка «Добавить типовые».'
  }
}

/**
 * The «Автоматический опрос банка» line (#576 added the pause to it).
 *
 * Three states, and they differ by WHO can change them:
 *   disabled on the server — the portal admin can do nothing, that is the app owner's switch;
 *   every account paused  — the admin turned it off and turns it back on; not a problem;
 *   some accounts paused  — polling runs, but not for every account; staying silent would mislead.
 *
 * ⚠ A pause does NOT make the line red. Red here means «setup is not finished», while a pause is
 * finished setup being used. Painting it red would train the admin to see red on a screen they put
 * into that state themselves.
 */
function pollLine(snap: ReadinessSnapshot, paused: number, connected: number): ReadinessItem {
  if (!snap.pollEnabled) {
    return {
      key: 'poll',
      title: 'Автоматический опрос банка включён',
      ok: false,
      detail: 'выключен',
      // The gate is server-side, so a portal admin genuinely cannot fix this themselves — say so
      // instead of showing an action they can't perform.
      hint: 'Опрос выключен на сервере приложения. Обратитесь к владельцу приложения — из портала это не включается.'
    }
  }
  const every = `каждые ${snap.pollIntervalMin} мин`
  if (paused > 0 && connected > 0 && paused >= connected) {
    return {
      key: 'poll',
      title: 'Автоматический опрос банка включён',
      ok: true,
      detail: `${every}, но все подключения на паузе`,
      hint: 'Опрос приостановлен вами — возобновите его в разделе «Подключение банка», когда снова понадобится выписка.'
    }
  }
  return {
    key: 'poll',
    title: 'Автоматический опрос банка включён',
    ok: true,
    detail: paused > 0 ? `${every}; ${paused} ${pluralRu(paused, ['подключение', 'подключения', 'подключений'])} на паузе` : every,
    hint: ''
  }
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
