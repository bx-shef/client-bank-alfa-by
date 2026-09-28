import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ALFA_BUSINESS_ONLINE_URL, ALFA_KEY_SHOTS, buildAlfaInvite } from '~/utils/bankConnectInvite'

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
      // ⚠ Без `max-w-full` снимок шириной 1633 px выпирает из колонки шагов и даёт горизонтальную
      // прокрутку в слайдере и в мобильном браузере (находка ревью: прежде это не проверял никто).
      expect(img.classes()).toContain('max-w-full')
    }
  })

  it('показаны ВСЕ снимки и только они — ни один не пропал, лишних нет', async () => {
    const w = await mountReady()
    const srcs = w.find('[data-testid="key-steps"]').findAll('img').map(i => i.attributes('src'))
    expect(srcs.sort()).toEqual(ALFA_KEY_SHOTS.map(s => `/${s.file}`).sort())
  })

  it('снимок — ссылка на себя в полном размере, в новой вкладке', async () => {
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
  it('«Альфа Бизнес Онлайн» в шаге 1 — ссылка на кабинет банка с названным доменом', async () => {
    const w = await mountReady()
    const first = w.find('[data-testid="key-steps"]').findAll('ol > li')[0]!
    const a = first.find('[data-testid="key-bank-link"]')
    expect(a.attributes('href')).toBe(ALFA_BUSINESS_ONLINE_URL)
    expect(a.attributes('target')).toBe('_blank')
    // Без пробела перед точкой: у многострочного элемента текст получил бы пробелы по краям.
    expect(first.text().replace(/\s+/g, ' ').trim()).toBe('Войдите в Альфа Бизнес Онлайн (online.alfabank.by).')
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

  // ⚠ Client ID с кнопкой копирования — ПРЯМО В ШАГЕ 3 (находка ревью): «значение ниже» уводило
  // на ~1100 px вниз, под два снимка во всю ширину.
  it('Client ID и кнопка копирования стоят в шаге 3', async () => {
    const w = await mountReady()
    const third = w.find('[data-testid="key-steps"]').findAll('ol > li')[2]!
    // `data-testid` у B24Input может лечь и на обёртку, и на сам <input> — берём поле в обоих случаях.
    const field = third.find('input[data-testid="key-client-id"], [data-testid="key-client-id"] input')
    expect((field.element as HTMLInputElement).value).toBe('CID')
    expect(third.find('[data-testid="key-copy-client-id"]').exists()).toBe(true)
  })
})

// ⚠ Шаги на экране — вторая копия шагов сообщения. Всё, что выделено жирным, — надписи кабинета
// банка, по которым человек ищет пункты меню; разойдись копии, экран и чат назвали бы разные
// кнопки. Сверяем НАБОРЫ выделенного по шагам 1–5 в обе стороны (находка ревью).
describe('/bank-key: шаги экрана и сообщения не расходятся', () => {
  const KEY_LINK = 'https://client.bitrix24.by/marketplace/view/shef.bankimport/?params[place]=app-bank-key&params[t]=sig'
  const chat = buildAlfaInvite({ clientId: 'CID', link: KEY_LINK, ttlHours: 24 })!

  /** Шаги сообщения: строка «N. …» и следующие за ней строки-пункты до следующего шага. */
  function chatSteps(): string[] {
    const steps: string[] = []
    for (const line of chat.split('\n')) {
      if (/^\d\. /.test(line)) steps.push(line)
      else if (line.startsWith('• ') && steps.length) steps[steps.length - 1] += `\n${line}`
    }
    return steps
  }

  const boldOf = (bb: string) => [...bb.matchAll(/\[B\](.+?)\[\/B\]/g)].map(m => m[1]!.trim()).sort()

  it('жирные надписи кабинета совпадают по каждому шагу', async () => {
    const w = await mountReady()
    const screen = w.find('[data-testid="key-steps"]').findAll('ol > li')
    const steps = chatSteps()
    expect(steps).toHaveLength(6)
    for (let i = 0; i < 5; i++) {
      const onScreen = screen[i]!.findAll('b').map(b => b.text().trim()).sort()
      expect(onScreen, `шаг ${i + 1}`).toEqual(boldOf(steps[i]!))
    }
  })

  // ⚠ Шаг 6 называет поле и кнопку ЭТОГО экрана дословно. Переименуй их — и каждое отправленное
  // приглашение велит нажать кнопку, которой нет, а сообщение задним числом не правится.
  it('шаг 6 называет поле и кнопку так, как они подписаны на экране', async () => {
    const w = await mountReady()
    const label = w.find('[data-testid="key-field"] label').text().trim()
    const button = w.find('[data-testid="key-submit"]').text().trim()
    expect(label).not.toBe('')
    expect(button).not.toBe('')
    const step6 = chatSteps()[5]!
    expect(step6).toContain(`«${label}»`)
    expect(step6).toContain(`«${button}»`)
  })
})
