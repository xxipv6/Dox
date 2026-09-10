import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type {
  SavedSession,
  SaveSessionInput,
  SessionStatus,
  SshSessionConfig
} from '@shared/types'
import { useSettingsStore } from './settings'

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
  /** ssh = 远端会话；local = 本地终端（node-pty） */
  kind: 'ssh' | 'local'
  /** SSH 标签页的连接配置，分屏时用于克隆出新会话；本地标签页为 null */
  config: SshSessionConfig | null
  split: SplitDirection
  panes: PaneState[]
  activePaneId: string
}

let tabSeq = 0
let paneSeq = 0

function newPane(): PaneState {
  return reactive<PaneState>({ paneId: `pane-${++paneSeq}`, sessionId: null, status: 'connecting' })
}

/**
 * 深拷贝成纯对象再交给 IPC。
 * 会话配置存在 reactive() 的 tab 里，读出来是 Proxy —— Proxy 无法被
 * Electron IPC 的结构化克隆序列化，会直接报 "An object could not be cloned."。
 */
function toPlainConfig(config: SshSessionConfig): SshSessionConfig {
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    auth:
      config.auth.type === 'password'
        ? { type: 'password', password: config.auth.password }
        : {
            type: 'key',
            privateKeyPath: config.auth.privateKeyPath,
            passphrase: config.auth.passphrase
          },
    jumpHostId: config.jumpHostId
  }
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
  /** sessionId → 上一条命令的退出码（shell integration，OSC 133） */
  const exitCodeBySession = reactive<Record<string, number>>({})

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
      const size = { cols: 80, rows: 24 }
      pane.sessionId =
        tab.kind === 'local'
          ? await window.api.connectLocal(size, useSettingsStore().localShellId || undefined)
          : await window.api.connect(toPlainConfig(tab.config!), size)
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
      kind: 'ssh',
      config,
      split: 'none',
      panes: [pane],
      activePaneId: pane.paneId
    })
    tabs.value.push(tab)
    activeTabId.value = tab.tabId
    await connectPane(tab, pane)
  }

  /** 打开本地终端标签页（Wave 形态：应用启动的默认视图） */
  async function connectLocal(): Promise<void> {
    const pane = newPane()
    const tab = reactive<SessionTab>({
      tabId: `tab-${++tabSeq}`,
      title: '本地终端',
      kind: 'local',
      config: null,
      split: 'none',
      panes: [pane],
      activePaneId: pane.paneId
    })
    tabs.value.push(tab)
    activeTabId.value = tab.tabId
    await connectPane(tab, pane)
  }

  /**
   * 用已保存的会话发起连接（认证信息由主进程解密后直接用于连接）。
   * 先建标签再取认证：这样取认证失败（如未保存密码）也能把错误显示在标签上，
   * 不会变成一个静默的未处理 Promise rejection。
   */
  async function connectSaved(saved: SavedSession): Promise<void> {
    const pane = newPane()
    const tab = reactive<SessionTab>({
      tabId: `tab-${++tabSeq}`,
      title: saved.name || `${saved.username}@${saved.host}`,
      kind: 'ssh',
      config: null,
      split: 'none',
      panes: [pane],
      activePaneId: pane.paneId
    })
    tabs.value.push(tab)
    activeTabId.value = tab.tabId

    try {
      const auth = await window.api.getSessionAuth(saved.id)
      tab.config = {
        host: saved.host,
        port: saved.port,
        username: saved.username,
        auth,
        jumpHostId: saved.jumpHostId
      }
      await connectPane(tab, pane)
    } catch (err) {
      pane.status = 'error'
      pane.error = err instanceof Error ? err.message : String(err)
    }
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

  async function saveSession(input: SaveSessionInput): Promise<SavedSession> {
    const saved = await window.api.saveSession(input)
    await refreshSaved()
    return saved
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

  function setLastExitCode(sessionId: string, code: number): void {
    exitCodeBySession[sessionId] = code
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
    exitCodeBySession,
    setCwd,
    setHome,
    setLastExitCode,
    connect,
    connectSaved,
    connectLocal,
    splitActive,
    setActivePane,
    closePane,
    closeTab,
    refreshSaved,
    deleteSaved,
    saveSession
  }
})
