/** Single source of truth for the landing copy — used by both app.vue (SEO/head)
 * and index.vue (visible hero), so the title/description can't drift apart.
 * Content follows issue #110 (marketing brief) verbatim. */
export const LANDING_TITLE = 'Импорт выписки клиент-банка в Bitrix24'
export const LANDING_DESCRIPTION
  = 'Выписка белорусских банков (Альфа-Банк Беларусь, Приорбанк) — онлайн из любой страны или файлом — превращается в рабочий процесс в вашем Bitrix24: контрагент, оплата, стадии, уведомления. Настраиваем под ваши регламенты и внедряем в ваш контур: ваш git, ваш сервер.'

/** Small print under the hero CTA. */
export const LANDING_HERO_NOTE = 'Само приложение — бесплатное, есть в Маркете Bitrix24.'

/** Marketplace listing of the free app (import-only hook). */
export const LANDING_MARKET_URL = 'https://www.bitrix24.ru/apps/app/shef.bankimport/'

/** Browser-tab title for an in-portal page: "<section> — <app name>". Keeps the
 * brand suffix in one place so per-page `useHead` titles can't drift. */
export function pageTitle(section: string): string {
  return `${section} — ${LANDING_TITLE}`
}

/** URL for the OG share image: absolute when siteUrl is set (prod), relative
 * `/og.png` otherwise (dev preview). Pure so the branch is unit-testable. */
export function ogImageUrl(siteUrl: string): string {
  return `${(siteUrl || '').replace(/\/$/, '')}/og.png`
}

/** Year the project started — left edge of the footer copyright range. */
export const START_YEAR = 2026

/** «Боль → результат» pair (section 2). */
export interface PainResult {
  before: string
  after: string
}

export const LANDING_PAIN_RESULT: PainResult = {
  before: 'бухгалтер вручную переносит платёжки из клиент-банка и сверяет, кто оплатил.',
  after: 'выписка загружается сама, платёж привязывается к контрагенту и попадает в вашу CRM, а ответственный менеджер сразу видит поступление в чате.'
}

/** A numbered step in «Как это работает» (section 3). */
export interface LandingStep {
  step: string
  title: string
  text: string
}

export const LANDING_STEPS: readonly LandingStep[] = [
  {
    step: '01',
    title: 'Забираем выписку',
    text: 'Онлайн из Альфа/Приора (портал может быть в любой стране) или файлом любой стандартной выгрузки (клиент-банк, 1С).'
  },
  {
    step: '02',
    title: 'Находим контрагента',
    text: 'По расчётному счёту автоматически подтягивается компания в CRM.'
  },
  {
    step: '03',
    title: 'Отражаем платёж',
    text: 'Платёж привязывается к сделке / счёту / заказу и уведомляет ответственного менеджера в чат. Автоматическое закрытие настраивается под ваши процессы.'
  }
]

/** A single selling point shown on the landing page («Почему мы», section 4). */
export interface LandingFeature {
  title: string
  description: string
}

/** Static content for the landing — the app's value props. */
export const LANDING_FEATURES: readonly LandingFeature[] = [
  {
    title: 'Онлайн-доступ к белорусским банкам',
    description: 'Читаем выписку Альфа-Банка Беларусь и Приорбанка онлайн — портал Bitrix24 может быть в любой стране. Плюс файлы клиент-банк и 1С.'
  },
  {
    title: 'Поддержим ваш формат',
    description: 'Нужного формата нет — пришлите образец выписки, и мы добавим поддержку. Главное, чтобы формат был распространённым.'
  },
  {
    title: 'Обработка под ваши процессы',
    description: 'Не коробочный импорт «как получится», а обработка под ваши регламенты: распределение оплат, стадии, уведомления, исключения. Приходы и расходы, а не только поступления.'
  },
  {
    title: 'Контрагент по расчётному счёту',
    description: 'Компания в CRM находится по номеру счёта из выписки — работает для белорусских компаний, где нет КПП.'
  },
  {
    title: 'Внедряем в ваш контур',
    description: 'Берём ваш git, ставим на ваш сервер, настраиваем что нужно. Данные и доступы к банку не уходят наружу — без зависимости от чужого облака.'
  },
  {
    title: 'Для компаний из РФ с бизнесом в РБ',
    description: 'Проверяйте платежи ваших белорусских офисов прямо в своём Bitrix24 — движение по счетам «дочки» в единой CRM.'
  }
]

/** «Интеграторам Bitrix24» block (section 5). */
export const LANDING_INTEGRATORS
  = 'Забирайте бесплатный коннектор белорусских банков в свой арсенал: ставьте клиентам сами, а установку в контур клиента и настройку под процессы отдавайте нам — работаем субподрядом.'

/** Banks/formats chips shown under the hero. */
export const LANDING_FORMATS: readonly string[] = [
  'Альфа-Банк Беларусь',
  'Приорбанк',
  'клиент-банк',
  '1С',
  'ваш формат — по запросу'
]

/**
 * Render a copyright span: a single year, or a `start–current` range when the
 * project has been running for more than one calendar year.
 */
export function copyrightYears(startYear: number, currentYear: number): string {
  return currentYear > startYear ? `${startYear}–${currentYear}` : `${startYear}`
}
