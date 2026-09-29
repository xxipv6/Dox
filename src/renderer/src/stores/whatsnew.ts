import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { WhatsNewPayload } from '@shared/whatsnew'

/**
 * 更新公告（「本次更新了什么」）。
 *
 * 判定在主进程（whatsnew:get 对比 app.getVersion() 与已读版本），
 * 这里只持有「要弹的载荷」。关闭即调 whatsnew:seen 记成已读 ——
 * 放在 dismiss 里而不是 get 时：get 就写已读的话，弹窗还没渲染出来
 * 进程崩了用户就永远看不到这条公告。
 */
export const useWhatsNewStore = defineStore('whatsnew', () => {
  const payload = ref<WhatsNewPayload | null>(null)

  /** 启动时问一次主进程：版本变了且有公告条目才弹 */
  async function check(): Promise<void> {
    try {
      payload.value = await window.api.whatsNewGet()
    } catch {
      // 公告不是关键路径：读失败就当没有，不打扰启动
      payload.value = null
    }
  }

  /** 设置「关于」页的「查看更新内容」：不受已读状态影响，给什么弹什么 */
  function show(p: WhatsNewPayload): void {
    payload.value = p
  }

  function dismiss(): void {
    payload.value = null
    void window.api.whatsNewSeen()
  }

  return { payload, check, show, dismiss }
})
