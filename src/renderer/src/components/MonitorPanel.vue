<script setup lang="ts">
/**
 * 性能监控面板（右侧栏，任务管理器式三页签）。
 *
 *  - 概览：总 CPU + **每核一个格子**（agent 0.6.0 的 cpus 帧字段）、内存、GPU。
 *    watch_stats 订阅由本面板自己持有（终端没有状态条了，全窗口唯一 owner），
 *    卸载时退订。
 *  - 网络：netstat 式连接表（agent 0.6.0 net_conns，/proc 直读不依赖 netstat）。
 *  - 进程：原「进程管理」全部能力（过滤/排序/两级结束）。
 *
 * 概览与网络依赖 agent；进程页宿主机没装 agent 仍退化 ps（ProcessService 兜底）。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { AgentStatsPayload, NetConn, ProcInfo } from '@shared/types'
import { useSessionStore } from '../stores/sessions'
import { useSettingsStore } from '../stores/settings'
import Icon from './Icon.vue'
import Spinner from './Spinner.vue'

const props = defineProps<{
  /** 发起调用的会话（容器目标是父会话） */
  sessionId: string
  containerName?: string
  /** 标题里显示的目标名（主机名 / 容器名） */
  label: string
  /** 打开时落在哪页（端口哨兵点进来 → network 并按端口过滤） */
  initialTab?: 'overview' | 'network' | 'processes'
  /** 预填过滤词（按 initialTab 路由到连接过滤框或进程过滤框） */
  initialFilter?: string
}>()

const store = useSessionStore()
const settings = useSettingsStore()

/*
 * 面板宽度：拖左缘调整，松手才写设置（拖动期间高频写持久化是浪费）。
 * 网络页的「地址:端口」在 440px 默认宽度下必然省略号 —— 加宽是用户自己的
 * 第一反应，给个拖柄比反复加默认宽度对。
 */
const panelWidth = ref(settings.monitorWidth)

