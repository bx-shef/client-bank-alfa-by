import { LANDING_PUBLISHER, canonicalUrl, ogImageUrl } from '~/utils/seo'
import { LANDING_MARKET_URL, LANDING_TITLE } from '~/utils/landing'

/**
 * Полный SEO-набор публичной страницы (#425): title/description, canonical, OpenGraph, Twitter.
 *
 * Композабл, а не копипаста на каждой странице, по двум причинам. Во-первых, набор большой и
 * «забыть половину» — норма: у `/partners` так и было, страница задавала только title/description,
 * а `og:title`/`og:image` подтягивались из корневого `app.vue`, то есть при шаринге показывался
 * текст ГЛАВНОЙ. Во-вторых, `canonical` и `og:url` обязаны быть согласованы между собой и с
 * маршрутом — разъехавшись, они начинают спорить друг с другом.
 *
 * ⚠ Вызывать ТОЛЬКО на публичных страницах (`PUBLIC_ROUTES`). Служебные должны нести `robots:
 * noindex` и никакой соц-меты: это дубли лендинга в выдаче.
 */
export function usePublicPageSeo(opts: {
  /** Маршрут страницы, ровно как в `PUBLIC_ROUTES` (`/`, `/partners`). */
  route: string
  title: string
  /** Короткое описание для выдачи — ~150–160 символов, иначе обрежется на полуслове. */
  description: string
  /** Добавить JSON-LD `SoftwareApplication` (только главная — приложение одно). */
  softwareApplication?: boolean
}): void {
  const canonical = canonicalUrl(opts.route)
  const ogImage = ogImageUrl()

  useHead({
    link: [{ rel: 'canonical', href: canonical }]
  })

  useSeoMeta({
    title: opts.title,
    description: opts.description,
    ogTitle: opts.title,
    ogDescription: opts.description,
    ogType: 'website',
    ogUrl: canonical,
    // Имя издателя, а НЕ заголовок: иначе карточка шаринга печатает одну фразу дважды.
    ogSiteName: LANDING_PUBLISHER,
    ogLocale: 'ru_RU',
    ogImage,
    ogImageWidth: 1200,
    ogImageHeight: 630,
    ogImageType: 'image/png',
    ogImageAlt: opts.title,
    twitterCard: 'summary_large_image',
    twitterTitle: opts.title,
    twitterDescription: opts.description,
    twitterImage: ogImage,
    twitterImageAlt: opts.title
  })

  // Структурированные данные (#425). Только на главной: карточка описывает ПРИЛОЖЕНИЕ, и повторять
  // её на каждой странице — размывать сигнал.
  //
  // ⚠ CSP: `application/ld+json` — это data-блок, а не скрипт: браузер его не исполняет, `script-src`
  // к нему не применяется, и хеш в allow-list не нужен. `scripts/csp-hashes.mjs` его тоже намеренно
  // пропускает (регексп исключает `type=*json*`) — иначе allow-list пух бы без пользы. Проверено на
  // собранной странице.
  if (opts.softwareApplication) {
    useHead({
      script: [{
        type: 'application/ld+json',
        innerHTML: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'SoftwareApplication',
          'name': LANDING_TITLE,
          'description': opts.description,
          'url': canonical,
          'image': ogImage,
          'applicationCategory': 'BusinessApplication',
          'operatingSystem': 'Bitrix24',
          'inLanguage': 'ru',
          'publisher': { '@type': 'Organization', 'name': LANDING_PUBLISHER },
          // Приложение в Маркете бесплатное — это заявлено на лендинге, и цена в карточке выдачи
          // отвечает на первый вопрос читателя.
          'offers': { '@type': 'Offer', 'price': '0', 'priceCurrency': 'BYN', 'url': LANDING_MARKET_URL }
        })
      }]
    })
  }
}
