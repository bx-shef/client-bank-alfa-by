// Обзор состояния банковских подключений ДЛЯ НАС, а не для клиента (#497 §3).
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ БЕЙДЖА В НАСТРОЙКАХ. Админ портала видит свои подключения и понимает, что с
// ними; мы не видим ничего. Умирающее подключение сегодня узнаётся по факту неработающего импорта —
// то есть позже клиента, а критерий приёмки тестовой эксплуатации сформулирован ровно наоборот:
// «бухгалтер видит свои платежи, а МЫ видим его проблемы».
//
// ⚠ ЧЕГО ЗДЕСЬ НЕТ: номеров счетов, названий порталов, доменов, `member_id`. Оператор смотрит на
// этот экран, чтобы понять «что-то ломается и у скольких», а не чтобы читать реквизиты чужих
// компаний. Порталы различаются НЕОБРАТИМОЙ короткой меткой (`portalHash` — SHA-256 от `member_id`,
// первые 12 hex; НЕ «солёной» — соли там нет, необратимость держится на энтропии самого
// идентификатора). Её достаточно, чтобы отличить два портала друг от друга и сопоставить строку с
// телеметрией, и недостаточно, чтобы кого-то опознать. Это та же граница, что и в телеметрии
// (`docs/PRIVACY.md`, `SAFE_MANUAL_ATTR_KEYS`).
//
// Чистое ядро: вход — уже загруженные строки, выход — счётчики. Ни I/O, ни расшифровки.

import { deadDays, SUBSCRIPTION_CUTOFF_DAYS } from './portalSubscription'
import type { BankProviderId } from '~/types/statement'
import { connectionHealth, NEEDS_HUMAN_HEALTH, needsHumanHealth, type BankConnectionHealth } from '~/utils/bankTokenLifetime'
import { isPendingAccountKey } from '~/utils/bankAccountKey'
import { bankDeadForDays, bankDeathSinceMs } from '~/utils/bankReaper'
import { pluralRu } from '~/utils/importStatus'
import { BANK_LABELS } from '~/utils/bankLabels'

/** Одна строка `bank_tokens` в том виде, в каком её отдаёт стор (без токенов). */
export interface BankHealthRow {
  /** Неизменяемый адрес строки — им оператор адресует ручное отключение (#599). Opaque: без БД
   *  ничего не значит, поэтому отдавать его наружу безопасно. */
  id: number
  memberId: string
  provider: BankProviderId
  accountKey: string
  connectedAt: number
  expiresAt: number
  hasRefresh: boolean
  /** Срок согласия банка (#503) — нужен, чтобы `connectionHealth` увидел истёкшее согласие. Без
   *  него Приор-подключения с истёкшим согласием читались бы как здоровые. */
  consentExpiresAt?: number
}

/**
 * Одно НЕЗДОРОВОЕ подключение, которое оператор может отключить руками (#599). PII-free:
 * `portalHash` вместо портала, opaque `id` вместо счёта. Номера счёта здесь НЕТ — оператору он не
 * нужен, а его отсутствие держит ту же границу приватности, что и весь экран.
 */
export interface BankAttentionConnection {
  /** Opaque id строки — для действия «Отключить». */
  id: number
  /** Необратимая метка портала. */
  portalHash: string
  provider: BankProviderId
  /** `expired` / `no-refresh` — только то, что чинит человек. */
  health: BankConnectionHealth
  /** Сколько дней подключение ИЗМЕРЕННО-мёртво; `null` — смерть не датируется (напр. `no-refresh`
   *  без истёкшего согласия: когда именно умерло, неизвестно). */
  deadDays: number | null
}

/**
 * Подключение портала, у которого истекла ПОДПИСКА на REST Bitrix24 (#614).
 *
 * ⚠ Отдельный список, а не ещё одно состояние в `attentionConnections`, и это не формальность.
 * Там причина в БАНКЕ: подключение мертво, чинится входом владельца счёта в интернет-банк. Здесь
 * банковское подключение может быть совершенно ЖИВЫМ — сломана оплата Битрикса. Свалив их в одну
 * кучу, мы отправили бы оператора говорить клиенту не то.
 */
export interface SubscriptionDeadConnection {
  /** Opaque id строки — для действия «Отключить». */
  id: number
  /** Необратимая метка портала. */
  portalHash: string
  provider: BankProviderId
  /** Сколько ДНЕЙ портал не отвечает по подписке. */
  deadDays: number
  /** Состояние самого банковского подключения — оно может быть в полном порядке. */
  health: BankConnectionHealth
}

