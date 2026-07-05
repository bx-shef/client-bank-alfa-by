/** Copy for the partners landing (`/partners`) — for Bitrix24 integrators.
 * Model: subcontracting (see docs/PARTNERS.md). Single source of truth so the
 * page and its head/SEO can't drift. Mirrors the structure of `landing.ts`. */

export const PARTNERS_TITLE = 'Интеграторам Bitrix24'

export const PARTNERS_DESCRIPTION
  = 'Забирайте бесплатный коннектор белорусских банков в свой арсенал: ставьте клиентам сами, а установку в контур клиента и настройку под процессы отдавайте нам — работаем субподрядом.'

/** Model chips shown under the hero. */
export const PARTNERS_MODEL: readonly string[] = [
  'модель: субподряд',
  'партнёру — Marketplace-версия',
  'код и сервер — у нас'
]

/** A rung of the sales ladder (what the partner can sell the client). */
export interface PartnerLadderRow {
  level: string
  client: string
  who: string
  paid: 'free' | 'us'
}

export const PARTNERS_LADDER: readonly PartnerLadderRow[] = [
  {
    level: 'Базовый',
    client: 'Импорт выписки в CRM, платежи, уведомления в чат',
    who: 'партнёр ставит из Маркета',
    paid: 'free'
  },
  {
    level: 'Установка',
    client: 'Приложение в контуре клиента: сервер/коробка, контроль данных',
    who: 'мы, субподряд',
    paid: 'us'
  },
  {
    level: 'Автоматизация',
    client: 'Обработка выписки под процессы клиента: распределение оплат, стадии, правила',
    who: 'мы, субподряд',
    paid: 'us'
  },
  {
    level: 'Сопровождение',
    client: 'Обновления, поддержка, донастройка',
    who: 'мы, субподряд',
    paid: 'us'
  }
]

/** Who does what: partner vs us. */
export interface PartnerSplit {
  partner: readonly string[]
  us: readonly string[]
}

export const PARTNERS_SPLIT: PartnerSplit = {
  partner: [
    'квалифицирует клиента и продаёт',
    'ставит бесплатное приложение из Маркета',
    'базовая настройка (источник выписки, чат, реквизиты в CRM)',
    'держит отношения и договор с клиентом'
  ],
  us: [
    'установка в контур клиента (код у нас)',
    'обработка и автоматизация под процессы клиента',
    'поддержка сложных случаев и обновления',
    'консультации партнёра на пресейле'
  ]
}

/** «Чего не обещать клиенту без нас» — the promise boundary for pre-sale. */
export const PARTNERS_LIMITS
  = 'Граница простая: всё глубже базовой настройки Marketplace-версии — к нам. Без нас не обещайте клиенту автоматическое закрытие сделок/счетов, работу с банком без действующего доступа к клиент-банку и произвольные форматы выписки без проверки образца.'

/** Mini-brief: what the partner sends us to hand off a project. */
export const PARTNERS_BRIEF: readonly string[] = [
  'портал Bitrix24: облако или коробка, редакция/тариф',
  'банк(и) клиента и способ получения выписки (онлайн / файл, формат)',
  'какие сущности и по какому правилу разносить оплаты',
  'заполнены ли банковские реквизиты компаний в CRM',
  'ожидания по срокам и объёму',
  'контактное лицо со стороны клиента'
]
