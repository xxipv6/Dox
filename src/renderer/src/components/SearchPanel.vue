<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SearchEngine, SearchEvent, SearchMatch } from '@shared/types'
import Icon from './Icon.vue'
import Spinner from './Spinner.vue'

/**
 * 项目模式全文搜索面板（与 ProjectTree 同位切换，父组件用 v-show 保活）。
 *
 * 引擎链 agent → rg → grep → node 全部在主进程 SearchService，这里只认
 * 一种 SearchEvent 协议。连续输入：300ms 防抖 + 新搜索取消旧 runId；
 * 旧 run 的迟到事件一律按 runId 丢弃。
 */

const props = defineProps<{
  /** 搜索范围（项目根，或右键「从文件夹中查找」缩到的子目录） */
  root: string
  /** 项目根（范围 chip 的参照：root !== baseRoot 时显示「已限定范围」） */
  baseRoot: string
  fsSessionId: string
  containerName?: string
  isWin: boolean
  /**
   * 面板当前可见（父组件用 v-show 保活，unmount 钩子等不到「隐藏」）。
   * 隐藏（Esc/✕/切回树）时在途搜索要立刻取消 —— 否则它一路烧完 8-30s
   * 预算，白占远端/本机 CPU；已出的结果留在内存，重新打开还在。
   */
  active: boolean
}>()

const emit = defineEmits<{
  close: []
  openMatch: [payload: { path: string; line: number }]
  /** 范围 chip 的 ✕：回到项目根 */
  resetScope: []
}>()

/** 输入防抖（命名常量：HIG 守卫只扫带单位的字面量） */
const SEARCH_DEBOUNCE_MS = 300

const query = ref('')
/** 默认忽略大小写（与 VS Code 一致）：「Aa」按钮点亮 = 大小写敏感 */
const ignoreCase = ref(true)
const isRegex = ref(false)

const inputEl = ref<HTMLInputElement>()
const results = ref<SearchMatch[]>([])
const searching = ref(false)
const errorMsg = ref('')
const doneInfo = ref<{
  engine: SearchEngine
  matchCount: number
  filesSearched: number
  elapsedMs: number
  truncated: boolean
  canceled: boolean
} | null>(null)

let activeRunId: string | null = null
/** 调用代际号：两次 startSearch 的 invoke 会交错返回，只有最新一代允许认养 runId */
let searchSeq = 0
let debounceTimer: number | null = null
let unsubscribe: (() => void) | null = null

const ENGINE_LABEL: Record<SearchEngine, string> = {
  agent: '助手',
  rg: 'ripgrep',
  grep: 'grep',
  node: 'node'
}

// ---- 搜索生命周期 ----
async function startSearch(): Promise<void> {
  const seq = ++searchSeq
  const pattern = query.value.trim()
  // 空 query 不发请求，但要把正在跑的旧搜索停掉
  if (activeRunId) {
    window.api.searchCancel(activeRunId)
    activeRunId = null
  }
  if (!pattern) {
    results.value = []
    searching.value = false
    errorMsg.value = ''
    doneInfo.value = null
    return
  }
  searching.value = true
  errorMsg.value = ''
  doneInfo.value = null
  results.value = []
  try {
    const { runId } = await window.api.searchStart({
      fsSessionId: props.fsSessionId,
      containerName: props.containerName,
      root: props.root,
      pattern,
      isRegex: isRegex.value,
      ignoreCase: ignoreCase.value
    })
    // invoke 返回期间又有更新的调用发起：这次启动直接作废（晚回来的 runId 必须杀掉，不能留僵尸搜索）
    if (seq !== searchSeq) {
      window.api.searchCancel(runId)
      return
    }
    activeRunId = runId
  } catch (err) {
    if (seq !== searchSeq) return
    searching.value = false
    errorMsg.value = err instanceof Error ? err.message : String(err)
  }
}

function scheduleSearch(): void {
  if (debounceTimer !== null) window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null
    void startSearch()
  }, SEARCH_DEBOUNCE_MS)
}

watch([query, ignoreCase, isRegex], scheduleSearch)

// 范围变化（右键「从文件夹中查找」/ chip 重置）：同一关键词换个范围重搜
watch(
  () => props.root,
  () => {
    collapsed.value = new Set()
    scheduleSearch()
  }
)

