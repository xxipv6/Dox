import { BrowserWindow, nativeTheme } from 'electron'
import type { AppSettings, UiTheme } from '../shared/types'

/**
 * 界面主题在主进程这一侧的收口。
 *
 * 渲染进程负责把颜色画出来，但有两件事它管不到，必须主进程做：
 *
 * 1. **建窗那一刻的底色。** 从窗口出现到 CSS 生效之间用户看到的是
 *    `BrowserWindow.backgroundColor`，渲染进程还没来得及跑。写死深色的话，
 *    亮色主题每次启动都会闪一块黑。
 * 2. **原生控件的主题。** `<select>` 弹开的下拉列表、滚动条、`confirm()`
 *    对话框都是操作系统/Chromium 画的，CSS 的 `color-scheme` 管不到弹出层。
 *    真正决定它们的是 `nativeTheme.themeSource`。
 */

/**
 * 窗口底色。
 *
 * ⚠️ 必须与 src/renderer/src/styles.css 里 `--bg` 的两套取值逐字一致。
 * 跨进程共享不了 CSS 变量，只能靠这行注释钉住 —— 对不上就会闪。
 */
const BACKGROUND: Record<'light' | 'dark', string> = {
  light: '#f8faff',
  dark: '#0b1220'
}

/** 'system' 落到当前系统值；其余原样。未设置时按亮色（与渲染层默认值一致） */
export function resolveUiTheme(uiTheme: UiTheme | undefined): 'light' | 'dark' {
  const mode = uiTheme ?? 'light'
  if (mode !== 'system') return mode
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

export function backgroundColorFor(uiTheme: UiTheme | undefined): string {
  return BACKGROUND[resolveUiTheme(uiTheme)]
}

/**
 * 把设置应用到原生层。设置变化时调用（`settings:set` 之后），
 * 也用于启动时先把 nativeTheme 摆正。
 */
export function applyNativeTheme(settings: AppSettings | null): void {
  const mode = settings?.uiTheme ?? 'light'
  nativeTheme.themeSource = mode

  const bg = backgroundColorFor(mode)
  for (const win of BrowserWindow.getAllWindows()) {
    // 只在预渲染期和实时缩放时看得见，但那段正是要消灭的闪白/闪黑窗口
    win.setBackgroundColor(bg)
  }
}
