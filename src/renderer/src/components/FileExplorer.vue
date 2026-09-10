<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DroppedFile, FileEntry } from '@shared/types'
import { formatSize, formatTime } from '../utils/format'
import { useSessionStore } from '../stores/sessions'
import { useEditorStore } from '../stores/editor'
import { errorText } from '../utils/errors'
import Icon from './Icon.vue'

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

/** 在终端中 cd 到当前目录（SFTP → 终端方向联动） */
function openInTerminal(): void {
  const quoted = `'${cwd.value.replace(/'/g, `'\\''`)}'`
  window.api.input(props.sessionId, `cd ${quoted}\r`)
}

// ---- 拖出到资源管理器 ----
/** 正在把哪个文件拉到本地（拖出必须先下载完才能交给系统拖动） */
const dragPreparing = ref<string | null>(null)

/**
 * 拖出行 → 交给主进程发起原生拖拽。
 *
 * 这里必须 preventDefault：不掐掉 HTML5 默认拖拽的话，渲染进程会同时启动
 * 一个「拖着一团网页内容」的拖拽，和主进程发起的原生文件拖拽打架。
 * 真正的拖拽由主进程 `webContents.startDrag` 发起 —— 只有它能给操作系统
 * 一个真实文件路径，而远端路径必须先下载到本地。
 *
 * 下载期间界面上只能等着，所以这里给一条明确的进行中提示，
 * 否则用户看到的就是「拖了一下什么都没发生」。
 */
async function onDragStart(e: DragEvent, entry: FileEntry): Promise<void> {
  e.preventDefault()

  errorMsg.value = ''
  dragPreparing.value = entry.name
  try {
    // 文件和目录都交给主进程：目录会先递归拉到本地临时目录再交给系统拖动，
    // 大小/文件数超限由主进程抛错（见 SftpService.prepareDragOut）
    await window.api.sftpStartDrag(props.sessionId, entry.path, entry.name)
  } catch (err) {
    // 用户自己点的取消不是错误，别把它当失败弹在界面上
    const text = errorText(err)
    if (!text.includes('已取消')) errorMsg.value = text
  } finally {
    dragPreparing.value = null
  }
}

/** 中止拖出：拷贝可能已经拉了很久（目录要递归），用户必须能反悔 */
function cancelDragOut(): void {
  void window.api.sftpCancelDrag(props.sessionId)
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

// 会话切换时重新加载
watch(() => props.sessionId, init)

// 跟随终端 cd（终端 → SFTP 方向联动）
watch(
  () => (store.followTerminal ? store.cwdBySession[props.sessionId] : undefined),
  (dir) => {
    if (dir && dir !== cwd.value) void load(dir)
  }
)

onMounted(init)
onBeforeUnmount(() => {
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

    <!--
      拖出要先完整下载到本地才能交给系统拖动，这段等待必须让用户看见。
      文件夹可能要递归拉很久，所以文案里点明是这个原因，别让人以为卡死了。
    -->
    <div v-if="dragPreparing" class="drag-hint">
      <span>正在把「{{ dragPreparing }}」取到本地（拖出需要先有本地文件）…</span>
      <button class="drag-cancel" @click="cancelDragOut">取消</button>
    </div>
    <div v-if="errorMsg" class="error-banner">{{ errorMsg }}</div>
    <div v-if="loading" class="hint">加载中…</div>

    <!-- 文件列表 -->
    <div v-else class="file-list">
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
        v-for="entry in entries"
        :key="entry.path"
        class="row"
        draggable="true"
        @dragstart="onDragStart($event, entry)"
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
  </div>
</template>

<style scoped>
.explorer {
  width: 360px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid #2a2b3d;
  background: #16161e;
}
.explorer.drag-over {
  outline: 2px dashed #7aa2f7;
  outline-offset: -4px;
}
.toolbar {
  display: flex;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid #2a2b3d;
}
.breadcrumb {
  padding: 6px 10px;
  font-size: 12px;
  color: #565f89;
  overflow-x: auto;
  white-space: nowrap;
  border-bottom: 1px solid #2a2b3d;
}
.crumb {
  color: #7aa2f7;
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
  padding: 4px 10px;
  font-size: 13px;
  cursor: default;
}
.row:hover {
  background: #1f2335;
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
  color: #565f89;
  font-size: 12px;
  flex-shrink: 0;
}
.file-time {
  width: 108px;
  color: #565f89;
  font-size: 12px;
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
  background: #1f2335;
  box-shadow: -10px 0 10px #1f2335;
}
.row:hover .row-actions {
  display: flex;
}
.rename-input {
  flex: 1;
  background: #1f2335;
  border: 1px solid #7aa2f7;
  border-radius: 4px;
  color: #c0caf5;
  padding: 2px 6px;
  font-size: 13px;
  outline: none;
}
.file-icon {
  color: #565f89;
}
.file-icon.dir {
  color: #7aa2f7;
}
.spacer {
  flex: 1;
}
.error-banner {
  padding: 8px 10px;
  color: #f7768e;
  font-size: 12px;
  border-bottom: 1px solid #2a2b3d;
}
.drag-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  color: #7aa2f7;
  font-size: 12px;
  border-bottom: 1px solid #2a2b3d;
}
.drag-cancel {
  flex-shrink: 0;
  margin-left: auto;
  background: none;
  border: 1px solid #2a2b3d;
  border-radius: 4px;
  color: #c0caf5;
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
}
.drag-cancel:hover {
  border-color: #f7768e;
  color: #f7768e;
}
.hint {
  padding: 16px;
  color: #565f89;
  font-size: 12px;
  text-align: center;
}
</style>
