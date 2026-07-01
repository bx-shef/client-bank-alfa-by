/** Single source of truth for the landing copy — used by both app.vue (SEO/head)
 * and index.vue (visible hero), so the title/description can't drift apart. */
export const LANDING_TITLE = 'Импорт выписки из клиент-банка'
export const LANDING_DESCRIPTION
  = 'Выписка из Альфа-Банка Беларусь в Bitrix24 онлайн — из любой страны. Или загрузите любую стандартную выписку вручную.'

/** Year the project started — left edge of the footer copyright range. */
export const START_YEAR = 2026

/** A single selling point shown on the landing page. */
export interface LandingFeature {
  title: string
  description: string
}

/** Static content for the landing hero — the app's value props. */
export const LANDING_FEATURES: readonly LandingFeature[] = [
  {
    title: 'Выписка без ручного экспорта',
    description: 'Забираем выписку из Альфа-Банка Беларусь по защищённому онлайн-доступу — портал Bitrix24 может быть в любой стране. Нет онлайна — загружаем любую стандартную выписку файлом.'
  },
  {
    title: 'Платежи прямо в CRM',
    description: 'Каждый платёж попадает в таймлайн компании как дело Bitrix24, а контрагент находится по расчётному счёту автоматически.'
  },
  {
    title: 'Уведомления в чат',
    description: 'Приходы и расходы — с фильтрами по счёту и назначению — приходят сообщением в выбранный чат портала.'
  }
]

/**
 * Render a copyright span: a single year, or a `start–current` range when the
 * project has been running for more than one calendar year.
 */
export function copyrightYears(startYear: number, currentYear: number): string {
  return currentYear > startYear ? `${startYear}–${currentYear}` : `${startYear}`
}
