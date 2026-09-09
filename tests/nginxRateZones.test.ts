import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Разделение зон ограничителя частоты по СТОИМОСТИ запроса (живой экран 2026-09-09).
//
// ⚠ Зона называлась `import` — по загрузке файла, — но обслуживала ВЕСЬ in-portal интерфейс. А он
// на каждое открытие настроек делает 7–9 запросов (экран готовности, список подключений, сверка
// счетов, настройки чата, отзывы). При 20r/m это один запрос в 3 секунды: администратор с ДВУМЯ
// порталами в одном браузере выбирал зону мгновенно и получал «слишком много запросов подряд» на
// обоих экранах сразу — то есть ограничитель ломал ровно того, кого должен был пропускать.
//
// ⚠ Ключ — IP, поэтому это не только про владельца с двумя вкладками: сотрудники одного клиента
// сидят за общим NAT и делят те же запросы.
const CONF = readFileSync(join(import.meta.dirname, '..', 'nginx.conf'), 'utf8')

/** Тело блока `location = <route> { … }`. */
function locationBody(route: string): string {
  const start = CONF.indexOf(`location = ${route} {`)
  expect(start, `в nginx.conf нет location для ${route}`).toBeGreaterThan(0)
  return CONF.slice(start, CONF.indexOf('\n    }', start))
}

/** Чтения, которые интерфейс дёргает САМ при открытии экрана — человек их не заказывает. */
const READS = [
  '/api/setup-status', '/api/bank/accounts', '/api/bank/matrix', '/api/import/status',
  '/api/import/batch', '/api/chat-settings', '/api/chat-search', '/api/app-rating',
  '/api/feedback', '/api/import/metrics', '/api/distribution/ledger', '/api/activities/erasable'
]

/**
 * Действия, которые запускает ЧЕЛОВЕК и которые дороги: разбор тела до авторизации, поход в банк,
 * запись в CRM клиента. Общий с чтениями потолок был бы либо тесен для чтений, либо широк для них.
 */
const ACTIONS = [
  '/api/import', '/api/poll-now', '/api/bank/connect', '/api/bank/connect-key',
  '/api/bank/disconnect', '/api/bank/set-account', '/api/bank/add-account', '/api/bank/pause',
  '/api/distribution/provision', '/api/distribution/recompute', '/api/import/metrics-reset',
  '/api/activities/erase'
]

describe('зоны ограничителя разделены по стоимости запроса', () => {
  it('обе зоны объявлены, и у чтений потолок ВЫШЕ', () => {
    const readRate = /zone=portal:\d+m rate=(\d+)r\/m/.exec(CONF)
    const actionRate = /zone=import:\d+m rate=(\d+)r\/m/.exec(CONF)
    expect(readRate, 'зона `portal` пропала — чтения снова делят потолок с загрузкой файла').toBeTruthy()
    expect(actionRate, 'зона `import` пропала').toBeTruthy()
    expect(Number(readRate![1])).toBeGreaterThan(Number(actionRate![1]))
  })

  // ⚠ Потолок ВЫВЕДЕН, а не выбран: стоимость непрошеного запроса — один вызов `profile` в портал
  // клиента, а сам Bitrix24 разрешает 2 запроса в секунду (120 в минуту). Больше половины его
  // бюджета отдавать нельзя — иначе ограничитель перестаёт защищать то, ради чего заведён.
  it('чтения не съедают больше половины бюджета REST портала клиента', () => {
    const rate = Number(/zone=portal:\d+m rate=(\d+)r\/m/.exec(CONF)![1])
    expect(rate, 'потолок чтений выше половины бюджета портала (120 запросов в минуту)')
      .toBeLessThanOrEqual(60)
  })

  it.each(READS)('%s — на зоне чтений', (route) => {
    expect(locationBody(route)).toContain('zone=portal')
  })

  // ⚠ Обратная половина обязательна: без неё «починка» свелась бы к переносу ВСЕГО на широкую
  // зону, то есть к снятию ограничителя под видом его настройки.
  it.each(ACTIONS)('%s — остаётся на тесной зоне', (route) => {
    expect(locationBody(route)).toContain('zone=import')
  })

  it('каждый гейтованный маршрут отвечает 429, а не молчаливым обрывом', () => {
    for (const route of [...READS, ...ACTIONS]) {
      expect(locationBody(route), `${route}: нет limit_req_status 429`).toContain('limit_req_status 429')
    }
  })
})
