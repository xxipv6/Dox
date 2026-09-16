import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { UpdaterState } from '@shared/types'

/**
 * 应用内更新状态的渲染层镜像（唯一事实源在主进程 updater.ts）。
 * 挂载时取一次快照，之后跟 updaterEvent 广播走 —— 快照是整体替换，
 * 不做增量合并，所以直接赋值即可。
 */
export const useUpdaterStore = defineStore('updater', () => {
  const state = ref<UpdaterState | null>(null)
  let off: (() => void) | null = null

  /** App.vue 挂载时调一次；重复调用安全（幂等） */
  async function init(): Promise<void> {
    if (off) return
    let eventArrived = false
    // 先订阅再取快照：invoke 往返期间的广播（如 macOS 的 codesign 探测结果）
    // 比快照新，以广播为准
    off = window.api.onUpdaterEvent((s) => {
      eventArrived = true
      state.value = s
    })
    try {
      const snapshot = await window.api.updaterGetState()
      if (!eventArrived) state.value = snapshot
    } catch {
      /* dev 模式主进程没注册也能跑，保持 null（UI 不渲染更新区） */
    }
  }

  return { state, init }
})
