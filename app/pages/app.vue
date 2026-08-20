<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SettingsIcon from '@bitrix24/b24icons-vue/outline/SettingsIcon'
import UploadFileIcon from '@bitrix24/b24icons-vue/outline/UploadFileIcon'
import { splitByDirection } from '~/utils/statement'
import type { OperationDirection, StatementItem } from '~/types/statement'
import { useB24 } from '~/composables/useB24'
import { useImportStatus } from '~/composables/useImportStatus'
import { useSetupStatus } from '~/composables/useSetupStatus'
import { useIsAdmin } from '~/composables/useIsAdmin'
import { useChatSettings } from '~/composables/useChatSettings'
import { useSettingsSync } from '~/composables/useSettingsSync'
import { pageTitle } from '~/utils/landing'
import { useLogger } from '~/utils/logger'
import { isPreviewQuery } from '~/utils/inPortalGate'
import {
  APP_SLIDER_PLACE_IMPORT,
  APP_SLIDER_PLACE_SETTINGS,
  APP_SLIDER_WIDTH
} from '~/config/b24'

const log = useLogger('app')

// In-portal page: `clear` layout wraps it in <B24App> so b24ui theming/colorMode
// work inside the iframe; standalone (direct URL) it just renders the same UI.
definePageMeta({ layout: 'clear' })

// Служебная страница: пререндерится в статику и отдаётся публично, но в выдаче ей делать нечего —
// без `noindex` она уходила в индекс с мета-данными ЛЕНДИНГА (#425). Закрываем именно мета-тегом, а
// не `Disallow` в robots.txt: краулер, послушавший `Disallow`, страницу не скачает, не увидит
// `noindex` и вполне может показать голый URL по внешней ссылке.
useHead({
  title: pageTitle('Выписка по счёту'),
  meta: [{ name: 'robots', content: 'noindex, nofollow' }]
})