/** Сводка по одному состоянию: сколько подключений и на скольких порталах. */
export interface HealthBucket {
  connections: number
  portals: number
}

export interface BankHealthOverview {
  /** По состоянию (`ok`/`due`/`expired`/`no-refresh`/`unknown`). */
  byHealth: Record<BankConnectionHealth, HealthBucket>
  /** Подключения, у которых админ ещё не выбрал счёт (#407) — они не опрашиваются. */
  pending: HealthBucket
  /** Всего строк и всего порталов с подключениями. */
  total: HealthBucket
  /**
   * Порталы, у которых ХОТЯ БЫ ОДНО подключение требует человека (`expired`/`no-refresh`).
   * Отдельно от счётчиков намеренно: чинится это не «в среднем по больнице», а походом к
   * конкретному клиенту, поэтому важно их число, а не число строк.
   */
  needAttention: number
  /**
   * НЕОБРАТИМЫЕ метки (`portalHash`) тех самых порталов — чтобы «3 портала требуют внимания» не
   * было тупиком. Оператор видит, что это РАЗНЫЕ порталы, отличает «те же три, что вчера» от
   * «ещё два новых» и сопоставляет строку с телеметрией, где `portal.hash` — уже принятый ключ
   * корреляции (`docs/PRIVACY.md`).
   *
   * ⚠ Поле ОТСУТСТВУЕТ, когда хешер не передан. Так и задумано — см. `summarizeBankHealth`.
   */
  attentionPortals?: string[]
  /**
   * НЕЗДОРОВЫЕ подключения ПОШТУЧНО — чтобы оператор мог отключить конкретное (#599). Как и
   * `attentionPortals`, поле ОТСУТСТВУЕТ без хешера (fail-safe): забытая зависимость даёт экран без
   * действий, а не сырые id/member_id в теле ответа.
   */
  attentionConnections?: BankAttentionConnection[]
  /**
   * Подключения порталов с истёкшей подпиской на REST (#614).
   *
   * ⚠ Живёт здесь, а не в приложении, по ЖЁСТКОЙ причине: приложение открывается ВНУТРИ Битрикса,
   * и при мёртвой подписке клиент до интерфейса не доберётся — значит отключить сам не может. Если
   * этого нет на экране оператора, этого нет нигде.
   *
   * ⚠ Как и соседи, поле ОТСУТСТВУЕТ без хешера (fail-safe).
   */
  subscriptionDead?: SubscriptionDeadConnection[]
}

function emptyBucket(): HealthBucket {
  return { connections: 0, portals: 0 }
}

/**
 * Свернуть строки в обзор. `nowMs` передаётся, а не берётся из часов: функция чистая, и тест не
 * должен зависеть от того, когда его запустили.
 *
 * ⚠ Ожидающие подключения (`~pending:`) СЧИТАЮТСЯ ОТДЕЛЬНО и не попадают в состояния. Формально
 * они живы, но опрашивать по ним нечего — у банка нет такого «номера». Смешав их с `ok`, экран
 * показывал бы здоровье там, где настройка не закончена.
 *
 * `hashPortal` — необязательная зависимость (на сервере это `portalHash`, который тянет
 * `node:crypto`, а модуль рендерится и в браузере). Без неё меток просто нет.
 */
