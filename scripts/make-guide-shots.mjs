// Render the step pictures that ride inside the Alfa API-key instruction the app sends to the
// ACCOUNT OWNER in chat (#19).  Run after editing the markup below:  pnpm guide:shots
//
// WHY THEY ARE DRAWN AND NOT PHOTOGRAPHED. The pictures are attached to a chat message in someone
// else's portal, so they have to be (a) hosted by us for as long as the app lives, (b) free of any
// real key, account number, company name or `client_id`, and (c) identical for every portal,
// including a fork running under its own `client_id`. A screenshot of one real cabinet fails all
// three: it carries that company's data, and its CLIENT ID field would contradict the one the
// message states in text. What the reader actually needs from a picture is WHERE ON THE SCREEN the
// control is and WHAT IT IS CALLED — so the labels are copied verbatim from the bank's cabinet and
// everything else is a wireframe.
//
// ⚠ Deliberately NOT a look-alike of the bank's UI. The cabinet is dark with a photographic
// background; these are flat light cards in our own styling, so nobody can mistake one for the
// bank's own screen. Imitating a bank's interface closely is a bad habit even when the intent is
// instructional.
//
// ⚠ NO CLIENT ID VALUE IN THE PICTURE. It differs per deployment and is already in the message
// text; a baked-in value would be wrong for every fork and would age silently.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { resolveChromium } from './lib/chromium.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT_DIR = join(ROOT, 'public', 'guide')
const WIDTH = 960

// ⚠ Heights differ per shot ON PURPOSE: a uniform canvas left the first and third pictures with a
// third of their area empty, and a chat client scales the whole image down to fit — so the padding
// was paid for in legibility of the labels, which are the only reason the picture exists.
const css = h => `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${WIDTH}px; height: ${h}px; background: #fff;
    font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #0f172a; -webkit-font-smoothing: antialiased;
  }
  .sheet { width: ${WIDTH}px; height: ${h}px; padding: 22px 26px 26px; display: flex; flex-direction: column; }
  .head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 18px; }
  .step { font-size: 22px; font-weight: 800; color: #ef3124; letter-spacing: .2px; }
  .where { font-size: 19px; color: #64748b; }
  .frame { flex: 1; border: 2px solid #cbd5e1; border-radius: 14px; background: #f8fafc; display: flex; overflow: hidden; }
  .rail { width: 168px; background: #e2e8f0; padding: 14px 0; display: flex; flex-direction: column; gap: 9px; }
  .rail div { font-size: 15px; color: #64748b; padding: 5px 16px; letter-spacing: .3px; }
  .rail .on { background: #ef3124; color: #fff; font-weight: 700; border-radius: 0 8px 8px 0; margin-right: 12px; }
  .body { flex: 1; padding: 20px 24px; display: flex; flex-direction: column; }
  .h1 { font-size: 27px; font-weight: 800; margin-bottom: 16px; }
  .tabs { display: flex; gap: 7px; flex-wrap: nowrap; margin-bottom: 20px; }
  .tab { font-size: 14px; padding: 7px 11px; border-radius: 999px; background: #e2e8f0; color: #475569; white-space: nowrap; }
  .tab.on { background: #0f172a; color: #fff; font-weight: 700; box-shadow: 0 0 0 3px #fecaca; }
  .card { background: #fff; border: 2px solid #cbd5e1; border-radius: 12px; padding: 18px 20px; }
  .btn { display: inline-block; font-size: 17px; font-weight: 700; padding: 11px 18px; border-radius: 10px;
         background: #e2e8f0; color: #0f172a; }
  .btn.hi { background: #fff; color: #0f172a; box-shadow: 0 0 0 3px #ef3124; }
  .btn.red { background: #ef3124; color: #fff; box-shadow: 0 0 0 3px #fecaca; }
  .row { display: flex; align-items: center; gap: 12px; }
  .num { flex: none; width: 30px; height: 30px; border-radius: 50%; background: #ef3124; color: #fff;
         font-size: 17px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
  .field { margin-bottom: 14px; }
  .label { font-size: 14px; font-weight: 700; color: #64748b; letter-spacing: .6px; margin-bottom: 5px; }
  .input { font-size: 17px; background: #f1f5f9; border: 2px solid #cbd5e1; border-radius: 9px; padding: 10px 13px; color: #334155; }
  .input.hi { border-color: #ef3124; }
  .muted { font-size: 15px; color: #64748b; }
  .kv { display: flex; gap: 10px; font-size: 16px; margin-bottom: 6px; }
  .kv b { color: #64748b; font-weight: 600; min-width: 190px; }
  .note { margin-top: 14px; font-size: 16px; color: #475569; }
  .radio { display: flex; align-items: center; gap: 9px; font-size: 17px; margin-bottom: 8px; }
  .dot { width: 17px; height: 17px; border-radius: 50%; border: 2px solid #94a3b8; flex: none; }
  .dot.on { border-color: #ef3124; border-width: 5px; }
  .box { width: 17px; height: 17px; border-radius: 4px; border: 2px solid #94a3b8; flex: none;
         display: flex; align-items: center; justify-content: center; font-size: 13px; color: #fff; }
  .box.on { background: #ef3124; border-color: #ef3124; }
`

const sheet = (step, where, inner, h) => `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<style>${css(h)}</style></head><body><div class="sheet">
<div class="head"><div class="step">${step}</div><div class="where">${where}</div></div>
${inner}</div></body></html>`

