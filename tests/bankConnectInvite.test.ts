import { describe, expect, it } from 'vitest'
import { buildAlfaInvite, buildBankInvite, buildPriorInvite } from '../app/utils/bankConnectInvite'

// Сообщение, которым администратор передаёт подключение банка ВЛАДЕЛЬЦУ СЧЁТА (#19).

const LINK = 'https://api.priorbank.by:9344/authorize?request=eyJ0eXAiOi'

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
  const msg = buildAlfaInvite({ clientId: 'shef-bank-import' })!

  // ⚠ Шаги дословно повторяют надписи кабинета банка — пересказ своими словами заставляет искать
  // несуществующий пункт меню.
  it('повторяет надписи кабинета банка и несёт client_id', () => {
    expect(msg).toContain('Альфа Бизнес Онлайн')
    expect(msg).toContain('Open API')
    expect(msg).toContain('Постоянный ключ')
    expect(msg).toContain('shef-bank-import')
  })

  it('предупреждает, что ключ — это доступ к счёту', () => {
    expect(msg).toContain('не пересылайте его посторонним')
  })

  // ⚠ Без `client_id` инструкция доводит человека до обязательного поля, которое нечем заполнить.
  it('без client_id сообщение не собирается', () => {
    expect(buildAlfaInvite({ clientId: '' })).toBeNull()
    expect(buildAlfaInvite({ clientId: 'с пробелом' })).toBeNull()
  })

  // Ссылки у Альфы нет вовсе: она подключается ключом API (#488).
  it('ссылки в нём нет', () => {
    expect(msg).not.toContain('http')
  })
})

describe('выбор сообщения по банку', () => {
  it('каждому банку своё', () => {
    const prior = buildBankInvite('prior-by', { prior: { link: LINK, ttlMin: 15 } })
    const alfa = buildBankInvite('alfa-by', { alfa: { clientId: 'x' } })
    expect(prior).toContain(LINK)
    expect(alfa).toContain('Open API')
  })

  // Ручная загрузка файла — банка нет, приглашать некуда.
  it('manual ⇒ null', () => {
    expect(buildBankInvite('manual', { alfa: { clientId: 'x' } })).toBeNull()
  })

  it('нет входных данных для банка ⇒ null, а не полусообщение', () => {
    expect(buildBankInvite('prior-by', {})).toBeNull()
    expect(buildBankInvite('alfa-by', {})).toBeNull()
  })
})
