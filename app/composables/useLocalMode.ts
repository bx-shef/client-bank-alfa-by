import { isLocalMode } from '~/utils/localMode'

// Реактивной части нет: `NUXT_PUBLIC_LOCAL_MODE` — build-time константа (запечена в статику), поэтому
// возвращаем обычный boolean, а не ref. Компоненты гейтят промо через `v-if="!localMode"`.
export function useLocalMode(): boolean {
  return isLocalMode(useRuntimeConfig().public.localMode)
}
