import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type {
  SavedSession,
  SaveSessionInput,
  SessionStatus,
  SshSessionConfig
} from '@shared/types'
import { useSettingsStore } from './settings'
import { errorText } from '../utils/errors'

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
  /**
   * 该标签对应的已保存设备 id（临时连接为 undefined）。
   * 主进程凭它重新解密凭证做断线重连；布局快照也靠它判断重启后能否自动连接。
   */
  savedSessionId?: string
  /**
   * 未保存的临时连接被恢复到界面后留下的地址信息。
   * 用户点「重新连接」时用它预填认证表单 —— 密码不在其中，必须重新输入。
   */
  pendingPrefill?: { host: string; port: number; username: string }
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
  /**
   * 请求打开「添加设备」弹窗并预填地址（未保存会话的重新连接用）。
   * 弹窗挂在侧边栏，而触发点在终端面板，所以借 store 传一次话。
   */
  const addDevicePrefill = ref<{ host: string; port: number; username: string } | null>(null)

  function requestAddDevice(prefill: { host: string; port: number; username: string }): void {
    addDevicePrefill.value = prefill
  }

  function clearAddDeviceRequest(): void {
    addDevicePrefill.value = null
  }

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

  /**
   * 主进程在 invoke 返回之前就会推送 connected（本地 shell 甚至可能紧接着推
   * closed），那时 pane.sessionId 尚未赋值，事件会找不到归属而被丢弃 ——
   * 后果是「进程已死但界面显示已连接」。这里先缓存，绑定 sessionId 后回放。
   */
  const pendingStatus = new Map<string, { status: SessionStatus; error?: string }>()

  window.api.onStatus(({ id, status, error }) => {
    const pane = findPane(id)
    if (!pane) {
      pendingStatus.set(id, { status, error })
      return
    }
    pane.status = status
    pane.error = error
  })

  /** 该 pane 是否仍挂在某个标签下（连接在途时用户可能已关掉标签/窗格） */
  function isPaneAlive(pane: PaneState): boolean {
    return tabs.value.some((t) => t.panes.some((p) => p.paneId === pane.paneId))
  }

  /** 标签/窗格关闭时清掉该会话的附属状态，避免长期运行下无界增长 */
  function clearSessionState(sessionId: string): void {
    delete cwdBySession[sessionId]
    delete homeBySession[sessionId]
    delete exitCodeBySession[sessionId]
    pendingStatus.delete(sessionId)
  }

  async function connectPane(tab: SessionTab, pane: PaneState): Promise<void> {
    pane.status = 'connecting'
    try {
      // shell 建立前先用 80x24，建立后 xterm 的 onResize 会立即修正
      const size = { cols: 80, rows: 24 }
      const sessionId =
        tab.kind === 'local'
          ? await window.api.connectLocal(size, useSettingsStore().localShellId || undefined)
          : await window.api.connect(toPlainConfig(tab.config!), size, {
              savedSessionId: tab.savedSessionId
            })

      // 连接在途时用户可能已经关掉了标签/窗格：此时会话已建立但无人认领，
      // 必须立刻断开，否则 ssh 连接（含整条跳板机链路）或本地 shell 进程
      // 会一直留到应用退出
      if (!isPaneAlive(pane)) {
        window.api.disconnect(sessionId)
        return
      }

      // 先取出绑定前到达的状态事件（如 shell 启动即失败），再清理缓存
      const buffered = pendingStatus.get(sessionId)
      pendingStatus.delete(sessionId)

      pane.sessionId = sessionId
      pane.status = buffered?.status ?? 'connected'
      pane.error = buffered?.error
    } catch (err) {
      pane.status = 'error'
      pane.error = errorText(err)
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

  /**
   * 恢复一个「未保存的临时连接」标签（重启后回到上次布局）。
   *
   * 这类会话当初就没存密码，重启后无从自动登录，所以只把标签和地址还原出来，
   * 状态置为已断开；用户点一下再用表单里的地址重新认证。
   * 绝不会替用户去连 —— 没有凭证就是没有。
   */
  function restoreUnsavedTab(snap: {
    title: string
    host: string
    port: number
    username: string
  }): void {
    const pane = newPane()
    pane.status = 'closed'
    const tab = reactive<SessionTab>({
      tabId: `tab-${++tabSeq}`,
      title: snap.title,
      kind: 'ssh',
      config: null,
      pendingPrefill: { host: snap.host, port: snap.port, username: snap.username },
      split: 'none',
      panes: [pane],
      activePaneId: pane.paneId
    })
    tabs.value.push(tab)
    activeTabId.value = tab.tabId
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
      savedSessionId: saved.id,
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
      pane.error = errorText(err)
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
    if (pane.sessionId) {
      window.api.disconnect(pane.sessionId)
      clearSessionState(pane.sessionId)
    }
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
      if (pane.sessionId) {
        window.api.disconnect(pane.sessionId)
        clearSessionState(pane.sessionId)
      }
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
    addDevicePrefill,
    requestAddDevice,
    clearAddDeviceRequest,
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
    restoreUnsavedTab,
    splitActive,
    setActivePane,
    closePane,
    closeTab,
    refreshSaved,
    deleteSaved,
    saveSession
  }
})
