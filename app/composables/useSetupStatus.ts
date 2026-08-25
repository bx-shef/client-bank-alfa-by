import { ref } from 'vue'
import { frameAuth, frameAuthHeaders as authHeaders, frameFetchError } from '~/composables/useFrameAuth'

// Server-side half of the setup checklist (#409/#405) — what the browser cannot know: connected
// bank accounts, the poll gate + period, and when the last run finished. The other half (chat,
// smart processes) comes from the settings the client already holds; `buildReadiness` joins them.
//
// Inert outside the portal frame: no token ⇒ defaults, so the card renders a truthful «ничего не
// настроено» preview instead of an error.

export interface SetupStatus {
  connectedAccounts: number
  /** Подключения без выбранного счёта (#407) — их надо доводить до конца. */
  pendingAccounts: number
  /** Подключения, которые приложение уже считает нерабочими (#504). ⚠ Поля не было в этом типе
   *  ВОВСЕ, хотя сервер его шлёт и `setupReadiness` читает: тип разошёлся с ответом, и счётчик не
   *  показывался ни разу. */
  unhealthyAccounts?: number
  /** Подключения с приостановленным автоопросом (#576). */
  pausedAccounts?: number
  pollEnabled: boolean
  pollIntervalMin: number
  lastRunMs: number | null
  /** Компания «моя» с расчётным счётом (#493). `undefined` — сервер не ответил на этот вопрос
   *  (старая сборка или отказ REST); строка тогда не рисуется вовсе. */
  myCompany?: 'ok' | 'no-company' | 'no-account'
  /** Последний прогон упёрся в неверную карту распознавания (#595). `undefined` — наблюдения нет
   *  (или старый сервер); строка карты тогда зависит только от числа шаблонов. */
  recognitionMisconfig?: { slot: string }
}

const DEFAULTS: SetupStatus = {
  connectedAccounts: 0,
  pendingAccounts: 0,
  pollEnabled: false,
  pollIntervalMin: 5,
  lastRunMs: null
}

export function useSetupStatus() {
  const status = ref<SetupStatus>({ ...DEFAULTS })
  /** Whether we are inside the portal frame (a token exists). Resolved by `load()` from OUR OWN
   *  frameAuth rather than borrowed from useChatSettings — that one only flips its flag after ITS
   *  load resolves, so a child mounting first would flash a false «предпросмотр» in-portal. */
  const inFrame = ref(false)
  const loading = ref(false)
  const loaded = ref(false)
  /** Было ли хоть одно УСПЕШНОЕ чтение. Отдельно от `loaded`, потому что вопросы разные:
   *  «проверка завершилась» (можно перестать показывать лоадер) и «данные в `status` настоящие»
   *  (можно на них ссылаться). Экран обновляется по возврату фокуса, и без этого флага одна
   *  моргнувшая сеть схлопывала бы уже показанный чек-лист в сообщение об ошибке. */
  const loadedOk = ref(false)
  const error = ref('')

  async function load(): Promise<void> {
    const a = frameAuth()
    inFrame.value = a !== null
    if (!a) {
      // Вне фрейма спрашивать некого: показываем дефолты и считаем проверку ЗАВЕРШЁННОЙ, иначе
      // карточка вечно висела бы в состоянии «проверяем настройку…».
      status.value = { ...DEFAULTS }
      loaded.value = true
      return
    }
    loading.value = true
    error.value = ''
    try {
      const res = await $fetch<Partial<SetupStatus>>('/api/setup-status', { headers: authHeaders(a) })
      loadedOk.value = true
      status.value = {
        connectedAccounts: Number(res?.connectedAccounts) || 0,
        pendingAccounts: Number(res?.pendingAccounts) || 0,
        // ⚠ Эти три поля ТЕРЯЛИСЬ (найдено ревью #597). Сервер их шлёт (`setupStatus.ts`), а
        // здесь литерал пересобирался по полям и молча их не переносил — то есть три функции
        // выглядели рабочими и не работали ни разу:
        //   • `pausedAccounts` — раздел «Очистка» считает `paused ?? 0` ⇒ всегда 0 ⇒ он предупреждал
        //     «опрос идёт», даже когда ВСЕ подключения на паузе. С массовой кнопкой (#581) это
        //     стало заметно сразу: приостановил всё — и тут же читаешь, что опрос идёт;
        //   • `unhealthyAccounts` — счётчик уже нерабочих подключений (#504) не показывался;
        //   • `myCompany` — строка «моя компания» (#493) на экране готовности не рисовалась ВОВСЕ.
        // ⚠ Пересборка по полям здесь намеренная (сервер отдаёт `Partial`, доверять форме нельзя),
        // поэтому лекарство не «спред», а перенос каждого поля с коэрсом — и тест, который держит
        // полноту.
        unhealthyAccounts: Number(res?.unhealthyAccounts) || 0,
        pausedAccounts: Number(res?.pausedAccounts) || 0,
        pollEnabled: res?.pollEnabled === true,
        pollIntervalMin: Number(res?.pollIntervalMin) || DEFAULTS.pollIntervalMin,
        lastRunMs: typeof res?.lastRunMs === 'number' ? res.lastRunMs : null,
        ...(res?.myCompany ? { myCompany: res.myCompany } : {}),
        // Признак misconfig карты распознавания (#595): переносим только валидный слот-объект,
        // иначе кривой ответ сервера зажёг бы красную строку на исправном портале.
        ...(res?.recognitionMisconfig && typeof res.recognitionMisconfig.slot === 'string' && res.recognitionMisconfig.slot !== ''
          ? { recognitionMisconfig: { slot: res.recognitionMisconfig.slot } }
          : {})
      }
    } catch (e) {
      error.value = frameFetchError(e, 'Не удалось загрузить состояние настройки')
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  return { status, inFrame, loading, loaded, loadedOk, error, load }
}
