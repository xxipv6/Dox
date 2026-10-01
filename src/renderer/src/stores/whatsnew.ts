import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { WhatsNewPayload } from '@shared/whatsnew'

/**
 * 「查看更新内容」弹窗的载荷持有处。
 *
 * 只在设置「关于」页手动点「更新内容」时弹（show），没有自动弹窗：
 * 更新内容在更新前经 UpdateDialog 展示，装完再弹一遍是重复打扰。
 */
export const useWhatsNewStore = defineStore('whatsnew', () => {
  const payload = ref<WhatsNewPayload | null>(null)

  function show(p: WhatsNewPayload): void {
    payload.value = p
  }

  function dismiss(): void {
    payload.value = null
  }

  return { payload, show, dismiss }
})
