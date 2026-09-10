import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { AppSettings, UiTheme } from '@shared/types'
import { AUTO_THEME_ID, resolveThemePreset, type TerminalThemePreset } from '../utils/themes'

/** 旧版把设置放在 localStorage；打包后那个源不落盘，dev 模式下则确实存过东西 */
const LEGACY_STORAGE_KEY = 'dox-settings'

/** 重设计之前 themeId 的默认值。迁移时靠它判断「用户到底选没选过」 */
const LEGACY_DEFAULT_THEME = 'tokyo-night'

// 必须显式标注为 AppSettings：用 satisfies 的话字面量会被收窄成
// `ligatures: false` 这种具体类型，ref 也跟着变成 Ref<false>，赋不进 boolean
const DEFAULT_SETTINGS: AppSettings = {
  // 默认跟随界面主题：装好就是亮色界面配亮色终端，不会一上来就割裂
  themeId: AUTO_THEME_ID,
  uiTheme: 'light',
  fontSize: 14,
  fontId: 'default',
  ligatures: false,
  localShellId: ''
}

/** 界面主题三选。'system' 那一项的解释文案见设置弹窗 */
export const UI_THEME_OPTIONS: { id: UiTheme; name: string }[] = [
  { id: 'light', name: '亮色' },
  { id: 'dark', name: '深色' },
  { id: 'system', name: '跟随系统' }
]

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
 * 应用设置：界面主题、终端配色、字体、本地 shell。
 *
 * 存在主进程（electron-store），不是 localStorage —— 打包后渲染进程从
 * file:// 加载，往那个源写 localStorage 不会落盘，表现为「设置每次重启都还原」。
 *
 * 必须在应用挂载前 await load()：组件在渲染时就会读这里的值，
 * 晚一拍会让用户看到「先闪一下默认主题再变回来」。
 */
export const useSettingsStore = defineStore('settings', () => {
  const themeId = ref(DEFAULT_SETTINGS.themeId)
  const uiTheme = ref<UiTheme>(DEFAULT_SETTINGS.uiTheme)
  const fontSize = ref(DEFAULT_SETTINGS.fontSize)
  const fontId = ref(DEFAULT_SETTINGS.fontId)
  const ligatures = ref(DEFAULT_SETTINGS.ligatures)
  const localShellId = ref(DEFAULT_SETTINGS.localShellId)
  const dialogVisible = ref(false)
  /** load() 完成前不写盘，否则会用默认值覆盖掉用户已保存的设置 */
  let loaded = false

  /*
   * 系统深浅色。用 ref 兜住 matchMedia 的当前值，resolvedTheme 才是纯计算 ——
   * 如果让 computed 直接读 matchMedia().matches，系统切换时它不会重新求值，
   * 「跟随系统」就变成了「跟随启动那一刻的系统」。
   */
  const systemQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const systemPrefersDark = ref(systemQuery.matches)
  systemQuery.addEventListener('change', (e) => {
    systemPrefersDark.value = e.matches
  })

  /** 实际生效的深浅：'system' 落到当前系统值，其余原样 */
  const resolvedTheme = computed<'light' | 'dark'>(() =>
    uiTheme.value === 'system' ? (systemPrefersDark.value ? 'dark' : 'light') : uiTheme.value
  )

  /*
   * 把解析结果写到 <html data-theme>。
   *
   * 放在 store 里而不是 main.ts，是为了让「resolvedTheme 一定已经反映在 DOM 上」
   * 这条不变量没有第二个入口可以绕过。immediate 的那一次写入发生在 store 首次
   * 被使用时（main.ts 的 load() 调用点），仍在 app.mount() 之前 —— 所以不会
   * 出现「先闪一下默认色再变回来」。
   *
   * 颜色本身由 styles.css 的 `:root[data-theme='…']` 决定，这里只切开关。
   */
  watch(
    resolvedTheme,
    (theme) => {
      document.documentElement.dataset['theme'] = theme
    },
    { immediate: true }
  )

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
    uiTheme.value = persisted?.uiTheme ?? DEFAULT_SETTINGS.uiTheme

    /*
     * 一次性迁移：老配置里没有 uiTheme 这个键，说明它来自重设计之前。
     *
     * 那时界面是深色、终端默认也是深色，两者看着是一体的；现在界面默认变亮色，
     * 如果放任 themeId 停在旧值，用户升级后看到的会是「白界面 + 黑终端」——
     * 正是这次要消掉的割裂感。所以把**没选过**（还停留在旧默认值）的人切到
     * 「跟随界面」。
     *
     * 只动旧默认值：用户真去挑过 Solarized / Monokai 的话，那是明确的选择，
     * 不替他改。他随时可以在设置里再选一次。
     */
    if (persisted && persisted.uiTheme === undefined && persisted.themeId === LEGACY_DEFAULT_THEME) {
      themeId.value = AUTO_THEME_ID
    }
    loaded = true

    // 迁移过来的值立刻固化到新位置，之后就不再依赖 localStorage
    if (persisted) persist()
  }

  function persist(): void {
    if (!loaded) return
    window.api
      .setSettings({
        themeId: themeId.value,
        uiTheme: uiTheme.value,
        fontSize: fontSize.value,
        fontId: fontId.value,
        ligatures: ligatures.value,
        localShellId: localShellId.value
      })
      .catch((err) => console.warn('[settings] 保存设置失败', err))
  }

  /*
   * 跟着 resolvedTheme 而不是 themeId：themeId 是 auto 时切界面主题，
   * 这个 computed 会变但 themeId 没变，终端就跟着不上了。
   */
  const currentPreset = computed<TerminalThemePreset>(() =>
    resolveThemePreset(themeId.value, resolvedTheme.value)
  )
  const fontFamily = computed(
    () => (FONT_PRESETS.find((f) => f.id === fontId.value) ?? FONT_PRESETS[0]).family
  )

  watch([themeId, uiTheme, fontSize, fontId, ligatures, localShellId], persist)

  /** 一键切换（侧栏那个太阳/月亮按钮）：亮 ↔ 暗 */
  function toggleTheme(): void {
    uiTheme.value = resolvedTheme.value === 'dark' ? 'light' : 'dark'
  }

  function openDialog(): void {
    dialogVisible.value = true
  }

  return {
    themeId,
    uiTheme,
    fontSize,
    fontId,
    ligatures,
    localShellId,
    dialogVisible,
    resolvedTheme,
    currentPreset,
    fontFamily,
    toggleTheme,
    load,
    openDialog
  }
})
