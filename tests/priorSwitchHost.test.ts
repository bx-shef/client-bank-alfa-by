import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Гард скрипта переключения хоста Приорбанка (#522).
//
// ⚠ Скрипт правит БОЕВОЙ `.env` и перезапускает сервисы, а исполняется на телефоне одной строкой.
// Проверить его глазами в такой момент невозможно, поэтому инварианты, которые нельзя нарушить,
// закреплены здесь. Всё это уже описано прозой в `docs/PRIOR_API.md` — а проза не падает.

const SCRIPT = readFileSync(join(import.meta.dirname, '..', 'scripts', 'prior-switch-host.sh'), 'utf8')

describe('переключение хоста Приорбанка (#522)', () => {
  it('исходник читается и содержит оба режима', () => {
    expect(SCRIPT).toContain('--to-direct')
    expect(SCRIPT).toContain('--to-gateway')
  })

  it('ОБЕ переменные меняются всегда вместе', () => {
    // ⚠ Половинчатый переезд — худший исход из возможных: подключение и первая выписка строят
    // адрес из `API_BASE`, а обновление токена читает ТОЛЬКО `TOKEN_URL`. Поменяв одну, оператор
    // получит полностью рабочий на вид стенд, который встанет через час, когда истечёт первый
    // токен, — и ошибка будет выглядеть обычным сбоем рефреша, а не незаконченной настройкой.
    expect(SCRIPT).toMatch(/set_var PRIOR_OAUTH_API_BASE\s+"\$NEW_BASE"/)
    expect(SCRIPT).toMatch(/set_var PRIOR_OAUTH_TOKEN_URL\s+"\$NEW_TOKEN"/)
    // И записанное перечитывается: `sed` мог не сработать на неожиданном форматировании файла.
    expect(SCRIPT).toMatch(/\[ "\$\(envv PRIOR_OAUTH_API_BASE\)" = "\$NEW_BASE" \]/)
    expect(SCRIPT).toMatch(/\[ "\$\(envv PRIOR_OAUTH_TOKEN_URL\)" = "\$NEW_TOKEN" \]/)
  })

  it('AUTHORIZE_BASE и AUDIENCE НЕ переписываются', () => {
    // ⚠ Первый — адрес для БРАУЗЕРА владельца счёта, он публичный в обоих режимах (через шлюз
    // браузеру не пройти). Второй — не адрес вовсе, а claim `aud` в подписанном JWT; поменять его
    // «за компанию» значит получить `invalid_client`, сообщение о котором укажет на ключ.
    expect(SCRIPT).not.toMatch(/set_var PRIOR_OAUTH_AUTHORIZE_BASE/)
    expect(SCRIPT).not.toMatch(/set_var PRIOR_OAUTH_AUDIENCE/)
  })

  it('делает резервную копию ДО правки и печатает команду отката', () => {
    const backupAt = SCRIPT.indexOf('cp ./.env "$BACKUP"')
    const editAt = SCRIPT.indexOf('set_var PRIOR_OAUTH_API_BASE')
    expect(backupAt).toBeGreaterThan(-1)
    expect(backupAt).toBeLessThan(editAt)
    expect(SCRIPT).toMatch(/Откат одной командой/)
  })

  it('отказывается вернуться на шлюз, пока сервис закомментирован', () => {
    // ⚠ Переключить переменные на несуществующий сервис — значит уронить опрос в «имя не
    // резолвится», и выглядеть это будет сетевым сбоем банка, а не незаконченной настройкой.
    expect(SCRIPT).toMatch(/grep -qE '\^\[\[:space:\]\]\{2\}crypto-gw:'/)
  })

  it('перезапускает ОБА сервиса, а не один', () => {
    // Подключение живёт на backend, опрос — на worker; перезапустив один, получишь рабочую
    // настройку при неработающем опросе, и разойдутся они молча.
    expect(SCRIPT).toMatch(/up -d backend worker/)
  })

  it('без явного режима ничего не делает', () => {
    // Запуск без аргументов на боевом сервере не должен ничего менять.
    expect(SCRIPT).toMatch(/\[ -n "\$MODE" \] \|\|/)
  })

  it('адреса совпадают с задокументированными', () => {
    expect(SCRIPT).toContain('http://crypto-gw:1080')
    expect(SCRIPT).toContain('https://api.priorbank.by:9344')
    expect(SCRIPT).toContain('/open-banking-authorize/v1.0/oauth2/token')
  })
})
