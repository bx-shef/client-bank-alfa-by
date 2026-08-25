#!/usr/bin/env node
/*
 * Подставляет в CSP собранного nginx.conf домены КОРОБОЧНОГО портала Bitrix24.
 *
 * Зачем: в конфиге перечислены только облачные `*.bitrix24.<tld>`. Портал у клиента
 * может быть коробочным (`portal.example.by`), и тогда браузер режет две вещи разом —
 * `frame-ancestors` не пускает наш iframe внутрь портала, а `connect-src` не даёт
 * странице обращаться к порталу. Снаружи приложение при этом открывается, поэтому
 * симптом выглядит как «в портале пустой фрейм», а не как ошибка конфигурации.
 *
 * Почему на СБОРКЕ, а не в рантайме: CSP живёт в nginx.conf образа рядом с хешами
 * инлайн-скриптов, которые тоже считаются на сборке (scripts/csp-hashes.mjs). Второй
 * механизм подстановки — вторая точка отказа ради одной строки.
 *
 * Использование: node scripts/csp-portal-origins.mjs [origins] [inConf] [outConf]
 *   origins  список доменов через запятую/пробел (по умолчанию — $B24_PORTAL_ORIGINS)
 *
 * Пустой список — ШТАТНЫЙ случай (облачный портал): токен заменяется пустой строкой.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const TOKEN = '__B24_PORTAL_ORIGINS__'

/**
 * Приводит запись к источнику CSP.
 *
 * ⚠ Значение приходит из переменной CI, то есть снаружи файла, и попадает В ЗАГОЛОВОК
 * ОТВЕТА. Поэтому проверка строгая, а не «почистим пробелы»: точка с запятой закрыла бы
 * директиву и позволила дописать в CSP свою (например, вернуть `script-src *`), а перенос
 * строки — разорвать заголовок. Пускаем ровно `https://host` и `https://*.host`.
 */
export function normalizeOrigin(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return null
  const withScheme = /^https:\/\//i.test(value) ? value : `https://${value}`
  // Хост, при желании с одной wildcard-меткой слева. Ни пути, ни порта, ни данных после хоста:
  // источник CSP такого вида — это то, что нам нужно, а всё прочее подозрительно по построению.
  const match = /^https:\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.exec(withScheme)
  return match ? `https://${match[1] ?? ''}${match[2].toLowerCase()}` : null
}

/** Список источников → строка для вставки в CSP (с ведущим пробелом либо пустая). */
export function buildOriginList(input) {
  const parts = String(input ?? '')
    .split(/[\s,]+/)
    .map(normalizeOrigin)
    .filter(v => v !== null)
  // Дедуп: повтор источника в CSP безвреден, но заголовок читают люди.
  const unique = [...new Set(parts)]
  return unique.length ? ` ${unique.join(' ')}` : ''
}

/** Замена токена во всех местах конфига. */
export function injectOrigins(conf, input) {
  return conf.split(TOKEN).join(buildOriginList(input))
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const [origins = process.env.B24_PORTAL_ORIGINS ?? '', inConf = 'nginx.conf', outConf = inConf]
    = process.argv.slice(2)
  const conf = readFileSync(inConf, 'utf8')
  if (!conf.includes(TOKEN)) {
    // Отсутствие токена — это НЕ «нечего делать»: значит конфиг разошёлся со скриптом,
    // и коробочный портал молча остался бы за бортом CSP.
    console.error(`csp-portal-origins: в ${inConf} нет токена ${TOKEN}`)
    process.exit(1)
  }
  const list = buildOriginList(origins)
  writeFileSync(outConf, injectOrigins(conf, origins))
  console.log(`csp-portal-origins: домены портала в CSP —${list || ' (нет, облачный портал)'}`)
}