// 隐藏即取消：done 事件（canceled）会被 runId 过滤丢掉，searching 要自己收
watch(
  () => props.active,
  (on) => {
    if (!on && activeRunId) {
      window.api.searchCancel(activeRunId)
      activeRunId = null
      searching.value = false
    }
  }
)

/** 范围 chip 的展示路径（root 相对 baseRoot；相等 = 全项目，不显示 chip） */
const scopeLabel = computed(() => {
  if (props.root === props.baseRoot) return ''
  const sep = props.isWin ? '\\' : '/'
  const prefix = props.baseRoot.endsWith(sep) ? props.baseRoot : props.baseRoot + sep
  return props.root.startsWith(prefix) ? props.root.slice(prefix.length) : props.root
})

function onSearchEvent(ev: SearchEvent): void {
  // 只认当前 runId：旧 run 的迟到事件（含被取消后的 done）一律丢
  if (!activeRunId || ev.runId !== activeRunId) return
  if (ev.type === 'match') {
    results.value.push(...ev.matches)
  } else if (ev.type === 'done') {
    searching.value = false
    doneInfo.value = ev
  } else {
    searching.value = false
    errorMsg.value = ev.message
  }
}

// ---- 结果分组（首次出现序；组可折叠）----
const collapsed = ref<Set<string>>(new Set())

const groups = computed(() => {
  const out: { path: string; rel: string; matches: SearchMatch[] }[] = []
  const byPath = new Map<string, { path: string; rel: string; matches: SearchMatch[] }>()
  for (const m of results.value) {
    let g = byPath.get(m.path)
    if (!g) {
      g = { path: m.path, rel: relPath(m.path), matches: [] }
      byPath.set(m.path, g)
      out.push(g)
    }
    g.matches.push(m)
  }
  return out
})

/** 绝对路径 → 相对 root 的展示形态（剥离前缀；不在 root 下就原样显示） */
function relPath(p: string): string {
  const sep = props.isWin ? '\\' : '/'
  const prefix = props.root.endsWith(sep) ? props.root : props.root + sep
  return p.startsWith(prefix) ? p.slice(prefix.length) : p
}

