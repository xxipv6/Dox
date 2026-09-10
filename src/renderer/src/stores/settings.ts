import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { getThemePreset, type TerminalThemePreset } from '../utils/themes'

const STORAGE_KEY = 'dox-settings'

interface PersistedSettings {
  themeId?: string
  fontSize?: number
}

function loadPersisted(): PersistedSettings {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as PersistedSettings
  } catch {
    return {}
  }
}

/** 应用设置：终端配色、字号等，localStorage 持久化（渲染进程本地偏好，无需过主进程） */
export const useSettingsStore = defineStore('settings', () => {
  const persisted = loadPersisted()

  const themeId = ref(persisted.themeId ?? 'tokyo-night')
  const fontSize = ref(persisted.fontSize ?? 14)
  const dialogVisible = ref(false)

  const currentPreset = computed<TerminalThemePreset>(() => getThemePreset(themeId.value))

  watch([themeId, fontSize], () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ themeId: themeId.value, fontSize: fontSize.value } satisfies PersistedSettings)
    )
  })

  function openDialog(): void {
    dialogVisible.value = true
  }

  return { themeId, fontSize, dialogVisible, currentPreset, openDialog }
})
