<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DroppedFile, FileEntry, TransferTask } from '@shared/types'
import { formatSize, formatTime } from '../utils/format'
import { useSessionStore } from '../stores/sessions'
import { useEditorStore } from '../stores/editor'
import { errorText } from '../utils/errors'
import Icon from './Icon.vue'
import ContextMenu, { type ContextMenuItem } from './ContextMenu.vue'

const props = defineProps<{ sessionId: string }>()
const store = useSessionStore()
const editor = useEditorStore()

const cwd = ref('')
const entries = ref<FileEntry[]>([])
const loading = ref(false)
const errorMsg = ref('')
const dragOver = ref(false)

// 内联新建文件夹 / 重命名
const creatingDir = ref(false)
const newDirName = ref('')
const renamingPath = ref<string | null>(null)
const renameValue = ref('')

// ---- 选中（对齐本地文件管理器的操作习惯）----
/** 已选中的条目路径。用 Set 而不是单个值，Ctrl 多选才有地方放 */
const selected = ref<Set<string>>(new Set())
/** Shift 连选的锚点（entries 里的下标） */
const anchorIndex = ref<number | null>(null)

const isSelected = (entry: FileEntry): boolean => selected.value.has(entry.path)

/**
 * 单击选中。和资源管理器一致：
 *   普通点击 → 只选中它
 *   Ctrl/Cmd  → 切换这一项，其余不动
 *   Shift     → 从锚点连选到这一项
 * 双击仍然是打开（浏览器会先发两次 click 再发 dblclick，顺序天然正确）。
 */
function onRowClick(e: MouseEvent, entry: FileEntry, index: number): void {
  const next = new Set(selected.value)
  if (e.shiftKey && anchorIndex.value !== null) {
    const [from, to] = [anchorIndex.value, index].sort((a, b) => a - b)
    for (let i = from; i <= to; i++) {
      const item = entries.value[i]
      if (item) next.add(item.path)
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (next.has(entry.path)) next.delete(entry.path)
    else next.add(entry.path)
    anchorIndex.value = index
  } else {
    next.clear()
    next.add(entry.path)
    anchorIndex.value = index
  }
  selected.value = next
}

const clearSelection = (): void => {
  selected.value = new Set()
  anchorIndex.value = null
}

/**
 * 面包屑的各级目录。
 *
 * 这里**不再**塞一个 name 为 '/' 的根节点：模板会为每级的下一项补一个
 * '/' 分隔符，根节点占着第 0 位却自己渲染成 '/'，于是 /root 显示成 / / root。
 * 根由模板单独渲染一次。
 */
const breadcrumbs = computed(() => {
  const parts = cwd.value.split('/').filter(Boolean)
  return parts.map((name, i) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }))
})

async function load(dir?: string): Promise<void> {
  loading.value = true
  errorMsg.value = ''
  // 换目录后旧路径已经没意义，留着会选中一个看不见的东西
  clearSelection()
  try {
    if (dir) cwd.value = dir
    entries.value = await window.api.sftpList(props.sessionId, cwd.value)
    // 与终端的 cwd 跟踪保持同步（作为下次 cd 相对路径的基准）
    store.setCwd(props.sessionId, cwd.value)
  } catch (err) {
    errorMsg.value = errorText(err)
  } finally {
    loading.value = false
  }
}

async function init(): Promise<void> {
  try {
    // 以远端 home 目录为起点
    const home = await window.api.sftpRealpath(props.sessionId, '.')
    await load(home)
  } catch {
    await load('/')
  }
}

function goUp(): void {
  const parts = cwd.value.split('/').filter(Boolean)
  parts.pop()
  void load('/' + parts.join('/') || '/')
}

function openEntry(entry: FileEntry): void {
  // 目录进目录；文件交给内置编辑器（二进制/超限由主编解读取时判定并报错）
  if (entry.isDir) void load(entry.path)
  else void editor.open(props.sessionId, entry.path)
}

