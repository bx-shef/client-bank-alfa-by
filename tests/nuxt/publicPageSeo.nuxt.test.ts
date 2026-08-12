import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h } from 'vue'
import { injectHead } from '#imports'
import { LANDING_PUBLISHER, LANDING_SITE_URL } from '~/utils/seo'

// Композабл — самый заметный артефакт SEO-фичи (#425) и при этом единственное место, где набор
// мета-тегов существует целиком. Юнит-тесты покрывают ядро (`canonicalUrl`/`ogImageUrl`), а
// «правильно ли им воспользовались» до этого не проверял никто: можно было поменять местами
// title и description или вовсе снести twitter-набор при зелёных тестах.

/** Собранные теги — из самого unhead, а не из `document.head`: в тестовой среде DOM-плагин голову
 *  не наполняет, и проверка молча смотрела бы в пустоту. */
async function mountWithSeo(opts: Parameters<typeof usePublicPageSeo>[0]) {
  let head: ReturnType<typeof injectHead>
  const Page = defineComponent({
    setup() {
      usePublicPageSeo(opts)
      head = injectHead()
      return () => h('div')
    }
  })
  await mountSuspended(Page)
  const tags = await head!.resolveTags()
  return tags.map((t) => {
    const attrs = Object.entries(t.props).map(([k, v]) => `${k}="${String(v)}"`).join(' ')
    return `<${t.tag} ${attrs}>${t.innerHTML ?? ''}</${t.tag}>`
  }).join('\n')
}

const base = {
  route: '/partners',
  title: 'Заголовок страницы',
  description: 'Описание страницы для выдачи.'
}

describe('usePublicPageSeo', () => {
  it('canonical и og:url — один и тот же абсолютный адрес маршрута', async () => {
    const head = await mountWithSeo(base)
    const expected = `${LANDING_SITE_URL}/partners`
    expect(head).toContain(`rel="canonical"`)
    expect(head).toContain(expected)
    const og = head.match(/<meta[^>]*property="og:url"[^>]*>/)?.[0] ?? ''
    expect(og).toContain(expected)
  })

  it('og:site_name — ИЗДАТЕЛЬ, а не заголовок (иначе карточка печатает одну фразу дважды)', async () => {
    const head = await mountWithSeo(base)
    const tag = head.match(/<meta[^>]*property="og:site_name"[^>]*>/)?.[0] ?? ''
    expect(tag).toContain(LANDING_PUBLISHER)
    expect(tag).not.toContain(base.title)
  })

  it('заголовок и описание не перепутаны местами в og/twitter', async () => {
    const head = await mountWithSeo(base)
    for (const key of ['og:title', 'twitter:title']) {
      expect(head.match(new RegExp(`<meta[^>]*"${key}"[^>]*>`))?.[0]).toContain(base.title)
    }
    for (const key of ['og:description', 'twitter:description']) {
      expect(head.match(new RegExp(`<meta[^>]*"${key}"[^>]*>`))?.[0]).toContain(base.description)
    }
  })

  it('og:image абсолютный — относительный скрейперы выбрасывают, превью будет пустым', async () => {
    const head = await mountWithSeo(base)
    const tag = head.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/)?.[1] ?? ''
    expect(tag).toBe(`${LANDING_SITE_URL}/og.png`)
  })

  it('twitter-набор на месте — без него ссылка в X разворачивается голой строкой', async () => {
    const head = await mountWithSeo(base)
    expect(head).toContain('summary_large_image')
    expect(head).toMatch(/twitter:image/)
  })

  it('JSON-LD появляется ТОЛЬКО по флагу — на каждой странице он размывал бы сигнал', async () => {
    expect(await mountWithSeo(base)).not.toContain('application/ld+json')

    const head = await mountWithSeo({ ...base, route: '/', softwareApplication: true })
    const raw = head.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? ''
    const data = JSON.parse(raw) as Record<string, unknown>
    expect(data['@type']).toBe('SoftwareApplication')
    expect(data.url).toBe(`${LANDING_SITE_URL}/`)
    expect(data.image).toBe(`${LANDING_SITE_URL}/og.png`)
    expect((data.offers as Record<string, unknown>).price).toBe('0')
    expect((data.publisher as Record<string, unknown>).name).toBe(LANDING_PUBLISHER)
  })
})
