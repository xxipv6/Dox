import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { getThemePreset, type TerminalThemePreset } from '../utils/themes'

const STORAGE_KEY = 'dox-settings'

/** 编程字体候选；系统未安装时会回退到等宽默认字体，不会报错 */
export const FONT_PRESETS = [
  { id: 'default', name: '跟随系统等宽', family: 'Consolas, "Courier New", monospace' },
  { id: 'cascadia', name: 'Cascadia Code', family: '"Cascadia Code", Consolas, monospace' },
  { id: 'cascadia-mono', name: 'Cascadia Mono', family: '"Cascadia Mono", Consolas, monospace' },
  { id: 'jetbrains', name: 'JetBrains Mono', family: '"JetBrains Mono", Consolas, monospace' },
  { id: 'firacode', name: 'Fira Code', family: '"Fira Code", Consolas, monospace' },
  { id: 'hack', name: 'Hack', family: 'Hack, Consolas, monospace' },
  { id: 'menlo', name: 'Menlo / Monaco', family: 'Menlo, Monaco, Consolas, monospace' }
]

interface PersistedSettings {
  themeId?: string
  fontSize?: number
  fontId?: string
  /** 连字需要 DOM 渲染器（WebGL 逐字形绘制，无法做字形替换） */
  ligatures?: boolean
  localShellId?: string
}

function loadPersisted(): PersistedSettings {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as PersistedSettings
  } catch {
    return {}
  }
}

/** 应用设置：终端配色、字体、本地 shell 等，localStorage 持久化 */
export const useSettingsStore = defineStore('settings', () => {
  const persisted = loadPersisted()

  const themeId = ref(persisted.themeId ?? 'tokyo-night')
  const fontSize = ref(persisted.fontSize ?? 14)
  const fontId = ref(persisted.fontId ?? 'default')
  const ligatures = ref(persisted.ligatures ?? false)
  const localShellId = ref(persisted.localShellId ?? '')
  const dialogVisible = ref(false)

  const currentPreset = computed<TerminalThemePreset>(() => getThemePreset(themeId.value))
  const fontFamily = computed(
    () => (FONT_PRESETS.find((f) => f.id === fontId.value) ?? FONT_PRESETS[0]).family
  )

  watch([themeId, fontSize, fontId, ligatures, localShellId], () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        themeId: themeId.value,
        fontSize: fontSize.value,
        fontId: fontId.value,
        ligatures: ligatures.value,
        localShellId: localShellId.value
      } satisfies PersistedSettings)
    )
  })

  function openDialog(): void {
    dialogVisible.value = true
  }

  return {
    themeId,
    fontSize,
    fontId,
    ligatures,
    localShellId,
    dialogVisible,
    currentPreset,
    fontFamily,
    openDialog
  }
})