export function summarizeBankHealth(
  rows: readonly BankHealthRow[],
  nowMs: number,
  hashPortal?: (memberId: string) => string,
  /** `member_id` → когда подписка на REST ПЕРВЫЙ раз отказала (#614). Необязательна: без неё
   *  раздел просто пуст, а не сломан. */
  subscriptionEndedAt?: ReadonlyMap<string, number>
): BankHealthOverview {
  const byHealth = {
    'ok': emptyBucket(),
    'due': emptyBucket(),
    'expired': emptyBucket(),
    'no-refresh': emptyBucket(),
    'unknown': emptyBucket()
  } as Record<BankConnectionHealth, HealthBucket>
  const portalsBy = new Map<BankConnectionHealth, Set<string>>()
  const pendingPortals = new Set<string>()
  const allPortals = new Set<string>()
  const attention = new Set<string>()
  const attentionConnections: BankAttentionConnection[] = []
  const subscriptionDead: SubscriptionDeadConnection[] = []
  const pending = emptyBucket()

  for (const row of rows) {
    allPortals.add(row.memberId)
    // ⚠ Метку подписки читаем ДО отсева ожидающих (#614). Автоотключение стирает ВСЕ строки
    // портала, включая `~pending:`, — а раздел консоли их не показывал, потому что отсев стоял
    // раньше. Получалось, что единственное состояние, которое раздел прятал, было ровно то, ради
    // которого он написан: админ прошёл банк, не успел выбрать счёт, подписка кончилась — и через
    // четверо суток недонастроенное подключение молча исчезало, без обратного отсчёта и без кнопки.
    const subEndedRaw = subscriptionEndedAt?.get(row.memberId) ?? 0
    if (isPendingAccountKey(row.accountKey)) {
      pending.connections += 1
      pendingPortals.add(row.memberId)
      if (hashPortal && subEndedRaw > 0) {
        subscriptionDead.push({
          id: row.id,
          portalHash: hashPortal(row.memberId),
          provider: row.provider,
          deadDays: deadDays(subEndedRaw, nowMs),
          // ⚠ Состояние — `unknown`, а не `ok`: у ожидающего подключения счёта ещё нет, и судить
          // о здоровье банковской пары не по чему. `ok` утверждал бы то, чего мы не проверяли.
          health: 'unknown'
        })
      }
      continue
    }
    const health = connectionHealth(row, nowMs)
    byHealth[health].connections += 1
    const set = portalsBy.get(health) ?? new Set<string>()
    set.add(row.memberId)
    portalsBy.set(health, set)
    // Подписка портала мертва — банковское подключение при этом может быть живым (#614).
    //
    // ⚠ РАЗДЕЛЫ ВЗАИМОИСКЛЮЧАЮЩИ, и это не косметика. Строка бывает нерабочей И по банку, И по
    // подписке разом; двумя независимыми `if` она попадала бы в ОБА списка — одно и то же
    // подключение показывалось бы оператору дважды, с разными формулировками, а `confirmDisconnectId`
    // у списков общий, поэтому клик по одной копии переводил бы в подтверждение и вторую.
    //
    // ⚠ Приоритет — БАНКОВСКИЙ, тот же, что на сервере (`bankReason ?? subscription-ended`): такую
    // строку чинит владелец счёта входом в интернет-банк, и подписка этого не отменяет. Разойдись
    // экран с сервером — оператор увидел бы «подписка», а пометка клиенту ушла бы про банк.
    const subEnded = needsHumanHealth(health) ? 0 : subEndedRaw
    if (hashPortal && subEnded > 0) {
      subscriptionDead.push({
        id: row.id,
        portalHash: hashPortal(row.memberId),
        provider: row.provider,
        // ⚠ Тем же `deadDays`, что и автоотключение (#614): разойдись правило — оператор увидит
        // одно число, а отключение сработает по другому.
        deadDays: deadDays(subEnded, nowMs),
        health
      })
    }
    if (needsHumanHealth(health)) {
      attention.add(row.memberId)
      // Поштучный список для ручного отключения — только с хешером (иначе сырой id/портал наружу).
      if (hashPortal) {
        attentionConnections.push({
          id: row.id,
          portalHash: hashPortal(row.memberId),
          provider: row.provider,
          health,
          deadDays: bankDeadForDays(bankDeathSinceMs(row, nowMs), nowMs)
        })
      }
    }
  }

  for (const [health, set] of portalsBy) byHealth[health].portals = set.size
  pending.portals = pendingPortals.size

  return {
    byHealth,
    pending,
    total: { connections: rows.length, portals: allPortals.size },
    needAttention: attention.size,
    // ⚠ РОВНО ЗДЕСЬ проходит граница приватности. Без хешера поля просто НЕТ — это fail-safe:
    // забытая зависимость даёт экран без меток, а не список `member_id` в теле HTTP-ответа. Сырой
    // идентификатор не покидает эту функцию ни при каком вызове; `sort()` — чтобы порядок не
    // зависел от порядка строк в БД (иначе одинаковая по смыслу сводка «мигала» бы между опросами).
    ...(hashPortal ? { attentionPortals: [...attention].map(hashPortal).sort() } : {}),
    // Стабильный порядок: сначала «нужно переподключить», затем «истекло», внутри — по метке
    // портала, чтобы список не мигал между опросами.
    ...(hashPortal
      ? { attentionConnections: attentionConnections.sort((a, b) =>
          a.health.localeCompare(b.health) || a.portalHash.localeCompare(b.portalHash) || a.id - b.id) }
      : {}),
    // Сначала те, кто молчит ДОЛЬШЕ: у них ближе автоотключение, и посмотреть на них надо раньше.
    ...(hashPortal && subscriptionDead.length > 0
      ? { subscriptionDead: subscriptionDead.sort((a, b) =>
          b.deadDays - a.deadDays || a.portalHash.localeCompare(b.portalHash) || a.id - b.id) }
      : {})
  }
}

