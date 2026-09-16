import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 全局确认弹窗（替代原生 window.confirm —— 那玩意儿跟界面两套画风，太丑）。
 *
 * 用法：`if (!(await useConfirmStore().ask('确认删除？'))) return`
 * 弹窗本体是 ConfirmDialog.vue（挂在 App.vue），样式走 .overlay/.dialog/
 * .pop-surface 词汇表。一次只弹一个：上一个没答完又来新的，按取消收掉。
 */
export const useConfirmStore = defineStore('confirm', () => {
  const visible = ref(false)
  const message = ref('')
  /** 破坏性动作用 danger 红按钮（删除/丢弃修改都是），默认 true */
  const danger = ref(true)
  const confirmText = ref('确定')
  let resolver: ((v: boolean) => void) | null = null

  function ask(msg: string, opts?: { danger?: boolean; confirmText?: string }): Promise<boolean> {
    if (resolver) resolver(false)
    message.value = msg
    danger.value = opts?.danger ?? true
    confirmText.value = opts?.confirmText ?? '确定'
    visible.value = true
    return new Promise((r) => {
      resolver = r
    })
  }

  function answer(v: boolean): void {
    visible.value = false
    resolver?.(v)
    resolver = null
  }

  return { visible, message, danger, confirmText, ask, answer }
})
