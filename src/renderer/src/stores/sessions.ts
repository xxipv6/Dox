import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import { AUTH_DECRYPT_FAILED } from '@shared/types'
import type {
  ContainerInfo,
  CliCommandPayload,
  SavedSession,
  SaveSessionInput,
  SessionStatus,
  SshSessionConfig
} from '@shared/types'
import { useSettingsStore } from './settings'
import { errorText } from '../utils/errors'
import { seedTermSize } from '../utils/termSize'

export interface PaneState {
  paneId: string
  /** 主进程分配的真实会话 id（shell 就绪后才有） */
  sessionId: string | null
  status: SessionStatus
  error?: string
}

/** row = 左右分屏，column = 上下分屏，none = 单 pane */
export type SplitDirection = 'none' | 'row' | 'column'

/** 容器标签的出身：从哪条 SSH 会话、进哪个容器 */
export interface ContainerTabInfo {
  /**
   * 承载 `docker exec` 的父 SSH 会话 id。
   * 同一标签的所有 pane 共用这一个 client，各自开一条独立的 exec 通道。
   */
  parentSessionId: string
  containerName: string
  image: string
  /** true = 日志标签（docker logs -f）；缺省/false = 容器内 shell。复用与标题都靠它区分 */
  logs?: boolean
  /**
   * 嵌套容器才有：从宿主到直接外层的逐跳容器名链（可任意深）。
   * 非空时这个容器活在链末端容器里（docker exec 链进入），
   * agent 依赖面（文件面板/进程管理/转发建议）不开放。
   */
  chain?: string[]
  /**
   * 直连容器才有：父会话是按需建的传输会话，这里记它的设备 id。
   * 传输会话死掉后重连容器 pane 靠它重建承载（ensureTransport 换新父）。
   */
  originSavedId?: string
}

export interface SessionTab {
  tabId: string
  title: string
  /** ssh = 远端宿主机；local = 本地终端（node-pty）；container = 容器内 shell */
  kind: 'ssh' | 'local' | 'container'
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
  /** 只有 kind === 'container' 才有 */
  container?: ContainerTabInfo
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
  /**
   * agent 安装成功的标记（单调递增）。AgentPanel 装完 bump 一次，
   * 开着的 TerminalPanel 据此重试 startPortWatch —— 否则装完要重开
   * 标签推送才生效（mount 时状态还是「未安装」，已经走了轮询兜底）。
   */
  const agentInstallStamp = ref(0)
  function markAgentInstalled(): void {
    agentInstallStamp.value++
  }

  // ---- 直连容器（Dev Containers 式：不开宿主机终端标签，后台传输会话承载）----

  /** savedSessionId → 传输会话 id（无 shell 的后台 SSH 连接，容器操作的承载） */
  const transports = reactive<Record<string, string>>({})
  /** 连接去重：同一台设备并发 ensure 只连一次 */
  const transportPending = new Map<string, Promise<string>>()
  /** 侧栏正展开着容器列表的设备（展开本身也是传输会话的一种占用） */
  const expandedDevices = reactive(new Set<string>())
  /** savedSessionId → 该设备的容器列表加载状态 */
  const deviceContainers = reactive<
    Record<string, { status: 'loading' | 'ok' | 'error'; list: ContainerInfo[]; error?: string }>
  >({})

  /**
   * 取某台已保存设备的传输会话，没有就连一条。
   * 传输会话没有 shell、没有终端标签 —— 它只是 docker exec / 容器文件操作的
   * 承载连接（VS Code Remote-Containers 里那条看不见的宿主机 SSH）。
   */
  async function ensureTransport(savedId: string): Promise<string> {
    const live = transports[savedId]
    if (live) return live
    const pending = transportPending.get(savedId)
    if (pending) return pending
    const p = window.api
      .connectTransport(savedId)
      .then((id) => {
        transports[savedId] = id
        // 首条 connected 事件到达时登记表还没建（invoke 未返回），已落进 pendingStatus，清掉
        pendingStatus.delete(id)
        return id
      })
      .finally(() => transportPending.delete(savedId))
    transportPending.set(savedId, p)
    return p
  }