/** Порядок показа: сначала то, что требует человека. Экран, начинающийся с «всё хорошо»,
 *  прячет единственную строку, ради которой его открыли. */
export const HEALTH_ORDER: readonly BankConnectionHealth[] = ['no-refresh', 'expired', 'due', 'unknown', 'ok']

/**
 * Синтетическая сводка для `?preview=1` — разработка без бэкенда и ВИЗУАЛЬНЫЕ ЭТАЛОНЫ (#3).
 *
 * ⚠ Живёт здесь, а не в компоненте, чтобы её арифметику мог проверить тест. Фикстура, которая
 * врёт (итог не сходится с суммой состояний), делает эталон снимком НЕВОЗМОЖНОГО состояния: на
 * него потом смотрят как на образец, и расхождение читается как норма.
 *
 * ⚠ Показывает намеренно ИНТЕРЕСНЫЙ случай — есть требующие человека, есть незавершённые. Карточка,
 * снятая в состоянии «всё хорошо», не документирует ничего из того, ради чего сделана.
 */
export const PREVIEW_BANK_HEALTH: BankHealthOverview = {
  byHealth: {
    'no-refresh': { connections: 1, portals: 1 },
    'expired': { connections: 2, portals: 1 },
    'due': { connections: 1, portals: 1 },
    'unknown': { connections: 0, portals: 0 },
    'ok': { connections: 4, portals: 3 }
  },
  pending: { connections: 1, portals: 1 },
  total: { connections: 9, portals: 5 },
  needAttention: 2,
  attentionPortals: ['3f1a9c0b7e42', 'c07d5b6142ae'],
  attentionConnections: [
    { id: 101, portalHash: '3f1a9c0b7e42', provider: 'prior-by', health: 'no-refresh', deadDays: null },
    { id: 102, portalHash: 'c07d5b6142ae', provider: 'alfa-by', health: 'expired', deadDays: 42 },
    { id: 103, portalHash: 'c07d5b6142ae', provider: 'prior-by', health: 'expired', deadDays: 12 }
  ],
  // ⚠ Фикстура обязана нести и этот раздел (#614): без него визуальный эталон задокументировал бы
  // ПУСТУЮ секцию, то есть закрепил бы её отсутствие как норму. Ровно так и пропускают регрессии в
  // блоках, которые видно только при редком состоянии.
  //
  // ⚠ Состояние банка здесь `ok` НАМЕРЕННО: весь смысл раздела в том, что подключение к банку
  // живо, а сломана оплата Битрикса. Поставь сюда `expired` — и фикстура описывала бы случай,
  // который и так виден в списке выше.
  subscriptionDead: [
    { id: 104, portalHash: '9b2e4477a013', provider: 'alfa-by', deadDays: 2, health: 'ok' },
    { id: 105, portalHash: '9b2e4477a013', provider: 'prior-by', deadDays: 2, health: 'ok' }
  ]
}

/** Подписи состояний для экрана оператора — короче клиентских: оператор знает предметную область,
 *  ему нужен ярлык, а не объяснение. */
export const HEALTH_TITLE: Record<BankConnectionHealth, string> = {
  'no-refresh': 'нужно переподключить',
  'expired': 'истекло',
  'due': 'скоро обновим',
  'unknown': 'срок неизвестен',
  'ok': 'в порядке'
}

/**
 * Сколько ПОДКЛЮЧЕНИЙ приложение уже считает нерабочими: `expired` + `no-refresh`.
 *
 * ⚠ Отдельная функция, а не подсчёт по месту, ровно потому, что мест два: экран оператора и экран
 * готовности портала. Посчитанное по месту в роуте не покрывается ничем — в этом проекте такое уже
 * приводило к тому, что подсчёт можно было заменить на константу, не уронив ни одного теста.
 *
 * ⚠ Ожидающие (`~pending:`) сюда не попадают по построению: `summarizeBankHealth` выносит их
 * отдельно и в состояния не кладёт. Это важно — незавершённая настройка не «сломанное подключение».
 */
export function unhealthyConnections(o: BankHealthOverview): number {
  return NEEDS_HUMAN_HEALTH.reduce((n, h) => n + o.byHealth[h].connections, 0)
}