function toggleGroup(path: string): void {
  const next = new Set(collapsed.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  collapsed.value = next
}

function focusInput(): void {
  inputEl.value?.focus()
  inputEl.value?.select()
}

defineExpose({ focusInput })

onMounted(() => {
  unsubscribe = window.api.onSearchEvent(onSearchEvent)
  focusInput()
})

onBeforeUnmount(() => {
  if (debounceTimer !== null) window.clearTimeout(debounceTimer)
  if (activeRunId) window.api.searchCancel(activeRunId)
  unsubscribe?.()
})
</script>

<template>
  <div class="search-panel">
    <div class="search-head">
      <div class="search-box">
        <Icon name="search" :size="13" />
        <input
          ref="inputEl"
          v-model="query"
          class="search-input"
          placeholder="在项目中搜索…"
          spellcheck="false"
          @keyup.esc="emit('close')"
        />
        <button
          class="icon-btn toggle"
          :class="{ active: !ignoreCase }"
          title="大小写敏感"
          @click="ignoreCase = !ignoreCase"
        >Aa</button>
        <button
          class="icon-btn toggle"
          :class="{ active: isRegex }"
          title="使用正则表达式"
          @click="isRegex = !isRegex"
        >.*</button>
      </div>
      <button class="icon-btn" title="关闭搜索（Esc）" @click="emit('close')">
        <Icon name="x" />
      </button>
    </div>

    <!-- 范围 chip：右键「从文件夹中查找」缩到子目录时出现，✕ 回到项目根 -->
    <div v-if="scopeLabel" class="scope-row">
      <Icon name="folder" :size="12" />
      <span class="scope-path" :title="root">{{ scopeLabel }}</span>
      <button class="icon-btn" title="重置为整个项目" @click="emit('resetScope')">
        <Icon name="x" :size="11" />
      </button>
    </div>

    <!-- 状态条：搜索中 spinner / 完成统计 + 引擎徽章 / 错误（指路文案主进程组装好） -->
    <div v-if="searching" class="search-status">
      <Spinner :size="12" />
      <span>搜索中…</span>
    </div>
    <div v-else-if="errorMsg" class="search-status error">{{ errorMsg }}</div>
    <div v-else-if="doneInfo" class="search-status">
      <span>
        {{ doneInfo.matchCount }} 条结果 · {{ doneInfo.filesSearched }} 个文件 · {{ doneInfo.elapsedMs }}ms
      </span>
      <span class="engine-badge">{{ ENGINE_LABEL[doneInfo.engine] }}</span>
      <span v-if="doneInfo.truncated" class="truncated" title="结果过多或超出时间预算，只显示了部分">已截断</span>
    </div>
    <div v-else-if="!query.trim()" class="search-status dim">输入即搜，排除 .git / node_modules</div>

    <div
      v-if="doneInfo && doneInfo.matchCount === 0 && !searching"
      class="hint"
    >没有匹配「{{ query.trim() }}」的内容</div>

    <!-- 结果：按文件分组，组头 = 相对路径 + 命中数；每条 = 行号 + 预览 -->
    <div class="search-results">
      <div v-for="g in groups" :key="g.path" class="search-group">
        <div class="group-head" @click="toggleGroup(g.path)">
          <span class="tree-chevron" :class="{ expanded: !collapsed.has(g.path) }">
            <Icon name="chevron-right" :size="11" />
          </span>
          <Icon class="file-icon" name="file" :size="14" />
          <span class="group-path" :title="g.path">{{ g.rel }}</span>
          <span class="group-count">{{ g.matches.length }}</span>
        </div>
        <div
          v-for="m in g.matches"
          v-show="!collapsed.has(g.path)"
          :key="`${m.path}:${m.line}:${m.col}`"
          class="search-match"
          @click="emit('openMatch', { path: m.path, line: m.line })"
        >
          <span class="match-line">{{ m.line }}</span>
          <span class="match-text" :title="m.text">{{ m.text }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-panel {
  flex: 1;
  /* flex 项的自动最小宽度 = 内容最大宽：500 字符的 nowrap 预览行会把面板
     顶出轨道外的可见区（右侧内容被压到编辑器底下），必须显式清零 */
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.search-head {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-2);
  border-bottom: 1px solid var(--border);
}
.search-box {
  flex: 1;
  /* 同 .search-panel 的 min-width:0：编辑器打开时面板按设计收窄到 250px，
     输入框的内在默认宽（~20 字符）会把 Aa/.* 挤出面板、滑到编辑器底下点不到 */
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 2px var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--fg-muted);
}
.search-box:focus-within {
  border-color: var(--accent);
}
.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fg);
  font-size: var(--fs-sm);
}
.icon-btn.toggle {
  width: auto;
  padding: 0 var(--sp-1);
  font-size: var(--fs-xs);
  font-family: var(--font-mono, monospace);
}
.icon-btn.toggle.active {
  color: var(--accent-text);
  background: var(--accent-soft);
}
.search-status {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-3);
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  overflow: hidden;
}
.search-status.error {
  color: var(--danger-text);
  white-space: normal;
}
.search-status.dim {
  border-bottom: none;
}
.scope-row {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-3);
  font-size: var(--fs-xs);
  color: var(--accent-text);
  background: var(--accent-soft);
  border-bottom: 1px solid var(--border);
}
.scope-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.engine-badge {
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  background: var(--accent-soft);
  color: var(--accent-text);
}
.truncated {
  color: var(--warning-text);
}
.search-results {
  flex: 1;
  overflow-y: auto;
  user-select: none;
  padding: var(--sp-1) 0;
}
.group-head {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  font-size: var(--fs-sm);
  cursor: default;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.group-head:hover {
  background: var(--bg-hover);
}
.tree-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--fg-muted);
  transition: transform var(--dur-fast) var(--ease-out);
}
.tree-chevron.expanded {
  transform: rotate(90deg);
}
.file-icon {
  flex-shrink: 0;
  color: var(--fg-muted);
}
.group-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--fw-semibold);
}
.group-count {
  flex-shrink: 0;
  font-size: var(--fs-xs);
  color: var(--fg-muted);
}
.search-match {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  padding: 1px var(--sp-2) 1px calc(var(--sp-2) + 28px);
  font-size: var(--fs-sm);
  cursor: default;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.search-match:hover {
  background: var(--bg-hover);
}
.search-match:active {
  background: var(--bg-active);
  transform: translateY(0.5px);
}
.match-line {
  flex-shrink: 0;
  min-width: 28px;
  text-align: right;
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  font-family: var(--font-mono, monospace);
}
.match-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
}
.hint {
  padding: var(--sp-3);
}
</style>
