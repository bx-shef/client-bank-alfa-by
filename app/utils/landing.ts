/** Single source of truth for the landing copy — used by both app.vue (SEO/head)
 * and index.vue (visible hero), so the title/description can't drift apart. */
export const LANDING_TITLE = 'Импорт выписки из клиент-банка (Беларусь)'
export const LANDING_DESCRIPTION
  = 'Выписка из клиент-банка в Bitrix24: Альфа-Банк, Приорбанк или ручной импорт.'

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
    description: 'Регулярно получаем выписку из Альфа-Банка или Приорбанка по защищённому доступу — без выгрузки файлов вручную. Нет онлайн-доступа — загружаем файл вручную.'
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
