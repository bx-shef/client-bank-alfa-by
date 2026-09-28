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
// Та же ссылка внутри `[URL=…]`: квадратные скобки параметров закодированы, иначе закрыли бы тег.
const KEY_LINK_BB = 'https://client.bitrix24.by/marketplace/view/shef.bankimport/?params%5Bplace%5D=app-bank-key&params%5Bt%5D=sig'
const STEP6 = `6. Откройте [URL=${KEY_LINK_BB}]экран подключения банка (client.bitrix24.by)[/URL]`

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

  // ⚠ Вид сообщения — текст владельца ДОСЛОВНО (2026-09-28): пустые строки между блоками и значки
  // чата `:!:`/`:idea:`, которые портал рисует иконками. Сверка целиком: любое «улучшение» текста
  // без владельца этот тест роняет — что и нужно.
  it('совпадает с текстом владельца символ в символ', () => {
    expect(msg).toBe([
      '[B]Подключение банка «Приорбанк» к Битрикс24[/B]',
      '',
      'Администратор портала настраивает импорт выписки. Нужно ваше подтверждение как владельца счёта.',
      '',
      ':!: [B]Ссылка действует около 15 минут с момента отправки этого сообщения.[/B]',
      '',
      `1. Откройте [URL=${LINK}]страницу входа Приорбанка (api.priorbank.by)[/URL].`,
      '2. Войдите логином и паролем от интернет-банка Приорбанка.',
      '3. Подтвердите доступ приложения к выписке по счёту.',
      '4. Откроется страница «Банк подключён» — это всё, вкладку можно закрыть. Счёт в приложении выберет администратор.',
      '',
      ':idea: Не успели или увидели «Не удалось подключить» — попросите администратора прислать новую ссылку.',
      '',
      ':!: Пароль от интернет-банка вводится только на сайте банка: приложение его не видит и не хранит.'
    ].join('\n'))
  })

  // Строка срока условна, а пустые строки-разделители — нет: без них инструкция слипается в абзац.
  // ⚠ Сверка ЦЕЛИКОМ, а не `toContain('\n\n')`: пустая строка после заголовка есть всегда, и проверка
  // «хоть один разрыв» не заметила бы вступление, слипшееся с шагом 1 (находка ревью, мутацией).
  it('без срока сообщение всё равно собирается, остаётся разбитым на блоки и не упоминает «не успели»', () => {
    expect(buildPriorInvite({ link: LINK, ttlMin: 0 })).toBe([
      '[B]Подключение банка «Приорбанк» к Битрикс24[/B]',
      '',
      'Администратор портала настраивает импорт выписки. Нужно ваше подтверждение как владельца счёта.',
      '',
      `1. Откройте [URL=${LINK}]страницу входа Приорбанка (api.priorbank.by)[/URL].`,
      '2. Войдите логином и паролем от интернет-банка Приорбанка.',
      '3. Подтвердите доступ приложения к выписке по счёту.',
      '4. Откроется страница «Банк подключён» — это всё, вкладку можно закрыть. Счёт в приложении выберет администратор.',
      '',
      ':idea: Увидели «Не удалось подключить» — попросите администратора прислать новую ссылку.',
      '',
      ':!: Пароль от интернет-банка вводится только на сайте банка: приложение его не видит и не хранит.'
    ].join('\n'))
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
  // Стоит она В ШАГЕ 6 (замечание владельца 2026-09-28): прежде ссылка была отдельно от шага, и
  // дойдя до него, человек искал её по сообщению.
  it('несёт внутреннюю ссылку портала в шаге 6 и запрещает пересылать ключ', () => {
    expect(msg).toContain(STEP6)
    expect(msg.split('\n').filter(l => /^\d\. /.test(l)).pop()).toContain(STEP6)
    expect(msg).not.toContain(KEY_LINK) // голые скобки закрыли бы тег раньше времени
    expect(msg).toContain('Ключ никому не пересылайте')
    expect(msg).not.toContain('передайте его администратору')
  })

  // Замечание владельца 2026-09-28: «Войдите в Альфа Бизнес Онлайн» — это ссылка на кабинет.
  // ⚠ Домен назван в тексте ссылки: по ней вводят пароль от интернет-банка, а на телефоне адрес не
  // посмотреть наведением (то же правило, что у ссылки Приора; находка ревью).
  it('шаг 1 ведёт в Альфа Бизнес Онлайн ссылкой с названным доменом', () => {
    expect(msg).toContain('1. Войдите в [URL=https://online.alfabank.by/]Альфа Бизнес Онлайн (online.alfabank.by)[/URL].')
  })

  // Замечание владельца 2026-09-28: три поля формы одной строкой читались «в одну кучу».
  it('шаг 3 — по полю формы на строку', () => {
    const lines = msg.split('\n')
    const at = lines.findIndex(l => l.startsWith('3. '))
    expect(lines[at]).toContain('«Генерация ключа API»')
    expect(lines.slice(at + 1, at + 4)).toEqual([
      '• [B]НАЗВАНИЕ[/B] — любое понятное, например «Подключение к Б24»',
      // ⚠ Без `;` вплотную: в чате нет кнопки «скопировать», и знак уехал бы в выделенный client_id.
      '• [B]CLIENT ID[/B] — shef-bank-import',
      '• [B]ТИП КЛЮЧА[/B] — [B]Постоянный ключ[/B]'
    ])
  })

  // Строка срока условна, а разделители — нет (та же ловушка, что у Приора): без срока примечания
  // обязаны остаться отдельными блоками, а не слиться со вступлением (находка инженера панели).
  // Начало сообщения — позиционно и при сроке (обычный случай): пустая строка между вступлением и
  // примечаниями не проверялась ничем (находка QA панели — мутация выживала).
  it('со сроком: вступление, срок и примечания — отдельными блоками', () => {
    expect(msg.split('\n').slice(0, 10)).toEqual([
      '[B]Ключ API «Альфа-Банк» для Битрикс24[/B]',
      '',
      'Администратор портала настраивает импорт выписки. Нужно, чтобы вы выпустили ключ API в кабинете банка и вставили его на экране подключения — по шагам ниже.',
      '',
      ':!: [B]Ссылка на экран подключения действует около 24 ч с момента отправки этого сообщения.[/B] Не успели — попросите администратора прислать новую.',
      '',
      ':!: [B]Ключ никому не пересылайте[/B] — ни в чат, ни администратору: вставьте его сами на экране подключения. Он открывает доступ к выписке по счёту.',
      '',
      ':idea: Ключ бессрочный — заблокировать или отозвать его можно в любой момент в кабинете банка.',
      ''
    ])
  })

  it('без срока примечания остаются отдельными блоками, и срок не упоминается', () => {
    const noTtl = buildAlfaInvite({ clientId: 'shef-bank-import', link: KEY_LINK, ttlHours: 0 })!
    expect(noTtl).not.toContain('действует около')
    expect(noTtl.split('\n').slice(0, 8)).toEqual([
      '[B]Ключ API «Альфа-Банк» для Битрикс24[/B]',
      '',
      'Администратор портала настраивает импорт выписки. Нужно, чтобы вы выпустили ключ API в кабинете банка и вставили его на экране подключения — по шагам ниже.',
      '',
      ':!: [B]Ключ никому не пересылайте[/B] — ни в чат, ни администратору: вставьте его сами на экране подключения. Он открывает доступ к выписке по счёту.',
      '',
      ':idea: Ключ бессрочный — заблокировать или отозвать его можно в любой момент в кабинете банка.',
      ''
    ])
  })

  // ⚠ Домен в тексте ссылки — без квадратных скобок: `URL` отдаёт IPv6-адрес как `[::1]`, и скобка
  // закрыла бы тег `[URL=…]…[/URL]` раньше времени (находка ревью безопасности).
  it('скобки из домена в текст ссылки не попадают', () => {
    const v6 = buildAlfaInvite({ clientId: 'x', link: 'https://[::1]/marketplace/view/a/?params[t]=s', ttlHours: 1 })!
    const step6 = v6.split('\n').find(l => l.startsWith('6. '))!
    expect(step6).toContain('экран подключения банка (::1)[/URL]')
  })

  // Вид — как у сообщения Приорбанка по тексту владельца: пустые строки между блоками и значки
  // `:!:`/`:idea:`. Примечания — ДО шагов, в тексте сообщения (см. раскладку со снимками ниже).
  it('примечания со значками чата стоят до шагов', () => {
    expect(msg).toContain(':!: [B]Ключ никому не пересылайте[/B]')
    expect(msg).toContain(':!: [B]Ссылка на экран подключения действует около 24 ч')
    expect(msg).toContain(':idea: Ключ бессрочный')
    expect(msg.indexOf(':idea:')).toBeLessThan(msg.indexOf('1. '))
    expect(msg.split('\n')[1]).toBe('') // пустая строка после заголовка
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

  // ⚠ Привязку снимка сверяем с его СОДЕРЖАНИЕМ, а не саму с собой (находка QA панели): остальные
  // проверки читают тот же `afterStep`, и перестановка снимка на соседний однострочный шаг проходила
  // зелёной. Подпись снимка называет свой шаг («Шаг 2 — …», «Шаги 3–4 — …») — последнее число в ней
  // обязано совпасть с `afterStep`.
  it('подпись снимка называет тот шаг, после которого он стоит', () => {
    for (const shot of ALFA_KEY_SHOTS) {
      const m = /^Шаги?\s+(\d+)(?:–(\d+))?\s+—/.exec(shot.name)
      expect(m, shot.name).not.toBeNull()
      expect(Number(m![2] ?? m![1]), shot.name).toBe(shot.afterStep)
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
// в тексте сообщения остаются вступление и примечания; ссылка — в шаге 6, внизу вложения (2026-09-28).
describe('инструкция Альфы со снимками кабинета', () => {
  const BASE = 'https://bank-import.example'
  const INPUT = { clientId: 'shef-bank-import', link: KEY_LINK, ttlHours: 24 }
  const guide = buildAlfaInviteGuide(INPUT, BASE)!
  const blocks = guide.attachment.attach
  const images = blocks.filter((b): b is ChatImageBlock => 'IMAGE' in b)
  const texts = blocks.filter((b): b is ChatMessageBlock => 'MESSAGE' in b)
  const stepLines = texts.flatMap(b => b.MESSAGE.split('[BR]'))
  const numbered = stepLines.filter(l => /^\d\. /.test(l))

  it('вложение — МАССИВ блоков, каждый с ОДНИМ ключом-типом', () => {
    // ⚠ Ровно на этом картинки однажды и потерялись. Портал знает две формы: полную
    // (`{ID, BLOCKS:[…]}`) и краткую — массив блоков. Прежний `{IMAGE:[…]}` не подходил ни под одну,
    // и портал принимал его МОЛЧА: сообщение доходило текстом, без картинок и без ошибки.
    expect(Array.isArray(blocks)).toBe(true)
    for (const b of blocks) expect(Object.keys(b)).toHaveLength(1)
  })

  it('все шесть шагов во вложении по порядку, и за каждым снимком — его шаг', () => {
    expect(numbered.map(l => l.split('.')[0])).toEqual(['1', '2', '3', '4', '5', '6'])
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
    const full = buildAlfaInvite(INPUT)!
    for (const line of stepLines) expect(full, line).toContain(line)
    expect(stepLines.join('\n')).toContain('shef-bank-import')
  })

  // ⚠ Ссылка — ВНИЗУ, в шаге 6 (замечание владельца 2026-09-28): прежде она стояла в тексте
  // сообщения над вложением, и дойдя до последнего шага, человек листал сообщение вверх.
  it('ссылка — в последнем шаге, внизу вложения, а в тексте сообщения её нет', () => {
    const last = texts[texts.length - 1]!.MESSAGE.split('[BR]').pop()!
    expect(last.startsWith(STEP6)).toBe(true)
    expect(blocks[blocks.length - 1]).toBe(texts[texts.length - 1])
    expect(guide.text).not.toContain(KEY_LINK)
    expect(guide.text).not.toContain(KEY_LINK_BB)
  })

  it('текст сообщения — вступление и примечания, без шагов и без ссылки', () => {
    expect(guide.text).toContain('Ключ никому не пересылайте')
    expect(guide.text).toContain('около 24 ч')
    expect(guide.text).not.toMatch(/^\d\. /m)
    expect(guide.text).not.toContain('Open API')
  })

  // ⚠ Значки `:!:`/`:idea:` портал рисует иконками в ТЕКСТЕ сообщения (снимок владельца); рисует ли
  // их блок вложения, не замерено. Поэтому во вложение они не попадают.
  it('значки чата — только в тексте сообщения, во вложении их нет', () => {
    expect(guide.text).toMatch(/:!:/)
    for (const b of texts) expect(b.MESSAGE).not.toMatch(/:!:|:idea:/)
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
