// Self-closing countdown for the tab the bank redirects the account holder back to.
// The page itself is rendered by the backend (server/utils/bankConnectCallback.ts); this file
// carries only the behaviour.
//
// Why a separate file and not an inline script: the page is served under the site's CSP
// (`script-src 'self'`, no 'unsafe-inline'), so an inline block would have to be allowed by its
// sha256 and that hash kept in nginx.conf in step with the script's text — a guarantee that
// someone eventually edits one and forgets the other, and the countdown quietly stops working.
// A same-origin file is covered by 'self' with no caveat at all.
//
// Progressive enhancement: with no JS the page stays truthful («можно закрыть эту вкладку») —
// the countdown is drawn by this script, so it only ever claims what it can deliver.
//
// ⚠ Deployment skew is SAFE in both directions, and that is deliberate. The static image and the
// backend image are published and pulled independently, so one can be newer than the other for a
// few minutes. New backend + old static ⇒ this file 404s and the paragraph keeps its static text.
// Old backend + new static ⇒ nothing references the file. Do not make the page depend on the
// script having run.
(function () {
  var hint = document.getElementById('close-hint')
  if (!hint) return

  var total = parseInt(hint.getAttribute('data-seconds') || '', 10)
  if (!(total > 0)) return

  // The markup's own text: what we restore on cancel and when close() is refused.
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
    // Restore the honest text FIRST, then try to close: a browser only lets a script close a tab
    // that a script opened (ours comes from window.open in the connect card). The link is often
    // handed to the account holder, who opens it by hand — there close() does nothing, and the
    // page must already read correctly instead of freezing on «закроется через 0 с».
    stop()
    window.close()
  }, 1000)
})()
