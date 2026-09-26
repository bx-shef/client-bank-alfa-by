<script setup lang="ts">
import { ref } from 'vue'

// Раздел «Смарт-процессы» (#530): служебные СП + журнал распределения.
//
// Раньше сюда вела одна невнятная ссылка, и админ их просто не находил.
//
// ⚠ Журнал ПЕРЕМОНТИРУЕТСЯ после успешного провижининга (#19): он читает состояние при монтировании,
// и без перечитывания под карточкой «настроены» оставалось «ещё не настроены» до перезагрузки.
const ledgerKey = ref(0)
</script>

<template>
  <div class="space-y-4">
    <ProvisionSpCard @provisioned="ledgerKey++" />
    <DistributionTab :key="ledgerKey" />
  </div>
</template>
