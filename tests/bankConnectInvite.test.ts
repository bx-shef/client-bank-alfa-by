import { describe, expect, it } from 'vitest'
import { buildAlfaInvite, buildBankInvite, buildPriorInvite } from '../app/utils/bankConnectInvite'

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