  /**
   * 传输会话空闲回收：侧栏没展开它、也没有任何容器标签挂在它上面时断开。
   * 调用点：收起设备行、关掉容器标签、删除设备。
   */
  function releaseTransportIfIdle(savedId: string): void {
    const tid = transports[savedId]
    if (!tid || expandedDevices.has(savedId)) return
    const inUse = tabs.value.some(
      (t) => t.kind === 'container' && t.container?.parentSessionId === tid
    )
    if (inUse) return
    window.api.disconnect(tid)
    delete transports[savedId]
  }

  async function loadDeviceContainers(savedId: string): Promise<void> {
    deviceContainers[savedId] = { status: 'loading', list: [] }
    try {
      const tid = await ensureTransport(savedId)
      const probe = await window.api.listContainers(tid)
      if (!expandedDevices.has(savedId)) return // 加载期间已被收起，结果直接丢
      deviceContainers[savedId] = probe.ok
        ? { status: 'ok', list: probe.list.containers }
        : { status: 'error', list: [], error: probe.message }
    } catch (err) {
      if (!expandedDevices.has(savedId)) return
      deviceContainers[savedId] = { status: 'error', list: [], error: errorText(err) }
    }
  }

  /** 侧栏设备行的展开/收起：展开即拉容器列表，收起顺手回收空闲传输会话 */
  async function toggleDeviceContainers(saved: SavedSession): Promise<void> {
    if (expandedDevices.has(saved.id)) {
      expandedDevices.delete(saved.id)
      delete deviceContainers[saved.id]
      releaseTransportIfIdle(saved.id)
      return
    }
    expandedDevices.add(saved.id)
    await loadDeviceContainers(saved.id)
  }

  /**
   * 直连进容器：不开宿主机终端标签，传输会话当承载。
   * 传输会话由这里按需建立，标签关掉后由 releaseTransportIfIdle 回收。
   * 承载都建不起来时也要让错误**看得见**：开一个错误态标签，
   * 占位区的「重新连接」按钮（reconnectPane 按 originSavedId 重建承载）就是退路。
   */
  async function enterContainerDirect(
    saved: SavedSession,
    box: Pick<ContainerInfo, 'name' | 'image'>
  ): Promise<void> {
    try {
      const tid = await ensureTransport(saved.id)
      await enterContainer(tid, box, saved.id)
    } catch (err) {
      const pane = newPane()
      pane.status = 'error'
      pane.error = errorText(err)
      const tab = reactive<SessionTab>({
        tabId: `tab-${++tabSeq}`,
        title: `容器 · ${box.name}`,
        kind: 'container',
        config: null,
        container: { parentSessionId: '', containerName: box.name, image: box.image, originSavedId: saved.id },
        split: 'none',
        panes: [pane],
        activePaneId: pane.paneId
      })
      tabs.value.push(tab)
      activeTabId.value = tab.tabId
    }
  }

  /**
   * 原地复活一个死 pane（标签占位区/复活覆盖层的「重新连接」）。
   * 先清掉旧会话残迹，再走正常连接流程 —— 与当初建 pane 同一条路，
   * 只是这次用户不用关掉标签去侧栏重新找设备。
   */
  async function reconnectPane(tab: SessionTab, pane: PaneState): Promise<void> {
    if (pane.sessionId) {
      window.api.disconnect(pane.sessionId)
      clearSessionState(pane.sessionId)
      pane.sessionId = null
    }
    // 直连容器：父传输会话可能已随标签死亡被回收，按原籍重建承载再换父
    if (tab.kind === 'container' && tab.container?.originSavedId) {
      try {
        tab.container.parentSessionId = await ensureTransport(tab.container.originSavedId)
      } catch (err) {
        pane.status = 'error'
        pane.error = errorText(err)
        return
      }
    }
    await connectPane(tab, pane)
  }

  /** 保存的密码解密失败时，请求侧栏打开该设备的编辑框（重输密码即自愈） */
  const editSessionRequest = ref<SavedSession | null>(null)

  function requestEditSession(saved: SavedSession): void {
    editSessionRequest.value = saved
  }

  function clearEditSessionRequest(): void {
    editSessionRequest.value = null
  }

