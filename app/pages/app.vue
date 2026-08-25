<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import SettingsIcon from '@bitrix24/b24icons-vue/outline/SettingsIcon'
import UploadFileIcon from '@bitrix24/b24icons-vue/outline/UploadFileIcon'
import { splitByDirection } from '~/utils/statement'
import type { OperationDirection, StatementItem } from '~/types/statement'
import { useB24 } from '~/composables/useB24'
import { useImportStatus } from '~/composables/useImportStatus'
import { useSetupStatus } from '~/composables/useSetupStatus'
import { useRecentOperations } from '~/composables/useRecentOperations'
import { useSliderRedirect } from '~/composables/useSliderRedirect'
import { useIsAdmin } from '~/composables/useIsAdmin'
import { useChatSettings } from '~/composables/useChatSettings'
import { useSettingsSync } from '~/composables/useSettingsSync'
import { pageTitle } from '~/utils/landing'
import { useLogger } from '~/utils/logger'
import { isPreviewQuery } from '~/utils/inPortalGate'
import {
  APP_SLIDER_PLACE_IMPORT,
  APP_SLIDER_PLACE_MAIN,
  APP_SLIDER_PLACE_SETTINGS,
  APP_SLIDER_WIDTH,
  APP_SLIDER_SETTINGS_WIDTH
} from '~/config/b24'
import {
  appLaunchMode, canAutoOpenMain, MAIN_SLIDER_MARK_KEY, type AppLaunchMode
} from '~/utils/appLaunchMode'

const log = useLogger('app')

