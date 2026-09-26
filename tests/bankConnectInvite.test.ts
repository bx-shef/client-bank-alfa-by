import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ALFA_KEY_SHOTS, buildAlfaInvite, buildAlfaInviteGuide, buildBankInvite, buildPriorInvite
} from '../app/utils/bankConnectInvite'
import type { ChatImageBlock, ChatMessageBlock } from '../app/utils/chatAttach'

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url))

// Сообщение, которым администратор передаёт подключение банка ВЛАДЕЛЬЦУ СЧЁТА (#19).

const LINK = 'https://api.priorbank.by:9344/authorize?request=eyJ0eXAiOi'
const KEY_LINK = 'https://client.bitrix24.by/marketplace/view/shef.bankimport/?params[place]=app-bank-key&params[t]=sig'

describe('приглашение Приорбанка', () => {
  const msg = buildPriorInvite({ link: LINK, ttlMin: 15 })!

  // ⚠ Ссылка ПОД ТЕКСТОМ, а не голой строкой: настоящий адрес авторизации — больше двух тысяч
  // знаков, и в чате он хоронил сами шаги под тремя десятками строк сплошных символов.
  it('ссылка спрятана под текст, и в тексте ссылки назван домен банка', () => {
    expect(msg).toContain(`[URL=${LINK}]`)
    expect(msg.split('\n')).not.toContain(LINK)
    // Сообщение просит ввести пароль от банка — человек вправе видеть, куда ведёт ссылка, не
    // наводя на неё мышь (на телефоне навести нечем).
    expect(msg).toMatch(/\[URL=[^\]]+\][^[]*api\.priorbank\.by[^[]*\[\/URL\]/)
  })

  it('квадратная скобка в адресе не закрывает тег раньше времени', () => {
    const odd = buildPriorInvite({ link: 'https://api.priorbank.by/x?a[b]=1', ttlMin: 15 })!
    expect(odd).toContain('[URL=https://api.priorbank.by/x?a%5Bb%5D=1]')
  })

  it('срок назван ДО шагов — о пятнадцати минутах стоит узнать прежде, чем начинать', () => {
    expect(msg.indexOf('около 15 минут')).toBeGreaterThan(-1)
    expect(msg.indexOf('около 15 минут')).toBeLessThan(msg.indexOf('1. '))
  })

  // Прежняя редакция обрывалась на «подтвердите доступ»: чем кончается путь, владелец счёта узнавал
  // от страницы, которая предлагала ему выбрать счёт в настройках — дело не по его правам.
  it('шаги доводят до конца: что будет после подтверждения и кто выбирает счёт', () => {
    const steps = msg.split('\n').filter(l => /^\d\. /.test(l))
    expect(steps.map(l => l[0])).toEqual(['1', '2', '3', '4'])
    expect(steps[3]).toContain('выберет администратор')
  })

  // ⚠ СРОК — ТОЛЬКО ДЛИТЕЛЬНОСТЬ, и стенного времени в сообщении быть не должно (решение
  // владельца): получатель — сотрудник портала, он может сидеть в любом поясе и прочитает время
  // чужого пояса как своё. Инвариант закреплён отрицанием, иначе «удобную» подсказку вернут.
  it('называет срок длительностью и НЕ называет стенным временем', () => {
    expect(msg).toContain('около 15 минут с момента отправки')
    expect(msg).not.toMatch(/\d{1,2}:\d{2}/)
    expect(msg).not.toContain('Минск')
  })

  // Главное предупреждение: приложение не просит и не видит пароль от интернет-банка.
  it('говорит, что пароль вводится только на сайте банка', () => {
    expect(msg).toContain('только на сайте банка')
  })

  // ⚠ Негодная ссылка ⇒ null: сообщение с нерабочим адресом отправляет человека в банк зря, а
  // выглядит как наша поломка. Последний случай проходит грубую проверку формы, но не разбирается
  // как адрес — назвать его домен было бы нечем.
  it('негодная ссылка ⇒ null', () => {
    for (const bad of ['', 'http://insecure.test/x', 'не ссылка', 'https://host', 'https://a%zz/x']) {
      expect(buildPriorInvite({ link: bad, ttlMin: 15 }), bad).toBeNull()
    }
  })

  // Строка срока условна, а пустые строки-разделители — нет: без них инструкция слипается в абзац.
  it('без срока сообщение всё равно собирается, остаётся разбитым на блоки и не упоминает «не успели»', () => {
    const noTtl = buildPriorInvite({ link: LINK, ttlMin: 0 })!
    expect(noTtl).toContain(`[URL=${LINK}]`)
    expect(noTtl).toContain('\n\n')
    expect(noTtl).not.toContain('Не успели')
  })
})

describe('приглашение Альфа-Банка', () => {
  const msg = buildAlfaInvite({ clientId: 'shef-bank-import', link: KEY_LINK, ttlHours: 24 })!

  // ⚠ Шаги дословно повторяют надписи кабинета банка — пересказ своими словами заставляет искать
  // несуществующий пункт меню.
  it('повторяет надписи кабинета банка и несёт client_id', () => {
    expect(msg).toContain('Альфа Бизнес Онлайн')
    expect(msg).toContain('Open API')
    expect(msg).toContain('Постоянный ключ')
    expect(msg).toContain('shef-bank-import')
  })

  it('предупреждает, что ключ — это доступ к счёту', () => {
    expect(msg).toContain('открывает доступ к выписке по счёту')
  })

  // ⚠ Без `client_id` инструкция доводит человека до обязательного поля, которое нечем заполнить.
  it('без client_id сообщение не собирается', () => {
    expect(buildAlfaInvite({ clientId: '', link: KEY_LINK, ttlHours: 24 })).toBeNull()
    expect(buildAlfaInvite({ clientId: 'с пробелом', link: KEY_LINK, ttlHours: 24 })).toBeNull()
  })

  // ⚠ Без ссылки на экран ввода ключ некуда девать, кроме как переслать в чат — ровно то, от чего
  // экран и заведён. Полуинструкция здесь хуже отсутствующей.
  it('без ссылки на экран ввода сообщение не собирается', () => {
    expect(buildAlfaInvite({ clientId: 'x', link: '', ttlHours: 24 })).toBeNull()
    expect(buildAlfaInvite({ clientId: 'x', link: 'не ссылка', ttlHours: 24 })).toBeNull()
  })

  // ⚠ Ссылка ведёт на НАШ экран внутри портала, а не на сайт банка: ключ вводится там, где выпущен.
  it('несёт внутреннюю ссылку портала и запрещает пересылать ключ', () => {
    expect(msg).toContain(KEY_LINK)
    expect(msg).toContain('Ключ никому не пересылайте')
    expect(msg).not.toContain('передайте его администратору')
  })
})

describe('выбор сообщения по банку', () => {
  it('каждому банку своё', () => {
    const prior = buildBankInvite('prior-by', { prior: { link: LINK, ttlMin: 15 } })
    const alfa = buildBankInvite('alfa-by', { alfa: { clientId: 'x', link: KEY_LINK, ttlHours: 24 } })
    expect(prior).toContain(LINK)
    expect(alfa).toContain('Open API')
  })

  // Ручная загрузка файла — банка нет, приглашать некуда.
  it('manual ⇒ null', () => {
    expect(buildBankInvite('manual', { alfa: { clientId: 'x', link: KEY_LINK, ttlHours: 24 } })).toBeNull()
  })

  it('нет входных данных для банка ⇒ null, а не полусообщение', () => {
    expect(buildBankInvite('prior-by', {})).toBeNull()
    expect(buildBankInvite('alfa-by', {})).toBeNull()
  })
})

describe('картинки шагов к инструкции Альфы', () => {
  it('каждый файл манифеста ЛЕЖИТ в public/', () => {
    // ⚠ Главный гард этого блока. Ссылка уезжает в чат ЧУЖОГО портала, и сообщение задним числом
    // не правится: промахнувшись файлом, мы оставляем клиенту битую картинку НАВСЕГДА. Проверяем
    // существование на диске, а не совпадение строк, — переименование файла ловится только так.
    for (const shot of ALFA_KEY_SHOTS) {
      expect(existsSync(join(PUBLIC, shot.file)), shot.file).toBe(true)
    }
  })

  it('размеры в манифесте совпадают с самим PNG', () => {
    // ⚠ Битрикс24 рисует место под картинку ПО ЗАЯВЛЕННЫМ размерам, поэтому разошедшееся число —
    // это не «неточность», а рамка не по картинке у получателя. Снимки меняют руками (новый
    // скриншот кабинета — другие размеры), манифест — отдельный файл, и синхронность их держит
    // только этот тест.
    for (const shot of ALFA_KEY_SHOTS) {
      const head = readFileSync(join(PUBLIC, shot.file)).subarray(16, 24)
      expect([head.readUInt32BE(0), head.readUInt32BE(4)], shot.file).toEqual([shot.width, shot.height])
    }
  })

  it('у каждого снимка свой шаг, по порядку и в пределах инструкции', () => {
    // ⚠ Снимок, привязанный к несуществующему шагу, не попал бы во вложение ВОВСЕ — молча.
    const steps = ALFA_KEY_SHOTS.map(s => s.afterStep)
    expect(steps).toEqual([...steps].sort((a, b) => a - b))
    expect(new Set(steps).size).toBe(steps.length)
    for (const n of steps) expect(n >= 1 && n <= 6, `шаг ${n}`).toBe(true)
  })
})

// Раскладка «шаг — и сразу его снимок» (решение владельца 2026-09-26): шаги переезжают во вложение,
// в тексте сообщения остаются вступление, ссылка и предупреждения.
describe('инструкция Альфы со снимками кабинета', () => {
  const BASE = 'https://bank-import.example'
  const INPUT = { clientId: 'shef-bank-import', link: KEY_LINK, ttlHours: 24 }
  const guide = buildAlfaInviteGuide(INPUT, BASE)!
  const blocks = guide.attachment.attach
  const images = blocks.filter((b): b is ChatImageBlock => 'IMAGE' in b)
  const texts = blocks.filter((b): b is ChatMessageBlock => 'MESSAGE' in b)
  const stepLines = texts.flatMap(b => b.MESSAGE.split('[BR]'))

  it('вложение — МАССИВ блоков, каждый с ОДНИМ ключом-типом', () => {
    // ⚠ Ровно на этом картинки однажды и потерялись. Портал знает две формы: полную
    // (`{ID, BLOCKS:[…]}`) и краткую — массив блоков. Прежний `{IMAGE:[…]}` не подходил ни под одну,
    // и портал принимал его МОЛЧА: сообщение доходило текстом, без картинок и без ошибки.
    expect(Array.isArray(blocks)).toBe(true)
    for (const b of blocks) expect(Object.keys(b)).toHaveLength(1)
  })

  it('все шесть шагов во вложении по порядку, и за каждым снимком — его шаг', () => {
    expect(stepLines.map(l => l.split('.')[0])).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(images).toHaveLength(ALFA_KEY_SHOTS.length)
    ALFA_KEY_SHOTS.forEach((shot, i) => {
      const at = blocks.indexOf(images[i]!)
      const before = blocks[at - 1] as ChatMessageBlock
      // Снимок стоит СРАЗУ за текстовым блоком, последняя строка которого — его шаг.
      expect(before.MESSAGE.split('[BR]').pop()!.startsWith(`${shot.afterStep}. `), shot.file).toBe(true)
    })
  })

  it('каждый снимок — отдельным блоком, а не плиткой в ряд', () => {
    // ⚠ Несколько картинок в одном блоке портал рисует плиткой с обрезкой (замер владельца
    // 2026-09-26): стрелки на кнопки уходили за край.
    for (const b of images) expect(b.IMAGE).toHaveLength(1)
  })

  it('строки текстового блока разделены [BR], а не переводом строки', () => {
    // Во вложении перенос строки — BB-код: голый `\n` портал склеил бы в одну строку.
    for (const b of texts) expect(b.MESSAGE).not.toContain('\n')
    expect(texts.some(b => b.MESSAGE.includes('[BR]'))).toBe(true)
  })

  it('шаги — ТЕ ЖЕ, что в полном тексте: источник один', () => {
    // Шаг 6 отличается одним словом: ссылка в полном тексте ниже шагов, а здесь — над вложением.
    const full = buildAlfaInvite(INPUT)!
    for (const line of stepLines.slice(0, 5)) expect(full, line).toContain(line)
    expect(stepLines[5]).toContain('ссылку выше')
    expect(stepLines.join('\n')).toContain('shef-bank-import')
  })

  it('текст сообщения — вступление, ссылка и предупреждения, без шагов', () => {
    expect(guide.text).toContain(KEY_LINK)
    expect(guide.text).toContain('Ключ никому не пересылайте')
    expect(guide.text).toContain('около 24 ч.')
    expect(guide.text).not.toMatch(/^\d\. /m)
    expect(guide.text).not.toContain('Open API')
  })

  it('запасной текст — ПОЛНАЯ инструкция со всеми шагами', () => {
    // ⚠ Несущий инвариант: портал может отвергнуть вложение, и тогда без полного текста владелец
    // счёта получил бы ссылку без единого шага.
    expect(guide.attachment.fallbackText).toBe(buildAlfaInvite(INPUT))
  })

  it('ссылки на снимки — абсолютные https на статику приложения', () => {
    for (const b of images) {
      const img = b.IMAGE[0]!
      expect(img.LINK.startsWith(`${BASE}/guide/`)).toBe(true)
      // PREVIEW обязателен для части клиентов; своей уменьшенной копии у нас нет — тот же файл.
      expect(img.PREVIEW).toBe(img.LINK)
      expect(img.WIDTH).toBeGreaterThan(0)
      expect(img.NAME).not.toBe('')
    }
  })

  it('вложение далеко от предела портала в 60 000 символов', () => {
    expect(JSON.stringify(blocks).length).toBeLessThan(60_000)
  })

  it('лишняя косая черта в базе не даёт двойного слеша', () => {
    const img = (buildAlfaInviteGuide(INPUT, `${BASE}//`)!.attachment.attach
      .find((b): b is ChatImageBlock => 'IMAGE' in b)!).IMAGE[0]!
    expect(img.LINK).toBe(`${BASE}/${ALFA_KEY_SHOTS[0]!.file}`)
  })

  it('негодная база ⇒ null, а не «почти ссылка»', () => {
    // ⚠ Картинку тянет САМ Битрикс24: по относительному или http-адресу получатель увидит пустое
    // место — молча. Вызывающий тогда шлёт полный текст без вложения.
    for (const bad of ['', '   ', '/guide', 'bank-import.example', 'http://bank-import.example',
      'https://bank import.example', 'ftp://bank-import.example']) {
      expect(buildAlfaInviteGuide(INPUT, bad), bad).toBeNull()
    }
  })

  it('негодный ввод ⇒ null, как и у полного текста', () => {
    expect(buildAlfaInviteGuide({ ...INPUT, clientId: '' }, BASE)).toBeNull()
    expect(buildAlfaInviteGuide({ ...INPUT, link: 'не ссылка' }, BASE)).toBeNull()
  })
})
