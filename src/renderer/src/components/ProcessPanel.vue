<script setup lang="ts">
/**
 * 进程管理面板（右侧栏，与文件面板同一位姿）。
 *
 * 数据通路在主进程 ProcessService：目标装了 agent ≥0.4.0 走 ps_list
 * （/proc 直读 + 两次采样差分 CPU），宿主机没装就退化一次性 ps 命令，
 * 容器没装则报错指路 —— 面板只负责呈现。
 *
 * 结束进程两级走：确认 → SIGTERM；5 秒后进程还在 → 给「强制结束」(SIGKILL)。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { ProcInfo } from '@shared/types'
import { useSessionStore } from '../stores/sessions'
import Icon from './Icon.vue'
import Spinner from './Spinner.vue'

const props = defineProps<{
  /** 发起调用的会话（容器目标是父会话） */
  sessionId: string
  containerName?: string
  /** 标题里显示的目标名（主机名 / 容器名） */
  label: string
}>()

const store = useSessionStore()

const processes = ref<ProcInfo[]>([])
/** agent = 瞬时 CPU 差分；fallback-ps = ps 命令退化（CPU 是存活期均值） */
const via = ref<'agent' | 'fallback-ps' | null>(null)
const loading = ref(true)
const errorMsg = ref('')
const filter = ref('')

type SortKey = 'pid' | 'user' | 'cpu' | 'mem' | 'command'
const sortKey = ref<SortKey>('cpu')
const sortAsc = ref(false)

/** TERM 已发、等待进程退出的 pid → 发出时刻（5s 后还在就允许 KILL） */
const termSentAt = reactive<Record<number, number>>({})

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase()
  let list = processes.value
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

async function refresh(): Promise<void> {
  try {
    const r = await window.api.procList(props.sessionId, props.containerName)
    processes.value = r.processes
    via.value = r.via
    errorMsg.value = ''
    // 已退出的进程清掉 TERM 计时
    const live = new Set(r.processes.map((p) => p.pid))
    for (const pid of Object.keys(termSentAt)) {
      if (!live.has(Number(pid))) delete termSentAt[Number(pid)]
    }
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

/** 待确认结束的进程 */
const confirming = ref<ProcInfo | null>(null)

async function killProc(p: ProcInfo, signal: 15 | 9): Promise<void> {
  confirming.value = null
  try {
    await window.api.procKill(props.sessionId, p.pid, signal, props.containerName)
    if (signal === 15) termSentAt[p.pid] = Date.now()
    await refresh()
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  }
}

/** TERM 发出超过 5 秒进程还在 → 亮出「强制结束」 */
function canForceKill(pid: number): boolean {
  const t = termSentAt[pid]
  return t !== undefined && Date.now() - t > 5000
}

let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  void refresh()
  // 2s 自动刷新；页面不可见时暂停（后台轮询白耗远端 CPU）
  timer = setInterval(() => {
    if (!document.hidden && !confirming.value) void refresh()
  }, 2000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="proc-panel">
    <div class="toolbar">
      <span class="title" :title="label">进程管理 · {{ label }}</span>
      <span class="spacer"></span>
      <button class="icon-btn" title="刷新" @click="refresh"><Icon name="refresh" /></button>
      <button class="icon-btn" title="关闭" @click="store.closeProcPanel()"><Icon name="x" /></button>
    </div>

    <div class="filter-row">
      <Icon name="search" :size="13" />
      <input v-model="filter" placeholder="过滤：命令 / 用户 / PID" spellcheck="false" />
      <span v-if="via === 'fallback-ps'" class="via-note" title="未安装远程助手，用 ps 命令退化：CPU% 是进程存活期的均值，不是瞬时值">
        退化模式
      </span>
    </div>

    <div v-if="errorMsg" class="error-banner">
      {{ errorMsg }}
      <button class="retry" @click="refresh">重试</button>
    </div>

    <div v-if="loading" class="hint"><Spinner text="读取进程列表…" /></div>

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
        v-for="p in filtered"
        :key="p.pid"
        class="row"
        :class="{ 'term-sent': termSentAt[p.pid] !== undefined }"
      >
        <span class="c-pid">{{ p.pid }}</span>
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
      <div v-if="!filtered.length" class="hint">{{ filter ? '没有匹配的进程' : '没有进程' }}</div>
    </div>

    <!-- 结束确认条：两级（TERM 温和退出，确认条里不直接给 KILL，先礼后兵） -->
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
.proc-panel {
  width: 420px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: var(--bg-panel);
  min-height: 0;
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