// ---- 新建文件夹 ----
async function submitNewDir(): Promise<void> {
  const name = newDirName.value.trim()
  if (name) {
    try {
      await window.api.sftpMkdir(props.sessionId, `${cwd.value}/${name}`)
      await load()
    } catch (err) {
      alert(`新建文件夹失败：${errorText(err)}`)
    }
  }
  creatingDir.value = false
  newDirName.value = ''
}

// ---- 重命名 ----
function startRename(entry: FileEntry): void {
  renamingPath.value = entry.path
  renameValue.value = entry.name
}

async function submitRename(entry: FileEntry): Promise<void> {
  const name = renameValue.value.trim()
  if (name && name !== entry.name) {
    try {
      await window.api.sftpRename(props.sessionId, entry.path, `${cwd.value}/${name}`)
      await load()
    } catch (err) {
      alert(`重命名失败：${errorText(err)}`)
    }
  }
  renamingPath.value = null
}

// ---- 删除 / 下载 / 上传 ----
async function removeEntry(entry: FileEntry): Promise<void> {
  const hint = entry.isDir ? `目录 ${entry.name} 及其全部内容（递归删除，不可恢复）` : `文件 ${entry.name}`
  if (!confirm(`确认删除${hint}？`)) return
  try {
    await window.api.sftpDelete(props.sessionId, entry.path, entry.isDir)
    await load()
  } catch (err) {
    alert(`删除失败：${errorText(err)}`)
  }
}

/** 统一收口：之前这些调用是 fire-and-forget，出错时界面上完全没反应 */
async function guard(action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
    errorMsg.value = ''
  } catch (err) {
    errorMsg.value = errorText(err)
  }
}

async function downloadEntry(entry: FileEntry): Promise<void> {
  await guard(() =>
    entry.isDir
      ? window.api.downloadDir(props.sessionId, entry.path)
      : window.api.download(props.sessionId, entry.path, entry.name)
  )
}

async function pickUpload(): Promise<void> {
  await guard(() => window.api.pickUpload(props.sessionId, cwd.value))
}

// ---- 右键菜单 ----
const menu = ref<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
/** 菜单是对哪几项开的。动作要用这一刻的选区，不能等点了再读（那时选区可能已变） */
let menuTargets: FileEntry[] = []
const closeMenu = (): void => {
  menu.value = null
}

/**
 * 右键行。
 *
 * 选区规则跟资源管理器一致：点在已选中的行上 → 保持整片选区（这样
 * 「Ctrl 多选之后右键下载」才成立）；点在选区外 → 先把这一行单独选上。
 */
function onRowContextMenu(e: MouseEvent, entry: FileEntry, index: number): void {
  if (!isSelected(entry)) {
    selected.value = new Set([entry.path])
    anchorIndex.value = index
  }
  const targets = entries.value.filter((en) => selected.value.has(en.path))
  menuTargets = targets
  const many = targets.length > 1
  menu.value = {
    x: e.clientX,
    y: e.clientY,
    items: [
      {
        id: 'download',
        label: many ? `下载这 ${targets.length} 项` : '下载',
        icon: 'download'
      },
      // 重命名只能对一项，多选时给个禁用项比整条去掉更好读
      { id: 'rename', label: '重命名', icon: 'pencil', disabled: many },
      {
        id: 'delete',
        label: many ? `删除这 ${targets.length} 项` : '删除',
        icon: 'trash',
        danger: true
      }
    ]
  }
}

async function onMenuSelect(id: string): Promise<void> {
  const targets = menuTargets
  closeMenu()
  if (!targets.length) return
  if (id === 'download') await downloadTargets(targets)
  else if (id === 'rename') startRename(targets[0])
  else if (id === 'delete') await removeTargets(targets)
}

