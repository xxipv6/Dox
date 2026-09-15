<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { FileEntry } from '@shared/types'
import { errorText } from '../utils/errors'
import { vFocus } from '../directives/focus'
import Icon from './Icon.vue'
import FileIcon from './FileIcon.vue'
import Spinner from './Spinner.vue'

/**
 * 项目模式的树形视图（VS Code explorer 语义）：
 *   - 根 = 用户选定的项目文件夹（不进树当行，顶栏已经展示了）；
 *   - 目录懒加载：展开才请求，折叠不丢缓存（再展开零往返）；
 *   - 选中即时（不等数据）、spinner 延迟出现（快的时候不闪）；
 *   - 键盘：↑↓ 走可见行、→ 展开/进首子、← 折叠/跳父、Enter 打开。
 *
 * 文件操作（删除/重命名/打包/粘贴…）一律不在本组件：菜单与 IPC 归 FileExplorer，
 * 这里只抛意图事件 + 暴露 refresh/reveal 等命令式方法。
 */

const props = defineProps<{
  /** 项目根绝对路径（远端 posix / 本机原生形态） */
  root: string
  /** 实际的文件操作会话（FileExplorer 已换算好容器父会话） */
  fsSessionId: string
  /** 容器目标名（透传 sftpList 第三参） */
  containerName?: string
  /** 路径分隔策略（本机 Windows） */
  isWin: boolean
}>()

const emit = defineEmits<{
  select: [entry: FileEntry | null]
  previewFile: [entry: FileEntry]
  openFile: [entry: FileEntry]
  rowContextmenu: [payload: { entry: FileEntry; x: number; y: number }]
  blankContextmenu: [payload: { x: number; y: number }]
  renameSubmit: [payload: { entry: FileEntry; name: string }]
  createSubmit: [payload: { dir: string; name: string }]
}>()

// 每级缩进与参考线位置（命名常量：样式与脚本同一出处）
const INDENT_PX = 12
const ROW_PAD_PX = 6
const GUIDE_OFFSET_PX = ROW_PAD_PX + 5 // 对齐 chevron 中心
/** spinner 延迟出现：快的时候根本不闪（HIG 守卫只扫带单位字面量，命名常量豁免） */
const SPINNER_DELAY_MS = 150

// ---- 树状态（全部扁平 Map/Set：缓存、展开、加载、失败）----
/** 目录 → 子级。有 key = 已加载；折叠不删（再展开零往返） */
const childrenOf = reactive(new Map<string, FileEntry[]>())
const expanded = reactive(new Set<string>())
const loading = reactive(new Set<string>())
/** loading 超过 SPINNER_DELAY_MS 才进这个集合（行上才画 spinner） */
const slowLoading = reactive(new Set<string>())
/** 加载失败的目录 → 错误文案（行尾给「失败，重试」） */
const failed = reactive(new Map<string, string>())
const selectedPath = ref<string | null>(null)
/** 按路径的代际号：同一目录连点只认最后一次；不同目录的展开互相独立 */
const fetchSeq = new Map<string, number>()
let disposed = false

// ---- 内联编辑（重命名 / 新建文件夹；执行归 FileExplorer，这里只管输入框）----
const editingPath = ref<string | null>(null)
const editValue = ref('')
const creatingInDir = ref<string | null>(null)
const createValue = ref('')

const rootEntry = computed<FileEntry>(() => ({
  name: props.root.split(/[\\/]/).filter(Boolean).pop() ?? props.root,
  path: props.root,
  isDir: true,
  isSymlink: false,
  size: 0,
  mtime: 0
}))

// ---- 路径工具（posix / 本机 Windows 两种形态）----
function parentDirOf(p: string): string {
  const m = /^(.*)[\\/][^\\/]+$/.exec(p)
  if (!m) return p
  const parent = m[1]
  if (parent === '') return props.isWin ? p : '/'
  // 盘符边界：C:\foo 的父是 C:\，不是 C:
  if (props.isWin && /^[A-Za-z]:$/.test(parent)) return `${parent}\\`
  return parent
}

function isUnderRoot(p: string): boolean {
  if (p === props.root) return true
  const sep = props.isWin ? '\\' : '/'
  const prefix = props.root.endsWith(sep) ? props.root : props.root + sep
  return p.startsWith(prefix)
}

function findEntry(path: string): FileEntry | null {
  if (path === props.root) return rootEntry.value
  for (const kids of childrenOf.values()) {
    const hit = kids.find((k) => k.path === path)
    if (hit) return hit
  }
  return null
}

// ---- 可见行（渲染与键盘导航共用这一份扁平模型；v-for 按 path 作 key）----
type VisibleRow =
  | { kind: 'entry'; entry: FileEntry; depth: number }
  | { kind: 'create'; dir: string; depth: number }

