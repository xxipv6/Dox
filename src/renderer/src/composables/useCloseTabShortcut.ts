import { onMounted, onUnmounted } from 'vue'

/**
 * 「关掉当前**标签**，而不是关掉整个窗口」这条快捷键，两个平台两条路：
 *
 * - **Windows / Linux**：Ctrl+W 由这里直接接管（默认应用菜单已在主进程摘掉，
 *   在这之前它就是被菜单里那条 CmdOrCtrl+W「关闭窗口」吃掉的）。
 * - **macOS**：走菜单。⌘W 是应用菜单的加速键，**优先于网页**，渲染层根本收不到
 *   那个 keydown —— 拦不住，只能把菜单项换成「关闭标签」（src/main/index.ts），
 *   它再 IPC 回来。所以这里额外挂一条 onMenuCloseTab。
 *
 * 三处刻意放行 —— 都是「不抢别人的按键」，不是漏写：
 * - **输入框与编辑器里**：Ctrl+W 是 Chromium 原生的「删掉前一个词」，在文件名、
 *   命令片段、编辑器里都用得上（mac 上删词的键是 ⌥⌫，⌘W 不受这条影响）；
 * - **终端里**：交给 TerminalPanel 自己的 key handler。它知道该关**哪一个**标签
 *   —— 平铺时焦点在第二格，而 store 的「当前标签」未必是你看的那一个；
 * - **弹窗开着时**：在对话框背后悄悄关掉一个标签，用户会以为点错了什么。
 */
export function useCloseTabShortcut(close: () => void): void {
  /** 两条路共用的落点：弹窗开着就不动 */
  const run = (): void => {
    if (document.querySelector('.overlay')) return
    close()
  }

  const onKeydown = (e: KeyboardEvent): void => {
    if (!e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
    if (e.key.toLowerCase() !== 'w') return
    const el = e.target as HTMLElement | null
    if (el?.closest?.('input, textarea, [contenteditable="true"], .xterm')) return
    e.preventDefault()
    run()
  }

  let offMenu: (() => void) | null = null
  onMounted(() => {
    window.addEventListener('keydown', onKeydown)
    offMenu = window.api.onMenuCloseTab(run)
  })
  onUnmounted(() => {
    window.removeEventListener('keydown', onKeydown)
    offMenu?.()
  })
}