async function downloadTargets(targets: FileEntry[]): Promise<void> {
  // 只有一项时沿用原来的路径：单文件弹保存框（能顺手改名），单目录弹目录框
  if (targets.length === 1) {
    await downloadEntry(targets[0])
    return
  }
  await guard(() =>
    window.api.downloadMany(
      props.sessionId,
      targets.map((t) => ({ remotePath: t.path, name: t.name, isDir: t.isDir }))
    )
  )
}

async function removeTargets(targets: FileEntry[]): Promise<void> {
  if (targets.length === 1) {
    await removeEntry(targets[0])
    return
  }
  const dirs = targets.filter((t) => t.isDir).length
  const hint = dirs ? `，其中 ${dirs} 个是目录（连同内容递归删除）` : ''
  if (!confirm(`确认删除选中的 ${targets.length} 项？${hint}。不可恢复。`)) return
  try {
    // 逐项删：一项失败不该把剩下的都吞掉，删成的那些也要如实反映出来
    for (const t of targets) {
      await window.api.sftpDelete(props.sessionId, t.path, t.isDir)
    }
  } catch (err) {
    alert(`删除过程中出错：${errorText(err)}`)
  } finally {
    clearSelection()
    await load()
  }
}

/** 在终端中 cd 到当前目录（SFTP → 终端方向联动） */
function openInTerminal(): void {
  const quoted = `'${cwd.value.replace(/'/g, `'\\''`)}'`
  window.api.input(props.sessionId, `cd ${quoted}\r`)
}

// ---- 拖拽上传 ----
function onDrop(e: DragEvent): void {
  dragOver.value = false
  const files: DroppedFile[] = [...(e.dataTransfer?.files ?? [])].map((f) => ({
    path: window.api.getPathForFile(f),
    name: f.name,
    size: f.size
  }))
  // 会话已断/远端不可写时不能静默失败，否则用户以为拖进去了
  if (files.length) void guard(() => window.api.enqueueDropped(props.sessionId, cwd.value, files))
}

// ---- 上传完成后自动刷新 ----
/*
 * 上传结束列表不会自己变，用户得手动点刷新才看得到刚传上去的东西。
 * 传一整个目录时尤其别扭：进度条都收干净了，眼前还是原来的样子。
 *
 * 三条约束：
 *   只认上传 —— 下载改的是本地，远端目录纹丝不动，跟着刷是白跑一趟；
 *   防抖 —— 传一个目录会展开成成百上千条任务，逐条刷新等于把 SFTP
 *     服务器打爆，列表也会疯狂闪；
 *   正在输入时不刷 —— 新建文件夹 / 重命名的输入框会被 load() 冲掉。
 */
const REFRESH_DEBOUNCE_MS = 600
let refreshTimer: number | null = null
/** 上一次看到的每条任务状态，用来认出「刚刚变成完成」的那一条 */
let lastStatus = new Map<string, TransferTask['status']>()
let unsubscribeTransfers: (() => void) | null = null

/** 落地路径是否在当前目录（含子目录）里 —— 别处的上传没必要刷这一屏 */
function isUnderCwd(remotePath: string): boolean {
  const base = cwd.value.endsWith('/') ? cwd.value : `${cwd.value}/`
  return remotePath.startsWith(base)
}

function scheduleRefresh(): void {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    if (creatingDir.value || renamingPath.value) return
    void load()
  }, REFRESH_DEBOUNCE_MS)
}

function watchTransfers(): void {
  unsubscribeTransfers = window.api.onTransferUpdate((tasks) => {
    const next = new Map<string, TransferTask['status']>()
    let touched = false
    for (const t of tasks) {
      next.set(t.id, t.status)
      const was = lastStatus.get(t.id)
      // was === undefined 是挂载后的第一份快照：里面已经是完成的那些不算数，
      // 否则一打开面板就会为一个早就传完的文件白刷一次
      if (
        was !== undefined &&
        was !== 'done' &&
        t.status === 'done' &&
        t.direction === 'upload' &&
        isUnderCwd(t.remotePath)
      ) {
        touched = true
      }
    }
    lastStatus = next
    if (touched) scheduleRefresh()
  })
}

// 会话切换时重新加载
watch(() => props.sessionId, init)

// 跟随终端 cd（终端 → SFTP 方向联动）
watch(
  () => (store.followTerminal ? store.cwdBySession[props.sessionId] : undefined),
  (dir) => {
    if (dir && dir !== cwd.value) void load(dir)
  }
)

onMounted(() => {
  watchTransfers()
  void init()
})
onBeforeUnmount(() => {
  unsubscribeTransfers?.()
  if (refreshTimer !== null) window.clearTimeout(refreshTimer)
  entries.value = []
})
</script>

<template>
  <div
    class="explorer"
    :class="{ 'drag-over': dragOver }"
    @dragover.prevent="dragOver = true"
    @dragleave.prevent="dragOver = false"
    @drop.prevent="onDrop"
  >
    <!-- 工具栏 -->
    <div class="toolbar">
      <button class="icon-btn" title="上一级" @click="goUp"><Icon name="arrow-up" /></button>
      <button class="icon-btn" title="刷新" @click="load()"><Icon name="refresh" /></button>
      <button class="icon-btn" title="新建文件夹" @click="creatingDir = true">
        <Icon name="folder-plus" />
      </button>
      <button class="icon-btn" title="上传文件" @click="pickUpload"><Icon name="upload" /></button>
      <span class="spacer"></span>
      <button class="icon-btn" title="在终端中打开此目录" @click="openInTerminal">
        <Icon name="terminal" />
      </button>
      <button
        class="icon-btn"
        :class="{ active: store.followTerminal }"
        :title="store.followTerminal ? '跟随终端：开（cd 时面板自动跳转）' : '跟随终端：关'"
        @click="store.toggleFollowTerminal()"
      ><Icon name="follow" /></button>
    </div>

    <!-- 面包屑：根单独渲染一次，其余每级前面补分隔符 -->
    <div class="breadcrumb">
      <a class="crumb" title="/" @click="load('/')">/</a>
      <template v-for="(crumb, i) in breadcrumbs" :key="crumb.path">
        <span v-if="i > 0" class="sep">/</span>
        <a class="crumb" @click="load(crumb.path)">{{ crumb.name }}</a>
      </template>
    </div>

    <div v-if="errorMsg" class="error-banner">{{ errorMsg }}</div>
    <div v-if="loading" class="hint">加载中…</div>

    <!-- 文件列表；点空白处取消选中（和资源管理器一致） -->
    <div
      v-else
      class="file-list"
      @click.self="clearSelection"
      @contextmenu.self.prevent="clearSelection"
    >
      <div v-if="creatingDir" class="row editing">
        <Icon class="file-icon" name="folder" :size="15" />
        <input
          v-model="newDirName"
          class="rename-input"
          placeholder="文件夹名"
          autofocus
          @keyup.enter="submitNewDir"
          @keyup.esc="creatingDir = false"
          @blur="submitNewDir"
        />
      </div>

      <div
        v-for="(entry, index) in entries"
        :key="entry.path"
        class="row"
        :class="{ selected: isSelected(entry) }"
        @click="onRowClick($event, entry, index)"
        @contextmenu.prevent="onRowContextMenu($event, entry, index)"
        @dblclick="openEntry(entry)"
      >
        <Icon
          class="file-icon"
          :class="{ dir: entry.isDir }"
          :name="entry.isDir ? 'folder' : entry.isSymlink ? 'link' : 'file'"
          :size="15"
        />
        <input
          v-if="renamingPath === entry.path"
          v-model="renameValue"
          class="rename-input"
          autofocus
          @keyup.enter="submitRename(entry)"
          @keyup.esc="renamingPath = null"
          @blur="submitRename(entry)"
        />
        <span v-else class="file-name" :title="entry.path">{{ entry.name }}</span>
        <span class="file-size">{{ entry.isDir ? '' : formatSize(entry.size) }}</span>
        <span class="file-time">{{ formatTime(entry.mtime) }}</span>
        <span class="row-actions">
          <button
            class="icon-btn"
            :title="entry.isDir ? '下载文件夹（递归）' : '下载'"
            @click.stop="downloadEntry(entry)"
          ><Icon name="download" /></button>
          <button class="icon-btn" title="重命名" @click.stop="startRename(entry)">
            <Icon name="pencil" />
          </button>
          <button class="icon-btn danger" title="删除" @click.stop="removeEntry(entry)">
            <Icon name="trash" />
          </button>
        </span>
      </div>

      <div v-if="!entries.length && !creatingDir" class="hint">空目录，拖拽文件到此处上传</div>
    </div>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menu.items"
      @select="onMenuSelect"
      @close="closeMenu"
    />
  </div>
</template>

<style scoped>
.explorer {
  width: 360px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: var(--bg-panel);
}
.explorer.drag-over {
  outline: 2px dashed var(--focus-ring);
  outline-offset: -4px;
}
.toolbar {
  display: flex;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.breadcrumb {
  padding: 6px 10px;
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  overflow-x: auto;
  white-space: nowrap;
  border-bottom: 1px solid var(--border);
}
.crumb {
  color: var(--accent-text);
  cursor: pointer;
}
.sep {
  margin: 0 2px;
}
.file-list {
  flex: 1;
  overflow-y: auto;
  user-select: none;
}
.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  /* 左侧留出选中条的宽度，选中时内容不会整体右移 */
  padding: 4px 10px 4px 12px;
  font-size: var(--fs-md);
  cursor: default;
  border-radius: var(--r-xs);
  transition: background-color var(--dur-fast) var(--ease-out);
}
.row:hover {
  background: var(--bg-hover);
}
/* 选中：块状高亮 + 左侧竖条，跟本地文件管理器一个读法 */
.row.selected {
  background: var(--bg-active);
  transition: background-color var(--dur-base) var(--ease-out);
}
.row.selected:hover {
  background: var(--bg-hover);
}
.row.selected::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 3px;
  bottom: 3px;
  width: 2px;
  border-radius: 1px;
  background: var(--accent-text);
}
/* 按下时轻微回弹，给「点到了」一个触感 */
.row:active {
  transform: scale(0.995);
}
.file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-size {
  width: 64px;
  text-align: right;
  color: var(--fg-muted);
  font-size: var(--fs-sm);
  flex-shrink: 0;
}
.file-time {
  width: 108px;
  color: var(--fg-muted);
  font-size: var(--fs-sm);
  flex-shrink: 0;
}
/*
 * 悬浮在行尾，不参与布局。
 *
 * 原来写的是 visibility: hidden —— 它只是不画出来，**照样占着宽度**，
 * 于是三个按钮在每一行都白占 ~80px，把 360px 面板里的文件名挤到只剩
 * 7 个字符（.vscode… 出现两次时根本分不出谁是谁）。改成绝对定位后
 * 文件名拿回全部宽度，按钮只在悬停时盖住名字末尾。
 */
.row-actions {
  display: none;
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  padding-left: 10px;
  background: var(--bg-hover);
  box-shadow: -10px 0 10px var(--bg-hover);
}
.row:hover .row-actions {
  display: flex;
}
.rename-input {
  flex: 1;
  background: var(--bg-hover);
  border: 1px solid var(--focus-ring);
  border-radius: var(--r-xs);
  color: var(--fg);
  padding: 2px 6px;
  font-size: var(--fs-md);
  outline: none;
}
.file-icon {
  color: var(--fg-muted);
}
.file-icon.dir {
  color: var(--accent-text);
}
.spacer {
  flex: 1;
}
.error-banner {
  padding: 8px 10px;
  color: var(--danger-text);
  font-size: var(--fs-sm);
  border-bottom: 1px solid var(--border);
}
.hint {
  padding: 16px;
  color: var(--fg-muted);
  font-size: var(--fs-sm);
  text-align: center;
}
</style>
