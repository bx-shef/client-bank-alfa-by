import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ALFA_BUSINESS_ONLINE_URL, ALFA_KEY_SHOTS } from '~/utils/bankConnectInvite'

// Снимки кабинета банка на экране владельца счёта `/bank-key` (#19).
//
// Владелец прислал скриншоты кабинета для инструкции, но попали они только во вложение сообщения
// в чат, а экран, где человек вставляет ключ, шёл голым текстом. Проверяем два утверждения:
// каждый снимок манифеста показан, и показан В СВОЁМ шаге — тот же `afterStep`, что во вложении.
// ⚠ Второе несущее: в сообщении шагов шесть, на экране пять. Снимок, привязанный к шагу, которого
// на экране нет, пропадал бы молча — ровно это ловит сверка «показаны все».

vi.mock('~/composables/useB24', async () => {
  const { makeMockB24 } = await import('./helpers/mockB24')
  return {
    useB24: () => makeMockB24({ isInit: () => true, placementOptions: { t: 'grant' } })
  }
})

vi.mock('~/composables/useFrameAuth', () => ({
  frameAuth: () => ({ token: 'T', domain: 'd.bitrix24.by' }),
  frameAuthHeaders: () => ({ 'authorization': 'Bearer T', 'x-b24-domain': 'd.bitrix24.by' }),
  frameFetchError: (_e: unknown, f: string) => f
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

async function mountReady() {
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => (
    String(url).includes('/api/bank/key-request') ? { ok: true, clientId: 'CID' } : {}
  )) as never)
  const BankKeyPage = await import('~/pages/bank-key.vue').then(m => m.default)
  const w = await mountSuspended(BankKeyPage)
  await flushPromises()
  return w
}

describe('/bank-key: снимки кабинета в шагах инструкции', () => {
  it('каждый снимок манифеста стоит в своём шаге', async () => {
    const w = await mountReady()
    // Только шаги верхнего уровня: у шага 3 свой вложенный список полей формы.
    const steps = w.find('[data-testid="key-steps"]').findAll('ol > li')
    expect(steps.length).toBeGreaterThan(0)
    for (const shot of ALFA_KEY_SHOTS) {
      const li = steps[shot.afterStep - 1]
      expect(li, `на экране нет шага ${shot.afterStep} для «${shot.name}»`).toBeTruthy()
      const img = li!.find('img')
      expect(img.exists(), `шаг ${shot.afterStep} без снимка`).toBe(true)
      expect(img.attributes('src')).toBe(`/${shot.file}`)
      expect(img.attributes('alt')).toBe(shot.name)
      // Размеры заданы — место под картинку зарезервировано, вёрстка не прыгает на догрузке.
      expect(img.attributes('width')).toBe(String(shot.width))
      expect(img.attributes('height')).toBe(String(shot.height))
    }
  })

  it('показаны ВСЕ снимки и только они — ни один не пропал, лишних нет', async () => {
    const w = await mountReady()
    const srcs = w.find('[data-testid="key-steps"]').findAll('img').map(i => i.attributes('src'))
    expect(srcs.sort()).toEqual(ALFA_KEY_SHOTS.map(s => `/${s.file}`).sort())
  })

  it('снимок открывается в полном размере — самый широкий на экране ужат вдвое', async () => {
    const w = await mountReady()
    const links = w.find('[data-testid="key-steps"]').findAll('a[data-testid^="guide-shot-"]')
    expect(links.map(a => a.attributes('href')).sort()).toEqual(ALFA_KEY_SHOTS.map(s => `/${s.file}`).sort())
    for (const a of links) {
      expect(a.attributes('target')).toBe('_blank')
      expect(a.attributes('rel')).toContain('noopener')
    }
  })
})

// Замечания владельца к инструкции (2026-09-28) — те же, что к сообщению в чат.
describe('/bank-key: вид шагов инструкции', () => {
  it('«Альфа Бизнес Онлайн» в шаге 1 — ссылка на кабинет банка, без пробела перед точкой', async () => {
    const w = await mountReady()
    const first = w.find('[data-testid="key-steps"]').findAll('ol > li')[0]!
    const a = first.find('[data-testid="key-bank-link"]')
    expect(a.attributes('href')).toBe(ALFA_BUSINESS_ONLINE_URL)
    expect(a.attributes('target')).toBe('_blank')
    expect(first.text().replace(/\s+/g, ' ').trim()).toBe('Войдите в Альфа Бизнес Онлайн.')
  })

  it('шаг 3 — по полю формы на строку, а не «всё в одну кучу»', async () => {
    const w = await mountReady()
    const third = w.find('[data-testid="key-steps"]').findAll('ol > li')[2]!
    const fields = third.findAll('ul > li').map(li => li.text())
    expect(fields).toHaveLength(3)
    expect(fields[0]).toContain('НАЗВАНИЕ')
    expect(fields[1]).toContain('CLIENT ID')
    expect(fields[2]).toContain('ТИП КЛЮЧА')
  })
})
