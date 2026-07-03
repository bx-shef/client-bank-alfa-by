/** Single source of truth for the landing copy — used by both app.vue (SEO/head)
 * and index.vue (visible hero), so the title/description can't drift apart.
 * Content follows issue #110 (marketing brief) verbatim. */
export const LANDING_TITLE = 'Импорт выписки клиент-банка в Bitrix24'
export const LANDING_DESCRIPTION
  = 'Выписка Альфа-Банка Беларусь и Приорбанка попадает в CRM автоматически. Оплаты сами закрывают сделки, счета и заказы — на вашем сервере, код в вашем git. Облако и коробка.'

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
  after: 'выписка загружается сама, платёж находит свою сделку/счёт/заказ, отмечает оплату — и ответственный менеджер сразу видит это в чате.'
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
    title: 'Разносим оплату',
    text: 'Платёж закрывает сделку / счёт / заказ и уведомляет ответственного менеджера в чат.'
  }
]

/** A single selling point shown on the landing page («Почему мы», section 4). */
export interface LandingFeature {
  title: string
  description: string
}

/** Static content for the landing — the app's value props (4 cards). */
export const LANDING_FEATURES: readonly LandingFeature[] = [
  {
    title: 'Авторазнесение оплат',
    description: 'Не просто импорт — оплаты сами двигают сделки и закрывают счета. Это и есть автоматизация, за которой приходят.'
  },
  {
    title: 'На вашем сервере, код в вашем git',
    description: 'Данные и токены не уходят вендору. Полный контроль — важно для финансов и для РФ-компаний с бизнесом в РБ.'
  },
  {
    title: 'Белорусские банки и форматы',
    description: 'Альфа-Банк Беларусь, Приорбанк, стандартные выгрузки — то, чего нет в типовых решениях Маркета.'
  },
  {
    title: 'Облако и коробка',
    description: 'Работаем с любой редакцией Bitrix24, дорабатываем под ваши процессы.'
  }
]

/** «Интеграторам Bitrix24» block (section 5). */
export const LANDING_INTEGRATORS
  = 'Забирайте бесплатный коннектор РБ-банков в свой арсенал: ставьте клиентам, а автоматизацию разнесения оплат делайте по нашей инструкции или отдавайте нам.'

/** Banks/formats chips shown under the hero. */
export const LANDING_FORMATS: readonly string[] = [
  'Альфа-Банк Беларусь',
  'Приорбанк',
  'клиент-банк',
  '1С'
]

/**
 * Render a copyright span: a single year, or a `start–current` range when the
 * project has been running for more than one calendar year.
 */
export function copyrightYears(startYear: number, currentYear: number): string {
  return currentYear > startYear ? `${startYear}–${currentYear}` : `${startYear}`
}
