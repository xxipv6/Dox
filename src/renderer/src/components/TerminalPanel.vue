<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, computed, watch } from 'vue'
import { Terminal, type ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { useSessionStore } from '../stores/sessions'
import { useEscapeToClose } from '../composables/useEscapeToClose'
import { isPlainSshId, LOCAL_CONTAINER_TARGET } from '@shared/sessionId'
import type { AgentStatsPayload } from '@shared/types'
import { useSettingsStore } from '../stores/settings'
import { useEditorStore } from '../stores/editor'
import { createZmodemBridge, type ZmodemBridge } from '../zmodem/zmodemService'
import { detectListenPorts } from '../utils/portSuggest'
import Icon from './Icon.vue'

const props = defineProps<{ sessionId: string }>()
const store = useSessionStore()
const settings = useSettingsStore()
const editor = useEditorStore()

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

// ---- agent 系统状态条（CPU/内存/GPU）：与端口推送同一条通道、同一 opt-in ----
const agentStats = ref<AgentStatsPayload | null>(null)
/** 推送是否活着（agent_closed 时藏起来，重建后首帧自动回来） */
const statsLive = ref(false)
let unsubscribeAgentStats: (() => void) | null = null
let statsSubscribed = false

const memPercent = computed(() => {
  const s = agentStats.value
  if (!s || !s.mem_total_mb) return 0
  return Math.round((s.mem_used_mb / s.mem_total_mb) * 100)
})

/** 悬停看全量：内存与显存的具体数字放 title，条上只留百分比 */
const statsTooltip = computed(() => {
  const s = agentStats.value
  if (!s) return ''
  const g = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(1)}G` : `${n}M`)
  const parts = [`内存 ${g(s.mem_used_mb)} / ${g(s.mem_total_mb)}`]
  for (const [i, gpu] of (s.gpus ?? []).entries()) {
    parts.push(`GPU${(s.gpus ?? []).length > 1 ? i : ''} ${gpu.name} · 显存 ${g(gpu.mem_used_mb)} / ${g(gpu.mem_total_mb)}`)
  }
  return parts.join('\n')
})

/** agent 差分帧：首帧全量即基线（不弹），之后 added 才是「新起的服务」 */
function handleAgentPorts(data: { listening?: number[]; added?: number[] }): void {
  if (!settings.suggestPortForward) return
  if (listenerBaseline === null) {
    listenerBaseline = new Set(data.listening ?? data.added ?? [])
    return
  }
  const target = forwardTarget()
  if (!target) return
  for (const port of data.added ?? []) {
    if (listenerBaseline.has(port) || port < MIN_SUGGEST_PORT || suggestedPorts.has(port)) continue
    suggestedPorts.add(port)
    listenerBaseline.add(port)
    void pushSuggestion(port, target)
  }
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

      // 系统状态条：同一条通道、同一个 opt-in（装助手即同意）。
      // 失败不拖累端口推送 —— 状态条本来就是锦上添花
      try {
        await window.api.agentWatchStats(target.sessionId, target.containerName)
        if (!disposed) {
          statsSubscribed = true
          unsubscribeAgentStats = window.api.onAgentStats((id, ctr, data) => {
            if (id !== target.sessionId || (ctr ?? undefined) !== target.containerName) return
            if (data.event === 'agent_closed') {
              statsLive.value = false
              return
            }
            if (data.event !== 'stats') return
            const { event: _e, ...payload } = data
            agentStats.value = payload as AgentStatsPayload
            statsLive.value = true
          })
        } else {
          void window.api.agentUnwatchStats(target.sessionId, target.containerName)
        }
      } catch {
        // 老版本 agent（0.1.0）没有 watch_stats：unknown method，状态条不出现即可
      }
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

function safeFit(): void {
  const el = container.value
  if (!el || el.clientWidth < MIN_CONTAINER_WIDTH || el.clientHeight < MIN_CONTAINER_HEIGHT) return
  fitAddon?.fit()
}

// ---- 终端 cwd 跟踪 ----
// 优先用 shell integration 上报（OSC 7，精确）；没有的 shell 退回解析 cd 命令
let lineBuf = ''
let cwdFromIntegration = false

function normalizePosix(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

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
  return raw
}

/** cd 目标验证的代际：连敲几条 cd 时，只认最后一条的 stat 结果 */
let cdVerifySeq = 0

/** 从命令行里取出 cd/pushd 的参数（不是 cd 命令则 null） */
function cdArgOf(line: string): string | null {
  const m = /^\s*(?:cd|pushd)\s*(.*)$/.exec(line)
  if (!m) return null
  const arg = (m[1] ?? '').trim().split(/\s*(?:&&|\|\||[;|])\s*/)[0]?.trim() ?? ''
  return arg.replace(/^["']|["']$/g, '')
}

/** 把 cd 参数解析成绝对路径（解析不出来返回 null） */
function resolveCdTarget(arg: string): string | null {
  if (arg === '-') return null
  const home = store.homeBySession[props.sessionId]
  const cur = store.cwdBySession[props.sessionId] ?? home ?? '/'
  if (!arg || arg === '~') return home ?? null
  if (arg.startsWith('/')) return normalizePosix(arg)
  if (arg.startsWith('~/')) return home ? normalizePosix(home + arg.slice(1)) : null
  return normalizePosix(cur + '/' + arg)
}

/**
 * 算出目标目录后先落一次地（sftpStat）再更新面板 ——
 * 「cd 失败」（目录不存在、没权限）时面板不该跟着走。
 * 仅 SSH 会话：本地/容器没有对应的 SFTP 通道，维持原来的直接信任。
 */
function applyCwd(next: string): void {
  if (!isPlainSshId(props.sessionId)) {
    store.setCwd(props.sessionId, next)
    return
  }
  const seq = ++cdVerifySeq
  window.api
    .sftpStat(props.sessionId, next)
    .then((stat) => {
      if (seq !== cdVerifySeq) return // 期间又敲了别的 cd，这趟结果作废
      if (stat?.isDir) store.setCwd(props.sessionId, next)
    })
    .catch(() => {
      /* 会话断开等：不更新也不打扰 */
    })
}

function handleCommand(line: string): void {
  const arg = cdArgOf(line)
  if (arg === null) return
  const next = resolveCdTarget(arg)
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
  const home = store.homeBySession[props.sessionId]
  const cur = store.cwdBySession[props.sessionId] ?? home ?? '/'
  let full: string
  if (arg.startsWith('~/')) {
    if (!home) return
    full = home + arg.slice(1)
  } else if (arg.startsWith('/')) {
    full = arg
  } else {
    full = `${cur}/${arg}`
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
  if (q) searchAddon.findNext(q, { incremental: true })
  else searchAddon.clearDecorations()
})

function findNext(): void {
  if (searchText.value) searchAddon?.findNext(searchText.value)
}

function findPrevious(): void {
  if (searchText.value) searchAddon?.findPrevious(searchText.value)
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
  const sel = term?.getSelection()
  if (sel) await navigator.clipboard.writeText(sel)
  closeMenu()
}

async function pasteClipboard(): Promise<void> {
  closeMenu()
  const text = await navigator.clipboard.readText()
  if (text) window.api.input(props.sessionId, text)
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
  if (tab?.kind === 'container' && tab.container) {
    return { sessionId: tab.container.parentSessionId, containerName: tab.container.containerName }
  }
  return null
})

function openProcesses(): void {
  closeMenu()
  const t = procTarget.value
  if (!t) return
  const tab = store.tabs.find((tb) => tb.panes.some((p) => p.sessionId === props.sessionId))
  store.openProcPanel({
    ...t,
    label: t.containerName ? `容器 ${t.containerName}` : (tab?.title ?? '主机')
  })
}

onMounted(() => {
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
  term.loadAddon(new WebLinksAddon())
  // 绝对路径链接仅对 SSH 会话有意义（本地/容器没有对应的 SFTP 视图）
  if (isPlainSshId(props.sessionId)) registerPathLinks(term)
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
    if (e.ctrlKey && !e.shiftKey && key === 'f') {
      toggleSearch()
      return false
    }
    if (e.ctrlKey && e.shiftKey && key === 'c') {
      const sel = term?.getSelection()
      if (sel) void navigator.clipboard.writeText(sel)
      return false
    }
    if (e.ctrlKey && e.shiftKey && key === 'v') {
      void pasteClipboard()
      return false
    }
    return true
  })

  // 选中即复制
  term.onSelectionChange(() => {
    const sel = term?.getSelection()
    if (sel) void navigator.clipboard.writeText(sel)
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
    window.api.input(props.sessionId, data)
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
  zmodem?.abort() // 清掉看门狗定时器，避免卸载后触发
  stopProcPoll()
  if (agentRetryTimer !== null) {
    clearTimeout(agentRetryTimer)
    agentRetryTimer = null
  }
  unsubscribeAgentPorts?.()
  unsubscribeAgentStats?.()
  if (agentSubscribed && subscribedTarget) {
    void window.api.agentUnwatchPorts(subscribedTarget.sessionId, subscribedTarget.containerName)
  }
  if (statsSubscribed && subscribedTarget) {
    void window.api.agentUnwatchStats(subscribedTarget.sessionId, subscribedTarget.containerName)
  }
  window.removeEventListener('click', closeMenu)
  unsubscribeData?.()
  unsubscribeStatus?.()
  resizeObserver?.disconnect()
  term?.dispose()
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
    safeFit()
  }
)

/** 标签页重新激活时父组件调用：隐藏期间尺寸可能已变化 */
function refitAndFocus(): void {
  safeFit()
  term?.focus()
}

defineExpose({ refitAndFocus })
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
    ></div>

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

    <!-- 端口转发建议：检测到服务横幅时浮在终端右下角，不挡输出 -->
    <div class="port-suggestions">
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

    <!--
      远端系统状态条：收到过帧就常驻。通道掉线时**不撤条**——数值变灰 + 连接中，
      凭空消失读起来像 bug；从没收过帧（没装助手）才不渲染。
    -->
    <div v-if="agentStats" class="agent-stats" :class="{ offline: !statsLive }" :title="statsTooltip">
      <template v-if="statsLive">
        <span>CPU {{ agentStats.cpu_percent.toFixed(0) }}%</span>
        <span>MEM {{ memPercent }}%</span>
        <span v-for="(g, i) in agentStats.gpus ?? []" :key="i">
          GPU{{ (agentStats.gpus ?? []).length > 1 ? i : '' }} {{ g.util_percent }}%
        </span>
      </template>
      <span v-else>助手连接中…</span>
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
      <button v-if="procTarget" @click="openProcesses">进程管理</button>
    </div>
  </div>
</template>

<style scoped>
.terminal-wrap {
  position: relative;
  width: 100%;
  height: 100%;
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

/* 远端系统状态条：左下细条，与右下的端口建议遥遥相对，都不挡输出 */
.agent-stats {
  position: absolute;
  left: 16px;
  bottom: 12px;
  z-index: 5;
  display: flex;
  gap: 12px;
  padding: 4px 10px;
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--bg-panel) 82%, transparent);
  border: 1px solid var(--border);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--fg-muted);
  white-space: pre-line;
  pointer-events: auto;
}
/* 通道掉线：条还在、数值收起来，一句话说清状态（凭空消失读起来像 bug） */
.agent-stats.offline {
  opacity: 0.65;
  font-style: italic;
}
</style>
