import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ALFA_KEY_SHOTS, buildAlfaInvite, buildAlfaInviteAttach, buildBankInvite, buildPriorInvite
} from '../app/utils/bankConnectInvite'

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url))

// Сообщение, которым администратор передаёт подключение банка ВЛАДЕЛЬЦУ СЧЁТА (#19).

const LINK = 'https://api.priorbank.by:9344/authorize?request=eyJ0eXAiOi'
const KEY_LINK = 'https://client.bitrix24.by/marketplace/view/shef.bankimport/?params[place]=app-bank-key&params[t]=sig'

describe('приглашение Приорбанка', () => {
  const msg = buildPriorInvite({ link: LINK, ttlMin: 15 })!

  it('несёт саму ссылку', () => {
    expect(msg).toContain(LINK)
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
  // выглядит как наша поломка.
  it('негодная ссылка ⇒ null', () => {
    for (const bad of ['', 'http://insecure.test/x', 'не ссылка', 'https://host']) {
      expect(buildPriorInvite({ link: bad, ttlMin: 15 }), bad).toBeNull()
    }
  })

  // Строка срока условна, а пустые строки-разделители — нет: без них инструкция слипается в абзац.
  it('без срока сообщение всё равно собирается и остаётся разбитым на блоки', () => {
    const noTtl = buildPriorInvite({ link: LINK, ttlMin: 0 })!
    expect(noTtl).toContain(LINK)
    expect(noTtl).toContain('\n\n')
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
  const BASE = 'https://bank-import.example'
  const attach = buildAlfaInviteAttach(BASE)!

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
    // это не «неточность», а рамка не по картинке у получателя. Генератор менять размеры волен
    // (`pnpm guide:shots`), манифест — отдельный файл, и синхронность их держит только этот тест.
    for (const shot of ALFA_KEY_SHOTS) {
      const head = readFileSync(join(PUBLIC, shot.file)).subarray(16, 24)
      expect([head.readUInt32BE(0), head.readUInt32BE(4)], shot.file).toEqual([shot.width, shot.height])
    }
  })

  it('строит абсолютные https-ссылки на все шаги', () => {
    expect(attach.IMAGE).toHaveLength(ALFA_KEY_SHOTS.length)
    for (const img of attach.IMAGE) {
      expect(img.LINK.startsWith(`${BASE}/guide/`)).toBe(true)
      // PREVIEW обязателен для части клиентов; своей уменьшенной копии у нас нет — тот же файл.
      expect(img.PREVIEW).toBe(img.LINK)
      expect(img.WIDTH).toBeGreaterThan(0)
      expect(img.NAME).not.toBe('')
    }
  })

  it('лишняя косая черта в базе не даёт двойного слеша', () => {
    const img = buildAlfaInviteAttach('https://bank-import.example//')!.IMAGE[0]!
    expect(img.LINK).toBe(`${BASE}/guide/${ALFA_KEY_SHOTS[0]!.file.split('/').pop()}`)
  })

  it('негодная база ⇒ null, а не «почти ссылка»', () => {
    // ⚠ Картинку тянет САМ Битрикс24: по относительному или http-адресу получатель увидит пустое
    // место — молча. Отсутствие вложения честнее: текст инструкции самодостаточен.
    for (const bad of ['', '   ', '/guide', 'bank-import.example', 'http://bank-import.example',
      'https://bank import.example', 'ftp://bank-import.example']) {
      expect(buildAlfaInviteAttach(bad), bad).toBeNull()
    }
  })
})