  function requestAddDevice(prefill: { host: string; port: number; username: string }): void {
    addDevicePrefill.value = prefill
  }

  /**
   * CLI 伴侣（dox 命令）：dox . 开本地标签；dox user@host:port 连接。
   * 连接优先匹配已保存设备（host 必配，user/port 给了也要对上）——
   * 库存凭证直接用；没存过就预填添加设备表单，绝不凭空试密码。
   */
  async function handleCliCommand(cmd: CliCommandPayload): Promise<void> {
    if (cmd.kind === 'local' && cmd.cwd) {
      await connectLocal(cmd.cwd)
      return
    }
    if (cmd.kind !== 'connect' || !cmd.target) return
    // 冷启动（dox 命令把 app 唤起）时设备列表可能还没拉回来：
    // 不匹配直接掉进预填表单 = 明明存过的设备连不上。先确保列表在手
    if (!savedSessions.value.length) await refreshSaved()
    // IPv6 用 [addr] 写法（root@[2001:db8::1]:2222），否则按 host[:port] 拆
    const m = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(cmd.target)
    if (!m) return
    const [, user, hostRaw, portStr] = m
    const host = hostRaw.startsWith('[') ? hostRaw.slice(1, -1) : hostRaw
    const saved = savedSessions.value.find(
      (s) =>
        s.host === host &&
        (!user || s.username === user) &&
        (!portStr || s.port === Number(portStr))
    )
    if (saved) void connectSaved(saved)
    else requestAddDevice({ host, port: portStr ? Number(portStr) : 22, username: user ?? 'root' })
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
    // 传输会话不属于任何 pane：断线只影响挂在它上面的直连容器。
    // 清掉登记表，下次 ensureTransport 自然会重连一条。
    const transportSavedId = Object.keys(transports).find((k) => transports[k] === id)
    if (transportSavedId) {
      if (status === 'closed' || status === 'error') {
        delete transports[transportSavedId]
        const dc = deviceContainers[transportSavedId]
        if (dc?.status === 'loading') {
          deviceContainers[transportSavedId] = {
            status: 'error',
            list: [],
            error: error ?? '连接已断开'
          }
        }
      }
      return
    }
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
    // 监控面板的宿主机目标死了就收面板 —— 概览的数据订阅挂在发起页上，
    // 发起页没了会定格假数据；本机容器目标的轮询还会重新 spawn agent
    // 通道而没有任何代码路径关它
    if (monitorTarget.value && !monitorTarget.value.containerName && monitorTarget.value.sessionId === sessionId) {
      closeMonitor()
    }
  }

