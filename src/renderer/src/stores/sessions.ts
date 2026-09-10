import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type { SavedSession, SessionStatus, SshSessionConfig } from '@shared/types'

export interface PaneState {
  paneId: string
  /** 主进程分配的真实会话 id（shell 就绪后才有） */
  sessionId: string | null
  status: SessionStatus
  error?: string
}

/** row = 左右分屏，column = 上下分屏，none = 单 pane */
export type SplitDirection = 'none' | 'row' | 'column'

export interface SessionTab {
  tabId: string
  title: string
  /** 连接配置，分屏时用于克隆出新会话（密码等敏感信息本就经过渲染进程连接流程） */
  config: SshSessionConfig
  split: SplitDirection
  panes: PaneState[]
  activePaneId: string
}

let tabSeq = 0
let paneSeq = 0

function newPane(): PaneState {
  return reactive<PaneState>({ paneId: `pane-${++paneSeq}`, sessionId: null, status: 'connecting' })
}

export const useSessionStore = defineStore('sessions', () => {
  const tabs = ref<SessionTab[]>([])
  const activeTabId = ref<string | null>(null)
  const savedSessions = ref<SavedSession[]>([])
  /** 右侧 SFTP 文件面板开关 */
  const sftpVisible = ref(false)
  /** SFTP 面板是否跟随终端 cd 命令 */
  const followTerminal = ref(true)
  /** sessionId → 终端当前目录（由 TerminalPanel 的 cd 跟踪维护） */
  const cwdBySession = reactive<Record<string, string>>({})
  /** sessionId → 远端 home 目录 */
  const homeBySession = reactive<Record<string, string>>({})

  const activeTab = computed(() => tabs.value.find((t) => t.tabId === activeTabId.value) ?? null)
  const activePane = computed(
    () => activeTab.value?.panes.find((p) => p.paneId === activeTab.value!.activePaneId) ?? null
  )
  /** 当前聚焦 pane 的会话 id（SFTP 面板绑定它） */
  const activeSessionId = computed(() => activePane.value?.sessionId ?? null)

  function findPane(sessionId: string): PaneState | undefined {
    for (const tab of tabs.value) {
      const pane = tab.panes.find((p) => p.sessionId === sessionId)
      if (pane) return pane
    }
    return undefined
  }

  // 主进程状态推送：connected / closed / error
  window.api.onStatus(({ id, status, error }) => {
    const pane = findPane(id)
    if (!pane) return
    pane.status = status
    pane.error = error
  })

  async function connectPane(tab: SessionTab, pane: PaneState): Promise<void> {
    pane.status = 'connecting'
    try {
      // shell 建立前先用 80x24，建立后 xterm 的 onResize 会立即修正
      pane.sessionId = await window.api.connect(tab.config, { cols: 80, rows: 24 })
      pane.status = 'connected'
    } catch (err) {
      pane.status = 'error'
      pane.error = err instanceof Error ? err.message : String(err)
    }
  }

  async function connect(config: SshSessionConfig): Promise<void> {
    const pane = newPane()
    const tab = reactive<SessionTab>({
      tabId: `tab-${++tabSeq}`,
      title: `${config.username}@${config.host}`,
      config,
      split: 'none',
      panes: [pane],
      activePaneId: pane.paneId
    })
    tabs.value.push(tab)
    activeTabId.value = tab.tabId
    await connectPane(tab, pane)
  }

  /** 用已保存的会话发起连接（认证信息由主进程解密后直接用于连接） */
  async function connectSaved(saved: SavedSession): Promise<void> {
    const auth = await window.api.getSessionAuth(saved.id)
    await connect({
      host: saved.host,
      port: saved.port,
      username: saved.username,
      auth,
      jumpHostId: saved.jumpHostId
    })
  }

  /** 当前标签页分屏：以同一份配置新建一条独立会话（每个 pane 一条 SSH 连接） */
  async function splitActive(direction: 'row' | 'column'): Promise<void> {
    const tab = activeTab.value
    if (!tab || tab.split !== 'none' || !activePane.value?.sessionId) return
    const pane = newPane()
    tab.split = direction
    tab.panes.push(pane)
    tab.activePaneId = pane.paneId
    await connectPane(tab, pane)
  }

  function setActivePane(tab: SessionTab, pane: PaneState): void {
    tab.activePaneId = pane.paneId
  }

  function closePane(tab: SessionTab, pane: PaneState): void {
    if (pane.sessionId) window.api.disconnect(pane.sessionId)
    tab.panes = tab.panes.filter((p) => p.paneId !== pane.paneId)
    if (tab.panes.length === 0) {
      closeTab(tab)
      return
    }
    if (tab.panes.length === 1) tab.split = 'none'
    if (tab.activePaneId === pane.paneId) {
      tab.activePaneId = tab.panes[tab.panes.length - 1].paneId
    }
  }

  function closeTab(tab: SessionTab): void {
    for (const pane of tab.panes) {
      if (pane.sessionId) window.api.disconnect(pane.sessionId)
    }
    tabs.value = tabs.value.filter((t) => t.tabId !== tab.tabId)
    if (activeTabId.value === tab.tabId) {
      activeTabId.value = tabs.value.at(-1)?.tabId ?? null
    }
  }

  async function refreshSaved(): Promise<void> {
    savedSessions.value = await window.api.listSessions()
  }

  async function deleteSaved(id: string): Promise<void> {
    await window.api.deleteSession(id)
    await refreshSaved()
  }

  function toggleSftp(): void {
    sftpVisible.value = !sftpVisible.value
  }

  function toggleFollowTerminal(): void {
    followTerminal.value = !followTerminal.value
  }

  function setCwd(sessionId: string, path: string): void {
    cwdBySession[sessionId] = path
  }

  function setHome(sessionId: string, path: string): void {
    homeBySession[sessionId] = path
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    activePane,
    activeSessionId,
    savedSessions,
    sftpVisible,
    toggleSftp,
    followTerminal,
    toggleFollowTerminal,
    cwdBySession,
    homeBySession,
    setCwd,
    setHome,
    connect,
    connectSaved,
    splitActive,
    setActivePane,
    closePane,
    closeTab,
    refreshSaved,
    deleteSaved
  }
})