/** Одна готовая к показу строка состояния. */
export interface BankHealthRowView {
  health: BankConnectionHealth
  title: string
  connections: number
  portals: number
  /** «3 на 2 порталах» — уже просклонённое; компонент только печатает. */
  countLabel: string
}

/** Одна готовая к показу СТРОКА ДЕЙСТВИЯ (нерабочее подключение, которое можно отключить). */
export interface BankAttentionRowView {
  id: number
  portalHash: string
  /** «Приорбанк · портал 3f1a9c0b7e42 · мёртво 42 дня» — уже собранная подпись. */
  label: string
  /** Состояние — для тона строки. */
  health: BankConnectionHealth
}

/**
 * Собрать подписи строк-действий (#599). Чистая презентация: банк, метка портала и, если смерть
 * датируется, «мёртво N дн.». У `no-refresh` без истёкшего согласия даты нет — тогда пишем просто
 * «нужно переподключить», не выдумывая срок.
 */
export function bankAttentionRowViews(o: BankHealthOverview): BankAttentionRowView[] {
  return (o.attentionConnections ?? []).map((c) => {
    const bank = BANK_LABELS[c.provider] ?? c.provider
    const dead = c.deadDays !== null
      ? `мёртво ${c.deadDays} ${pluralRu(c.deadDays, ['день', 'дня', 'дней'])}`
      : HEALTH_TITLE[c.health]
    return { id: c.id, portalHash: c.portalHash, health: c.health, label: `${bank} · портал ${c.portalHash} · ${dead}` }
  })
}

/** «N на M порталах» одним правилом для всех строк — включая «счёт не выбран». */
export function spreadLabel(connections: number, portals: number): string {
  return `${connections} на ${portals} ${pluralRu(portals, ['портале', 'порталах', 'порталах'])}`
}

/**
 * Строки состояний в порядке «сначала то, что требует человека», без пустых.
 *
 * ⚠ Живёт здесь, а не в `<script setup>`, ровно из-за склонений. Первая версия склоняла руками
 * (`n === 1 ? 'портал' : 'портала(ов)'`) и была грамматически неверна для 5+ — «5 портала(ов)».
 * В проекте уже есть `pluralRu` с тремя русскими формами; ручной суррогат в шаблоне не мог быть
 * покрыт юнит-тестом и поэтому дожил до ревью.
 */
export function bankHealthRows(o: BankHealthOverview): BankHealthRowView[] {
  return HEALTH_ORDER
    .map(health => ({
      health,
      title: HEALTH_TITLE[health],
      ...o.byHealth[health],
      countLabel: spreadLabel(o.byHealth[health].connections, o.byHealth[health].portals)
    }))
    .filter(r => r.connections > 0)
}

/** Заголовок карточки: либо «всё живо», либо сколько порталов ждут человека. */
export function attentionHeadline(o: BankHealthOverview): string {
  if (!o.needAttention) return 'Все подключения живы.'
  const word = pluralRu(o.needAttention, ['портал требует', 'портала требуют', 'порталов требуют'])
  return `${o.needAttention} ${word} человека — владельцу счёта нужно заново войти в интернет-банк.`
}

/**
 * Подписи строк «портал не оплатил подписку» (#614).
 *
 * ⚠ Формулировка отличается от банковской НАМЕРЕННО. Там «мёртво N дней» — про доступ к счёту, и
 * чинится это входом владельца счёта в интернет-банк. Здесь «не отвечает N дней» — про Битрикс, и
 * чинится оплатой. Одинаковая подпись отправила бы оператора говорить клиенту не то.
 *
 * ⚠ Показываем, сколько осталось до автоотключения: оператор должен видеть не только состояние, но
 * и то, что произойдёт само и когда. Иначе он либо отключит раньше времени, либо будет думать, что
 * висеть это может вечно.
 */
export function subscriptionRowViews(o: BankHealthOverview): BankAttentionRowView[] {
  return (o.subscriptionDead ?? []).map((c) => {
    const bank = BANK_LABELS[c.provider] ?? c.provider
    const days = `${c.deadDays} ${pluralRu(c.deadDays, ['день', 'дня', 'дней'])}`
    const left = SUBSCRIPTION_CUTOFF_DAYS - c.deadDays
    const tail = left > 0
      ? `отключим через ${left} ${pluralRu(left, ['день', 'дня', 'дней'])}`
      : 'отключение уже наступило'
    return {
      id: c.id,
      portalHash: c.portalHash,
      health: c.health,
      label: `${bank} · портал ${c.portalHash} · не отвечает ${days} · ${tail}`
    }
  })
}
