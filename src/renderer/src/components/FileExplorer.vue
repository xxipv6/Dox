<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DroppedFile, FileEntry } from '@shared/types'
import { formatSize, formatTime } from '../utils/format'
import { useSessionStore } from '../stores/sessions'
import { errorText } from '../utils/errors'

const props = defineProps<{ sessionId: string }>()
const store = useSessionStore()

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

const breadcrumbs = computed(() => {
  const parts = cwd.value.split('/').filter(Boolean)
  return [{ name: '/', path: '/' }].concat(
    parts.map((name, i) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }))
  )
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
  if (entry.isDir) void load(entry.path)
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
      <button class="icon-btn" title="上一级" @click="goUp">↑</button>
      <button class="icon-btn" title="刷新" @click="load()">⟳</button>
      <button class="icon-btn" title="新建文件夹" @click="creatingDir = true">📁+</button>
      <button class="icon-btn" title="上传文件" @click="pickUpload">⬆</button>
      <span class="spacer"></span>
      <button class="icon-btn" title="在终端中打开此目录" @click="openInTerminal">⌨</button>
      <button
        class="icon-btn"
        :class="{ active: store.followTerminal }"
        :title="store.followTerminal ? '跟随终端：开（cd 时面板自动跳转）' : '跟随终端：关'"
        @click="store.toggleFollowTerminal()"
      >⇄</button>
    </div>

    <!-- 面包屑 -->
    <div class="breadcrumb">
      <template v-for="(crumb, i) in breadcrumbs" :key="crumb.path">
        <span v-if="i > 0" class="sep">/</span>
        <a class="crumb" @click="load(crumb.path)">{{ crumb.name }}</a>
      </template>
    </div>

    <div v-if="errorMsg" class="error-banner">{{ errorMsg }}</div>
    <div v-if="loading" class="hint">加载中…</div>

    <!-- 文件列表 -->
    <div v-else class="file-list">
      <div v-if="creatingDir" class="row editing">
        <span class="file-icon">📁</span>
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
        @dblclick="openEntry(entry)"
      >
        <span class="file-icon">{{ entry.isDir ? '📁' : entry.isSymlink ? '🔗' : '📄' }}</span>
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
          >⬇</button>
          <button class="icon-btn" title="重命名" @click.stop="startRename(entry)">✎</button>
          <button class="icon-btn danger" title="删除" @click.stop="removeEntry(entry)">🗑</button>
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
.row:hover .row-actions {
  visibility: visible;
}
.file-name {
  flex: 1;
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
.row-actions {
  visibility: hidden;
  display: flex;
  flex-shrink: 0;
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
.icon-btn {
  background: none;
  border: none;
  color: #565f89;
  cursor: pointer;
  font-size: 13px;
  padding: 2px 4px;
}
.icon-btn:hover {
  color: #c0caf5;
}
.icon-btn.active {
  color: #7aa2f7;
  background: #1f2335;
  border-radius: 4px;
}
.spacer {
  flex: 1;
}
.icon-btn.danger:hover {
  color: #f7768e;
}
.error-banner {
  padding: 8px 10px;
  color: #f7768e;
  font-size: 12px;
  border-bottom: 1px solid #2a2b3d;
}
.hint {
  padding: 16px;
  color: #565f89;
  font-size: 12px;
  text-align: center;
}
</style>