// Операции приходят с backend (фид #5); до него список пуст — честное пустое состояние.
//
// ⚠ ДЕМО-НАБОР ВИДЕН ТОЛЬКО ПО `?preview=1` — тому же штатному обходу, на котором держатся
// скриншоты и визуальные тесты. Он существует, чтобы вёрстку длинного списка было на чём смотреть;
// в портале его быть не должно, иначе бухгалтер увидит чужие платежи и решит, что импорт уже
// работает. Флаг читается ИЗ РОУТЕРА, а не из `window.location`: на гидратации пререндеренной
// страницы строка запроса пуста.
const PREVIEW_ITEMS: StatementItem[] = [
  {
    account: 'BY10DEMO30120000000000000001',
    docId: '127938853',
    docNum: '356',
    direction: 'debit',
    amount: 0.29,
    currency: 'BYN',
    purpose: 'Вознагражд-е за зачисл-е ден-х средств на текущие (расчетные) банковские счета физич-х лиц  ИП ИВАНОВ И. И. за 24.07.2026 согл. до',
    counterparty: {
      name: 'ЗАО "ДЕМО-БАНК"',
      unp: '190000003',
      account: 'BY22DEMO30120000000000000012',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-28',
    operCodeName: '6'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00928450004',
    docNum: '2280',
    direction: 'debit',
    amount: 100,
    currency: 'BYN',
    purpose: 'OTHR 130102 АВАНС (ЗАРАБОТНАЯ ПЛАТА) ЗА ЗА ИЮЛЬ2026Г. ПО СПИСКУ 147 ОТ 24.07.2026СОГЛАСНО ДОГОВОРУ 30-06/100 ОТ 29.12.2015',
    counterparty: {
      name: 'ЗАО \'ДЕМО-БАНК\'',
      unp: '190000003',
      account: 'BY20DEMO30120000000000000010',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-24',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00928101693',
    docNum: '2279',
    direction: 'debit',
    amount: 159.78,
    currency: 'BYN',
    purpose: 'OTHR 190401 ОПЛАТА АКТА У-000063 ОТ 30.06.2026ПО ДОГОВОРУ 53/100/20 ОТ 03.11.2020',
    counterparty: {
      name: 'ООО \'ВАСИЛЁК\'',
      unp: '190000005',
      account: 'BY14DEMO30120000000000000004',
      bic: 'MTBKBY22'
    },
    acceptDate: '2026-07-24',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00928101687',
    docNum: '2279',
    direction: 'debit',
    amount: 19.24,
    currency: 'BYN',
    purpose: 'OTHR 190401 ОПЛАТА АКТА У-000061 ОТ 30.06.2026ПО ДОГОВОРУ 53/100/20 ОТ 03.11.2020',
    counterparty: {
      name: 'ООО \'ВАСИЛЁК\'',
      unp: '190000005',
      account: 'BY14DEMO30120000000000000004',
      bic: 'MTBKBY22'
    },
    acceptDate: '2026-07-24',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00928101629',
    docNum: '2278',
    direction: 'debit',
    amount: 1008,
    currency: 'BYN',
    purpose: 'OTHR 140101 ПЕРЕВОД ДЕНЕЖНЫХ СРЕДСТВ В РАМКАХ ОДНОГО ЮРИДИЧЕСКОГО ЛИЦАБЕЗ НДС',
    counterparty: {
      name: 'ИП ИВАНОВ И. И.',
      unp: '190000006',
      account: 'BY13DEMO30120000000000000003',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-24',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00927735152',
    docNum: '2043611938230893',
    direction: 'credit',
    amount: 6300,
    currency: 'BYN',
    purpose: 'OTHR 121101 ОПЛАТА РАБОТ ПООБНОВЛЕНИЮ СЕРВИСНОГО ПО ПОРТАЛА B24.DEMO-CLIENT.BY СОГЛАСНО ДОГОВОРА НА ОКАЗАНИЕ УСЛУГ И ВЫПОЛНЕНИЕ РАБОТ N 52/05.10.2020 ОТ05.10.2020 СЧЕТ-ПРОТОКОЛ СОГЛАСОВАНИЯ ЦЕНЫ 52/05.102020/31',
    counterparty: {
      name: 'ООО "БИЗНЕС-ЦЕНТР"',
      unp: '190000007',
      account: 'BY26DEMO30120000000000000016',
      bic: 'PJCBBY2X'
    },
    acceptDate: '2026-07-23',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: '126766867',
    docNum: '256',
    direction: 'debit',
    amount: 3.7,
    currency: 'BYN',
    purpose: 'Вознагражд-е за зачисл-е ден-х средств на текущие (расчетные) банковские счета физич-х лиц  ИП ИВАНОВ И. И. за 15.07.2026 согл. до',
    counterparty: {
      name: 'ЗАО "ДЕМО-БАНК"',
      unp: '190000003',
      account: 'BY22DEMO30120000000000000012',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-17',
    operCodeName: '6'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: '126603199',
    docNum: '837',
    direction: 'debit',
    amount: 50,
    currency: 'BYN',
    purpose: '2.4.23. II Вознаграждение за обслуживание по пакету услуг "Пакет Лайт" за 7 месяц 2026 г. сог-но Перечню вознаграждений Банка. Без НДС.',
    counterparty: {
      name: 'ЗАО "ДЕМО-БАНК"',
      unp: '190000003',
      account: 'BY18DEMO30120000000000000008',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-16',
    operCodeName: '6'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: '126603198',
    docNum: '446',
    direction: 'debit',
    amount: 1.9,
    currency: 'BYN',
    purpose: '2.3.16. б) II Вознагр.за предоставление услуги "Клиент-Уведомление" путем отправки сообщения на адрес эл.почты  в июле 2026 г. cогл. П',
    counterparty: {
      name: 'ЗАО "ДЕМО-БАНК"',
      unp: '190000003',
      account: 'BY18DEMO30120000000000000008',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-16',
    operCodeName: '6'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00923002595',
    docNum: '2276',
    direction: 'debit',
    amount: 126.51,
    currency: 'BYN',
    purpose: 'TAXS 190101 ПОДОХОДНЫЙ НАЛОГ С ЗАРАБОТНОЙ ПЛАТЫЗА ИЮНЬ 2026  ПО СРОКУ УПЛАТЫ 15.07.2026Г.',
    counterparty: {
      name: 'ГЛАВНОЕ УПРАВЛЕНИЕ МИНФИНА (ДЕМО)',
      unp: '190000002',
      account: 'BY25DEMO30120000000000000015',
      bic: 'AKBBBY2X'
    },
    acceptDate: '2026-07-15',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00923002587',
    docNum: '2275',
    direction: 'debit',
    amount: 680,
    currency: 'BYN',
    purpose: 'TAXS 190102 ФСЗН НАЛОГ С ЗАРАБОТНОЙ ПЛАТЫ ЗА ИЮНЬ 2026  ПО СРОКУ УПЛАТЫ 15.07.2026Г.',
    counterparty: {
      name: 'ГЛАВНОЕ УПРАВЛЕНИЕ МИНФИНА (ДЕМО)',
      unp: '190000002',
      account: 'BY17DEMO30120000000000000007',
      bic: 'AKBBBY2X'
    },
    acceptDate: '2026-07-15',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00923002589',
    docNum: '2277',
    direction: 'debit',
    amount: 10,
    currency: 'BYN',
    purpose: 'OTHR 143805 ОПЛАТА СТРАХОВЫХ ВЗНОСОВ ЗА НАЕМНЫХСОТРУДНИКОВ НАЛОГ С ЗАРАБОТНОЙ ПЛАТЫ ЗА ИЮНЬ 2026  ПО СРОКУ УПЛАТЫ 15.07.2026Г.СТРАХОВОЙ НОМЕР 500000001КОД ПЛАТЕЖА 10001',
    counterparty: {
      name: 'ФИЛИАЛ СТРАХОВЩИКА (ДЕМО)',
      unp: '190000001',
      account: 'BY16DEMO30120000000000000006',
      bic: 'AKBBBY2X'
    },
    acceptDate: '2026-07-15',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00923002585',
    docNum: '2274',
    direction: 'debit',
    amount: 1275.08,
    currency: 'BYN',
    purpose: 'OTHR 130102 ЗАРАБОТНАЯ ПЛАТА ЗА МЕСЯЦ (ИСТЕКШИЙ) ЗА ИЮНЬ 2026Г. ПО СПИСКУ 146 ОТ 15.07.2026 СОГЛАСНО ДОГОВОРУ 30-06/100 ОТ 29.12.2015',
    counterparty: {
      name: 'ЗАО \'ДЕМО-БАНК\'',
      unp: '190000003',
      account: 'BY20DEMO30120000000000000010',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-15',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00920729820',
    docNum: '5954',
    direction: 'credit',
    amount: 700,
    currency: 'BYN',
    purpose: 'OTHR 123501 ОПЛАТА ЗА УСЛУГИ ПО ДОГОВОРУ 8/06.05.2022 ОТ 06.05.2022, БЕЗ НДС',
    counterparty: {
      name: 'ООО \'МЕТАЛЛСЕРВИС\'',
      unp: '190000010',
      account: 'BY23DEMO30120000000000000013',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-10',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: '125791075',
    docNum: '37',
    direction: 'debit',
    amount: 5.8,
    currency: 'BYN',
    purpose: '2.1.3.д)II Вознагражд-е за исполн-еплат-й инструкции клиента 07.07.2026 по переводу ср-в на текущие счета ФЛ сог-ноПеречнювознаграждБезНДС',
    counterparty: {
      name: 'ЗАО "ДЕМО-БАНК"',
      unp: '190000003',
      account: 'BY18DEMO30120000000000000008',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-09',
    operCodeName: '6'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: '125647285',
    docNum: '54',
    direction: 'debit',
    amount: 7.25,
    currency: 'BYN',
    purpose: '2.1.3.д)II Вознагражд-е за исполн-еплат-й инструкции клиента 06.07.2026 по переводу ср-в на текущие счета ФЛ сог-ноПеречнювознаграждБезНДС',
    counterparty: {
      name: 'ЗАО "ДЕМО-БАНК"',
      unp: '190000003',
      account: 'BY18DEMO30120000000000000008',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-08',
    operCodeName: '6'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00918663612',
    docNum: '2273',
    direction: 'debit',
    amount: 2000,
    currency: 'BYN',
    purpose: 'OTHR 130601 0000000A000AA0 ПЕРЕЧИСЛЯЕТСЯ ЛИЧНЫЙ ДОХОД ИП ЗА 3КВАРТАЛ 2026 БЕЗ НДС',
    counterparty: {
      name: 'И***В И***Н И***Ч',
      unp: '',
      account: 'BY15DEMO30120000000000000005',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-07',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: '125500324',
    docNum: '253',
    direction: 'debit',
    amount: 3.48,
    currency: 'BYN',
    purpose: '2.1.3.д)II Вознагражд-е за исполн-еплат-й инструкции клиента 02.07.2026 по переводу ср-в на текущие счета ФЛ сог-ноПеречнювознаграждБезНДС',
    counterparty: {
      name: 'ЗАО "ДЕМО-БАНК"',
      unp: '190000003',
      account: 'BY18DEMO30120000000000000008',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-07',
    operCodeName: '6'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00917983116',
    docNum: '1937',
    direction: 'credit',
    amount: 100,
    currency: 'BYN',
    purpose: 'OTHR 121101 ЗА  ОБНОВЛЕНИЕ  . С-НО АКТА 1142/22ОТ 02.06.25Г. ДОГ.1100/30.11.2021ОТ 30.11.2021Г.',
    counterparty: {
      name: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "РОМАШКА"',
      unp: '190000009',
      account: 'BY21DEMO30120000000000000011',
      bic: 'BLBBBY2X'
    },
    acceptDate: '2026-07-06',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00917823497',
    docNum: '2272',
    direction: 'debit',
    amount: 2500,
    currency: 'BYN',
    purpose: 'OTHR 130601 0000000A000AA0 ПЕРЕЧИСЛЯЕТСЯ ЛИЧНЫЙ ДОХОД ИП ЗА 3КВАРТАЛ 2026 БЕЗ НДС',
    counterparty: {
      name: 'И***В И***Н И***Ч',
      unp: '',
      account: 'BY15DEMO30120000000000000005',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-06',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00917822371',
    docNum: '2271',
    direction: 'debit',
    amount: 72,
    currency: 'BYN',
    purpose: 'OTHR 140101 ПЕРЕВОД ДЕНЕЖНЫХ СРЕДСТВ В РАМКАХ ОДНОГО ЮРИДИЧЕСКОГО ЛИЦАБЕЗ НДС',
    counterparty: {
      name: 'ИП ИВАНОВ И. И.',
      unp: '190000006',
      account: 'BY13DEMO30120000000000000003',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-06',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00916639804',
    docNum: '636',
    direction: 'credit',
    amount: 450,
    currency: 'BYN',
    purpose: 'OTHR 190401 ОПЛАТА ЗА УСЛУГИ ПО АКТУ 74/26 ОТ 22.06.2026 Г. ПО ДОГОВОРУ 74/04.03.2024 ОТ 04.03.2024 Г.',
    counterparty: {
      name: 'ООО "ТОРГОВЫЙ ДОМ"',
      unp: '190000008',
      account: 'BY12DEMO30120000000000000002',
      bic: 'PJCBBY2X'
    },
    acceptDate: '2026-07-02',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00916543109',
    docNum: '2270',
    direction: 'debit',
    amount: 60,
    currency: 'BYN',
    purpose: 'OTHR 190401 ОПЛАТА СЧЕТА 145792 ОТ 2 ИЮЛЯ 2026ПО ДОГОВОРУ 151М ОТ 21.12.2020, В ТОМ ЧИСЛЕ НДС ПО СТАВКЕ 25% НА СУММУ12.00 БЕЛ.РУБ',
    counterparty: {
      name: 'ООО СЕТЕВАЯ КОМПАНИЯ',
      unp: '190000004',
      account: 'BY24DEMO30120000000000000014',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-02',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00916417690',
    docNum: '2270',
    direction: 'debit',
    amount: 1200,
    currency: 'BYN',
    purpose: 'OTHR 130601 0000000A000AA0 ПЕРЕЧИСЛЯЕТСЯ ЛИЧНЫЙ ДОХОД ИП ЗА 3КВАРТАЛ 2026 БЕЗ НДС',
    counterparty: {
      name: 'И***В И***Н И***Ч',
      unp: '',
      account: 'BY15DEMO30120000000000000005',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-02',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00916415951',
    docNum: '2269',
    direction: 'debit',
    amount: 281.6,
    currency: 'BYN',
    purpose: 'OTHR 140101 ПЕРЕВОД ДЕНЕЖНЫХ СРЕДСТВ В РАМКАХ ОДНОГО ЮРИДИЧЕСКОГО ЛИЦАБЕЗ НДС',
    counterparty: {
      name: 'ИП ИВАНОВ И. И.',
      unp: '190000006',
      account: 'BY13DEMO30120000000000000003',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-07-02',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'ABOWD00916395472',
    docNum: '2268',
    direction: 'debit',
    amount: 1143.5,
    currency: 'BYN',
    purpose: 'OTHR 190401 АРЕНДНАЯ ПЛАТА ПО ДОГОВОРУ 53/100/20 ОТ 03.11.20, В ТОМ ЧИСЛЕ НДС ПО СТАВКЕ 20% НА СУММУ 190.58 БЕЛ.РУБ',
    counterparty: {
      name: 'ООО \'ВАСИЛЁК\'',
      unp: '190000005',
      account: 'BY19DEMO30120000000000000009',
      bic: 'BAPBBY2X'
    },
    acceptDate: '2026-07-02',
    operCodeName: '1'
  }
]

const route = useRoute()
const items = computed<StatementItem[]>(() => (isPreviewQuery(route.query.preview) ? PREVIEW_ITEMS : []))
const byDirection = computed(() => splitByDirection(items.value))

// Filter chips (labels keep the "(N)" counts). Default "all" shows everything.
type Filter = 'all' | OperationDirection
const filter = ref<Filter>('all')
const chips = computed(() => [
  { value: 'all' as Filter, label: `Все (${items.value.length})` },
  { value: 'credit' as Filter, label: `Приходы (${byDirection.value.credits.length})` },
  { value: 'debit' as Filter, label: `Расходы (${byDirection.value.debits.length})` }
])
const shown = computed(() =>
  filter.value === 'all' ? items.value : items.value.filter(i => i.direction === filter.value)
)

// Pagination (renders only when it overflows a page).
const perPage = 10
const page = ref(1)
const paged = computed(() => shown.value.slice((page.value - 1) * perPage, page.value * perPage))
function setFilter(f: Filter) {
  filter.value = f
  page.value = 1
}

// Вторичные экраны открываются НАСТОЯЩИМ слайдером портала (`openSliderAppPage({ place })`), а не
// нашим `B24Slideover`: портал рисует свой оверлей поверх работы, с родной шапкой и поведением, и
// экран не делит вьюпорт с этой страницей. Прежний вывод «слайдер портала для своей страницы не
// годится» относился к `slider.openPath` (он открывает ПОРТАЛЬНЫЙ путь → 404); `openSliderAppPage`
// переоткрывает НАШ адрес и передаёт `place`, по которому глобальный мидлвар уводит свежий фрейм на
// нужный маршрут.
//
// Фолбэк обычной навигацией обязателен: вне портала слайдера нет вовсе, а внутри портал может
// отказать во вложенном слайдере — экран всё равно должен открыться.
async function openSettings(): Promise<void> {
  const opened = await b24.openAppSlider(APP_SLIDER_PLACE_SETTINGS, {
    width: APP_SLIDER_WIDTH,
    title: 'Настройки'
  })
  if (!opened) await navigateTo('/settings')
}

async function openImport(): Promise<void> {
  const opened = await b24.openAppSlider(APP_SLIDER_PLACE_IMPORT, {
    width: APP_SLIDER_WIDTH,
    title: 'Загрузка выписки'
  })
  if (!opened) await navigateTo('/import')
}

// Import status (demo until the backend poller, #5). Client fetches on mount.
const { status, refresh } = useImportStatus()

// Admin gate (drives which setup banner shows). Resolved after useB24().init().
const { inPortal, isAdmin, check: checkAdmin } = useIsAdmin()

// Chat settings (shared singleton with the SettingsForm slideover). Subscribe to the
// cross-instance reload pull so a save in another open instance re-reads live. MUST run
// SYNCHRONOUSLY in setup — after an `await` the active effect scope is lost and
// onScopeDispose (inside subscribeReload) wouldn't bind → the pull client would leak.
// Best-effort; no-op if the portal pull server / frame is unavailable.
const chatSettings = useChatSettings()
useSettingsSync().subscribeReload(() => void chatSettings.load())

// «Настроено» = a notification chat is chosen (its dialogId is non-empty). That is the
// minimal switch that turns the pipeline on, so it gates the setup banner.
const configured = computed(() => chatSettings.settings.chat.dialogId !== '')
// Settings are «ready» to decide the view: outside the portal there's nothing to load;
// inside, only once chatSettings.load() has resolved. Gating on this avoids a flash of the
// "not configured" banner while the fetch is still in flight for an already-configured portal.
const settingsReady = computed(() => !inPortal.value || chatSettings.loaded.value)
// Show the setup banner only inside the portal, after settings loaded, when not configured.
// Standalone/dev (no frame) is neither blocked nor nagged — it renders the empty operations view.
const showSetupBanner = computed(() => inPortal.value && chatSettings.loaded.value && !configured.value)

// Полоса статуса импорта. «Ещё не запускалась» — правда, но пока банк не подключён и файл не
// загружали, она сообщает не о состоянии импорта, а о том, что настройка не закончена: про это
// уже говорит экран готовности в настройках, и вторая формулировка того же читается как поломка.
// Поэтому полосу показываем, когда прогон был — или когда есть чему запускаться (подключён счёт).
// ⚠ Прячем полосу, только когда ТОЧНО ЗНАЕМ, что подключать нечего: `/api/setup-status`
// admin-only и не-админу отвечает 403, поэтому «нет счетов» и «нам не дали посмотреть» —
// разные вещи. Иначе бухгалтер и админ на одном и том же портале видели бы разное.
const setup = useSetupStatus()
const setupKnown = computed(() => setup.loaded.value && setup.error.value === '')
const showStatusBanner = computed(
  () => status.value.state !== 'never' || !setupKnown.value || setup.status.value.connectedAccounts > 0
)

const b24 = useB24()
// Мобильное приложение Bitrix24 определяем механизмом b24ui (`useDevice()` → платформа
// `bitrix-mobile`, её ставит плагин платформы по UA), а не JS SDK. Скрытие — через `v-if`,
// поэтому оно не зависит от темы.
const { isBitrixMobile } = useDevice()
onMounted(async () => {
  // ⚠ Порядок важен: `refresh()` авторизуется фрейм-токеном, а он доступен только ПОСЛЕ `init()`.
  // Раньше статус запрашивался первым и всегда упирался в «нет токена» — баг маскировался
  // демо-моком, а с его удалением (#415) полоса статуса навсегда показывала бы «не запускалась».
  await b24.init()
  if (!b24.isInit()) return
  await refresh()
  checkAdmin()
  // Load chat settings so the setup banner reflects the real configured state.
  await chatSettings.load()
  // Только для решения «показывать ли полосу статуса», поэтому НЕ в критическом пути:
  // ждать его перед `setTitle`/`fitWindow` значило бы держать фрейм без заголовка и
  // неподогнанным всё время запроса (а у не-админа он ещё и заведомо 403).
  void setup.load()
  try {
    const $b24 = b24.getOrThrow()
    await $b24.parent.setTitle('Выписка по счёту')
    await $b24.parent.fitWindow()
  } catch (e) {
    log.warning('не удалось вызвать parent-методы портала', { error: String(e) })
  }
})
</script>

<!-- Страница осмысленна только внутри портала: снаружи нет фрейм-токена, а значит ни настроек,
     ни статуса, ни записи в CRM (#414). `?preview=1` — обход для разработки и скриншотов. -->
<template>
  <InPortalGate>
    <B24DashboardPanel
      id="home"
      :b24ui="{ body: 'p-4 sm:pt-0 scrollbar-transparent flex flex-col gap-4' }"
    >
      <!-- ⚠ В МОБИЛЬНОМ ПРИЛОЖЕНИИ шапки нет вовсе. Заголовок там дублирует нативный заголовок
           экрана приложения, а две кнопки рядом с ним не помещаются: на 375 px они выдавливали
           название до «Бан!». Настройки в мобильном скрыты по той же причине, что и у соседнего
           `ai-price-import` — это десктопная работа администратора, а не то, ради чего открывают
           приложение с телефона. Определяем через `useDevice()` b24ui (платформа
           `bitrix-mobile` из UA), а не через SDK. -->
      <template
        v-if="!isBitrixMobile"
        #header
      >
        <B24DashboardNavbar
          :toggle="false"
          title="Банковские выписки"
        >
          <!-- Короткий заголовок на узком экране: полный не помещался рядом с кнопками даже после
               того, как у них убрали подписи, — срезалась последняя буква, и это читается как
               поломка. Обрезка средствами CSS (`truncate`) дала бы то же самое, только многоточием;
               здесь мы выбираем, ЧТО показать, а не чем закончить. -->
          <template #title>
            <span class="sm:hidden">Выписки</span>
            <span class="hidden sm:inline">Банковские выписки</span>
          </template>

          <template #right>
            <!-- ⚠ Подписи кнопок скрыты ниже `sm` — иначе они выдавливают заголовок: на 375 px
                 «Банковские выписки» ужималось до «Бан!». Скрывать шапку целиком тут нельзя:
                 `isBitrixMobile` — это мобильное ПРИЛОЖЕНИЕ по UA, а узкий БРАУЗЕР им не является,
                 и он остался бы с тем же обрезанным заголовком. Подпись уезжает слотом, а не
                 пропом `label`: проп рисует её сам, обернуть его нечем. Иконка остаётся всегда,
                 `aria-label` даёт имя кнопке для скринридера. -->
            <B24Button
              :icon="UploadFileIcon"
              color="air-boost"
              size="sm"
              aria-label="Загрузить выписку"
              @click="openImport"
            >
              <span class="hidden sm:inline">Загрузить выписку</span>
            </B24Button>

            <B24Button
              :icon="SettingsIcon"
              color="air-secondary-no-accent"
              size="sm"
              aria-label="Настройки"
              @click="openSettings"
            >
              <span class="hidden sm:inline">Настройки</span>
            </B24Button>
          </template>
        </B24DashboardNavbar>
      </template>
      <template #body>
        <!-- Ручная загрузка в мобильном — ОТДЕЛЬНОЙ кнопкой в теле, а не в шапке: шапки там нет,
             а загрузка файла с телефона — ровно то, ради чего приложение и открывают в дороге. -->
        <B24Button
          v-if="isBitrixMobile"
          :icon="UploadFileIcon"
          color="air-boost"
          size="md"
          label="Загрузить выписку"
          block
          @click="openImport"
        />

        <!-- App not configured yet (no notification chat chosen). Admins get a call-to-action
           with a shortcut to the settings; everyone else is told an admin is setting it up. -->
        <template v-if="showSetupBanner">
          <B24Alert
            v-if="isAdmin"
            color="air-primary-warning"
            title="Приложение не настроено"
            description="Выберите чат для уведомлений в настройках — после этого приложение начнёт присылать операции и записывать их в CRM."
            class="mb-5"
          />
          <B24Button
            v-if="isAdmin"
            label="Открыть настройки"
            color="air-primary"
            class="mb-5"
            @click="openSettings"
          />
          <B24Alert
            v-else
            color="air-secondary-accent"
            title="Приложение ещё настраивается"
            description="Администратор портала завершает настройку. Импорт выписок станет доступен после этого."
            class="mb-5"
          />
        </template>

        <!-- Real operations view (empty until the backend feed, #5). Shown once settings are
           ready and the app is configured; hidden while unconfigured (setup banner) or while
           the in-portal settings fetch is still resolving (avoids a flash either way). -->
        <template v-else-if="settingsReady">
          <!-- ⚠ Полоса статуса и карточка доработок живут СНАРУЖИ ветки «есть операции»: список
               в портале пуст до бэкенд-фида (#5), и внутри неё они не показались бы НИКОГДА —
               то есть настроенный портал остался бы и без статуса импорта, и без кнопки
               «Проверить настройки», ради которой полоса и заведена. -->
          <div class="flex flex-col lg:flex-row items-start justify-between gap-4">
            <ImportStatsChart
              v-if="items.length"
              :items="items"
              title="Сводка по операциям"
              class="w-full"
            />
            <div class="w-full lg:max-w-105 shrink-0 flex flex-col items-center justify-between gap-4">
              <ImportStatusBanner
                v-if="showStatusBanner"
                :status="status"
                @open-settings="openSettings"
              />
              <CustomDevCard />
            </div>
          </div>
          <!-- Operations, styled like the "Последние операции" view. -->
          <B24Card>
            <template #header>
              <h2 class="font-semibold">
                Последние операции
              </h2>
            </template>

            <!-- Filter chips -->
            <div class="flex flex-wrap gap-2">
              <B24Button
                v-for="c in chips"
                :key="c.value"
                :label="c.label"
                :color="filter === c.value ? 'air-primary' : 'air-tertiary-no-accent'"
                :aria-pressed="filter === c.value"
                size="sm"
                @click="setFilter(c.value)"
              />
            </div>

            <!-- Column header -->
            <div class="mt-4 flex items-center justify-between border-b border-(--ui-color-design-tinted-na-stroke) pb-2 text-xs text-(--ui-color-base-3)">
              <span>Операция</span>
              <span>Сумма</span>
            </div>

            <!-- `reserve-rows` держит высоту страницы: последняя страница короче, и без резерва
                 кнопки пагинации прыгали вверх под курсором. -->
            <OperationList
              :items="paged"
              :reserve-rows="shown.length > perPage ? perPage : 0"
            />

            <!-- Pagination shows only when operations overflow a page (real data). -->
            <B24Pagination
              v-if="shown.length > perPage"
              v-model:page="page"
              :total="shown.length"
              :items-per-page="perPage"
              class="mt-4 justify-center"
            />
          </B24Card>
        </template>
      </template>

      <template #footer>
        <BuildFooter />
      </template>
    </B24DashboardPanel>
  </InPortalGate>
</template>
