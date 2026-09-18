import type { Directive } from 'vue'

/**
 * autofocus 属性对动态插入的元素不可靠（同一页面第二次插入常常不聚焦）。
 * 输入框没聚焦就不会有 blur —— 用户点别处输入框也不消失（报告过的 bug）。
 * 指令是确定性的：挂载即聚焦；输入框再像 Finder 一样预选主名（不含扩展名）。
 * 按钮也可用（确认弹窗的默认钮 —— 焦点不进去 Enter 就会被底下的面板截走）。
 */
export const vFocus: Directive<HTMLElement> = {
  mounted(el) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLButtonElement)) return
    el.focus()
    if (el instanceof HTMLInputElement) {
      const dot = el.value.lastIndexOf('.')
      el.setSelectionRange(0, dot > 0 ? dot : el.value.length)
    }
  }
}