const visibleRows = computed<VisibleRow[]>(() => {
  const out: VisibleRow[] = []
  const walk = (entry: FileEntry, depth: number): void => {
    out.push({ kind: 'entry', entry, depth })
    if (entry.isDir && expanded.has(entry.path)) {
      if (creatingInDir.value === entry.path) {
        out.push({ kind: 'create', dir: entry.path, depth: depth + 1 })
      }
      const kids = childrenOf.get(entry.path)
      if (kids) for (const k of kids) walk(k, depth + 1)
    }
  }
  // 根不进树当行（顶栏已展示），其子级恒显
  if (creatingInDir.value === props.root) out.push({ kind: 'create', dir: props.root, depth: 0 })
  const rootKids = childrenOf.get(props.root)
  if (rootKids) for (const k of rootKids) walk(k, 0)
  return out
})

/** 键盘导航只走真实条目（新建输入行不参与） */
const navRows = computed(() =>
  visibleRows.value.filter((r): r is Extract<VisibleRow, { kind: 'entry' }> => r.kind === 'entry')
)

const rootError = computed(() => failed.get(props.root) ?? '')

// ---- 懒加载 ----
async function fetchChildren(path: string): Promise<void> {
  const seq = (fetchSeq.get(path) ?? 0) + 1
  fetchSeq.set(path, seq)
  loading.add(path)
  const timer = window.setTimeout(() => {
    if (loading.has(path)) slowLoading.add(path)
  }, SPINNER_DELAY_MS)
  try {
    const kids = await window.api.sftpList(props.fsSessionId, path, props.containerName)
    if (disposed || fetchSeq.get(path) !== seq) return
    childrenOf.set(path, kids)
    failed.delete(path)
  } catch (err) {
    if (disposed || fetchSeq.get(path) !== seq) return
    failed.set(path, errorText(err))
    // 收回乐观展开 —— 否则留下一个「展开了但永远是空」的目录；再点行即重试
    expanded.delete(path)
  } finally {
    window.clearTimeout(timer)
    // 只清自己这一代的标记：同路径有更新的请求在飞时，别清它的
    if (fetchSeq.get(path) === seq) {
      loading.delete(path)
      slowLoading.delete(path)
    }
  }
}

async function toggleDir(entry: FileEntry): Promise<void> {
  if (expanded.has(entry.path)) {
    expanded.delete(entry.path)
    return
  }
  // 乐观展开：chevron 立即转，数据后到
  expanded.add(entry.path)
  if (!childrenOf.has(entry.path)) await fetchChildren(entry.path)
}

// ---- 选中与打开 ----
function select(entry: FileEntry | null): void {
  selectedPath.value = entry?.path ?? null
  emit('select', entry)
}

/**
 * 单击行：选中；目录同时切换展开（VS Code 语义）；文件预览打开。
 * 预览放这里而不放 select()：键盘导航也调 select()，那不该开编辑器。
 */
function onRowActivate(entry: FileEntry): void {
  select(entry)
  if (entry.isDir) void toggleDir(entry)
  else emit('previewFile', entry)
}

/** chevron：只切展开（也选中，与 VS Code 一致） */
function onChevronClick(entry: FileEntry): void {
  select(entry)
  void toggleDir(entry)
}

function retryDir(entry: FileEntry): void {
  expanded.add(entry.path)
  void fetchChildren(entry.path)
}

const treeEl = ref<HTMLElement>()
function scrollRowIntoView(path: string): void {
  treeEl.value
    ?.querySelector(`[data-path="${CSS.escape(path)}"]`)
    ?.scrollIntoView({ block: 'nearest' })
}

// ---- 键盘 ----
function selectNavRow(index: number): void {
  const row = navRows.value[index]
  if (!row) return
  select(row.entry)
  scrollRowIntoView(row.entry.path)
}

function onKeydown(e: KeyboardEvent): void {
  // 内联输入框里的按键归输入框自己
  if ((e.target as HTMLElement).tagName === 'INPUT') return
  const rows = navRows.value
  if (!rows.length) return
  const idx = rows.findIndex((r) => r.entry.path === selectedPath.value)
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectNavRow(Math.min(idx + 1, rows.length - 1))
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectNavRow(Math.max(idx < 0 ? 0 : idx - 1, 0))
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    const row = rows[idx]
    if (!row || !row.entry.isDir) return
    if (!expanded.has(row.entry.path)) void toggleDir(row.entry)
    else selectNavRow(idx + 1)
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    const row = rows[idx]
    if (!row) return
    if (row.entry.isDir && expanded.has(row.entry.path)) {
      expanded.delete(row.entry.path)
      return
    }
    for (let i = idx - 1; i >= 0; i--) {
      const candidate = rows[i]
      if (candidate.depth < row.depth) {
        selectNavRow(i)
        break
      }
    }
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const row = rows[idx]
    if (!row) return
    if (row.entry.isDir) void toggleDir(row.entry)
    else emit('openFile', row.entry)
  }
}