  async function connectPane(tab: SessionTab, pane: PaneState, cwd?: string): Promise<void> {
    pane.status = 'connecting'
    try {
      // 用上一个终端的真实尺寸（见 utils/termSize）：写死 80x24 会让 pty
      // 出生即错尺寸，而 tmux 这类程序会把出生尺寸读进自己的状态
      const size = seedTermSize()
      const sessionId =
        tab.kind === 'local'
          ? await window.api.connectLocal(size, useSettingsStore().localShellId || undefined, cwd)
          : tab.kind === 'container'
            ? tab.container!.logs
              ? await window.api.connectContainerLogs(
                  tab.container!.parentSessionId,
                  tab.container!.containerName,
                  size,
                  // reactive 数组是 Proxy，过不了 IPC 结构化克隆 —— 拷贝成纯数组
                  tab.container!.chain ? [...tab.container!.chain] : undefined
                )
              : await window.api.connectContainer(
                  tab.container!.parentSessionId,
                  tab.container!.containerName,
                  size,
                  tab.container!.chain ? [...tab.container!.chain] : undefined
                )
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

  /** 打开本地终端标签页（Wave 形态：应用启动的默认视图）。cwd：布局恢复指定初始目录 */
  async function connectLocal(cwd?: string): Promise<void> {
    // 没指定目录（布局恢复之外的普通新开）：设置里的「默认目录」，没设就回家目录（spawn 兜底）
    if (!cwd) {
      cwd = useSettingsStore().localDefaultDir || undefined
    }
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
    await connectPane(tab, pane, cwd)
  }

  /**
   * 进入一个容器：在父 SSH 会话的连接上开一条 docker exec 通道。
   *
   * 同一个容器已有标签时**复用/聚焦**而不是再堆一个 ——
   * 反复进出同一个容器不该把标签栏塞满：活着的标签直接聚焦，
   * 死掉的标签复用重连。
   */
  async function enterContainer(
    parentSessionId: string,
    box: Pick<ContainerInfo, 'name' | 'image'>,
    originSavedId?: string,
    chain?: string[]
  ): Promise<void> {
    const chainKey = (t: SessionTab): string => (t.container?.chain ?? []).join('▸')
    const live = tabs.value.find(
      (t) =>
        t.kind === 'container' &&
        !t.container?.logs &&
        t.container?.parentSessionId === parentSessionId &&
        t.container.containerName === box.name &&
        chainKey(t) === (chain ?? []).join('▸') &&
        t.panes.some((p) => p.status === 'connected' || p.status === 'connecting')
    )
    if (live) {
      activeTabId.value = live.tabId
      return
    }
    const dead = tabs.value.find(
      (t) =>
        t.kind === 'container' &&
        !t.container?.logs &&
        t.container?.parentSessionId === parentSessionId &&
        t.container.containerName === box.name &&
        chainKey(t) === (chain ?? []).join('▸') &&
        t.panes.every((p) => p.status === 'closed' || p.status === 'error')
    )
    if (dead) {
      activeTabId.value = dead.tabId
      for (const pane of dead.panes) await connectPane(dead, pane)
      return
    }

    const pane = newPane()
    const tab = reactive<SessionTab>({
      tabId: `tab-${++tabSeq}`,
      title: chain?.length ? `容器 · ${[...chain, box.name].join(' ▸ ')}` : `容器 · ${box.name}`,
      kind: 'container',
      config: null,
      container: { parentSessionId, containerName: box.name, image: box.image, originSavedId, chain },
      split: 'none',
      panes: [pane],
      activePaneId: pane.paneId
    })
    tabs.value.push(tab)
    activeTabId.value = tab.tabId
    await connectPane(tab, pane)
  }

  /**
   * 查看容器日志（docker logs -f）：与「进入」共用容器会话机制，
   * 但日志流是同一条 —— 同一个容器开第二个日志标签没有意义，
   * 所以活着的标签直接聚焦，死掉的才复用重连。
   */
  async function viewContainerLogs(
    parentSessionId: string,
    box: Pick<ContainerInfo, 'name' | 'image'>,
    originSavedId?: string,
    chain?: string[]
  ): Promise<void> {
    const existing = tabs.value.find(
      (t) =>
        t.kind === 'container' &&
        t.container?.logs === true &&
        t.container.parentSessionId === parentSessionId &&
        t.container.containerName === box.name &&
        (t.container.chain ?? []).join('▸') === (chain ?? []).join('▸')
    )
    if (existing) {
      activeTabId.value = existing.tabId
      if (existing.panes.every((p) => p.status === 'closed' || p.status === 'error')) {
        for (const pane of existing.panes) await connectPane(existing, pane)
      }
      return
    }

    const pane = newPane()
    const tab = reactive<SessionTab>({
      tabId: `tab-${++tabSeq}`,
      title: chain?.length ? `日志 · ${[...chain, box.name].join(' ▸ ')}` : `日志 · ${box.name}`,
      kind: 'container',
      config: null,
      container: { parentSessionId, containerName: box.name, image: box.image, logs: true, originSavedId, chain },
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
      const text = errorText(err)
      pane.error = text.replace(AUTH_DECRYPT_FAILED, '').trim()
      // 密文解不开（钥匙串身份变更）：自动弹编辑框让用户重输密码，
      // 重存时用当前钥匙串重新加密，连上即自愈
      if (text.includes(AUTH_DECRYPT_FAILED)) requestEditSession(saved)
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
    const idx = tabs.value.indexOf(tab)
    tabs.value = tabs.value.filter((t) => t.tabId !== tab.tabId)
    // 标签 id 不复用，但广播清单里留着它会一直算进「勾了几个」的计数里
    broadcastTabIds.value.delete(tab.tabId)
    // 直连容器标签关掉后，承载它的传输会话若已无人使用（侧栏也没展开）顺手断掉
    if (tab.kind === 'container' && tab.container) {
      // 监控面板的目标是这个容器也一起收（它的 sessionId 是父会话，clearSessionState 管不到）
      const m = monitorTarget.value
      if (m && m.containerName === tab.container.containerName && m.sessionId === tab.container.parentSessionId) {
        closeMonitor()
      }
      const parent = tab.container.parentSessionId
      const savedId = Object.keys(transports).find((k) => transports[k] === parent)
      if (savedId) releaseTransportIfIdle(savedId)
    }
    if (activeTabId.value === tab.tabId) {
      // 落到相邻标签（右邻优先，没有则左邻），不是无脑跳去最后一个
      activeTabId.value = tabs.value[idx]?.tabId ?? tabs.value[idx - 1]?.tabId ?? null
    }
    // 关到一空就自动开一个本地终端 —— 全空的界面没有「下一步去哪」，
    // 与启动时无标签默认开本地终端（App.vue）是同一个取舍
    if (tabs.value.length === 0) void connectLocal()
  }

  /*
   * ---- 标签的显示派生 ----
   *
   * 这两个原本是 App.vue 里的局部函数。挪进 store 是因为标签**溢出清单**
   * （TabListMenu）也要用：清单里那一行必须和标签栏上那个标签是同一个字符串，
   * 不然用户没法把「清单第 7 行」和「标签栏最右边那个」对起来。复制一份出来
   * 迟早会漂。
   */

  /**
   * 状态点取**所有** pane 中最差的状态：
   * 后台 pane（没聚焦的那半个）死了不能无声无息 —— 原来状态点只读
   * activePane，后台 pane 挂了要等用户切过去才发现屏幕早就冻住了。
   */
  const STATUS_RANK: Record<SessionStatus, number> = {
    error: 0,
    reconnecting: 1,
    connecting: 2,
    connected: 3,
    closed: 4
  }
  function tabStatus(tab: SessionTab): SessionStatus {
    let worst: SessionStatus = 'closed'
    for (const p of tab.panes) {
      if (STATUS_RANK[p.status] < STATUS_RANK[worst]) worst = p.status
    }
    return worst
  }

  /** 标签标题：本地终端显示当前目录（shell integration 上报），其余用 tab.title */
  function tabLabel(tab: SessionTab): string {
    const sessionId = tab.panes.find((p) => p.paneId === tab.activePaneId)?.sessionId
    const cwd = sessionId ? cwdBySession[sessionId] : undefined
    if (tab.kind === 'local' && cwd) {
      const name = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
      return name ? `本地 · ${name}` : '本地终端'
    }
    return tab.title
  }

  /*
   * ---- 批量关闭 ----
   *
   * 全部走 closeTab 这条路，而不是自己写一遍「断开会话 + 清状态 + 挪标签」：
   * 那段收尾里还挂着广播清单、容器标签的传输会话回收、监控面板收拾 ——
   * 复制一遍必然漏掉其中一条（漏了就是「关掉了但连接还在」这种静默错误）。
   *
   * 遍历的是快照：closeTab 每次都会把 tabs 换成新数组，边遍历边改会漏掉元素。
   */
  function closeOtherTabs(keep: SessionTab): void {
    for (const tab of [...tabs.value]) {
      if (tab.tabId !== keep.tabId) closeTab(tab)
    }
    activeTabId.value = keep.tabId
  }

  function closeTabsToRight(from: SessionTab): void {
    const idx = tabs.value.indexOf(from)
    if (idx < 0) return
    for (const tab of tabs.value.slice(idx + 1)) closeTab(tab)
    activeTabId.value = from.tabId
  }

  function closeAllTabs(): void {
    for (const tab of [...tabs.value]) closeTab(tab)
  }

  async function refreshSaved(): Promise<void> {
    savedSessions.value = await window.api.listSessions()
  }

  async function deleteSaved(id: string): Promise<void> {
    await window.api.deleteSession(id)
    // 设备没了，它的传输会话与展开的容器列表也一起收掉
    expandedDevices.delete(id)
    delete deviceContainers[id]
    const tid = transports[id]
    if (tid) {
      window.api.disconnect(tid)
      delete transports[id]
    }
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

  // ---- 广播下发（一处敲键，多处同时执行）----

  /**
   * 广播开关。**不持久化**（不进 AppSettings）：勾选的标签本身就随进程消失，
   * 重启后一个目标都不剩，此时开关还亮着只是撒谎 —— 每次开工重新开一次更直白。
   */
  const broadcastEnabled = ref(false)
  /**
   * 勾选了「接收下发」的标签。**存标签 id 而不是 sessionId**：断线重连、容器标签
   * 重建承载会话都会换 sessionId，标签 id 是稳定的那个。用 Set 是因为模板里
   * 要按标签 id 做 O(1) 判断（`:class` 每个标签每帧都会求值）。
   */
  const broadcastTabIds = ref(new Set<string>())

  /**
   * 真正接收下发的会话清单：只认**当前连着**的会话。
   * 连不上的目标（connecting / reconnecting / error / 已关闭）直接跳过 ——
   * 往一个还没建好的 pty 里塞字节没有意义，主进程那边也只是丢掉。
   */
  const broadcastTargets = computed<{ tabId: string; title: string; sessionId: string }[]>(() => {
    if (!broadcastEnabled.value) return []
    const out: { tabId: string; title: string; sessionId: string }[] = []
    for (const tab of tabs.value) {
      if (!broadcastTabIds.value.has(tab.tabId)) continue
      for (const pane of tab.panes) {
        if (pane.sessionId && pane.status === 'connected') {
          // 分屏的两个 pane 是两个会话，各自都算一个目标
          out.push({ tabId: tab.tabId, title: tab.title, sessionId: pane.sessionId })
        }
      }
    }
    return out
  })

  /** 全部标签都在清单里（决定那个批量按钮写「全选」还是「全不选」） */
  const broadcastAllChecked = computed(
    () => tabs.value.length > 0 && tabs.value.every((t) => broadcastTabIds.value.has(t.tabId))
  )

  /**
   * 开关广播。**开就是从「全部标签」起步** —— 用户的典型场景是「手上这几个
   * 页签一起跑」，挨个勾一遍是最烦的一步；要缩小范围就取消勾选（想全砍掉
   * 也有旁边的「全不选」一键）。
   */
  function toggleBroadcast(): void {
    broadcastEnabled.value = !broadcastEnabled.value
    if (!broadcastEnabled.value) return
    for (const tab of tabs.value) broadcastTabIds.value.add(tab.tabId)
  }

  function toggleBroadcastTab(tabId: string): void {
    if (broadcastTabIds.value.has(tabId)) broadcastTabIds.value.delete(tabId)
    else broadcastTabIds.value.add(tabId)
  }

  /** 批量：全不选 / 全选（按当前是不是已经全选来切换） */
  function toggleBroadcastAll(): void {
    if (broadcastAllChecked.value) {
      broadcastTabIds.value.clear()
      return
    }
    for (const tab of tabs.value) broadcastTabIds.value.add(tab.tabId)
  }

  /*
   * 广播开着时新开的标签自动入列。
   * 默认既然是「全部」，后开的标签掉队就会跟按钮上那个数字自相矛盾
   * （写着 广播 3，其实已经 4 个页签了）。不想要就取消那一个勾。
   */
  watch(
    () => tabs.value.map((t) => t.tabId),
    (ids, prev) => {
      if (!broadcastEnabled.value) return
      for (const id of ids) if (!prev?.includes(id)) broadcastTabIds.value.add(id)
    }
  )

  /**
   * 终端输入的统一出口：永远写当前会话；广播开着时再扇出给其余勾选中的会话。
   *
   * 只给**键盘输入、粘贴、快捷命令**走这里。以下四类刻意不广播，它们描述的是
   * 某一个会话自己的状态，不是「用户敲下去的命令」：
   *   - 布局恢复 / 断线重连后自动注入的 `cd`（每个会话各自的 cwd）
   *   - 文件面板「在终端打开」的 `cd`（同上，且目标路径在别的会话里多半不存在）
   *   - 拖文件粘路径（本地路径只对发起的那台机器有意义）
   *   - ZMODEM 上传的数据帧（会话私有的传输协议流，混进别的会话就是乱码）
   */
  function sendInput(sessionId: string, data: string | Uint8Array): void {
    window.api.input(sessionId, data)
    if (!broadcastEnabled.value) return
    for (const target of broadcastTargets.value) {
      if (target.sessionId === sessionId) continue
      window.api.input(target.sessionId, data)
    }
  }

  // ---- 性能监控面板 ----
  /**
   * 监控面板目标：SSH 标签 → 宿主机；容器标签 → 容器。
   * tab = 打开时落在哪页（top 进程点进来 → processes 并带过滤词）。
   */
  const monitorTarget = ref<{
    sessionId: string
    containerName?: string
    label: string
    tab?: 'overview' | 'network' | 'processes'
    filter?: string
  } | null>(null)
  function openMonitor(target: {
    sessionId: string
    containerName?: string
    label: string
    tab?: 'overview' | 'network' | 'processes'
    filter?: string
  }): void {
    monitorTarget.value = target
  }
  function closeMonitor(): void {
    monitorTarget.value = null
  }

  function toggleFollowTerminal(): void {
    followTerminal.value = !followTerminal.value
  }

  function setCwd(sessionId: string, path: string): void {
    cwdBySession[sessionId] = path
  }

  /*
   * 文件面板「项目模式」持久化用的设备标识：同一台设备（重连、新开标签）
   * 必须算出同一个 key。规则：
   *   - 本地标签       → '@local'（所有本地标签共享一个项目根）
   *   - 容器标签       → 宿主 key + '#ctr:<容器名>'（经 originSavedId 拿宿主身份；
   *                      不能拿 parentSessionId 反查 tab —— 传输会话没有 tab）
   *   - 已保存的 SSH   → 'saved:<SavedSession.id>'
   *   - 临时 SSH 连接  → 'tmp:user@host:port'（设备后来保存了，旧 key 成为孤儿条目，无害）
   *   - 找不到 tab     → 'session:<id>' 兜底：运行期一致，重启即忘
   */
  function deviceKeyForSession(sessionId: string): string {
    const tab = tabs.value.find((t) => t.panes.some((p) => p.sessionId === sessionId))
    if (!tab) return `session:${sessionId}`
    if (tab.kind === 'local') return '@local'
    if (tab.kind === 'container') {
      const base = tab.container?.originSavedId ? `saved:${tab.container.originSavedId}` : '@local'
      return `${base}#ctr:${tab.container?.containerName ?? ''}`
    }
    if (tab.savedSessionId) return `saved:${tab.savedSessionId}`
    const cfg = tab.config
    return cfg ? `tmp:${cfg.username}@${cfg.host}:${cfg.port}` : `session:${sessionId}`
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
    agentInstallStamp,
    markAgentInstalled,
    requestAddDevice,
    handleCliCommand,
    clearAddDeviceRequest,
    editSessionRequest,
    requestEditSession,
    clearEditSessionRequest,
    sftpVisible,
    toggleSftp,
    broadcastEnabled,
    broadcastTabIds,
    broadcastTargets,
    broadcastAllChecked,
    toggleBroadcast,
    toggleBroadcastTab,
    toggleBroadcastAll,
    sendInput,
    monitorTarget,
    openMonitor,
    closeMonitor,
    followTerminal,
    toggleFollowTerminal,
    cwdBySession,
    homeBySession,
    exitCodeBySession,
    setCwd,
    deviceKeyForSession,
    tabStatus,
    tabLabel,
    setHome,
    setLastExitCode,
    connect,
    connectSaved,
    enterContainer,
    enterContainerDirect,
    viewContainerLogs,
    expandedDevices,
    deviceContainers,
    transports,
    toggleDeviceContainers,
    loadDeviceContainers,
    connectLocal,
    restoreUnsavedTab,
    splitActive,
    reconnectPane,
    setActivePane,
    closePane,
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
    closeAllTabs,
    refreshSaved,
    deleteSaved,
    saveSession
  }
})
