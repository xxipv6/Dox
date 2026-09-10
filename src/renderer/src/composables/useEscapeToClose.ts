import { onUnmounted } from 'vue'

/**
 * 弹窗按 Esc 关闭。
 *
 * 挂在 window 上而不是弹窗元素上：弹窗里的输入框、按钮会抢走焦点，
 * 绑在容器上的 keydown 根本收不到事件。挂在 window 上则无论焦点在
 * 哪个输入框里都能生效。
 *
 * 记录成栈，Escape 只关**最上面那个打开着的**弹窗 —— 指纹确认弹窗
 * 可能盖在添加设备弹窗之上，一次 Esc 不该把两个都关掉。
 */
interface Entry {
  /** 传函数而不是布尔值：弹窗组件常年挂载着，开合只是内部 v-if */
  isOpen: () => boolean
  close: () => void
}

const stack: Entry[] = []
let listening = false

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!stack[i].isOpen()) continue
    e.preventDefault()
    e.stopPropagation()
    stack[i].close()
    return
  }
}

export function useEscapeToClose(isOpen: () => boolean, close: () => void): void {
  const entry: Entry = { isOpen, close }
  stack.push(entry)
  if (!listening) {
    window.addEventListener('keydown', onKeydown)
    listening = true
  }

  onUnmounted(() => {
    const i = stack.indexOf(entry)
    if (i >= 0) stack.splice(i, 1)
    if (!stack.length && listening) {
      window.removeEventListener('keydown', onKeydown)
      listening = false
    }
  })
}
