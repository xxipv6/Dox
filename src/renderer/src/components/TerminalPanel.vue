<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, computed, watch } from 'vue'
import { Terminal, type ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { useSessionStore } from '../stores/sessions'
import { useEscapeToClose } from '../composables/useEscapeToClose'
import { isPlainSshId, LOCAL_CONTAINER_TARGET, LOCAL_ID_PREFIX } from '@shared/sessionId'
import { useSettingsStore } from '../stores/settings'
import { useEditorStore } from '../stores/editor'
import { createZmodemBridge, type ZmodemBridge } from '../zmodem/zmodemService'
import { detectListenPorts } from '../utils/portSuggest'
import { rememberTermSize } from '../utils/termSize'
import { cdArgOf, createCwdTracker, resolveCdTarget } from '../utils/cwdFollow'
import { OutputHighlighter } from '../utils/outputHighlight'
import { pushToast } from '../stores/toast'
import Icon from './Icon.vue'

const props = defineProps<{ sessionId: string }>()
const store = useSessionStore()
const settings = useSettingsStore()
const editor = useEditorStore()
/** mac 上 ⌘C 才算复制；Win/Linux 上 Ctrl+C 得留给前台进程的 SIGINT */
const isMac = window.api.platform === 'darwin'

/**
 * 写系统剪贴板。
 *
 * 这里原先（以及其余两处复制入口）是 `void navigator.clipboard.writeText(...)` ——
 * 失败是彻底静默的：没有提示，菜单也不会关（copySelection 的 closeMenu 在 await
 * 之后，异常直接把它跳过），用户看到的只有「点了复制没反应」，无从区分是没选中
 * 还是写剪贴板被拒。改走主进程的 Electron clipboard（见 IPC 通道注释），
 * 但仍留这一层 catch：IPC 本身也会失败，而沉默的失败没法排查。
 *
 * notify：只有**显式复制**（右键菜单 / 快捷键）才回一条成功提示 ——
 * 「选中即复制」每次拖拽都会触发，给它弹提示就是把界面变成噪声。
 * 失败一律提示，那是用户必须知道的事。
 */
async function copyToClipboard(text: string, notify = false): Promise<void> {
  if (!text) return
  try {
    await window.api.writeClipboardText(text)
    if (notify) pushToast(`已复制 ${text.length} 个字符`, 'success', 1600)
  } catch (err) {
    pushToast(`复制到剪贴板失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

const container = ref<HTMLDivElement>()
const searchInput = ref<HTMLInputElement>()
const searchVisible = ref(false)
const searchText = ref('')

// 右键菜单
const menu = ref<{ x: number; y: number } | null>(null)
const hasSelection = ref(false)

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let searchAddon: SearchAddon | null = null
let unsubscribeData: (() => void) | null = null
let unsubscribeStatus: (() => void) | null = null
let resizeObserver: ResizeObserver | null = null
let zmodem: ZmodemBridge | null = null
let highlighter: OutputHighlighter | null = null
/** 卸载后禁止再往已销毁的终端写入（ZMODEM 看门狗可能在卸载后触发） */
let disposed = false

// ---- 断线重连（状态由主进程推送，这里只负责呈现与恢复）----
const reconnect = ref<{ attempt: number; reason: string } | null>(null)

/**
 * 往终端里插一条分隔行。
 * 断线前的输出一律保留 —— 断线时正在跑的命令往往已经把线索打在屏幕上了，
 * 清掉就再也找不回来。
 */
function separator(text: string, color = '33'): void {
  if (disposed || !term) return
  term.write(`\r\n\x1b[${color}m━━━━ ${text} ━━━━\x1b[0m\r\n`)
}

/** 单引号包裹 + 转义，路径里有空格/引号也不会把命令拆坏 */
function quoteShellPath(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

// ---- 端口转发建议：输出里出现服务横幅 → 一键 ssh -L ----
interface PortSuggestion {
  port: number
  state: 'pending' | 'ok' | 'error'
  error?: string
}
const suggestions = ref<PortSuggestion[]>([])
/** 已建议过的端口（含被忽略/已转发的）：同一会话不重复打扰 */
const suggestedPorts = new Set<number>()
const MAX_SUGGESTIONS = 3

/**
 * 转发的落点。
 *
 * 普通 SSH 标签：本会话 + 远端 127.0.0.1。
 * 远端容器标签：父会话 + 容器网桥 IP（容器没发布端口时 127.0.0.1 根本
 * 摸不到它，但宿主机能直连网桥 IP，inspect 在点转发时才做）。
 * 本地终端 / 本机容器不给建议：localhost 本来就能直接开，
 * 本机容器的网桥 IP 藏在 VM 里，转发了也到不了。
 */
function forwardTarget(): { sessionId: string; containerName?: string } | null {
  if (isPlainSshId(props.sessionId)) return { sessionId: props.sessionId }
  const tab = store.tabs.find((t) => t.panes.some((p) => p.sessionId === props.sessionId))
  if (tab?.kind !== 'container' || !tab.container) return null
  // 嵌套容器：内层网桥 IP 在外层 netns 里，宿主机摸不到，转发给不出正确目标
  if (tab.container.chain?.length) return null
  const parent = tab.container.parentSessionId
  if (parent === LOCAL_CONTAINER_TARGET) return null
  return { sessionId: parent, containerName: tab.container.containerName }
}

/**
 * 每个数据块扫一次（字节门控，几乎零成本）。
 * 命中端口后要查一次既有规则，异步 fire-and-forget —— 横幅会在连接保持
 * 期间反复打印的情况很少，宁可晚一拍也不能把输出路径堵上。
 */
function scanForListenPorts(chunk: Uint8Array): void {
  if (!settings.suggestPortForward) return
  const target = forwardTarget()
  if (!target) return
  const fresh = detectListenPorts(chunk).filter((p) => !suggestedPorts.has(p))
  if (!fresh.length) return
  for (const p of fresh) suggestedPorts.add(p)
  for (const port of fresh) void pushSuggestion(port, target)
}

/** 规则查重后把建议推上屏（横幅与 /proc 两条检测路径共用） */
async function pushSuggestion(port: number, target: { sessionId: string }): Promise<void> {
  const rules = await window.api.listForwards().catch(() => [])
  const exists = rules.some(
    (r) =>
      r.sessionId === target.sessionId &&
      r.type === 'local' &&
      r.targetPort === port &&
      r.status === 'active'
  )
  if (exists || suggestions.value.length >= MAX_SUGGESTIONS) return
  suggestions.value.push({ port, state: 'pending' })
}

// ---- /proc 静默监听轮询：不打横幅的服务也能发现 ----
const PROC_POLL_MS = 5000
/** 建议下限：特权端口基本是系统服务（53/631…），开发服务器都在 1024 以上 */
const MIN_SUGGEST_PORT = 1024
/** 首查只建基线不弹窗 —— 一连上就被既有端口轰炸，功能就死了 */
let listenerBaseline: Set<number> | null = null
let procPollTimer: number | null = null

/**
 * 每 5 秒读一次 /proc/net/tcp（VS Code "process" 检测源的无 agent 版）。
 *
 * 普通 SSH 标签读宿主机那张表；远端容器标签读**容器 netns** 那张
 * （docker exec，容器有自己的 netns，宿主机表里看不到它的 socket）。
 * 本地终端 / 本机容器不查 —— forwardTarget 为 null 时整条路不存在。
 */
async function pollRemoteListeners(): Promise<void> {
  if (!settings.suggestPortForward) return
  const target = forwardTarget()
  if (!target) return
  const res = target.containerName
    ? await window.api.containerListeners(target.sessionId, target.containerName).catch(() => null)
    : await window.api.remoteListeners(target.sessionId).catch(() => null)
  if (!res || !res.supported) {
    // 非 Linux（没有 /proc）：这条路不存在，别再每 5 秒白跑
    stopProcPoll()
    return
  }
  if (listenerBaseline === null) {
    listenerBaseline = new Set(res.ports)
    // 容器：首查全量也弹（理由同 handleAgentPorts —— 进容器往往就是冲着服务来的）
    if (target.containerName) {
      for (const port of res.ports) {
        if (port < MIN_SUGGEST_PORT || suggestedPorts.has(port)) continue
        suggestedPorts.add(port)
        void pushSuggestion(port, target)
      }
    }
    return
  }
  for (const port of res.ports) {
    if (listenerBaseline.has(port) || port < MIN_SUGGEST_PORT || suggestedPorts.has(port)) continue
    suggestedPorts.add(port)
    // 弹过即入基线：服务一直在听也不反复弹
    listenerBaseline.add(port)
    void pushSuggestion(port, target)
  }
}

function startProcPoll(): void {
  // 有转发落点的标签才轮询（普通 SSH / 远端容器）；本地终端没有可转的目标
  if (procPollTimer !== null || !forwardTarget()) return
  procPollTimer = window.setInterval(() => void pollRemoteListeners(), PROC_POLL_MS)
}

function stopProcPoll(): void {
  if (procPollTimer !== null) {
    clearInterval(procPollTimer)
    procPollTimer = null
  }
}

// ---- agent 端口推送：装了 agent 走长连接；通道死了 /proc 轮询顶班，重建成功自动切回 ----
let unsubscribeAgentPorts: (() => void) | null = null
let agentWatchActive = false
/** 是否已在主进程登记订阅（卸载时据此退订；降级期意图仍在主进程，不能漏退） */
let agentSubscribed = false
/** 订阅时的目标（卸载时标签可能已从 store 摘掉，forwardTarget 会拿不到了） */
let subscribedTarget: { sessionId: string; containerName?: string } | null = null

/*
 * agent 差分帧的处理。
 * 宿主机：首帧全量即基线（不弹）——机器上常驻服务多，连上就弹是轰炸。
 * 容器：首帧也弹 —— 容器里监听的通常就那一两个服务，用户进容器往往
 * 就是冲着它来的，「已经在跑」不该等于「不提醒」（上限 3 条兜底）。
 */
function handleAgentPorts(data: { listening?: number[]; added?: number[] }): void {
  const target = forwardTarget()
  if (listenerBaseline === null) {
    listenerBaseline = new Set(data.listening ?? data.added ?? [])
    if (!settings.suggestPortForward || !target?.containerName) return
    for (const port of listenerBaseline) {
      if (port < MIN_SUGGEST_PORT) continue
      suggestedPorts.add(port)
      void pushSuggestion(port, target)
    }
    return
  }
  // 端口哨兵：基线建立后**新出现**的监听端口（独立开关，与转发建议解耦）。
  // 安全语义：服务不会无缘无故多一个监听 —— 要么是自己起的，要么值得看一眼
  if (settings.portSentinel && target) {
    for (const port of data.added ?? []) {
      if (listenerBaseline.has(port) || sentinelFired.has(port)) continue
      sentinelFired.add(port)
      void fireSentinel(port, target)
    }
  }
  if (!settings.suggestPortForward || !target) return
  for (const port of data.added ?? []) {
    if (listenerBaseline.has(port) || port < MIN_SUGGEST_PORT || suggestedPorts.has(port)) continue
    suggestedPorts.add(port)
    listenerBaseline.add(port)
    void pushSuggestion(port, target)
  }
}

// ---- 端口哨兵：新监听端口 → 警告 toast，反查进程名，点击直达连接表 ----
interface SentinelToast {
  port: number
  process?: string
  pid?: number
  /** 开火时的目标（点击跳转时标签可能已切走，必须存下来） */
  sessionId: string
  containerName?: string
}
const sentinelToasts = ref<SentinelToast[]>([])
const sentinelFired = new Set<number>()
const sentinelTimers = new Map<number, number>()

async function fireSentinel(port: number, target: { sessionId: string; containerName?: string }): Promise<void> {
  const toast = reactive<SentinelToast>({ port, sessionId: target.sessionId, containerName: target.containerName })
  sentinelToasts.value.push(toast)
  sentinelTimers.set(
    port,
    window.setTimeout(() => dismissSentinel(port), 20_000)
  )
  // 反查进程名：net_conns（0.6.2+ 早退后很快）；老助手没有这个方法就只显示端口
  try {
    const r = (await window.api.agentCall(target.sessionId, target.containerName, 'net_conns', {})) as {
      conns: { local_port: number; state: string; pid: number; process?: string }[]
    }
    const hit = r.conns.find((c) => c.local_port === port && c.state === 'LISTEN')
    if (hit?.process) {
      toast.process = hit.process
      toast.pid = hit.pid
    }
  } catch { /* 老助手/通道异常：只显示端口号 */ }
}

function dismissSentinel(port: number): void {
  const t = sentinelTimers.get(port)
  if (t !== undefined) clearTimeout(t)
  sentinelTimers.delete(port)
  sentinelToasts.value = sentinelToasts.value.filter((s) => s.port !== port)
}

/** 点击哨兵 toast → 性能监控网络页，按端口过滤（它在和谁说话一眼看到） */
function openSentinel(s: SentinelToast): void {
  dismissSentinel(s.port)
  store.openMonitor({
    sessionId: s.sessionId,
    containerName: s.containerName,
    label: s.containerName ? `容器 ${s.containerName}` : '主机',
    tab: 'network',
    filter: String(s.port)
  })
}

/**
 * 端口监视的统一入口：有转发落点就开。
 * 优先 agent 长连接推送（宿主机标签 → 宿主机助手；容器标签 → 容器内助手，
 * Dev Containers 式注入）；没装/起不来都退回 /proc 轮询（宿主机直读 /
 * 容器 docker exec，pollRemoteListeners 内部按目标分路）。
 */
async function startPortWatch(): Promise<void> {
  const target = forwardTarget()
  if (!target) return
  const st = await window.api.agentStatus(target.sessionId, target.containerName).catch(() => null)
  if (st?.installed) {
    try {
      await window.api.agentWatchPorts(target.sessionId, target.containerName)
      // 挂载期间异步返回的：面板可能已卸载，立即退订别漏通道
      if (disposed) {
        void window.api.agentUnwatchPorts(target.sessionId, target.containerName)
        return
      }
      agentSubscribed = true
      subscribedTarget = target
      agentWatchActive = true
      stopProcPoll() // 可能是从轮询兜底升级上来的（装完 agent 的重试），停掉顶班的
      unsubscribeAgentPorts = window.api.onAgentPorts((id, ctr, data) => {
        if (id !== target.sessionId || (ctr ?? undefined) !== target.containerName) return
        if (data.event === 'agent_closed') {
          // 通道死了（SSH 断线/容器停止/升级安装后重启/agent 被杀）：
          // /proc 轮询顶班，订阅保留。
          agentWatchActive = false
          listenerBaseline = null // 换路径重建基线，别把 /proc 全量当差分弹了
          startProcPoll()
          // 立即重试一次：升级安装是「掐旧通道换新二进制」，秒级就能接回来；
          // SSH 断线场景这次调用会失败（无害），之后由重连钩子/节流重试兜底
          void window.api
            .agentWatchPorts(target.sessionId, target.containerName)
            .then(() => {
              if (disposed || agentWatchActive) return
              agentWatchActive = true
              stopProcPoll()
              listenerBaseline = null
            })
            .catch(() => scheduleAgentRetry(target))
          return
        }
        if (!agentWatchActive) {
          // agent 重建成功：停顶班轮询，首帧即新基线
          agentWatchActive = true
          stopProcPoll()
          listenerBaseline = null
        }
        handleAgentPorts(data)
      })
      return
    } catch {
      // agent 起不来（二进制被删/容器在停/权限变化）：走轮询
    }
  }
  if (!disposed) startProcPoll()
}

/**
 * 容器标签的 agent 复活重试：容器 stop→start 后二进制还在容器文件层里，
 * 只是进程没了 —— 重新拉起 serve 即可（SSH 全程没断，主进程的重连钩子
 * 管不到这种死法）。45s 节流、上限 20 次（约 15 分钟，容器真删了就别吵）。
 */
let agentRetryTimer: number | null = null
let agentRetryCount = 0
function scheduleAgentRetry(target: { sessionId: string; containerName?: string }): void {
  if (!target.containerName || agentRetryTimer !== null || agentRetryCount >= 20) return
  agentRetryTimer = window.setTimeout(() => {
    agentRetryTimer = null
    if (disposed || agentWatchActive) return
    agentRetryCount++
    void window.api
      .agentWatchPorts(target.sessionId, target.containerName)
      .then(() => {
        if (disposed) return
        agentRetryCount = 0
        agentWatchActive = true
        stopProcPoll()
        listenerBaseline = null
      })
      .catch(() => scheduleAgentRetry(target))
  }, 45_000)
}

async function confirmForward(s: PortSuggestion): Promise<void> {
  const target = forwardTarget()
  if (!target) return dismissForward(s)
  let targetHost = '127.0.0.1'
  if (target.containerName) {
    targetHost =
      (await window.api.containerIp(target.sessionId, target.containerName).catch(() => null)) ??
      '127.0.0.1'
  }
  try {
    const rule = await window.api.addForward({
      sessionId: target.sessionId,
      type: 'local',
      listenPort: s.port,
      targetHost,
      targetPort: s.port
    })
    if (rule.status === 'error') {
      s.state = 'error'
      s.error = rule.error ?? '未知错误'
    } else {
      s.state = 'ok'
    }
  } catch (err) {
    s.state = 'error'
    s.error = err instanceof Error ? err.message : String(err)
  }
  // 成败都短暂停留后自己收掉
  setTimeout(() => dismissForward(s), 3500)
}

function dismissForward(s: PortSuggestion): void {
  suggestions.value = suggestions.value.filter((x) => x !== s)
}


/**
 * 终端输出里的绝对路径 → Ctrl/Cmd+点击分发：
 * 目录 → SFTP 面板跳过去；文件 → 内置编辑器打开。
 *
 * 只在 SSH 会话注册（本地/容器会话没有对应的 SFTP 视图）。
 * 识别是纯文本猜测（没动远端），点的时候才用 sftpStat 落一次地 ——
 * 终端里的路径可能早就过期了，stat 不到就静默不点。
 */
const PATH_RE = /\/(?:[\w@%+\-=.,~]+\/)*[\w@%+\-=.,~]+/g

async function openRemotePath(path: string): Promise<void> {
  try {
    const stat = await window.api.sftpStat(props.sessionId, path)
    if (!stat) return
    // 编辑器与面板都挂在 sftpVisible 之下，两个分支都要先把它拉出来
    if (!store.sftpVisible) store.toggleSftp()
    if (stat.isDir) {
      // 目录跳转走既有的「终端↔SFTP 跟随」通道：面板导航本来就会写 cwd 记录
      if (!store.followTerminal) store.toggleFollowTerminal()
      // 等面板挂载完再写 cwd，否则 watcher（非 immediate）收不到这次变化
      await nextTick()
      store.setCwd(props.sessionId, path)
      return
    }
    await editor.open(props.sessionId, path)
  } catch {
    // 会话断开等场景：点不动就不动，不弹错误
  }
}

/** 给 SSH 终端注册绝对路径链接（与 WebLinksAddon 并存：URL 归它，路径归这里） */
function registerPathLinks(t: Terminal): void {
  t.registerLinkProvider({
    provideLinks(y, callback) {
      const line = t.buffer.active.getLine(y - 1)
      if (!line) return callback(undefined)
      const text = line.translateToString(true)
      const links: ILink[] = []
      for (const m of text.matchAll(PATH_RE)) {
        // 削掉句读尾巴：「见 /etc/hosts.」里的句点不是路径的一部分
        const path = m[0].replace(/[.,:;!?]+$/, '')
        if (path.length < 3) continue
        links.push({
          text: path,
          range: { start: { x: m.index + 1, y }, end: { x: m.index + path.length, y } },
          // 只有按住 Ctrl/Cmd 才激活 —— 单击留给文本选择（与 VS Code 一致）
          activate: (event) => {
            if (event.ctrlKey || event.metaKey) void openRemotePath(path)
          }
        })
      }
      callback(links.length ? links : undefined)
    }
  })
}

function stopReconnect(): void {
  window.api.reconnectControl(props.sessionId, 'stop')
  reconnect.value = null
}

function retryNow(): void {
  window.api.reconnectControl(props.sessionId, 'now')
}

/**
 * 安全 fit：容器不可见（v-show 隐藏的标签、分屏/面板切换的中间态、挂载瞬间
 * 布局未稳定）时容器尺寸接近 0，fit() 会算出极小的行列数（实测 11x5）并
 * 通过 onResize 把 pty 也缩成那样 —— 之后任何程序按 11 列输出都会渲染成
 * 交织错乱的文本。这里加下限保护，退化尺寸一律不下发给 pty。
 */
const MIN_CONTAINER_WIDTH = 120
const MIN_CONTAINER_HEIGHT = 60
/** 下发给 pty 的最小行列数，低于此值视为退化尺寸 */
const MIN_COLUMNS = 20
const MIN_ROWS = 5

/** OSC 52 的尺寸上限：与主流终端一致（解码后 75KB / 原始 128KB） */
const OSC52_MAX_BYTES = 75 * 1024
const OSC52_MAX_RAW = 128 * 1024

function safeFit(): void {
  const el = container.value
  if (!el || el.clientWidth < MIN_CONTAINER_WIDTH || el.clientHeight < MIN_CONTAINER_HEIGHT) return
  fitAddon?.fit()
  // 只有这一条路径的尺寸是可信的：容器真占了地方才 fit。记下来给下一个
  // 建会话的当种子（见 utils/termSize）—— 隐藏标签的退化尺寸不能记
  if (term && term.cols > MIN_COLUMNS && term.rows > MIN_ROWS) {
    rememberTermSize(term.cols, term.rows)
  }
}

// ---- 终端 cwd 跟踪 ----
// 优先用 shell integration 上报（OSC 7，精确）；没有的 shell 退回解析 cd 命令
let lineBuf = ''
let cwdFromIntegration = false

/** shell 侧不做 URI 编码，路径里的裸 % 会让 decodeURIComponent 抛错，这里兜住 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 把 OSC 7 的 file:// URI 转成本地显示路径 */
function pathFromOsc7(uri: string): string | null {
  const m = /^file:\/\/([^/]*)(\/.*)$/.exec(uri)
  if (!m) return null
  const raw = safeDecode(m[2])
  // Windows 下是 /C:/Users/... → C:\Users\...
  if (/^\/[A-Za-z]:/.test(raw)) return raw.slice(1).replace(/\//g, '\\')
  // Git Bash（MSYS）报的是 /c/Users/... 形式
  if (window.api.platform === 'win32') {
    const msys = /^\/([a-z])(\/.*)?$/.exec(raw)
    if (msys) return (msys[1].toUpperCase() + ':' + (msys[2] ?? '')).replace(/\//g, '\\')
  }
  return raw
}

/** cd 目标验证的代际：连敲几条 cd 时，只认最后一条的 stat 结果 */
let cdVerifySeq = 0

/**
 * 期望 cwd 链（见 utils/cwdFollow 的模块注释）：解析基准同步推进，
 * 面板显示值仍然只在 stat 确认后才写 —— 两者分开才不会「只跟一级」。
 */
const cwdTracker = createCwdTracker()

/** 当前解析基准：期望值优先，拿不到就是 null（不跟随，别拿 '/' 猜） */
function cwdBase(): string | null {
  return cwdTracker.base(props.sessionId, store.cwdBySession[props.sessionId])
}

function cwdHome(): string | null {
  return store.homeBySession[props.sessionId] ?? null
}

/*
 * 别的权威来源改了 cwd（OSC 7 上报、SFTP 面板里点进目录、终端里 Ctrl+点路径），
 * 基准要立刻跟上 —— 否则链上还留着一条早就过期的期望值，下一条相对 cd 就按它算。
 * 我们自己 stat 成功写 store 时也会走到这里，此时值是同一个，等于空操作。
 */
watch(
  () => store.cwdBySession[props.sessionId],
  (confirmed) => {
    if (confirmed) cwdTracker.sync(props.sessionId, confirmed)
  }
)

/**
 * 算出目标目录后先落一次地（sftpStat）再更新面板 ——
 * 「cd 失败」（目录不存在、没权限）时面板不该跟着走。
 * 仅 SSH 会话：本地/容器没有对应的 SFTP 通道，维持原来的直接信任。
 */
function applyCwd(next: string): void {
  const sid = props.sessionId
  // 基准先同步推进：下一条 cd 不等这次 stat 回来（这正是「只跟一级」的病根）
  cwdTracker.advance(sid, next)
  if (!isPlainSshId(sid)) {
    store.setCwd(sid, next)
    return
  }
  const seq = ++cdVerifySeq
  window.api
    .sftpStat(sid, next)
    .then((stat) => {
      if (seq !== cdVerifySeq) return // 期间又敲了别的 cd，这趟结果作废
      if (stat?.isDir) store.setCwd(sid, next)
      // 远端明确说「不存在/不是目录」：这条 cd 没生效，基准退回最后一个确认值，
      // 免得后面每条相对 cd 都挂在一条不存在的路径上继续错
      else cwdTracker.rollback(sid, store.cwdBySession[sid])
    })
    .catch(() => {
      // 会话断开这类**结果未知**的情况不回滚：cd 多半已经生效了，
      // 退回确认值反而会让下一条相对 cd 算错
    })
}

function handleCommand(line: string): void {
  const arg = cdArgOf(line)
  if (arg === null) return
  const next = resolveCdTarget(arg, cwdBase(), cwdHome())
  if (next) applyCwd(next)
}

/**
 * 不可信命令（用过 Tab/方向键）的补救：把参数当**前缀**去远端父目录里补全 ——
 * 「cd /va<TAB>」补成 /var 是 shell 干的，本地看不到补全结果，但拿 va 去 /
 * 下列一圈，唯一匹配一个目录时就是它。多义或零匹配都放弃：宁可不跳，也不跳错。
 * applyCwd 里还有一层 stat 复核兜底。
 */
function followCompletedCd(line: string): void {
  if (!isPlainSshId(props.sessionId)) return
  const arg = cdArgOf(line)
  if (!arg || arg === '-' || arg === '~') return
  const home = cwdHome()
  const base = cwdBase()
  let full: string
  if (arg.startsWith('~/')) {
    if (!home) return
    full = home + arg.slice(1)
  } else if (arg.startsWith('/')) {
    full = arg
  } else {
    if (!base) return // 基准未知就别拿去列目录（同 resolveCdTarget）
    full = `${base}/${arg}`
  }
  const idx = full.lastIndexOf('/')
  const parent = idx <= 0 ? '/' : full.slice(0, idx)
  const prefix = full.slice(idx + 1)
  if (!prefix) return

  const seq = ++cdVerifySeq
  window.api
    .sftpList(props.sessionId, parent)
    .then((entries) => {
      if (seq !== cdVerifySeq) return
      const hits = entries.filter((e) => e.isDir && e.name.startsWith(prefix))
      if (hits.length !== 1) return
      applyCwd(hits[0].path)
    })
    .catch(() => {
      /* 列目录失败：放弃跟随 */
    })
}

/**
 * 本地解析击键重建命令行，只在 shell integration（OSC 7）缺席时启用。
 *
 * Tab 补全与方向键历史召回会让缓冲失真 —— 「cd va<TAB>」补成「cd var/」
 * 是 shell 干的，我们看得到的只有补全前的文本。这类命令标记为不可信，
 * 回车时走 followCompletedCd 的前缀补全而不是按字面跳
 * （实测踩过：按字面跳 /va → no such file）。
 */
let lineUnreliable = false

function trackInput(data: string): void {
  for (const ch of data) {
    if (ch === '\r') {
      if (lineUnreliable) followCompletedCd(lineBuf)
      else handleCommand(lineBuf)
      lineBuf = ''
      lineUnreliable = false
    } else if (ch === '\x7f') {
      lineBuf = lineBuf.slice(0, -1)
    } else if (ch === '\x03' || ch === '\x0c') {
      lineBuf = ''
      lineUnreliable = false
    } else if (ch === '\t' || ch === '\x1b') {
      // \x1b 是方向键/功能键转义序列的开头（历史召回、光标移动同样失真）
      lineUnreliable = true
    } else if (ch >= ' ') {
      lineBuf += ch
    }
  }
}

// ---- 搜索 ----
/*
 * 匹配高亮配色。装饰只有背景/边框可配（不能改文字色），所以背景色要
 * 同时扛住黑字（亮色终端）和白字（深色终端）：
 *  - 匹配项 #b58900：对白字 ~4.9:1、对黑字 ~4.3:1，两套都够得着
 *  - 当前项  #cb4b16：橙，与黄匹配项一眼分开，边框给亮黄再提一档
 * overview ruler 颜色是 API 必填，顺带给了。
 */
const SEARCH_DECORATIONS = {
  matchBackground: '#b58900',
  matchBorder: '#b58900',
  matchOverviewRuler: '#b58900',
  activeMatchBackground: '#cb4b16',
  activeMatchBorder: '#ffd700',
  activeMatchColorOverviewRuler: '#ff9f1a'
} as const

function toggleSearch(): void {
  searchVisible.value = !searchVisible.value
  if (searchVisible.value) {
    void nextTick(() => searchInput.value?.focus())
  } else {
    searchText.value = ''
    searchAddon?.clearDecorations()
    term?.focus()
  }
}

watch(searchText, (q) => {
  if (!searchAddon) return
  if (q) searchAddon.findNext(q, { incremental: true, decorations: SEARCH_DECORATIONS })
  else searchAddon.clearDecorations()
})

function findNext(): void {
  if (searchText.value) searchAddon?.findNext(searchText.value, { decorations: SEARCH_DECORATIONS })
}

function findPrevious(): void {
  if (searchText.value) searchAddon?.findPrevious(searchText.value, { decorations: SEARCH_DECORATIONS })
}

// ---- 右键菜单（不再盲目粘贴）----
function openMenu(e: MouseEvent): void {
  hasSelection.value = !!term?.hasSelection()
  // 钳在视口内：贴边右键时菜单不能探出屏幕（菜单约 180×140）
  const x = Math.min(e.clientX, window.innerWidth - 190)
  const y = Math.min(e.clientY, window.innerHeight - 150)
  menu.value = { x, y }
}

function closeMenu(): void {
  menu.value = null
}

// 与其他浮层同一个 Esc 关闭栈：原来只有 window click 能关它
useEscapeToClose(
  () => menu.value !== null,
  () => closeMenu()
)

async function copySelection(): Promise<void> {
  // 菜单项是亮的（右键那一刻 hasSelection 为真）却取不到文字 —— 这种情况必须说出来，
  // 否则又是「点了没反应」：无从判断是没选中、还是选区在两次点击之间被终端输出冲掉了
  const sel = term?.getSelection() ?? ''
  closeMenu()
  if (!sel) {
    pushToast('当前没有选中的文本')
    return
  }
  await copyToClipboard(sel, true)
}

async function pasteClipboard(): Promise<void> {
  closeMenu()
  try {
    const text = await window.api.readClipboardText()
    if (text) store.sendInput(props.sessionId, text)
  } catch (err) {
    pushToast(`读取剪贴板失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

function clearTerminal(): void {
  closeMenu()
  term?.clear()
}

function focusTerminal(): void {
  closeMenu()
  term?.focus()
}

/**
 * 进程管理的打开目标。
 * SSH 标签 → 宿主机；远端容器 → 容器（经父会话）；本机容器 → 容器
 * （经本机 docker CLI，AgentManager 的 LOCAL 分支）。本地终端没有这项。
 * 注意不复用 forwardTarget：端口转发建议对本机容器是**故意**关闭的
 * （网桥 IP 藏在 VM 里转了也到不了），进程管理没有这个问题。
 */
const procTarget = computed(() => {
  const fwd = forwardTarget()
  if (fwd) return fwd
  const tab = store.tabs.find((t) => t.panes.some((p) => p.sessionId === props.sessionId))
  // 本机顶层容器 → 容器（经本机 docker CLI）；嵌套容器不在 agent 支持面（docker cp 链没有嵌套实现）
  if (tab?.kind === 'container' && tab.container && !tab.container.chain?.length) {
    return { sessionId: tab.container.parentSessionId, containerName: tab.container.containerName }
  }
  return null
})

function openProcesses(): void {
  closeMenu()
  const t = procTarget.value
  if (!t) return
  const tab = store.tabs.find((tb) => tb.panes.some((p) => p.sessionId === props.sessionId))
  store.openMonitor({
    ...t,
    label: t.containerName ? `容器 ${t.containerName}` : (tab?.title ?? '主机')
  })
}

/*
 * ---- 拖文件进终端 ----
 *
 * 本地终端：粘贴引号包裹的路径（Finder 拖进终端的经典手势）。
 * SSH / 容器：上传到**当前目录**（cwd 来自 shell integration / cd 跟踪，
 * 都没有时回退家目录）——「随手一扔」不用先开 SFTP 面板。
 * 嵌套容器没有传输通道（docker cp 链没有嵌套实现），拖进来给提示不静默吞。
 */
const dropActive = ref(false)
let dragDepth = 0

/** 拖放目标：本地 = 粘贴路径；远端 = 上传到 cwd */
const dropTarget = computed<
  | { kind: 'local' }
  | { kind: 'remote'; sessionId: string; containerName?: string; dir: string }
  | { kind: 'unsupported'; reason: string }
  | null
>(() => {
  const tab = store.tabs.find((t) => t.panes.some((p) => p.sessionId === props.sessionId))
  if (!tab) return null
  if (tab.kind === 'local') return { kind: 'local' }
  const dir = store.cwdBySession[props.sessionId] ?? store.homeBySession[props.sessionId] ?? '/'
  if (tab.kind === 'container' && tab.container) {
    if (tab.container.chain?.length) {
      return { kind: 'unsupported', reason: '嵌套容器暂不支持文件传输' }
    }
    return {
      kind: 'remote',
      sessionId: tab.container.parentSessionId,
      containerName: tab.container.containerName,
      dir
    }
  }
  return { kind: 'remote', sessionId: props.sessionId, dir }
})

/** 拖入时浮层上的一句话 */
const dropHint = computed(() => {
  const t = dropTarget.value
  if (!t) return ''
  if (t.kind === 'local') return '松开粘贴路径'
  if (t.kind === 'unsupported') return t.reason
  return `松开上传到 ${t.dir}`
})

function onDragOver(e: DragEvent): void {
  if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  dropActive.value = true
}

function onDragEnter(e: DragEvent): void {
  if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return
  dragDepth++
}

function onDragLeave(): void {
  // 进出子元素会成对触发 enter/leave，用计数器而不是单次 leave 判定离开
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dropActive.value = false
}

/**
 * 引号包裹路径，按当前本地 shell 的种类选策略：
 *  cmd 不认单引号（引号会变成路径的一部分），必须双引号
 *  （Windows 路径本身不可能含双引号，无需内转义）；
 *  PowerShell 单引号内单引号写两个；POSIX 单引号 + \\' 转义。
 */
let localShellKind: string | null = null
function shellQuote(p: string): string {
  if (localShellKind === 'cmd') return `"${p}"`
  if (localShellKind === 'powershell') return `'${p.replace(/'/g, "''")}'`
  return `'${p.replace(/'/g, `'\\''`)}'`
}

function onDropFiles(e: DragEvent): void {
  e.preventDefault()
  dropActive.value = false
  dragDepth = 0
  // 从本应用 SFTP 面板拖出的虚拟文件/网页拖拽，getPathForFile 拿不到真实路径
  // （返回空串）—— 不过滤会把空路径送进 fs.stat 炸出一句看不懂的错
  const files = [...(e.dataTransfer?.files ?? [])]
    .map((f) => ({ path: window.api.getPathForFile(f), name: f.name, size: f.size }))
    .filter((f) => f.path)
  const t = dropTarget.value
  if (!files.length || !t || t.kind === 'unsupported') return
  if (t.kind === 'local') {
    // 不补回车 —— 粘路径是输入的一部分，执行与否留给用户
    window.api.input(props.sessionId, files.map((f) => shellQuote(f.path)).join(' '))
    return
  }
  window.api.enqueueDropped(t.sessionId, t.dir, files, t.containerName).catch((err) => {
    pushToast(`上传启动失败：${err instanceof Error ? err.message : String(err)}`)
  })
}

onMounted(() => {
  // 本地标签：解析这个标签跑的是哪种 shell（拖拽粘路径的引号策略靠它）
  if (props.sessionId.startsWith(LOCAL_ID_PREFIX)) {
    void window.api.listLocalShells().then((shells) => {
      const cur = shells.find((sh) => sh.id === settings.localShellId) ?? shells[0]
      localShellKind = cur?.integration ?? null
    }).catch(() => undefined)
  }
  term = new Terminal({
    cursorBlink: true,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    // 不设 lineHeight：非 1 的行高会改变 fit() 的行数计算，属于未验证的渲染风险
    scrollback: 10000,
    theme: settings.currentPreset.theme,
    allowProposedApi: true
  })
  fitAddon = new FitAddon()
  searchAddon = new SearchAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(searchAddon)
  /*
   * URL 链接交给系统浏览器，且与路径链接同口径（见 registerPathLinks）：
   * 只有按住 Ctrl/Cmd 才激活，单击留给文本选择。
   *
   * 必须自己传 handler：WebLinksAddon 的默认实现是「先 window.open() 再往
   * 返回的窗口写 location.href」，而主进程的 setWindowOpenHandler 一律 deny ——
   * 那条路的结果只有一条 console.warn，URL 永远打不开。
   */
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (event.ctrlKey || event.metaKey) void window.api.openExternal(uri)
    })
  )
  /*
   * 绝对路径链接：SSH 会话（远端面板）与 POSIX 本地终端（本机面板）都有
   * 对应的文件视图。Windows 本地终端不注册 —— PATH_RE 只认 posix 形态，
   * 盘符路径的点击分发是另一套规则（还没做）。
   */
  if (
    isPlainSshId(props.sessionId) ||
    (props.sessionId.startsWith(LOCAL_ID_PREFIX) && window.api.platform !== 'win32')
  ) {
    registerPathLinks(term)
  }
  term.open(container.value!)

  // 连字需要浏览器做字形替换，只有 DOM 渲染器支持；否则用 WebGL（大数据量不卡）
  if (!settings.ligatures) {
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch (err) {
      console.warn('[terminal] WebGL 不可用，使用 DOM 渲染', err)
    }
  }

  // 必须在 fit() 之前注册：否则首次 fit 造成的尺寸变化事件会被丢掉，
  // pty 会一直停在创建时的 80x24，而 xterm 已是真实尺寸 —— conpty 按
  // 80x24 发屏幕差量，xterm 在更大的屏上重放，会渲染出交织错位的文本
  term.onResize(({ cols, rows }) => window.api.resize(props.sessionId, cols, rows))

  safeFit()
  // 再显式同步一次：fit() 的首次变化可能早于上面注册（xterm 初始也是 80x24，
  // 若恰好相等则不会触发事件，pty 就永远收不到真实尺寸）
  if (term.cols > MIN_COLUMNS && term.rows > MIN_ROWS) {
    window.api.resize(props.sessionId, term.cols, term.rows)
  }

  // ZMODEM：数据流先过 Sentry，识别到 rz/sz 序列时自动接管会话
  zmodem = createZmodemBridge(props.sessionId, (data) => {
    if (!disposed) term?.write(data)
  })

  /*
   * 输出高亮（IP / 日志级别 / error 关键字…）。挂在这里而不是数据通路上：
   * 它扫的是 term.buffer 的行，不是字节流 —— 见 utils/outputHighlight 的模块注释。
   */
  highlighter = new OutputHighlighter()
  highlighter.setTheme(settings.currentPreset.theme)
  highlighter.attach(term)
  highlighter.setEnabled(settings.outputHighlight)

  // ---- shell integration：cwd（OSC 7）----
  term.parser.registerOscHandler(7, (payload) => {
    // 必须包 try/catch：本回调在 xterm 的解析循环里同步执行，抛异常会让
    // 整个数据块（含提示符）被丢弃，而且每次刷提示符都会再抛一次
    try {
      const path = pathFromOsc7(payload)
      if (path) {
        cwdFromIntegration = true
        store.setCwd(props.sessionId, path)
      }
    } catch (err) {
      console.warn('[terminal] 解析 OSC 7 失败', err)
    }
    return true
  })

  /*
   * ---- 远端设置剪贴板（OSC 52）----
   *
   * 这是 tmux/vim 里选字能真正进系统剪贴板的唯一通路：tmux 的 `set-clipboard`
   * 默认是 external —— 在它自己那边选中（mouse on 时拖选、或 copy-mode）之后，
   * 它把选中的内容用 `ESC ] 52 ; c ; <base64>` 发给**外层终端**，由终端负责写
   * 系统剪贴板。终端不实现这条，tmux 里选中就永远是"看着选上了、粘出来是空的"
   * —— 因为鼠标被 tmux 拿走后，xterm 自己那个选区根本不是用户看到的那个。
   *
   * 安全取舍：这条等于把「远端可以写本机剪贴板」做成能力，恶意程序能用它覆盖
   * 剪贴板做投毒。业界（iTerm2 / Windows Terminal / kitty / Wave）都默认支持，
   * 所以随大流；但**不支持查询**（`?`）—— 那才是剪贴板被读走的口子，本机内容
   * 不该让远端按需索取。另外加长度上限，避免远端拿超大 base64 拖住渲染进程。
   */
  term.parser.registerOscHandler(52, (payload) => {
    try {
      // payload 形如 "c;<base64>"，选择器可能是 c/p/空
      const sep = payload.indexOf(';')
      if (sep < 0 || sep > 10) return true
      const b64 = payload.slice(sep + 1)
      // 查询（"?"）与空内容都不处理
      if (!b64 || b64 === '?') return true
      if (payload.length > OSC52_MAX_RAW) return true
      // tmux 分块发送时会带换行（RFC 4648 允许）
      const clean = b64.replace(/\s+/g, '')
      if (Math.ceil(clean.length * 0.75) > OSC52_MAX_BYTES) return true
      const bin = atob(clean)
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
      const text = new TextDecoder().decode(bytes)
      // 真实字节数再校一次：base64 长度的估算对多字节 UTF-8 不准
      if (bytes.length > OSC52_MAX_BYTES) return true
      if (text) void window.api.writeClipboardText(text)
    } catch (err) {
      console.warn('[terminal] 解析 OSC 52 失败', err)
    }
    // 认领这条序列（xterm 本身不实现 52，声明所有权避免落到别的处理者）
    return true
  })

  // ---- shell integration：命令边界与退出码（OSC 133）----
  term.parser.registerOscHandler(133, (payload) => {
    // 形如 "D;0"、"A"、"B"
    const [kind, code] = payload.split(';')
    if (kind === 'D') store.setLastExitCode(props.sessionId, Number(code) || 0)
    return true
  })

  // Ctrl+F 打开搜索框；Ctrl+Shift+C/V 显式复制粘贴
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true
    const key = e.key.toLowerCase()

    // ZMODEM 会话期间键盘被屏蔽，必须留一个逃生口，否则协议出错时终端假死
    if (zmodem?.isActive()) {
      if (key === 'escape') zmodem.abort()
      return false
    }
    const primary = e.ctrlKey || e.metaKey
    if (primary && !e.shiftKey && key === 'f') {
      toggleSearch()
      return false
    }
    /*
     * macOS 上 ⌘C 就是「复制」——这是肌肉记忆，不该逼人多按一个 Shift。
     * 有选区才吃这个键：没选区时放行，免得把用户想送进终端的按键吞掉
     * （mac 上给前台进程发 SIGINT 也是 Ctrl+C，不冲突）。
     * Windows/Linux 不这么干：那边 Ctrl+C 必须是 SIGINT，复制一律 Ctrl+Shift+C。
     */
    if (isMac && e.metaKey && !e.ctrlKey && !e.shiftKey && key === 'c') {
      const sel = term?.getSelection()
      if (!sel) return true
      void copyToClipboard(sel, true)
      return false
    }
    if (primary && e.shiftKey && key === 'c') {
      const sel = term?.getSelection()
      if (sel) void copyToClipboard(sel, true)
      return false
    }
    if (primary && e.shiftKey && key === 'v') {
      void pasteClipboard()
      return false
    }
    return true
  })

  // 选中即复制
  term.onSelectionChange(() => {
    const sel = term?.getSelection()
    if (sel) void copyToClipboard(sel)
  })

  // 远端输出 → ZMODEM Sentry → xterm（ZMODEM 会话期间数据被协议接管）
  unsubscribeData = window.api.onData((id, chunk) => {
    if (id !== props.sessionId) return
    scanForListenPorts(chunk)
    zmodem?.consume(chunk)
  })

  // 端口监视：agent 长连接优先，/proc 轮询兜底（内部自选）
  void startPortWatch()

  // 面板里装完 agent → 重试通道（mount 时状态是「未安装」，已走轮询兜底）
  watch(
    () => store.agentInstallStamp,
    () => {
      if (!disposed && !agentSubscribed) void startPortWatch()
    }
  )

  // 会话状态：断线 / 重连中 / 重连成功都往终端里留痕，并驱动顶部状态条
  unsubscribeStatus = window.api.onStatus((e) => {
    if (e.id !== props.sessionId || disposed) return

    if (e.status === 'reconnecting') {
      const attempt = e.attempt ?? 1
      // e.error 里是断线原因（主进程记下的错误原文），不是「连接已断开」这句话本身
      const reason = e.error || '网络中断'
      reconnect.value = { attempt, reason }
      separator(`连接已断开 · ${reason} · 正在重连（第 ${attempt} 次）`)
      return
    }

    if (e.status === 'connected') {
      reconnect.value = null
      if (!e.reconnected) return
      // 尽力回到断线前的目录。cwd 只来自本地跟踪（OSC 7 或解析用户敲的 cd），
      // 也就是说全程不依赖远端装任何东西。
      const cwd = store.cwdBySession[props.sessionId]
      if (cwd) {
        separator(`已重新连接 · 回到 ${cwd}`, '36')
        window.api.input(props.sessionId, `cd ${quoteShellPath(cwd)}\r`)
      } else {
        separator('已重新连接', '36')
      }
      return
    }

    // closed / error：重连已停止，把原因留在屏幕上
    if (reconnect.value) {
      reconnect.value = null
      if (e.error) separator(`重连已停止（${e.error}）`, '31')
    }
  })
  // 键盘输入 → 远端；ZMODEM 会话期间屏蔽输入（Esc 中断由上面的 key handler 处理）
  term.onData((data) => {
    if (zmodem?.isActive()) return
    store.sendInput(props.sessionId, data)
    if (!cwdFromIntegration) trackInput(data)
  })

  resizeObserver = new ResizeObserver(() => safeFit())
  resizeObserver.observe(container.value!)

  /*
   * 只有宿主机 SSH 会话才取 home 作为相对路径基准。
   * 本地终端没有 SFTP；容器终端也没有 —— 它的会话 id 落在父 SSH 连接上，
   * 真去调 sftpRealpath 会拿到**宿主机**的家目录，那是错的。
   * 这里刻意用正向判断而不是 `!startsWith('local-')`：后者在会话类型变多之后
   * 会静默改变含义。
   */
  if (isPlainSshId(props.sessionId)) {
    void window.api
      .sftpRealpath(props.sessionId, '.')
      .then((home) => {
        store.setHome(props.sessionId, home)
        if (!store.cwdBySession[props.sessionId]) store.setCwd(props.sessionId, home)
      })
      .catch(() => undefined)
  }

  window.addEventListener('click', closeMenu)
  term.focus()
})

onBeforeUnmount(() => {
  disposed = true
  for (const t of sentinelTimers.values()) clearTimeout(t)
  sentinelTimers.clear()
  zmodem?.abort() // 清掉看门狗定时器，避免卸载后触发
  stopProcPoll()
  if (agentRetryTimer !== null) {
    clearTimeout(agentRetryTimer)
    agentRetryTimer = null
  }
  unsubscribeAgentPorts?.()
  if (agentSubscribed && subscribedTarget) {
    void window.api.agentUnwatchPorts(subscribedTarget.sessionId, subscribedTarget.containerName)
  }
  window.removeEventListener('click', closeMenu)
  unsubscribeData?.()
  unsubscribeStatus?.()
  resizeObserver?.disconnect()
  term?.dispose()
  // 面板没了，链上的期望值也一起丢掉（会话若还在，store 里的确认值仍然有效）
  cwdTracker.forget(props.sessionId)
  highlighter?.dispose()
  highlighter = null
})

/*
 * 配色 / 字号 / 字体变化时实时应用（连字开关需重建渲染器，提示重开标签）。
 *
 * 第一个依赖是 currentPreset 而不是 themeId：themeId 是 'auto'（跟随界面）时，
 * 用户切界面深浅并不会改 themeId，但 currentPreset 会由亮色终端换成暗色终端 ——
 * 盯 themeId 的话终端就不跟着变了，正是「白界面配黑终端」的来源。
 */
watch(
  () => [settings.currentPreset, settings.fontSize, settings.fontId],
  () => {
    if (!term) return
    term.options.theme = settings.currentPreset.theme
    term.options.fontSize = settings.fontSize
    term.options.fontFamily = settings.fontFamily
    // 高亮的颜色取自主题，配色一变已挂上的装饰就是旧色，让它自己重挂
    highlighter?.setTheme(settings.currentPreset.theme)
    safeFit()
  }
)

/** 输出高亮开关：关掉时把已经挂上的颜色立刻摘掉（不必等重开标签） */
watch(
  () => settings.outputHighlight,
  (on) => highlighter?.setEnabled(on)
)

/** 隐藏期间尺寸可能已变化：只重量尺寸，不碰键盘焦点 */
function refit(): void {
  safeFit()
}

/** 标签页重新激活时父组件调用：重量尺寸 + 把键盘交给它 */
function refitAndFocus(): void {
  refit()
  term?.focus()
}

/*
 * refit 与 refitAndFocus 分开暴露，是给平铺模式用的：铺开/收起时所有面板都要
 * 重量尺寸，但只有当前那一格该抢焦点 —— 挨个调 refitAndFocus 会把焦点甩到最后
 * 一个格子上，接着敲的字就进错会话了。
 */
defineExpose({ refit, refitAndFocus })
</script>

<template>
  <div class="terminal-wrap">
    <!--
      底色跟着**终端配色**走而不是 chrome 的 --bg-panel：xterm 只画自己那块画布，
      四周的留白是这层 div 的背景。两者不一致时终端边上会露出一圈对不上的色边
      （原先靠写死的深色恰好蒙对，换成浅色主题就露馅）。
    -->
    <div
      ref="container"
      class="terminal-container"
      :style="{ background: settings.currentPreset.theme.background }"
      @contextmenu.prevent="openMenu"
      @dragover="onDragOver"
      @dragenter="onDragEnter"
      @dragleave="onDragLeave"
      @drop="onDropFiles"
    ></div>

    <!-- 拖文件进来的目标提示浮层（pointer-events none：别把 drop 从终端上抢走） -->
    <div v-if="dropActive" class="drop-veil">
      <span>{{ dropHint }}</span>
    </div>

    <!-- 断线重连状态条：重连期间一直挂着，随时可以停下 -->
    <div v-if="reconnect" class="reconnect-bar">
      <span class="pulse"></span>
      <span class="reconnect-text">连接已断开 · {{ reconnect.reason }} · 第 {{ reconnect.attempt }} 次重试</span>
      <span class="spacer"></span>
      <button title="立刻再试一次" @click="retryNow">立即重试</button>
      <button title="停止自动重连" @click="stopReconnect">停止</button>
    </div>

    <!-- Ctrl+F 搜索框 -->
    <div v-show="searchVisible" class="search-bar" @keydown.esc="toggleSearch">
      <input
        ref="searchInput"
        v-model="searchText"
        placeholder="搜索终端输出…"
        @keyup.enter="findNext"
        @keyup.shift.enter="findPrevious"
      />
      <button title="上一个 (Shift+Enter)" @click="findPrevious"><Icon name="arrow-up" /></button>
      <button title="下一个 (Enter)" @click="findNext"><Icon name="arrow-down" /></button>
      <button title="关闭 (Esc)" @click="toggleSearch"><Icon name="x" /></button>
    </div>

    <!-- 端口浮层：哨兵警告（新监听）+ 转发建议同一个栈，哨兵在前 -->
    <div class="port-suggestions">
      <div
        v-for="s in sentinelToasts"
        :key="'sentinel-' + s.port"
        class="port-toast sentinel"
        title="点击查看这个端口的连接（性能监控 · 网络）"
        @click="openSentinel(s)"
      >
        <Icon name="alert" :size="13" />
        <span>新监听端口 :{{ s.port }}<template v-if="s.process"> · {{ s.process }}{{ s.pid ? `(${s.pid})` : '' }}</template></span>
        <button class="x" title="忽略" @click.stop="dismissSentinel(s.port)"><Icon name="x" :size="12" /></button>
      </div>
      <div v-for="s in suggestions" :key="s.port" class="port-toast" :class="s.state">
        <template v-if="s.state === 'pending'">
          <Icon name="zap" :size="13" />
          <span>检测到服务监听 :{{ s.port }}</span>
          <button class="act" @click="confirmForward(s)">转发到本机</button>
          <button class="x" title="忽略" @click="dismissForward(s)"><Icon name="x" :size="12" /></button>
        </template>
        <template v-else-if="s.state === 'ok'">
          <Icon name="check" :size="13" />
          <span>已转发 → localhost:{{ s.port }}</span>
        </template>
        <template v-else>
          <Icon name="x" :size="13" />
          <span :title="s.error">转发失败：{{ s.error }}</span>
        </template>
      </div>
    </div>

    <!-- 右键菜单 -->
    <div
      v-if="menu"
      class="context-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
    >
      <button :disabled="!hasSelection" @click="copySelection">复制<span class="hint">Ctrl+Shift+C</span></button>
      <button @click="pasteClipboard">粘贴<span class="hint">Ctrl+Shift+V</span></button>
      <button @click="clearTerminal">清屏<span class="hint">Ctrl+L</span></button>
      <button @click="focusTerminal">聚焦终端</button>
      <button v-if="procTarget" @click="openProcesses">性能监控</button>
    </div>
  </div>
</template>

<style scoped>
.terminal-wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
/* 拖文件进来的提示浮层：只展示不拦截，drop 还得落在终端上 */
.drop-veil {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border: 2px dashed var(--accent-text);
  border-radius: var(--r-md);
  z-index: 5;
}
.drop-veil span {
  background: var(--bg-panel);
  border-radius: var(--r-pill);
  padding: 6px 14px;
  font-size: var(--fs-sm);
  color: var(--accent-text);
  box-shadow: var(--shadow-sm);
}
.terminal-container {
  width: 100%;
  height: 100%;
  padding: 4px 0 0 8px;
  box-sizing: border-box;
}
.reconnect-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  font-size: var(--fs-sm);
  color: var(--warning-text);
  background: var(--warning-soft);
  border-bottom: 1px solid var(--warning-border);
}
.reconnect-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reconnect-bar .spacer {
  flex: 1;
}
.reconnect-bar button {
  background: none;
  border: 1px solid var(--warning-border);
  border-radius: var(--r-xs);
  color: var(--warning-text);
  cursor: pointer;
  font-size: var(--fs-xs);
  padding: 1px 8px;
  flex-shrink: 0;
}
.reconnect-bar button:hover {
  background: var(--warning-soft);
}
.pulse {
  width: 7px;
  height: 7px;
  border-radius: var(--r-pill);
  background: var(--warning-text);
  flex-shrink: 0;
  animation: reconnect-pulse 1s infinite alternate;
}
@keyframes reconnect-pulse {
  from {
    opacity: 0.3;
  }
  to {
    opacity: 1;
  }
}
.search-bar {
  position: absolute;
  top: 36px;
  right: 12px;
  display: flex;
  gap: 4px;
  padding: 6px;
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-md);
  z-index: 5;
}
.search-bar input {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--r-xs);
  color: var(--fg);
  padding: 4px 8px;
  font-size: var(--fs-sm);
  width: 180px;
  outline: none;
}
.search-bar input:focus {
  border-color: var(--accent-text);
}
.search-bar button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--r-xs);
  color: var(--fg-muted);
  cursor: pointer;
  padding: 4px 8px;
}
.search-bar button:hover {
  color: var(--fg);
}
.context-menu {
  position: fixed;
  z-index: 50;
  min-width: 180px;
  padding: 4px;
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
}
.context-menu button {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  background: none;
  border: none;
  border-radius: var(--r-sm);
  color: var(--fg);
  font-size: var(--fs-md);
  text-align: left;
  padding: 6px 10px;
  cursor: pointer;
}
.context-menu button:hover:not(:disabled) {
  background: var(--border);
}
.context-menu button:disabled {
  opacity: 0.35;
  cursor: default;
}
.hint {
  color: var(--fg-muted);
  font-size: var(--fs-xs);
}

/* 端口转发建议气泡：右下浮层，不抢焦点不遮状态条 */
.port-suggestions {
  position: absolute;
  right: 16px;
  bottom: 12px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 60%;
}
.port-toast {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--r-md);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
  font-size: var(--fs-sm);
  color: var(--fg);
}
.port-toast.ok {
  color: var(--success-text);
}
.port-toast.error {
  color: var(--danger-text);
}
/* 端口哨兵：黄色警告调，整条可点（点击直达连接表） */
.port-toast.sentinel {
  color: var(--warning-text);
  border-color: var(--warning-text);
  cursor: pointer;
}
.port-toast .act {
  padding: 2px 10px;
  border: none;
  border-radius: var(--r-sm);
  /* 约定：带白字的实底按钮用 --accent-text 而不是 --accent（见 styles.css） */
  background: var(--accent-text);
  color: var(--bg-panel);
  font-weight: 600;
  font-size: var(--fs-sm);
  cursor: pointer;
}
.port-toast .x {
  display: flex;
  padding: 2px;
  border: none;
  background: none;
  color: var(--fg-muted);
  cursor: pointer;
}

</style>