const RAIL = ['СЧЕТА', 'ВЫПИСКИ', 'ДОКУМЕНТЫ', 'ЗАРПЛАТА', 'КАРТЫ', 'ЭКВАЙРИНГ', 'ПРОДУКТЫ', 'СОБЫТИЯ']
  .map(t => `<div>${t}</div>`).join('') + '<div class="on">НАСТРОЙКИ</div>'

const TABS = ['Общие', 'Пользователи', 'Схема подписания', 'Отчет об импорте']
  .map(t => `<span class="tab">${t}</span>`).join('')
  + '<span class="tab on">Open API</span><span class="tab">Сертификаты</span>'

const shots = [
  {
    file: 'alfa-key-1.png',
    height: 460,
    html: sheet('Шаг 1', 'Альфа Бизнес Онлайн', `<div class="frame">
      <div class="rail">${RAIL}</div>
      <div class="body">
        <div class="h1">Настройки</div>
        <div class="tabs">${TABS}</div>
        <div class="card">
          <div class="row" style="margin-bottom:16px">
            <span class="muted">Ключи API</span><span class="muted">·</span>
            <span class="muted">Сторонние приложения</span><span class="muted">·</span>
            <span class="muted">Аккаунты разработчика</span>
          </div>
          <div class="row"><span class="num">3</span><span class="btn hi">Сгенерировать ключ API</span></div>
        </div>
        <div class="note">
          <span class="num" style="display:inline-flex;vertical-align:-8px;margin-right:8px">1</span>«НАСТРОЙКИ» — в самом низу левого меню.
          <span class="num" style="display:inline-flex;vertical-align:-8px;margin:0 8px 0 14px">2</span>вкладка «Open API».
        </div>
      </div></div>`, 460)
  },
  {
    file: 'alfa-key-2.png',
    height: 560,
    html: sheet('Шаг 2', 'Окно «Генерация ключа API»', `<div class="frame" style="background:#fff;padding:22px 26px;flex-direction:column">
      <div class="h1" style="font-size:24px">Генерация ключа API</div>
      <div class="field"><div class="label">НАЗВАНИЕ</div>
        <div class="input">Подключение к Б24</div>
        <div class="muted" style="margin-top:5px">любое понятное название</div></div>
      <div class="field"><div class="label">CLIENT ID</div>
        <div class="input hi">значение CLIENT ID — в сообщении, скопируйте его оттуда</div></div>
      <div class="field"><div class="label">ТИП КЛЮЧА</div>
        <div class="radio"><span class="dot on"></span><b>Постоянный ключ</b>
          <span class="num" style="margin-left:6px">1</span></div>
        <div class="radio"><span class="dot"></span><span class="muted">Временный ключ</span></div></div>
      <div class="row" style="margin-bottom:16px"><span class="box on">✓</span>
        <span class="muted">Я соглашаюсь на предоставление приложению доступа…</span>
        <span class="num">2</span></div>
      <div class="row"><span class="num">3</span><span class="btn red">Сгенерировать ключ</span></div>
    </div>`, 560)
  },
  {
    file: 'alfa-key-3.png',
    height: 440,
    html: sheet('Шаг 3', 'Вкладка «Ключи API» после генерации', `<div class="frame" style="background:#fff;padding:22px 26px;flex-direction:column">
      <div class="card" style="border-color:#94a3b8">
        <div class="row" style="justify-content:space-between;margin-bottom:16px">
          <div><b style="font-size:19px">ПОДКЛЮЧЕНИЕ К Б24</b>
            <div class="muted" style="margin-top:3px">БЕССРОЧНЫЙ</div></div>
          <div class="row"><span style="color:#16a34a;font-size:17px;font-weight:700">✓ Действителен</span>
            <span class="btn hi" style="padding:6px 12px;font-size:20px">⌃</span><span class="num">1</span></div>
        </div>
        <div class="kv"><b>Идентификатор ключа</b><span class="muted">9X09…99X99</span></div>
        <div class="kv"><b>Дата создания</b><span class="muted">сегодня</span></div>
        <div class="kv" style="margin-bottom:16px"><b>Действует до</b><span class="muted">БЕССРОЧНЫЙ</span></div>
        <div class="row"><span class="num">2</span><span class="btn hi">Скопировать ключ</span>
          <span class="btn">Заблокировать</span><span class="btn">Отозвать</span></div>
      </div>
      <div class="note"><span class="num" style="display:inline-flex;vertical-align:-8px;margin-right:8px">1</span>раскройте строку ключа стрелкой справа, потом
        <span class="num" style="display:inline-flex;vertical-align:-8px;margin:0 8px">2</span>«Скопировать ключ».</div>
      <div class="note" style="color:#ef3124;font-weight:700">Ключ никому не пересылайте — вставьте его сами по ссылке из сообщения.</div>
    </div>`, 440)
  }
]

const browser = await chromium.launch({ executablePath: await resolveChromium() })
try {
  await mkdir(OUT_DIR, { recursive: true })
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: shot.height }, deviceScaleFactor: 1 })
    await page.setContent(shot.html, { waitUntil: 'networkidle' })
    const out = join(OUT_DIR, shot.file)
    await page.screenshot({ path: out, type: 'png', clip: { x: 0, y: 0, width: WIDTH, height: shot.height } })
    await page.close()
    console.log(`✓ ${out.replace(ROOT, '.')} (${WIDTH}×${shot.height})`)
  }
} finally {
  await browser.close()
}