// ---- 内联编辑 ----
function beginRename(path: string): void {
  const entry = findEntry(path)
  if (!entry) return
  creatingInDir.value = null
  editingPath.value = path
  editValue.value = entry.name
}

async function beginCreate(dir: string): Promise<void> {
  editingPath.value = null
  if (dir !== props.root && !expanded.has(dir)) {
    expanded.add(dir)
    if (!childrenOf.has(dir)) await fetchChildren(dir)
  }
  creatingInDir.value = dir
  createValue.value = ''
}

function submitRename(entry: FileEntry): void {
  const name = editValue.value.trim()
  editingPath.value = null
  if (name && name !== entry.name) emit('renameSubmit', { entry, name })
}

function submitCreate(): void {
  const dir = creatingInDir.value
  const name = createValue.value.trim()
  creatingInDir.value = null
  if (dir && name) emit('createSubmit', { dir, name })
}

// ---- 菜单（构造归 FileExplorer，这里只报坐标与对象）----
function onRowMenu(e: MouseEvent, entry: FileEntry): void {
  emit('rowContextmenu', { entry, x: e.clientX, y: e.clientY })
}

function onBlankMenu(e: MouseEvent): void {
  emit('blankContextmenu', { x: e.clientX, y: e.clientY })
}

// ---- 对外命令（FileExplorer 经 ref 调用）----
/** 重列一个目录（操作后局部刷新）；没加载过的目录不在视野里，不用刷 */
async function refreshDir(path: string): Promise<void> {
  if (path !== props.root && !childrenOf.has(path)) return
  await fetchChildren(path)
}

/** 工具栏「刷新」：根 + 所有已展开目录并行重列，展开状态不动 */
async function refreshAll(): Promise<void> {
  const dirs = [props.root, ...[...expanded].filter((p) => childrenOf.has(p))]
  await Promise.allSettled(dirs.map((d) => fetchChildren(d)))
}

/** 当前选中目录（选中文件 = 其父目录；无选中 = 根）：粘贴/上传/拖拽的落点 */
function selectedDirOrRoot(): string {
  const p = selectedPath.value
  if (!p) return props.root
  const entry = findEntry(p)
  if (!entry) return props.root
  return entry.isDir ? entry.path : parentDirOf(entry.path)
}

/*
 * reveal：把 path 在树里展开定位（跟随终端 cd）。
 * 根外不跳 —— 待在项目里是「项目模式」的存在意义。
 */
let rootReady = false
let pendingReveal: string | null = null

async function reveal(path: string): Promise<void> {
  if (!isUnderRoot(path)) return
  // 持久化恢复的竞态：follow watch 可能比根的首次加载先触发，存下来补
  if (!rootReady) {
    pendingReveal = path
    return
  }
  // 从根到 path 父目录的整条链，父先于子逐层确保展开 + 已加载
  const chain: string[] = []
  let cur = path
  while (cur !== props.root) {
    const parent = parentDirOf(cur)
    if (parent === cur) break
    chain.unshift(parent)
    cur = parent
  }
  for (const dir of chain) {
    if (dir === props.root) continue
    if (!expanded.has(dir)) expanded.add(dir)
    if (!childrenOf.has(dir)) await fetchChildren(dir)
  }
  const visible = navRows.value.some((r) => r.entry.path === path)
  const target = visible ? path : parentDirOf(path)
  const entry = findEntry(target)
  if (entry) select(entry)
  await nextTick()
  scrollRowIntoView(target)
}

defineExpose({ refreshDir, refreshAll, reveal, selectedDirOrRoot, beginRename, beginCreate })

// ---- 生命周期 ----
function resetTree(): void {
  childrenOf.clear()
  expanded.clear()
  loading.clear()
  slowLoading.clear()
  failed.clear()
  fetchSeq.clear()
  selectedPath.value = null
  editingPath.value = null
  creatingInDir.value = null
  rootReady = false
  pendingReveal = null
}

async function initRoot(): Promise<void> {
  await fetchChildren(props.root)
  rootReady = true
  if (pendingReveal) {
    const p = pendingReveal
    pendingReveal = null
    void reveal(p)
  }
}

// 换根（菜单「以此文件夹为项目根」）：整棵树重来
watch(
  () => props.root,
  () => {
    resetTree()
    void initRoot()
  }
)

onMounted(() => {
  void initRoot()
})

onBeforeUnmount(() => {
  disposed = true
})
</script>

