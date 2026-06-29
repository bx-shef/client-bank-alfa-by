/** Single source of truth for the landing copy — used by both app.vue (SEO/head)
 * and index.vue (visible hero), so the title/description can't drift apart. */
export const LANDING_TITLE = 'Клиент-банк Альфа-Банк Беларусь'
export const LANDING_DESCRIPTION
  = 'Приложение для получения выписки из клиент-банка Альфа-Банк Беларусь.'

/** Year the project started — left edge of the footer copyright range. */
export const START_YEAR = 2026

/** A single selling point shown on the landing page. */
export interface LandingFeature {
  title: string
  description: string
}

/** Static content for the landing hero. Replace when the real app lands. */
export const LANDING_FEATURES: readonly LandingFeature[] = [
  {
    title: 'Выписка из клиент-банка',
    description: 'Получение выписки из клиент-банка Альфа-Банк Беларусь.'
  },
  {
    title: 'Интеграция с Bitrix24',
    description: 'Работа внутри портала Bitrix24.'
  },
  {
    title: 'Автоматизация',
    description: 'Регулярная выгрузка операций без ручного экспорта.'
  }
]

/**
 * Render a copyright span: a single year, or a `start–current` range when the
 * project has been running for more than one calendar year.
 */
export function copyrightYears(startYear: number, currentYear: number): string {
  return currentYear > startYear ? `${startYear}–${currentYear}` : `${startYear}`
}