function startResize(e: MouseEvent): void {
  const startX = e.clientX
  const startW = panelWidth.value
  const onMove = (ev: MouseEvent): void => {
    panelWidth.value = Math.min(960, Math.max(360, startW + (startX - ev.clientX)))
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    settings.monitorWidth = panelWidth.value
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

const tab = ref(props.initialTab ?? 'overview')
// initialFilter 按目标页签路由：网络页 → 连接过滤框；进程页 → 进程过滤框
const initConnsFilter = props.initialTab === 'network' ? (props.initialFilter ?? '') : ''
const initProcFilter = props.initialTab === 'network' ? '' : (props.initialFilter ?? '')

// App.vue 的 :key 只含 sessionId:containerName —— 面板已开时再点状态条的
// top 进程 chip（openMonitor 带新 tab/filter），组件不重挂载，props 的
// 变化要靠这个 watch 同步进来，否则点击毫无反馈
watch(
  () => [props.initialTab, props.initialFilter] as const,
  ([t, f]) => {
    if (t) tab.value = t
    if (f === undefined) return
    if (t === 'network') connsFilter.value = f
    else filter.value = f
  }
)

// ================= 概览：watch_stats（本面板自己持有订阅） =================

const stats = ref<AgentStatsPayload | null>(null)
const statsLive = ref(false)
let offStats: (() => void) | null = null
/** 订阅成功后才赋值的退订函数（只在订阅成功后退订，避免误删别人的意图） */
let unwatchStats: (() => void) | null = null
/** 卸载标记：watch_stats 是异步登记，返回时面板可能已关 */
let disposed = false

const memPercent = computed(() => {
  const s = stats.value
  if (!s || !s.mem_total_mb) return 0
  return Math.round((s.mem_used_mb / s.mem_total_mb) * 100)
})

function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${mb}M`
}

/** 格子的热色：绿（闲）→ 黄 → 红（满） */
function coreColor(pct: number): string {
  if (pct >= 90) return 'var(--danger-text)'
  if (pct >= 60) return 'var(--warning-text)'
  return 'var(--success-text)'
}

// ================= 网络：net_conns 轮询（页签激活才轮） =================

const conns = ref<NetConn[]>([])
const connsTruncated = ref(false)
const connsError = ref('')
const connsLoading = ref(false)
const connsFilter = ref(initConnsFilter)
/** 进程页「看它的连接」带过来的精确 PID 过滤（全文搜索框会被端口子串污染：
 *  PID 443 会把所有 :443 端口的连接都捞进来，所以走独立字段精确匹配） */
const connsPid = ref<number | null>(null)
let connsInFlight = false

const filteredConns = computed(() => {
  let list = conns.value
  if (connsPid.value !== null) list = list.filter((c) => c.pid === connsPid.value)
  const q = connsFilter.value.trim().toLowerCase()
  if (!q) return list
  return list.filter(
    (c) =>
      c.local_addr.includes(q) ||
      c.remote_addr.includes(q) ||
      String(c.local_port).includes(q) ||
      String(c.remote_port).includes(q) ||
      (c.process ?? '').toLowerCase().includes(q) ||
      c.state.toLowerCase().includes(q)
  )
})

async function refreshConns(): Promise<void> {
  // net_conns 的 socketOwners 是全量 /proc/[pid]/fd 扫描，慢机器上秒级；
  // 上一次没回来就再发，请求会在 agent 串行循环里只进不出地积压
  if (connsInFlight) return
  connsInFlight = true
  connsLoading.value = conns.value.length === 0
  try {
    const r = (await window.api.agentCall(props.sessionId, props.containerName, 'net_conns', {})) as {
      conns: NetConn[]
      truncated: boolean
    }
    conns.value = r.conns
    connsTruncated.value = r.truncated
    connsError.value = ''
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    connsError.value = msg.includes('unknown method')
      ? '连接表需要助手 v0.6.0，请在侧栏「远程助手」升级'
      : msg
  } finally {
    connsInFlight = false
    connsLoading.value = false
  }
}

// ================= 进程：原进程管理全部能力 =================

const processes = ref<ProcInfo[]>([])
const via = ref<'agent' | 'fallback-ps' | null>(null)
const procLoading = ref(true)
const procError = ref('')
const filter = ref(initProcFilter)
/** 网络页「定位进程」带过来的精确 PID（进程过滤框是子串匹配，PID 443 会
 *  连 1443 一起捞出来，跳转必须走精确字段） */
const procPid = ref<number | null>(null)

type SortKey = 'pid' | 'user' | 'cpu' | 'mem' | 'command'
const sortKey = ref<SortKey>('cpu')
const sortAsc = ref(false)

/** TERM 已发、等待进程退出的 pid → 发出时刻（5s 后还在就允许 KILL） */
const termSentAt = reactive<Record<number, number>>({})

const filteredProcs = computed(() => {
  const q = filter.value.trim().toLowerCase()
  let list = processes.value
  if (procPid.value !== null) list = list.filter((p) => p.pid === procPid.value)
  if (q) {
    list = list.filter(
      (p) =>
        p.command.toLowerCase().includes(q) ||
        p.user.toLowerCase().includes(q) ||
        String(p.pid).includes(q)
    )
  }
  const dir = sortAsc.value ? 1 : -1
  return [...list].sort((a, b) => {
    switch (sortKey.value) {
      case 'pid': return (a.pid - b.pid) * dir
      case 'user': return a.user.localeCompare(b.user) * dir
      case 'cpu': return (a.cpuPercent - b.cpuPercent) * dir
      case 'mem': return (a.memPercent - b.memPercent) * dir
      default: return a.command.localeCompare(b.command) * dir
    }
  })
})

/**
 * 渲染上限：大宿主机上千级进程每 2s 全量重绘能把 Electron 渲染进程
 * 打满（真实案例：1822 进程 × 2s 刷新 = 面板本身 80%+ CPU）。
 * 排序照全量排，只渲染前 N 行；要找人用过滤框。
 */
const PROC_RENDER_CAP = 300
const CONN_RENDER_CAP = 300
const shownProcs = computed(() => filteredProcs.value.slice(0, PROC_RENDER_CAP))
const shownConns = computed(() => filteredConns.value.slice(0, CONN_RENDER_CAP))

function toggleSort(key: SortKey): void {
  if (sortKey.value === key) sortAsc.value = !sortAsc.value
  else {
    sortKey.value = key
    sortAsc.value = key === 'command' || key === 'user'
  }
}

function formatRss(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

let procInFlight = false

async function refreshProcs(): Promise<void> {
  if (procInFlight) return
  procInFlight = true
  try {
    const r = await window.api.procList(props.sessionId, props.containerName)
    processes.value = r.processes
    via.value = r.via
    procError.value = ''
    const live = new Set(r.processes.map((p) => p.pid))
    for (const pid of Object.keys(termSentAt)) {
      if (!live.has(Number(pid))) delete termSentAt[Number(pid)]
    }
  } catch (err) {
    procError.value = err instanceof Error ? err.message : String(err)
  } finally {
    procInFlight = false
    procLoading.value = false
  }
}

const confirming = ref<ProcInfo | null>(null)

async function killProc(p: ProcInfo, signal: 15 | 9): Promise<void> {
  confirming.value = null
  try {
    await window.api.procKill(props.sessionId, p.pid, signal, props.containerName)
    if (signal === 15) termSentAt[p.pid] = Date.now()
    await refreshProcs()
  } catch (err) {
    procError.value = err instanceof Error ? err.message : String(err)
  }
}

function canForceKill(pid: number): boolean {
  const t = termSentAt[pid]
  return t !== undefined && Date.now() - t > 5000
}

/** 进程页行点击 → 网络页按 PID 精确过滤（从「谁」跳到「它在和谁说话」） */
function jumpToConns(p: ProcInfo): void {
  connsPid.value = p.pid
  connsFilter.value = ''
  tab.value = 'network'
}

/** 网络页连接行的进程名点击 → 进程页精确定位（从「连接」跳回「谁」，方便结束任务） */
function jumpToProc(c: NetConn): void {
  if (!c.pid) return
  procPid.value = c.pid
  filter.value = ''
  tab.value = 'processes'
}

// ================= 轮询编排：激活页签 2s 一轮，后台/不可见暂停 =================

let timer: ReturnType<typeof setInterval> | null = null

function tick(): void {
  if (document.hidden) return
  if (tab.value === 'network') void refreshConns()
  else if (tab.value === 'processes' && !confirming.value) void refreshProcs()
}

watch(tab, (t) => {
  if (t === 'network') void refreshConns()
  if (t === 'processes') void refreshProcs()
})

onMounted(() => {
  offStats = window.api.onAgentStats((id, ctr, data) => {
    if (id !== props.sessionId || (ctr ?? undefined) !== props.containerName) return
    if (data.event === 'agent_closed') {
      statsLive.value = false
      return
    }
    if (data.event !== 'stats') return
    const { event: _e, ...payload } = data
    stats.value = payload as AgentStatsPayload
    statsLive.value = true
  })

  // 面板自己持有 watch_stats 订阅（终端不再订阅，全窗口就这一个 owner）。
  // 老 agent 没有 watch_stats → unknown method，概览页停在等待文案即可
  void (async () => {
    const st = await window.api.agentStatus(props.sessionId, props.containerName).catch(() => null)
    if (!st?.installed) return
    try {
      await window.api.agentWatchStats(props.sessionId, props.containerName)
      // 异步返回时面板可能已关：立即退订别漏通道
      if (disposed) void window.api.agentUnwatchStats(props.sessionId, props.containerName)
      else unwatchStats = () => window.api.agentUnwatchStats(props.sessionId, props.containerName)
    } catch { /* 老版本助手没有 watch_stats */ }
  })()

  if (tab.value === 'network') void refreshConns()
  if (tab.value === 'processes') void refreshProcs()
  else procLoading.value = false
  timer = setInterval(tick, 2000)
})

onBeforeUnmount(() => {
  disposed = true
  if (timer) clearInterval(timer)
  offStats?.()
  unwatchStats?.()
})
</script>

<template>
  <div class="mon-panel" :style="{ width: panelWidth + 'px' }">
    <div class="resize-handle" title="拖动调整面板宽度" @mousedown.prevent="startResize"></div>
    <div class="toolbar">
      <span class="title" :title="label">性能监控 · {{ label }}</span>
      <span class="spacer"></span>
      <button class="icon-btn" title="关闭" @click="store.closeMonitor()"><Icon name="x" /></button>
    </div>

    <div class="tab-bar">
      <button :class="{ active: tab === 'overview' }" @click="tab = 'overview'">概览</button>
      <button :class="{ active: tab === 'network' }" @click="tab = 'network'">网络</button>
      <button :class="{ active: tab === 'processes' }" @click="tab = 'processes'">进程</button>
    </div>

    <!-- ============ 概览 ============ -->
    <div v-show="tab === 'overview'" class="page">
      <template v-if="stats && statsLive">
        <div class="sec-head">
          <span>CPU</span>
          <span class="sec-val">{{ stats.cpu_percent.toFixed(0) }}%</span>
        </div>
        <!-- 每核一个格子：任务管理器的核心视图 -->
        <div v-if="stats.cpus?.length" class="core-grid">
          <div
            v-for="(pct, i) in stats.cpus"
            :key="i"
            class="core-box"
            :title="`核心 ${i}：${pct.toFixed(0)}%`"
          >
            <span class="core-fill" :style="{ height: `${Math.min(100, pct)}%`, background: coreColor(pct) }"></span>
            <span class="core-label">{{ i }}</span>
            <span class="core-pct">{{ pct.toFixed(0) }}</span>
          </div>
        </div>
        <div v-else class="dim-line">总 CPU {{ stats.cpu_percent.toFixed(1) }}%（每核视图需要助手 v0.6.0）</div>

        <div class="sec-head">
          <span>内存</span>
          <span class="sec-val">{{ memPercent }}%</span>
        </div>
        <div class="big-bar">
          <span class="big-fill" :style="{ width: `${memPercent}%`, background: coreColor(memPercent) }"></span>
        </div>
        <div class="dim-line">{{ fmtMb(stats.mem_used_mb) }} / {{ fmtMb(stats.mem_total_mb) }}</div>

        <template v-for="(g, i) in stats.gpus ?? []" :key="i">
          <div class="sec-head">
            <span>GPU{{ (stats.gpus ?? []).length > 1 ? i : '' }}</span>
            <span class="sec-val">{{ g.util_percent }}%</span>
          </div>
          <div class="big-bar">
            <span class="big-fill" :style="{ width: `${g.util_percent}%`, background: coreColor(g.util_percent) }"></span>
          </div>
          <div class="dim-line">{{ g.name }} · 显存 {{ fmtMb(g.mem_used_mb) }} / {{ fmtMb(g.mem_total_mb) }}</div>
        </template>

        <div v-if="stats.top_procs?.length" class="sec-head"><span>谁在吃 CPU</span></div>
        <div v-for="p in stats.top_procs" :key="p.pid" class="top-row">
          <span class="top-cmd" :title="p.command">{{ p.command }}</span>
          <span class="top-pct">{{ p.cpu_percent.toFixed(0) }}%</span>
        </div>
      </template>
      <div v-else class="hint">
        <!-- 从未收到帧 = 等待推送；收到过又断了 = 断线（定格旧数据不能假装在线） -->
        <Spinner v-if="!stats" text="等待状态推送…（需要安装远程助手）" />
        <template v-else>助手已断线，等待重连…</template>
      </div>
    </div>

    <!-- ============ 网络 ============ -->
    <div v-show="tab === 'network'" class="page">
      <div class="filter-row">
        <Icon name="search" :size="13" />
        <input v-model="connsFilter" placeholder="过滤：地址 / 端口 / 进程 / 状态 / PID" spellcheck="false" />
        <span v-if="connsPid !== null" class="pid-chip" title="只看这个进程的连接">
          PID {{ connsPid }}
          <button class="chip-x" title="清除 PID 过滤" @click="connsPid = null"><Icon name="x" :size="11" /></button>
        </span>
        <span v-if="connsTruncated" class="via-note" title="连接太多被截断">截断</span>
      </div>
      <div v-if="connsError" class="error-banner">
        {{ connsError }}
        <button class="retry" @click="refreshConns">重试</button>
      </div>
      <div v-if="connsLoading && !conns.length" class="hint"><Spinner text="读取连接表…" /></div>
      <div v-else class="table-wrap">
        <div class="thead">
          <span class="n-proto">协议</span>
          <span class="n-addr">本地</span>
          <span class="n-addr">远端</span>
          <span class="n-state">状态</span>
          <span class="n-proc">进程</span>
        </div>
        <div v-for="(c, i) in shownConns" :key="i" class="row conn-row">
          <span class="n-proto">{{ c.proto }}</span>
          <span class="n-addr mono" :title="`${c.local_addr}:${c.local_port}`">{{ c.local_addr }}:{{ c.local_port }}</span>
          <span class="n-addr mono" :title="c.remote_port ? `${c.remote_addr}:${c.remote_port}` : ''">{{
            c.remote_port ? `${c.remote_addr}:${c.remote_port}` : '*'
          }}</span>
          <span class="n-state" :class="c.state.toLowerCase()">{{ c.state }}</span>
          <span
            class="n-proc"
            :class="{ jump: !!c.pid }"
            :title="c.pid ? `${c.process}（PID ${c.pid}）— 点击在进程页定位` : ''"
            @click="jumpToProc(c)"
            >{{ c.process ? `${c.process}${c.pid ? `(${c.pid})` : ''}` : '—' }}</span
          >
        </div>
        <div v-if="!filteredConns.length" class="hint">{{ connsFilter || connsPid !== null ? '没有匹配的连接' : '没有连接' }}</div>
        <div v-else-if="filteredConns.length > shownConns.length" class="hint">
          共 {{ filteredConns.length }} 条，只渲染前 {{ shownConns.length }} 条（用过滤缩小范围）
        </div>
      </div>
    </div>

    <!-- ============ 进程 ============ -->
    <div v-show="tab === 'processes'" class="page">
      <div class="filter-row">
        <Icon name="search" :size="13" />
        <input v-model="filter" placeholder="过滤：命令 / 用户 / PID" spellcheck="false" />
        <span v-if="procPid !== null" class="pid-chip" title="只看这个进程">
          PID {{ procPid }}
          <button class="chip-x" title="清除 PID 过滤" @click="procPid = null"><Icon name="x" :size="11" /></button>
        </span>
        <span v-if="via === 'fallback-ps'" class="via-note" title="未安装远程助手，用 ps 命令退化：CPU% 是进程存活期的均值，不是瞬时值">
          退化模式
        </span>
      </div>
      <div v-if="procError" class="error-banner">
        {{ procError }}
        <button class="retry" @click="refreshProcs">重试</button>
      </div>
      <div v-if="procLoading" class="hint"><Spinner text="读取进程列表…" /></div>
      <div v-else class="table-wrap">
        <div class="thead">
          <span class="c-pid sortable" @click="toggleSort('pid')">PID{{ sortKey === 'pid' ? (sortAsc ? ' ↑' : ' ↓') : '' }}</span>
          <span class="c-user sortable" @click="toggleSort('user')">用户{{ sortKey === 'user' ? (sortAsc ? ' ↑' : ' ↓') : '' }}</span>
          <span class="c-num sortable" @click="toggleSort('cpu')">CPU%{{ sortKey === 'cpu' ? (sortAsc ? ' ↑' : ' ↓') : '' }}</span>
          <span class="c-num sortable" @click="toggleSort('mem')">MEM%{{ sortKey === 'mem' ? (sortAsc ? ' ↑' : ' ↓') : '' }}</span>
          <span class="c-cmd sortable" @click="toggleSort('command')">命令{{ sortKey === 'command' ? (sortAsc ? ' ↑' : ' ↓') : '' }}</span>
          <span class="c-act"></span>
        </div>
        <div
          v-for="p in shownProcs"
          :key="p.pid"
          class="row"
          :class="{ 'term-sent': termSentAt[p.pid] !== undefined }"
        >
          <span class="c-pid jump" title="看它的网络连接" @click="jumpToConns(p)">{{ p.pid }}</span>
          <span class="c-user" :title="p.user">{{ p.user }}</span>
          <span class="c-num">{{ p.cpuPercent.toFixed(1) }}</span>
          <span class="c-num" :title="formatRss(p.rssBytes)">{{ p.memPercent.toFixed(1) }}</span>
          <span class="c-cmd" :title="p.command">{{ p.command }}</span>
          <span class="c-act">
            <button
              v-if="canForceKill(p.pid)"
              class="kill-btn force"
              title="SIGTERM 后 5 秒仍未退出，发送 SIGKILL"
              @click="killProc(p, 9)"
            >强制</button>
            <button
              v-else
              class="kill-btn"
              title="结束进程（SIGTERM）"
              @click="confirming = p"
            >结束</button>
          </span>
        </div>
        <div v-if="!filteredProcs.length" class="hint">{{ filter || procPid !== null ? '没有匹配的进程' : '没有进程' }}</div>
        <div v-else-if="filteredProcs.length > shownProcs.length" class="hint">
          共 {{ filteredProcs.length }} 个进程，只渲染前 {{ shownProcs.length }} 个（用过滤缩小范围）
        </div>
      </div>
    </div>

    <!-- 结束确认条：两级（TERM 温和退出，先礼后兵） -->
    <div v-if="confirming" class="confirm-bar">
      <span class="confirm-text" :title="confirming.command">
        结束 {{ confirming.pid }}（{{ confirming.command.slice(0, 40) }}）？
      </span>
      <button class="kill-btn danger" @click="killProc(confirming, 15)">结束</button>
      <button class="kill-btn" @click="confirming = null">取消</button>
    </div>
  </div>
</template>

<style scoped>
.mon-panel {
  position: relative; /* 拖宽柄的锚 */
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: var(--bg-panel);
  min-height: 0;
}
/* 左缘拖宽柄：压一半在边框外，6px 的命中区比 1px 边框好抓 */
.resize-handle {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 5;
}
.resize-handle:hover {
  background: var(--accent-soft);
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.title {
  font-size: var(--fs-sm);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
.tab-bar {
  display: flex;
  gap: 2px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}
.tab-bar button {
  flex: 1;
  border: none;
  background: none;
  border-radius: var(--r-sm);
  color: var(--fg-muted);
  font-size: var(--fs-sm);
  padding: 4px 0;
  cursor: pointer;
}
.tab-bar button:hover {
  color: var(--fg);
  background: var(--bg-hover);
}
.tab-bar button.active {
  color: var(--accent-text);
  background: var(--accent-soft);
  font-weight: var(--fw-medium);
}
.page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

/* ---- 概览 ---- */
.sec-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 10px 12px 6px;
  font-size: var(--fs-sm);
  color: var(--fg-secondary);
  font-weight: var(--fw-medium);
}
.sec-val {
  font-variant-numeric: tabular-nums;
  color: var(--fg);
}
.core-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
  gap: 5px;
  padding: 0 12px;
}
.core-box {
  position: relative;
  height: 44px;
  border: 1px solid var(--border);
  border-radius: var(--r-xs);
  background: var(--bg-sunken);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.core-fill {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  opacity: 0.28;
  transition: height 0.6s var(--ease-out);
}
.core-label {
  font-size: 10px;
  color: var(--fg-muted);
  z-index: 1;
}
.core-pct {
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--fg);
  z-index: 1;
}
.big-bar {
  margin: 0 12px;
  height: 14px;
  border-radius: var(--r-xs);
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  overflow: hidden;
}
.big-fill {
  display: block;
  height: 100%;
  opacity: 0.5;
  transition: width 0.6s var(--ease-out);
}
.dim-line {
  padding: 4px 12px 0;
  font-size: var(--fs-xs);
  color: var(--fg-muted);
}
.top-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 12px;
  font-size: var(--fs-xs);
}
.top-cmd {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  color: var(--fg-secondary);
}
.top-pct {
  font-variant-numeric: tabular-nums;
  color: var(--fg);
}

/* ---- 网络 ---- */
.conn-row .mono {
  font-family: var(--font-mono, monospace);
  font-size: var(--fs-xs);
}
.n-proto {
  width: 36px;
  flex-shrink: 0;
  color: var(--fg-muted);
  font-size: var(--fs-xs);
}
.n-addr {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.n-state {
  width: 76px;
  flex-shrink: 0;
  font-size: var(--fs-xs);
}
.n-state.established {
  color: var(--success-text);
}
.n-state.listen {
  color: var(--accent-text);
}
.n-state.time_wait,
.n-state.close_wait {
  color: var(--fg-muted);
}
.n-proc {
  width: 96px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--fg-secondary);
}

/* ---- 进程（原进程管理样式） ---- */
.filter-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--fg-muted);
}
.filter-row input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: var(--fg);
  font-size: var(--fs-sm);
}
.via-note {
  flex-shrink: 0;
  font-size: var(--fs-xs);
  color: var(--warning-text);
  background: var(--warning-soft);
  border-radius: var(--r-pill);
  padding: 0 8px;
}
.n-proc.jump {
  cursor: pointer;
  color: var(--accent-text);
}
.n-proc.jump:hover {
  text-decoration: underline;
}
.pid-chip {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-xs);
  color: var(--accent-text);
  background: var(--accent-soft);
  border-radius: var(--r-pill);
  padding: 0 4px 0 8px;
}
.pid-chip .chip-x {
  display: inline-flex;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  padding: 1px;
}
.error-banner {
  padding: 6px 10px;
  font-size: var(--fs-sm);
  color: var(--danger-text);
  background: var(--danger-soft);
  border-bottom: 1px solid var(--danger);
  display: flex;
  align-items: center;
  gap: 8px;
}
.error-banner .retry {
  flex-shrink: 0;
  background: none;
  border: 1px solid var(--danger);
  border-radius: var(--r-xs);
  color: var(--danger-text);
  cursor: pointer;
  font-size: var(--fs-xs);
  padding: 1px 8px;
}
.hint {
  padding: 24px 12px;
  text-align: center;
  color: var(--fg-muted);
  font-size: var(--fs-sm);
}
.table-wrap {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.thead,
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  font-size: var(--fs-sm);
}
.thead {
  position: sticky;
  top: 0;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  color: var(--fg-muted);
  font-size: var(--fs-xs);
}
.sortable {
  cursor: pointer;
  user-select: none;
}
.sortable:hover {
  color: var(--fg);
}
.c-pid {
  width: 52px;
  flex-shrink: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.c-pid.jump {
  cursor: pointer;
  color: var(--accent-text);
}
.c-user {
  width: 64px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.c-num {
  width: 44px;
  flex-shrink: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.c-cmd {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  font-size: var(--fs-xs);
}
.c-act {
  width: 44px;
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
}
.row:hover {
  background: var(--bg-hover);
}
.row.term-sent {
  opacity: 0.55;
}
.kill-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--r-xs);
  color: var(--fg-muted);
  cursor: pointer;
  font-size: var(--fs-xs);
  padding: 1px 8px;
}
.kill-btn:hover {
  color: var(--danger-text);
  border-color: var(--danger);
}
.kill-btn.force,
.kill-btn.danger {
  color: var(--danger-text);
  border-color: var(--danger);
}
.confirm-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--warning-border);
  background: var(--warning-soft);
}
.confirm-text {
  flex: 1;
  font-size: var(--fs-sm);
  color: var(--warning-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
