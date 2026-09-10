import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { LayoutSnapshot } from '@shared/types'
import { useSessionStore } from './sessions'

/** 布局变动很频繁（分屏、开关标签），攒一下再写 */
const SAVE_DEBOUNCE_MS = 400

/**
 * 标签布局的持久化与启动恢复。
 *
 * 快照存在**主进程**（electron-store），不是渲染进程的 localStorage：
 * 打包后渲染进程从 file:// 加载，Chromium 视其为不透明源，往那里写
 * localStorage 不会落盘（已实测：userData 里没有任何 file:// 源记录；
 * 换成自定义协议 dox:// 同样不落盘）。settings 也踩了这个坑，见交付说明。
 *
 * 快照是**随改动写**而不是退出时写：应用被强杀或崩溃时布局同样保得住。
 */
export const useLayoutStore = defineStore('layout', () => {
  /** 恢复期间挂起自动保存，否则重建过程会把快照一步步写坏 */
  const restoring = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null

  function snapshot(): LayoutSnapshot {
    const store = useSessionStore()
    return {
      tabs: store.tabs.map((tab) => ({
        kind: tab.kind,
        title: tab.title,
        split: tab.split,
        paneCount: tab.panes.length,
        active: tab.tabId === store.activeTabId,
        savedSessionId: tab.savedSessionId,
        // 未保存的 SSH 会话把地址留下：重启后没凭证，但至少能把表单填好。
        // 密码绝不进快照 —— 它只活在内存里，落盘一律不碰。
        host: tab.savedSessionId ? undefined : tab.config?.host,
        port: tab.savedSessionId ? undefined : tab.config?.port,
        username: tab.savedSessionId ? undefined : tab.config?.username
      }))
    }
  }

  function saveNow(): void {
    // 落盘失败不该打断使用，但要让它在控制台可见
    window.api.setLayout(snapshot()).catch((err) => {
      console.warn('[layout] 保存布局失败', err)
    })
  }

  /** 开始监听标签变化并落盘。恢复流程结束后再调用。 */
  function startAutoSave(): void {
    const store = useSessionStore()
    watch(
      () => store.tabs.map((t) => [t.tabId, t.split, t.panes.length, t.title, t.tabId === store.activeTabId]),
      () => {
        if (restoring.value) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(saveNow, SAVE_DEBOUNCE_MS)
      },
      { deep: true }
    )
  }

  /**
   * 按上次的布局重建标签。
   * 返回是否真的恢复了内容（false 表示调用方该开一个默认的本地终端）。
   */
  async function restore(): Promise<boolean> {
    const snap = await window.api.getLayout()
    if (!snap || snap.tabs.length === 0) return false

    const store = useSessionStore()
    restoring.value = true
    try {
      // 必须先拿到设备列表：savedSessionId 要查表才知道连接参数
      await store.refreshSaved()
      const byId = new Map(store.savedSessions.map((s) => [s.id, s]))

      let restored = 0
      let activeTabId: string | null = null

      for (const item of snap.tabs) {
        const before = store.tabs.at(-1)?.tabId

        if (item.kind === 'local') {
          await store.connectLocal()
        } else if (item.savedSessionId) {
          const saved = byId.get(item.savedSessionId)
          // 设备被删掉了：这个标签没有意义，跳过
          if (!saved) continue
          await store.connectSaved(saved)
        } else if (item.host && item.username) {
          // 显式构造：item 的 host/port/username 是可选的，收窄后传整个对象
          // 并不能让 TS 满意
          store.restoreUnsavedTab({
            title: item.title,
            host: item.host,
            port: item.port ?? 22,
            username: item.username
          })
        } else {
          continue
        }

        const tab = store.tabs.at(-1)
        if (!tab || tab.tabId === before) continue
        restored++

        // 分屏：按原有方向再开一条同配置会话
        if (item.split !== 'none' && item.paneCount > 1) {
          for (let i = 1; i < item.paneCount; i++) await store.splitActive(item.split)
        }
        if (item.active) activeTabId = tab.tabId
      }

      if (restored === 0) return false
      if (activeTabId) store.activeTabId = activeTabId
      return true
    } finally {
      restoring.value = false
    }
  }

  /** 清空快照：下次启动回到「只开一个本地终端」的默认形态 */
  function clear(): void {
    void window.api.setLayout({ tabs: [] })
  }

  return { restore, startAutoSave, clear, saveNow }
})