<template>
  <div ref="treeEl" class="tree" tabindex="0" @keydown="onKeydown">
    <!-- 根目录本身进不去（被删/掉线/没权限）：给错误与重试，退出按钮在顶栏 -->
    <div v-if="rootError" class="hint">
      无法打开项目根目录：{{ rootError }}
      <button class="retry" @click="initRoot">重试</button>
    </div>

    <!--
      展开收起零动画（VS Code 同款瞬时）：试过 TransitionGroup 的进退场 + FLIP，
      大目录上每次切换都要对全部行做 getBoundingClientRect（强制同步布局），
      外加成百行同时跑 transform 补间 —— 树一大就「卡一下」。树视图要的是即点即变。
    -->
    <div v-else class="tree-rows" @click.self="select(null)" @contextmenu.self.prevent="onBlankMenu">
      <div
        v-for="row in visibleRows"
        :key="row.kind === 'entry' ? row.entry.path : `new:${row.dir}`"
        class="tree-row"
        :class="{ selected: row.kind === 'entry' && row.entry.path === selectedPath }"
        :style="{ paddingLeft: `${row.depth * INDENT_PX + ROW_PAD_PX}px` }"
        :data-path="row.kind === 'entry' ? row.entry.path : undefined"
        @click="row.kind === 'entry' ? onRowActivate(row.entry) : undefined"
        @dblclick="row.kind === 'entry' && !row.entry.isDir ? emit('openFile', row.entry) : undefined"
        @contextmenu.prevent="row.kind === 'entry' ? onRowMenu($event, row.entry) : undefined"
      >
        <!-- 缩进参考线（VS Code 层次感的来源之一）：每级一条，对齐 chevron 中心 -->
        <span
          v-for="g in row.depth"
          :key="g"
          class="guide"
          :style="{ left: `${(g - 1) * INDENT_PX + GUIDE_OFFSET_PX}px` }"
        ></span>

        <template v-if="row.kind === 'entry'">
          <span
            v-if="row.entry.isDir"
            class="tree-chevron"
            :class="{ expanded: expanded.has(row.entry.path) }"
            @click.stop="onChevronClick(row.entry)"
          >
            <Spinner v-if="slowLoading.has(row.entry.path)" :size="11" />
            <Icon v-else name="chevron-right" :size="11" />
          </span>
          <span v-else class="tree-chevron"></span>
          <FileIcon :entry="row.entry" :size="15" />
          <input
            v-if="editingPath === row.entry.path"
            v-model="editValue"
            v-focus
            class="rename-input"
            @keyup.enter="submitRename(row.entry)"
            @keyup.esc="editingPath = null"
            @blur="submitRename(row.entry)"
            @click.stop
          />
          <span v-else class="file-name" :title="row.entry.path">{{ row.entry.name }}</span>
          <span
            v-if="failed.has(row.entry.path)"
            class="tree-error"
            :title="failed.get(row.entry.path)"
            @click.stop="retryDir(row.entry)"
          >失败，重试</span>
        </template>

        <template v-else>
          <span class="tree-chevron"></span>
          <Icon class="file-icon dir" name="folder" :size="15" />
          <input
            v-model="createValue"
            v-focus
            class="rename-input"
            placeholder="文件夹名"
            @keyup.enter="submitCreate"
            @keyup.esc="creatingInDir = null"
            @blur="submitCreate"
            @click.stop
          />
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tree {
  flex: 1;
  /* 同 SearchPanel：nowrap 的长文件名会顶大 flex 项的自动最小宽度 */
  min-width: 0;
  overflow-y: auto;
  user-select: none;
}
/* 键盘焦点环不外显：选中态本身可见，焦点只是快捷键的载体 */
.tree:focus {
  outline: none;
}
.tree-rows {
  min-height: 100%;
  padding: var(--sp-1) 0;
}
.tree-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2) var(--sp-1) 0;
  font-size: var(--fs-md);
  cursor: default;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.tree-row:hover {
  background: var(--bg-hover);
}
/* 按下：全局同一套（深一档 + 半像素下沉） */
.tree-row:active {
  background: var(--bg-active);
  transform: translateY(0.5px);
}
/* 选中：块状高亮 + 左侧竖条，与 browse 列表同一读法 */
.tree-row.selected {
  background: var(--bg-active);
  transition: background-color var(--dur-base) var(--ease-out);
}
.tree-row.selected::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 3px;
  bottom: 3px;
  width: 2px;
  border-radius: 1px;
  background: var(--accent-text);
}
.guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border);
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
.file-icon.dir {
  color: var(--accent-text);
}
.file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rename-input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-md);
  padding: 1px var(--sp-1);
  border: 1px solid var(--accent);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--fg);
}
.tree-error {
  flex-shrink: 0;
  font-size: var(--fs-xs);
  color: var(--danger-text);
  cursor: pointer;
}
.retry {
  margin-left: var(--sp-2);
}
</style>
