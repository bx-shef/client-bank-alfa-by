<script setup lang="ts">
import { useChatSettings } from '~/composables/useChatSettings'

// Раздел «Карта распознавания» (#109 §4): матрицы, алфавит, карта полей.
defineProps<{ disabled?: boolean }>()

const { settings } = useChatSettings()
</script>

<template>
  <RecognitionMap
    v-model="settings.recognition"
    :disabled="disabled"
  />
</template>