// In-portal page: `portal` layout wraps it in <B24App> so b24ui theming/colorMode
// work inside the iframe; standalone (direct URL) it just renders the same UI.
definePageMeta({ layout: 'portal' })

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
    docId: 'DEMO00000001',
    docNum: '2101',
    direction: 'debit',
    amount: 120.0,
    currency: 'BYN',
    purpose: 'Вознаграждение за расчётно-кассовое обслуживание за май 2026 г. Без НДС.',
    counterparty: {
      name: 'ЗАО \'ДЕМО-БАНК\'',
      unp: '190000003',
      account: 'BY22DEMO30120000000000000012',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-02',
    operCodeName: '6'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000002',
    docNum: '2102',
    direction: 'debit',
    amount: 45.5,
    currency: 'BYN',
    purpose: 'Комиссия за ведение счёта за май 2026 г. Без НДС.',
    counterparty: {
      name: 'ЗАО \'ДЕМО-БАНК\'',
      unp: '190000003',
      account: 'BY22DEMO30120000000000000012',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-02',
    operCodeName: '6'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000003',
    docNum: '311',
    direction: 'credit',
    amount: 4800.0,
    currency: 'BYN',
    purpose: 'Оплата по счёту СЧ-1001 от 01.06.2026 за услуги внедрения. Без НДС.',
    counterparty: {
      name: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "РОМАШКА"',
      unp: '190000001',
      account: 'BY23DEMO30120000000000000003',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-03',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000004',
    docNum: '2103',
    direction: 'debit',
    amount: 980.0,
    currency: 'BYN',
    purpose: 'Оплата по счёту СЧ-2001 от 02.06.2026 за офисную технику. В т.ч. НДС 20%.',
    counterparty: {
      name: 'ООО "ТОРГОВЫЙ ДОМ"',
      unp: '190000002',
      account: 'BY24DEMO30120000000000000004',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-03',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000005',
    docNum: '2104',
    direction: 'debit',
    amount: 310.75,
    currency: 'BYN',
    purpose: 'Оплата услуг связи и интернета за май 2026 г. по договору Д-100 от 10.01.2024. В т.ч. НДС 20%.',
    counterparty: {
      name: 'ООО СЕТЕВАЯ КОМПАНИЯ',
      unp: '190000004',
      account: 'BY25DEMO30120000000000000005',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-04',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000006',
    docNum: '2105',
    direction: 'debit',
    amount: 60.0,
    currency: 'BYN',
    purpose: 'Вознаграждение за перевод денежных средств. Без НДС.',
    counterparty: {
      name: 'ЗАО \'ДЕМО-БАНК\'',
      unp: '190000003',
      account: 'BY22DEMO30120000000000000012',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-04',
    operCodeName: '6'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000007',
    docNum: '312',
    direction: 'credit',
    amount: 1500.0,
    currency: 'BYN',
    purpose: 'Оплата по счёту СЧ-1002 от 03.06.2026 за сопровождение портала. Без НДС.',
    counterparty: {
      name: 'ООО "БИЗНЕС-ЦЕНТР"',
      unp: '190000005',
      account: 'BY26DEMO30120000000000000006',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-05',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000008',
    docNum: '2106',
    direction: 'debit',
    amount: 250.0,
    currency: 'BYN',
    purpose: 'Перевод денежных средств в рамках одного юридического лица. Без НДС.',
    counterparty: {
      name: 'ИП ИВАНОВ И. И.',
      unp: '190000006',
      account: 'BY27DEMO30120000000000000007',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-05',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000009',
    docNum: '2107',
    direction: 'debit',
    amount: 1740.0,
    currency: 'BYN',
    purpose: 'Подоходный налог с заработной платы за май 2026 г. по сроку уплаты 08.06.2026.',
    counterparty: {
      name: 'ГЛАВНОЕ УПРАВЛЕНИЕ МИНФИНА (ДЕМО)',
      unp: '190000007',
      account: 'BY28DEMO30120000000000000008',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-08',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000010',
    docNum: '2108',
    direction: 'debit',
    amount: 2320.0,
    currency: 'BYN',
    purpose: 'Взносы на государственное социальное страхование за май 2026 г.',
    counterparty: {
      name: 'ГЛАВНОЕ УПРАВЛЕНИЕ МИНФИНА (ДЕМО)',
      unp: '190000007',
      account: 'BY28DEMO30120000000000000008',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-08',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000011',
    docNum: '2109',
    direction: 'debit',
    amount: 96.0,
    currency: 'BYN',
    purpose: 'Страховые взносы от несчастных случаев на производстве за май 2026 г.',
    counterparty: {
      name: 'ФИЛИАЛ СТРАХОВЩИКА (ДЕМО)',
      unp: '190000008',
      account: 'BY29DEMO30120000000000000009',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-08',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000012',
    docNum: '2110',
    direction: 'debit',
    amount: 3200.0,
    currency: 'BYN',
    purpose: 'Аванс (заработная плата) за июнь 2026 г. по списку 7 от 09.06.2026 согласно договору Д-200 от 04.01.2021.',
    counterparty: {
      name: 'ИП ИВАНОВ И. И.',
      unp: '190000006',
      account: 'BY27DEMO30120000000000000007',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-09',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000013',
    docNum: '2111',
    direction: 'debit',
    amount: 35.0,
    currency: 'BYN',
    purpose: 'Вознаграждение за зачисление денежных средств на счета физических лиц за 09.06.2026. Без НДС.',
    counterparty: {
      name: 'ЗАО \'ДЕМО-БАНК\'',
      unp: '190000003',
      account: 'BY22DEMO30120000000000000012',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-09',
    operCodeName: '6'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000014',
    docNum: '2112',
    direction: 'debit',
    amount: 640.0,
    currency: 'BYN',
    purpose: 'Оплата по счёту СЧ-2002 от 09.06.2026 за расходные материалы. В т.ч. НДС 20%.',
    counterparty: {
      name: 'ООО "ТОРГОВЫЙ ДОМ"',
      unp: '190000002',
      account: 'BY24DEMO30120000000000000004',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-10',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000015',
    docNum: '2113',
    direction: 'debit',
    amount: 88.2,
    currency: 'BYN',
    purpose: 'Оплата по акту А-500 от 31.05.2026 за хостинг. В т.ч. НДС 20%.',
    counterparty: {
      name: 'ООО СЕТЕВАЯ КОМПАНИЯ',
      unp: '190000004',
      account: 'BY25DEMO30120000000000000005',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-10',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000016',
    docNum: '313',
    direction: 'credit',
    amount: 2600.0,
    currency: 'BYN',
    purpose: 'Оплата по счёту СЧ-1003 от 09.06.2026 за доработку CRM. Без НДС.',
    counterparty: {
      name: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "РОМАШКА"',
      unp: '190000001',
      account: 'BY23DEMO30120000000000000003',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-11',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000017',
    docNum: '2114',
    direction: 'debit',
    amount: 150.0,
    currency: 'BYN',
    purpose: 'Вознаграждение за обслуживание по пакету услуг «Пакет Демо» за 6 месяц 2026 г. Без НДС.',
    counterparty: {
      name: 'ЗАО \'ДЕМО-БАНК\'',
      unp: '190000003',
      account: 'BY22DEMO30120000000000000012',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-11',
    operCodeName: '6'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000018',
    docNum: '2115',
    direction: 'debit',
    amount: 420.0,
    currency: 'BYN',
    purpose: 'Оплата по счёту СЧ-2003 от 12.06.2026 за канцелярские товары. В т.ч. НДС 20%.',
    counterparty: {
      name: 'ООО "ТОРГОВЫЙ ДОМ"',
      unp: '190000002',
      account: 'BY24DEMO30120000000000000004',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-15',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000019',
    docNum: '2116',
    direction: 'debit',
    amount: 12.6,
    currency: 'BYN',
    purpose: 'Вознаграждение за предоставление услуги уведомления по электронной почте в июне 2026 г. Без НДС.',
    counterparty: {
      name: 'ЗАО \'ДЕМО-БАНК\'',
      unp: '190000003',
      account: 'BY22DEMO30120000000000000012',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-15',
    operCodeName: '6'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000020',
    docNum: '2117',
    direction: 'debit',
    amount: 1980.0,
    currency: 'BYN',
    purpose: 'Оплата по счёту СЧ-3001 от 15.06.2026 за аренду серверного оборудования. В т.ч. НДС 20%.',
    counterparty: {
      name: 'ООО СЕТЕВАЯ КОМПАНИЯ',
      unp: '190000004',
      account: 'BY25DEMO30120000000000000005',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-16',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000021',
    docNum: '314',
    direction: 'credit',
    amount: 7300.0,
    currency: 'BYN',
    purpose: 'Оплата по счёту СЧ-1004 от 16.06.2026 за работы по обновлению сервисного ПО портала b24.demo-client.by согласно договору Д-300 от 05.10.2020.',
    counterparty: {
      name: 'ООО "БИЗНЕС-ЦЕНТР"',
      unp: '190000005',
      account: 'BY26DEMO30120000000000000006',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-17',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000022',
    docNum: '2118',
    direction: 'debit',
    amount: 530.4,
    currency: 'BYN',
    purpose: 'Оплата по акту А-501 от 16.06.2026 за доставку. В т.ч. НДС 20%.',
    counterparty: {
      name: 'ООО "ТОРГОВЫЙ ДОМ"',
      unp: '190000002',
      account: 'BY24DEMO30120000000000000004',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-17',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000023',
    docNum: '2119',
    direction: 'debit',
    amount: 74.0,
    currency: 'BYN',
    purpose: 'Вознаграждение за расчётно-кассовое обслуживание. Без НДС.',
    counterparty: {
      name: 'ЗАО \'ДЕМО-БАНК\'',
      unp: '190000003',
      account: 'BY22DEMO30120000000000000012',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-18',
    operCodeName: '6'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000024',
    docNum: '2120',
    direction: 'debit',
    amount: 3200.0,
    currency: 'BYN',
    purpose: 'Заработная плата за июнь 2026 г. по списку 8 от 22.06.2026 согласно договору Д-200 от 04.01.2021.',
    counterparty: {
      name: 'ИП ИВАНОВ И. И.',
      unp: '190000006',
      account: 'BY27DEMO30120000000000000007',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-22',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000025',
    docNum: '2121',
    direction: 'debit',
    amount: 860.0,
    currency: 'BYN',
    purpose: 'Возврат излишне перечисленных средств по счёту СЧ-1001 от 01.06.2026. Без НДС.',
    counterparty: {
      name: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "РОМАШКА"',
      unp: '190000001',
      account: 'BY23DEMO30120000000000000003',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-23',
    operCodeName: '1'
  },
  {
    account: 'BY10DEMO30120000000000000001',
    docId: 'DEMO00000026',
    docNum: '2122',
    direction: 'debit',
    amount: 205.3,
    currency: 'BYN',
    purpose: 'Оплата по счёту СЧ-3002 от 23.06.2026 за техническую поддержку. В т.ч. НДС 20%.',
    counterparty: {
      name: 'ООО СЕТЕВАЯ КОМПАНИЯ',
      unp: '190000004',
      account: 'BY25DEMO30120000000000000005',
      bic: 'DEMOBY2X'
    },
    acceptDate: '2026-06-24',
    operCodeName: '1'
  }
]

const route = useRoute()
// «Последние операции» (#5/#36): в портале — реальный фид из реестра «Платежи» (`useRecentOperations`),
// под `?preview=1` — синтетический демо-набор для скриншотов и визуальных тестов. Раньше в портале
// список был жёстко пуст, хотя реестр в настройках уже показывал те же операции своим endpoint'ом.
const { operations: recentOps, load: loadRecentOps } = useRecentOperations()
const items = computed<StatementItem[]>(() => (isPreviewQuery(route.query.preview) ? PREVIEW_ITEMS : recentOps.value))
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
    // Настройки шире общей ширины (#34): двухколоночный экран, нужен десктопный `lg`-режим (>1024).
    width: APP_SLIDER_SETTINGS_WIDTH,
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

// Chat settings (shared singleton with the SettingsForm on /settings). Subscribe to the
// cross-instance reload pull so a save in another open instance re-reads live. MUST run
// SYNCHRONOUSLY in setup — after an `await` the active effect scope is lost and
// onScopeDispose (inside subscribeReload) wouldn't bind → the pull client would leak.
// Best-effort; no-op if the portal pull server / frame is unavailable.
const chatSettings = useChatSettings()
useSettingsSync().subscribeReload(() => void chatSettings.load())

// «Настроено» = a notification chat is chosen (its dialogId is non-empty). That is the
// minimal switch that turns the pipeline on, so it gates the setup banner.
/**
 * Пусковая страница или рабочий экран (#15).
 *
 * `launcher` — базовый фрейм портала (прямая ссылка, пункт левого меню). Он открывает главную
 * СЛАЙДЕРОМ и сам не поднимает ничего: иначе опрос статуса, чтение настроек и pull-подписка
 * крутились бы в ДВУХ фреймах разом — в базовом и в открытом им слайдере.
 * До `init()` считаем рабочим экраном: вне портала лаунчер был бы тупиком (открывать слайдер нечем).
 */
const launch = ref<AppLaunchMode>('work')
const isLauncher = computed(() => launch.value === 'launcher')
/** Портал отказал в слайдере — показываем кнопку, а не мёртвую страницу. */
const sliderFailed = ref(false)

const configured = computed(() => chatSettings.settings.chat.dialogId !== '')
// Settings are «ready» to decide the view: outside the portal there's nothing to load;
// inside, only once chatSettings.load() has resolved. Gating on this avoids a flash of the
// "not configured" banner while the fetch is still in flight for an already-configured portal.
// ⚠ ЛАУНЧЕР ГАСИТ ОБЕ ВЕТКИ РАЗОМ (#15), и гейт стоит ЗДЕСЬ, а не в шаблоне. Ветки связаны цепочкой
// `v-if`/`v-else-if`: погаси мы в шаблоне только первую, вторая перехватила бы её и показала рабочий
// экран ровно там, где его быть не должно. Один источник решения — одно поведение.
const settingsReady = computed(() => !isLauncher.value && (!inPortal.value || chatSettings.loaded.value))
// Show the setup banner only inside the portal, after settings loaded, when not configured.
// Standalone/dev (no frame) is neither blocked nor nagged — it renders the empty operations view.
const showSetupBanner = computed(() =>
  !isLauncher.value && inPortal.value && chatSettings.loaded.value && !configured.value)

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

// ⚠ Портал открывает слайдер по НАШЕМУ адресу, то есть по дороге к настройкам этот экран
// монтируется всегда — а редирект уезжает лишь на готовности приложения. Пока он не случился,
// страница обязана молчать: её `onMounted` не отменяется уходом, и вернувшийся позже
// `setTitle('Выписка по счёту')` перекрыл бы уже поставленный заголовок «Настройки», а
// `fitWindow()` подогнал бы высоту слайдера под вёрстку, которой на экране нет. Плюс три
// холостых запроса (у не-админа один — заведомый 403) и вспышка чужого экрана.
const leavingToSlider = computed(() => useSliderRedirect().target.value !== null)

/** Отметка предыдущего автооткрытия в этой вкладке — страховка от бесконечного открытия. */
function lastMainSliderAt(): number | null {
  try {
    const raw = window.sessionStorage?.getItem(MAIN_SLIDER_MARK_KEY)
    return raw ? Number(raw) : null
  } catch {
    return null
  }
}

/**
 * Открыть главную слайдером.
 *
 * ⚠ Отметку ставим ТОЛЬКО на успехе: иначе портал, где слайдеры вообще не открываются, съедал бы ею
 * право на автооткрытие — и повторная загрузка страницы в пределах окна оставляла бы человека на
 * пусковой странице с нерабочей кнопкой и без рабочего экрана.
 */
async function openMain(): Promise<boolean> {
  const opened = await b24.openAppSlider(APP_SLIDER_PLACE_MAIN, {
    width: APP_SLIDER_WIDTH, title: 'Банковские выписки'
  })
  sliderFailed.value = !opened
  if (opened) {
    try {
      window.sessionStorage?.setItem(MAIN_SLIDER_MARK_KEY, String(Date.now()))
    } catch { /* приватный режим — без отметки, страховка от цикла просто не сработает */ }
  }
  return opened
}

onMounted(async () => {
  if (leavingToSlider.value) return
  // ⚠ Порядок важен: `refresh()` авторизуется фрейм-токеном, а он доступен только ПОСЛЕ `init()`.
  // Раньше статус запрашивался первым и всегда упирался в «нет токена» — баг маскировался
  // демо-моком, а с его удалением (#415) полоса статуса навсегда показывала бы «не запускалась».
  await b24.init()
  if (!b24.isInit()) return
  // ⚠ `?preview=1` — рабочий экран, а не лаунчер. Флаг это дев-обход для разработки, скриншотов и
  // визуальных тестов: он существует ровно ради того, чтобы показать НАСТОЯЩИЙ экран без портала.
  // Открой мы под ним слайдер (а вне портала он и не откроется), приёмка увидела бы пустую пусковую
  // страницу вместо работы. Гейт `InPortalGate` этот же флаг пропускает, и здесь та же дверь.
  launch.value = isPreviewQuery(route.query.preview)
    ? 'work'
    : appLaunchMode({
        inFrame: b24.isInit(),
        place: b24.placementPlace(),
        sliderMode: b24.isSliderMode(),
        isMobile: isBitrixMobile.value
      })
  if (launch.value === 'launcher') {
    // Автооткрытие — не чаще раза в окно (страховка от цикла); кнопку человек всегда нажмёт сам.
    if (!canAutoOpenMain(lastMainSliderAt(), Date.now())) return
    if (await openMain()) return
    // Слайдер не открылся — не оставляем человека на мёртвой странице, работаем как раньше.
    launch.value = 'work'
  }
  await refresh()
  checkAdmin()
  // «Последние операции» (#36) — реальный фид из реестра «Платежи». Не в критическом пути (список
  // может дорисоваться после `fitWindow`, как и статус): его отсутствие не должно задерживать
  // заголовок/подгонку фрейма.
  void loadRecentOps()
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

// ⚠ Список операций приходит фидом АСИНХРОННО, уже после `fitWindow` в `onMounted` (#36, находка
// ревью): раньше список в портале был всегда пуст и высота не менялась, теперь он дорисовывается и
// фрейм остаётся коротким. Переподгоняем окно, когда число операций изменилось. Best-effort и только
// в портале (`fitWindow` вне фрейма бросает — глотаем).
watch(() => items.value.length, async () => {
  if (!b24.isInit()) return
  try {
    await b24.getOrThrow().parent.fitWindow()
  } catch { /* вне портала fitWindow недоступен — не мешаем */ }
})
</script>

<!-- Пока фрейм уезжает на экран слайдера (`leavingToSlider`), не рисуем вообще ничего: этот
     экран никто не открывал, портал лишь переоткрыл по нему приложение.
     Страница осмысленна только внутри портала: снаружи нет фрейм-токена, а значит ни настроек,
     ни статуса, ни записи в CRM (#414). `?preview=1` — обход для разработки и скриншотов. -->
<template>
  <InPortalGate v-if="!leavingToSlider">
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
      <!-- ⚠ В режиме ЛАУНЧЕРА (#38) шапки нет вовсе: заголовок и кнопки «Загрузить выписку»/
           «Настройки» относятся к РАБОЧЕМУ экрану, а он открыт слайдером поверх. На пусковой
           странице они вели бы во второй фрейм того же приложения (удвоение опроса/подписок) и
           путали бы — экран лаунчера это только «окно открыто, вот путь обратно». -->
      <template
        v-if="!isBitrixMobile && !isLauncher"
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
        <!-- ПУСКОВАЯ СТРАНИЦА (#15): приложение открыли прямой ссылкой или пунктом левого меню.
             Рабочий экран здесь НЕ поднимаем — он уже открыт слайдером поверх, и держать его в двух
             фреймах значило бы удвоить опрос статуса, чтение настроек и pull-подписку к порталу
             клиента. Кнопка нужна, чтобы был путь обратно после закрытия слайдера. -->
        <!-- ⚠ Оформление по образцу InPortalGate-outside (#38): центрированный экран с заголовком
             первого уровня и описанием. Это единственное, что видно на пусковой странице, поэтому
             оно должно читаться как самостоятельный экран, а не как строчка над пустотой. -->
        <div
          v-if="launch === 'launcher'"
          class="mx-auto flex max-w-lg flex-col items-center justify-center gap-1 px-4 py-10 text-center"
          role="status"
          data-testid="app-launcher"
        >
          <ProseH1 class="mb-0 text-2xl">
            Выписки открываются в отдельном окне
          </ProseH1>
          <ProseP accent="less">
            Окно открывается поверх портала. Не открылось или вы его закрыли —
            нажмите «Открыть выписки».
          </ProseP>
          <ProseP
            v-if="sliderFailed"
            accent="less"
            class="text-(--ui-color-accent-main-alert)"
          >
            Окно открыть не удалось. Попробуйте ещё раз или обновите страницу.
          </ProseP>
          <div class="mt-1 flex flex-wrap items-center justify-center gap-2">
            <B24Button
              color="air-primary"
              label="Открыть выписки"
              data-testid="app-launcher-open"
              @click="() => { void openMain() }"
            />
          </div>
        </div>

        <!-- Ручная загрузка в мобильном — ОТДЕЛЬНОЙ кнопкой в теле, а не в шапке: шапки там нет,
             а загрузка файла с телефона — ровно то, ради чего приложение и открывают в дороге. -->
        <B24Button
          v-if="isBitrixMobile && !isLauncher"
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
