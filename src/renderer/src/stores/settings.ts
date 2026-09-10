import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { AppSettings } from '@shared/types'
import { getThemePreset, type TerminalThemePreset } from '../utils/themes'

/** 旧版把设置放在 localStorage；打包后那个源不落盘，dev 模式下则确实存过东西 */
const LEGACY_STORAGE_KEY = 'dox-settings'

// 必须显式标注为 AppSettings：用 satisfies 的话字面量会被收窄成
// `ligatures: false` 这种具体类型，ref 也跟着变成 Ref<false>，赋不进 boolean
const DEFAULT_SETTINGS: AppSettings = {
  themeId: 'tokyo-night',
  fontSize: 14,
  fontId: 'default',
  ligatures: false,
  localShellId: ''
}

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

/** 读旧 localStorage 里的设置，用于一次性迁移 */
function loadLegacy(): Partial<AppSettings> {
  try {
    return JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? '{}') as Partial<AppSettings>
  } catch {
    return {}
  }
}

/**
 * 应用设置：终端配色、字体、本地 shell 等。
 *
 * 存在主进程（electron-store），不是 localStorage —— 打包后渲染进程从
 * file:// 加载，往那个源写 localStorage 不会落盘，表现为「设置每次重启都还原」。
 *
 * 必须在应用挂载前 await load()：组件在渲染时就会读这里的值，
 * 晚一拍会让用户看到「先闪一下默认主题再变回来」。
 */
export const useSettingsStore = defineStore('settings', () => {
  const themeId = ref(DEFAULT_SETTINGS.themeId)
  const fontSize = ref(DEFAULT_SETTINGS.fontSize)
  const fontId = ref(DEFAULT_SETTINGS.fontId)
  const ligatures = ref(DEFAULT_SETTINGS.ligatures)
  const localShellId = ref(DEFAULT_SETTINGS.localShellId)
  const dialogVisible = ref(false)
  /** load() 完成前不写盘，否则会用默认值覆盖掉用户已保存的设置 */
  let loaded = false

  async function load(): Promise<void> {
    let persisted: AppSettings | null = null
    try {
      // 主进程读一个本地 JSON 文件而已，正常是毫秒级；万一它卡住，
      // 宁可带着默认值把界面开出来，也不能让用户对着白窗口干等
      persisted = await Promise.race([
        window.api.getSettings(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))
      ])
    } catch (err) {
      console.warn('[settings] 读取设置失败，使用默认值', err)
    }

    if (!persisted) {
      // 迁移：dev 模式下设置确实写在 localStorage 里，别让开发者白丢一遍
      const legacy = loadLegacy()
      if (Object.keys(legacy).length > 0) persisted = { ...DEFAULT_SETTINGS, ...legacy }
    }

    themeId.value = persisted?.themeId ?? DEFAULT_SETTINGS.themeId
    fontSize.value = persisted?.fontSize ?? DEFAULT_SETTINGS.fontSize
    fontId.value = persisted?.fontId ?? DEFAULT_SETTINGS.fontId
    ligatures.value = persisted?.ligatures ?? DEFAULT_SETTINGS.ligatures
    localShellId.value = persisted?.localShellId ?? DEFAULT_SETTINGS.localShellId
    loaded = true

    // 迁移过来的值立刻固化到新位置，之后就不再依赖 localStorage
    if (persisted) persist()
  }

  function persist(): void {
    if (!loaded) return
    window.api
      .setSettings({
        themeId: themeId.value,
        fontSize: fontSize.value,
        fontId: fontId.value,
        ligatures: ligatures.value,
        localShellId: localShellId.value
      })
      .catch((err) => console.warn('[settings] 保存设置失败', err))
  }

  const currentPreset = computed<TerminalThemePreset>(() => getThemePreset(themeId.value))
  const fontFamily = computed(
    () => (FONT_PRESETS.find((f) => f.id === fontId.value) ?? FONT_PRESETS[0]).family
  )

  watch([themeId, fontSize, fontId, ligatures, localShellId], persist)

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
    load,
    openDialog
  }
})
