// Автозакрытие вкладки, на которую банк вернул администратора после согласия.
// Страницу рисует backend (server/utils/bankConnectCallback.ts); здесь — только поведение.
//
// Почему отдельный файл, а не inline-скрипт: страница отдаётся под общим CSP сайта
// (`script-src 'self'` без 'unsafe-inline'), поэтому inline пришлось бы разрешать по sha256 и
// держать этот хеш в nginx.conf синхронно с текстом скрипта — гарантия того, что однажды
// поправят одно и забудут другое, и счётчик молча перестанет работать. Тот же origin под 'self'
// проходит без единой оговорки.
//
// Прогрессивное улучшение: без JS страница остаётся правдивой («можно закрыть эту вкладку»),
// счётчик появляется только когда есть кому его крутить.
(function () {
  var hint = document.getElementById('close-hint')
  if (!hint) return

  var total = parseInt(hint.getAttribute('data-seconds') || '', 10)
  if (!(total > 0)) return

  // Тот же текст, что в разметке: к нему возвращаемся и при отмене, и когда закрыть не дали.
  var MANUAL = hint.textContent
  var left = total
  var timer = null

  var label = document.createElement('span')
  var cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Отменить'
  cancel.style.cssText = 'margin-left:.5rem;font:inherit;color:inherit;background:none;'
    + 'border:1px solid currentColor;border-radius:.25rem;padding:.1rem .5rem;cursor:pointer'

  function render() {
    label.textContent = 'Вкладка закроется через ' + left + ' с.'
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    hint.textContent = MANUAL
  }

  cancel.addEventListener('click', stop)

  hint.textContent = ''
  hint.appendChild(label)
  hint.appendChild(cancel)
  render()

  timer = setInterval(function () {
    left -= 1
    if (left > 0) {
      render()
      return
    }
    // Сначала возвращаем честный текст, потом пробуем закрыть: закрыть браузер разрешает только
    // вкладку, открытую скриптом (у нас — window.open из карточки подключения). Если ссылку
    // открыли руками, close() ничего не сделает, и на экране уже будет верная подсказка,
    // а не застывший «закроется через 0 с».
    stop()
    window.close()
  }, 1000)
})()
