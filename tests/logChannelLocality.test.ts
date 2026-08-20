import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ⚠ Сторож РЕШЕНИЯ, а не кода (#525). Мы печатаем `member_id` в логах воркера ОТКРЫТО, тогда как
// телеметрия и Telegram-алерты то же значение хешируют. Расхождение осознанное, и критерий у него
// один: хеш там, где значение покидает наш периметр. Логи его сегодня не покидают — драйвер
// локальный, внешнего сборщика нет.
//
// ⚠ Само решение записано в `docs/PRIVACY.md` §Логи, но запись — это напоминание, а напоминание
// срабатывает, только если его прочитают ровно в нужный момент. Нужный момент здесь — чужая правка
// инфраструктуры («добавим сбор логов»), у которой с приватностью `member_id` нет ничего общего на
// вид. Поэтому напоминание сделано ТЕСТОМ: он падает в тот момент, когда канал меняет класс.
//
// ⚠ Охват честный и неполный: тест видит только то, что описано В РЕПОЗИТОРИИ. Агент, поднятый на
// хосте руками или через `daemon.json` демона docker, пройдёт мимо. Он закрывает обычный путь, а не
// все — и это лучше, чем не закрывать ничего.

const root = new URL('../', import.meta.url)
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, root)), 'utf8')

/** Драйверы, при которых логи остаются на хосте. Всё остальное куда-то их ОТПРАВЛЯЕТ. */
const LOCAL_DRIVERS = ['json-file', 'local', 'none']

/** Образы/имена сервисов, чьё появление означает «логи теперь собирают». */
const SHIPPER_MARKERS = /fluentd|fluent-bit|logstash|filebeat|vector|promtail|loki|datadog|sentry|splunk|graylog|newrelic|logdna/i

/**
 * Значения `driver:` из блоков `logging:` / `x-logging:` — и только из них. Блок опознаётся по
 * отступу: всё, что вложено глубже заголовка, принадлежит ему. `logging: *anchor` собственного
 * драйвера не объявляет — его даёт якорь, который здесь же и разбирается.
 */
function loggingDrivers(src: string): string[] {
  const lines = src.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    // ⚠ Заголовок может нести ЯКОРЬ (`x-logging: &default-logging`) — именно так драйвер и
    // задан в проде. Требование «строка кончается двоеточием» пропускало этот блок целиком,
    // и тест зеленел, не найдя НИ ОДНОГО драйвера. Поймано мутацией, а не вычитано.
    const head = /^(\s*)(?:x-)?logging:\s*(?:&[\w.-]+)?\s*$/.exec(lines[i]!)
    if (!head) continue
    const base = head[1]!.length
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!
      if (line.trim() === '' || /^\s*#/.test(line)) continue
      const indent = line.length - line.trimStart().length
      if (indent <= base) break // блок кончился
      const d = /^\s*driver:\s*"?([\w.-]+)"?/.exec(line)
      if (d) out.push(d[1]!)
    }
  }
  return out
}

describe('логи остаются локальным каналом (#525)', () => {
  const composeFiles = readdirSync(fileURLToPath(root))
    .filter(f => /^docker-compose.*\.ya?ml$/.test(f))

  it('в репозитории есть compose-файлы для проверки', () => {
    // Иначе тест зелёный по пустому множеству и не значит ничего.
    expect(composeFiles.length).toBeGreaterThan(0)
  })

  it.each(composeFiles)('%s: лог-драйвер локальный', (file) => {
    // ⚠ Берём `driver:` ТОЛЬКО из блоков `logging:`/`x-logging:`, по отступу. Широкий поиск любого
    // `driver:` не годится: в compose их несколько видов, и `driver: bridge` у сети — это не про
    // логи вовсе. Такой тест падал бы на здоровом файле, а тест, который врёт, снимают.
    const src = read(file)
    const drivers = loggingDrivers(src)
    // ⚠ Пустой список значит РАЗНОЕ, и различать обязательно: в dev-файле блока `logging:` нет
    // вовсе (драйвер тогда — умолчание docker, то есть локальный `json-file`), а вот блок, который
    // ЕСТЬ, но не дал ни одного драйвера, — это сломавшийся разбор, и он зеленит тест впустую.
    // Ровно так первая редакция и прошла мутацию `json-file → gelf`: заголовок с якорем
    // (`x-logging: &default-logging`) не совпал, драйверов нашлось ноль, цикл ниже не выполнился.
    if (/^\s*(?:x-)?logging:/m.test(src)) {
      expect(drivers.length, `${file}: блок logging есть, а драйвера не нашлось — разбор сломался`)
        .toBeGreaterThan(0)
    }
    for (const d of drivers) {
      expect(
        LOCAL_DRIVERS.includes(d),
        `драйвер «${d}» в ${file} отправляет логи наружу — логи сменили класс канала, `
        + 'и решение печатать `member_id` открыто (docs/PRIVACY.md §Логи, #525) надо пересмотреть'
      ).toBe(true)
    }
  })

  it.each(composeFiles)('%s: нет сервиса-сборщика логов', (file) => {
    // ⚠ Закомментированные строки не считаем: в `docker-compose.prod.yml` целые сервисы лежат
    // выключенными намеренно (крипто-шлюз), и запретить упоминание в комментарии значило бы
    // запретить обсуждать вариант.
    const active = read(file).split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    const hit = active.match(SHIPPER_MARKERS)
    expect(
      hit,
      `в ${file} появился сборщик логов (${hit?.[0]}) — логи сменили класс канала, `
      + 'и решение печатать `member_id` открыто (docs/PRIVACY.md §Логи, #525) надо пересмотреть'
    ).toBeNull()
  })

  it('решение действительно записано, а не только застережено тестом', () => {
    // Тест говорит «что-то изменилось», документ говорит «и вот почему это важно». Без второго
    // упавший тест выглядит придиркой, и его снимут, не поняв, что снимают.
    const privacy = read('docs/PRIVACY.md')
    expect(privacy).toContain('#525')
    expect(privacy, 'в PRIVACY.md нет разбора member_id в логах').toMatch(/member_id.{0,40}в логах/)
  })
})
