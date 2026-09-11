<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DiskUsage, DroppedFile, FileEntry, TransferTask } from '@shared/types'
import { BUNDLED_AGENT_VERSION, agentVersionOlder } from '@shared/agentVersion'
import { formatSize, formatTime } from '../utils/format'
import { useSessionStore } from '../stores/sessions'
import { useEditorStore } from '../stores/editor'
import { errorText } from '../utils/errors'
import Icon from './Icon.vue'
import Spinner from './Spinner.vue'
import ContextMenu, { type ContextMenuItem } from './ContextMenu.vue'

const props = defineProps<{
  /** 面板归属的会话（cwd 跟随/编辑器分组用这个；容器标签 = 容器 pane id） */
  sessionId: string
  /** 容器目标：文件操作经容器里的 dox-agent（fs 调用用 parentSessionId + containerName） */
  container?: { parentSessionId: string; containerName: string }
}>()
const store = useSessionStore()
const editor = useEditorStore()

/** 实际的文件操作会话（容器 = 父 SSH 会话；宿主机 = 自己） */
const fsSessionId = computed(() => props.container?.parentSessionId ?? props.sessionId)
const ctrName = computed(() => props.container?.containerName)

const cwd = ref('')
const entries = ref<FileEntry[]>([])
const loading = ref(false)
const errorMsg = ref('')
const dragOver = ref(false)
/** 容器标签但还没装容器助手：文件面板无米下锅，指路去装 */
const agentMissing = ref(false)
/** 容器助手版本过旧（没有 fs_* 方法）：指路去升级（空串 = 不过旧） */
const agentOutdated = ref('')
/** 是否真的持有过 agent 通道（只释放持有过的，盲 release 会误关别人的通道） */
const holdAcquired = ref(false)
/** 打包进行中（远端 tar 最长 5 分钟，没反馈就像卡死） */
const archiving = ref(false)

// ---- 磁盘用量条（宿主 statvfs 扩展 / 容器 agent fs_usage；不支持就不显示）----
const usage = ref<DiskUsage | null>(null)
let usageFetchedAt = 0

async function refreshUsage(): Promise<void> {
  // 10s 缓存：用量变化慢，每次 cd 都问一次远端是浪费
  if (Date.now() - usageFetchedAt < 10_000) return
  usageFetchedAt = Date.now()
  usage.value = await window.api
    .sftpDiskUsage(fsSessionId.value, cwd.value || '/', ctrName.value)
    .catch(() => null)
}

const usagePercent = computed(() =>
  usage.value && usage.value.total > 0 ? Math.round((usage.value.used / usage.value.total) * 100) : 0
)

// ---- 磁盘占用分解：点用量条展开「谁占的」（agent fs_du，0.5.0+）----
interface DuEntry {
  name: string
  path: string
  is_dir: boolean
  size: number
}
const duOpen = ref(false)
const duLoading = ref(false)
const duError = ref('')
const duResult = ref<{ total: number; entries: DuEntry[]; truncated: boolean } | null>(null)

async function refreshDu(): Promise<void> {
  duLoading.value = true
  duError.value = ''
  try {
    duResult.value = (await window.api.agentCall(fsSessionId.value, ctrName.value, 'fs_du', {
      path: cwd.value || '/'
    })) as { total: number; entries: DuEntry[]; truncated: boolean }
  } catch (err) {
    const msg = errorText(err)
    // 老 agent 没有 fs_du：指路升级比糊 unknown method 原文好
    duError.value = msg.includes('unknown method')
      ? `磁盘分解需要助手 v${BUNDLED_AGENT_VERSION}，请在侧栏「远程助手」升级`
      : msg
  } finally {
    duLoading.value = false
  }
}

function toggleDu(): void {
  duOpen.value = !duOpen.value
  if (duOpen.value) void refreshDu()
}

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
  const prev = cwd.value
  try {
    if (dir) cwd.value = dir
    entries.value = await window.api.sftpList(fsSessionId.value, cwd.value, ctrName.value)
    // 与终端的 cwd 跟踪保持同步（作为下次 cd 相对路径的基准）
    store.setCwd(props.sessionId, cwd.value)
  } catch (err) {
    // 进不去目标目录：回滚路径、保留旧列表 —— 否则面包屑指着新路径、
    // 行却是旧目录的，用户会以为自己在删/改另一个目录的东西
    cwd.value = prev
    errorMsg.value = (dir ? '无法进入目录：' : '') + errorText(err)
  } finally {
    loading.value = false
  }
  // 顺手刷新磁盘用量（自带 10s 缓存；失败静默 —— 用量条是加分项不是刚需）
  void refreshUsage()
  // 换目录后旧的分解结果作废；分解面板开着就顺手重扫
  duResult.value = null
  if (duOpen.value) void refreshDu()
}

async function init(): Promise<void> {
  // 容器标签先看助手在不在：没装就是「无米下锅」，指路比报错好
  if (props.container) {
    const st = await window.api
      .agentStatus(props.container.parentSessionId, props.container.containerName)
      .catch(() => null)
    if (!st?.installed) {
      agentMissing.value = true
      return
    }
    // 版本过旧（没有 fs_* 方法的老助手）：糊 unknown method 原文不如指路升级
    if (st.version && agentVersionOlder(st.version, BUNDLED_AGENT_VERSION)) {
      agentOutdated.value = st.version
      return
    }
    agentOutdated.value = ''
    agentMissing.value = false
    // 只持有一次：stamp 监听会重复触发 init，重复 hold 会在 unmount 时留一个没释放
    if (!holdAcquired.value) {
      holdAcquired.value = true
      void window.api.agentFsHold(props.container.parentSessionId, props.container.containerName)
    }
  }
  try {
    // 以远端 home 目录为起点（容器落地 /，由主进程 realpath 分路处理）
    const home = await window.api.sftpRealpath(fsSessionId.value, '.', ctrName.value)
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
  else
    void editor.open(
      props.sessionId,
      entry.path,
      props.container
        ? { sessionId: props.container.parentSessionId, containerName: props.container.containerName }
        : undefined
    )
}

// ---- 新建文件夹 ----
async function submitNewDir(): Promise<void> {
  const name = newDirName.value.trim()
  if (name) {
    try {
      await window.api.sftpMkdir(fsSessionId.value, `${cwd.value}/${name}`, ctrName.value)
      await load()
    } catch (err) {
      errorMsg.value = `新建文件夹失败：${errorText(err)}`
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
      await window.api.sftpRename(fsSessionId.value, entry.path, `${cwd.value}/${name}`, ctrName.value)
      await load()
    } catch (err) {
      errorMsg.value = `重命名失败：${errorText(err)}`
    }
  }
  renamingPath.value = null
}

// ---- 删除 / 下载 / 上传 ----
async function removeEntry(entry: FileEntry): Promise<void> {
  const hint = entry.isDir ? `目录 ${entry.name} 及其全部内容（递归删除，不可恢复）` : `文件 ${entry.name}`
  if (!confirm(`确认删除${hint}？`)) return
  try {
    await window.api.sftpDelete(fsSessionId.value, entry.path, entry.isDir, ctrName.value)
    await load()
  } catch (err) {
    errorMsg.value = `删除失败：${errorText(err)}`
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
      ? window.api.downloadDir(fsSessionId.value, entry.path, ctrName.value)
      : window.api.download(fsSessionId.value, entry.path, entry.name, ctrName.value)
  )
}

async function pickUpload(): Promise<void> {
  await guard(() => window.api.pickUpload(fsSessionId.value, cwd.value, ctrName.value))
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
      {
        // 就地打包：当前目录生成 .tar.gz，出现在面板里；下载走单独的「下载」。
        // 容器里也能打 —— 由容器里的 agent 用 Go 标准库产包，不依赖容器里有 tar
        id: 'archive',
        label: many ? `打包这 ${targets.length} 项` : '打包',
        icon: 'box'
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
  else if (id === 'archive') await archiveTargets(targets)
  else if (id === 'rename') startRename(targets[0])
  else if (id === 'delete') await removeTargets(targets)
}

/**
 * 就地打包：远端在当前目录生成 .tar.gz，完事刷新列表让包露出来。
 * 大目录要等远端 tar 跑完（主进程给了 5 分钟上限）——期间顶部出
 * 不确定进度条，不然慢目录上看着就像卡死；失败原因落在 errorMsg 里。
 */
async function archiveTargets(targets: FileEntry[]): Promise<void> {
  archiving.value = true
  try {
    await guard(async () => {
      await window.api.sftpArchive(
        fsSessionId.value,
        targets.map((t) => t.path),
        ctrName.value
      )
      clearSelection()
      await load()
    })
  } finally {
    archiving.value = false
  }
}

async function downloadTargets(targets: FileEntry[]): Promise<void> {
  // 只有一项时沿用原来的路径：单文件弹保存框（能顺手改名），单目录弹目录框
  if (targets.length === 1) {
    await downloadEntry(targets[0])
    return
  }
  await guard(() =>
    window.api.downloadMany(
      fsSessionId.value,
      targets.map((t) => ({ remotePath: t.path, name: t.name, isDir: t.isDir })),
      ctrName.value
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
      await window.api.sftpDelete(fsSessionId.value, t.path, t.isDir, ctrName.value)
    }
  } catch (err) {
    errorMsg.value = `删除过程中出错：${errorText(err)}`
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
  if (files.length) void guard(() => window.api.enqueueDropped(fsSessionId.value, cwd.value, files, ctrName.value))
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

/** 这条任务是不是「我这个面板」的上传：容器认 containerName（remotePath 是中转路径，认不了目录），宿主机认目录归属 */
function isMyUpload(t: TransferTask): boolean {
  if (t.direction !== 'upload') return false
  if (props.container) return t.containerName === props.container.containerName
  return !t.containerName && isUnderCwd(t.remotePath)
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
      if (was !== undefined && was !== 'done' && t.status === 'done' && isMyUpload(t)) {
        touched = true
      }
    }
    lastStatus = next
    if (touched) scheduleRefresh()
  })
}

// 会话切换时重新加载
watch(() => props.sessionId, init)

// 在面板开着的时候装上/升级了容器助手：从「无米下锅/版本过旧」进入正常态
watch(
  () => store.agentInstallStamp,
  () => {
    if (props.container && (agentMissing.value || agentOutdated.value)) void init()
  }
)

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
  // 只释放真的持有过的通道：版本过旧等路径从没 hold 过，
  // 盲 release 会把别人（终端标签）在用的 agent 通道误关
  if (props.container && holdAcquired.value) {
    holdAcquired.value = false
    void window.api.agentFsRelease(props.container.parentSessionId, props.container.containerName)
  }
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

    <!-- 面包屑：容器模式先给容器名徽章（这是哪个容器的文件系统一眼得见），根单独渲染一次 -->
    <div class="breadcrumb">
      <span v-if="props.container" class="ctr-badge" :title="`容器 ${props.container.containerName} 内的文件（经容器助手）`">
        <Icon name="box" :size="12" />{{ props.container.containerName }}
      </span>
      <a class="crumb" title="/" @click="load('/')">/</a>
      <template v-for="(crumb, i) in breadcrumbs" :key="crumb.path">
        <span v-if="i > 0" class="sep">/</span>
        <a class="crumb" @click="load(crumb.path)">{{ crumb.name }}</a>
      </template>
      <!-- 打包期间的不确定进度：远端 tar 最长 5 分钟，没反馈就像卡死 -->
      <span v-if="archiving" class="archiving" title="正在远端打包…">
        <Spinner :size="12" />打包中…
      </span>
    </div>

    <div v-if="errorMsg" class="error-banner">{{ errorMsg }}</div>

    <!-- 容器标签但没装容器助手：指路比报错好 -->
    <div v-if="agentMissing" class="hint">
      浏览容器文件需要容器里的 dox-agent。<br />
      请在侧栏「远程助手」点「安装到容器 {{ props.container?.containerName }}」。
    </div>

    <!-- 容器助手版本过旧：老二进制没有 fs_* 方法 -->
    <div v-else-if="agentOutdated" class="hint">
      容器助手 v{{ agentOutdated }} 过旧，文件管理需要 v{{ BUNDLED_AGENT_VERSION }}。<br />
      请在侧栏「远程助手」点「升级到 v{{ BUNDLED_AGENT_VERSION }}」。
    </div>

    <div v-else-if="loading" class="hint"><Spinner text="加载中…" /></div>

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

    <!-- 磁盘用量分解（点用量条展开）：谁占的、各占多少，点目录直接跳进去 -->
    <div v-if="duOpen && usage" class="du-panel">
      <div v-if="duLoading" class="hint"><Spinner :size="12" text="扫描目录占用…" /></div>
      <div v-else-if="duError" class="du-error">{{ duError }}</div>
      <template v-else-if="duResult">
        <div
          v-for="e in duResult.entries"
          :key="e.path"
          class="du-row"
          :class="{ clickable: e.is_dir }"
          @click="e.is_dir && load(e.path)"
        >
          <span class="du-name">{{ e.name }}{{ e.is_dir ? '/' : '' }}</span>
          <span class="du-track">
            <span
              class="du-fill"
              :style="{ width: (duResult.total > 0 ? Math.max(1, Math.round((e.size / duResult.total) * 100)) : 0) + '%' }"
            ></span>
          </span>
          <span class="du-size">{{ formatSize(e.size) }}</span>
        </div>
        <div v-if="duResult.truncated" class="du-note">目录太大，结果不完整（已按已扫描部分排序）</div>
        <div v-if="!duResult.entries.length" class="du-note">空目录</div>
      </template>
    </div>

    <!-- 磁盘用量条：目标不支持（无 statvfs 也无 agent）时整条不出现；点击展开分解 -->
    <div
      v-if="usage"
      class="usage-bar"
      :class="{ warn: usagePercent >= 85, open: duOpen }"
      :title="(usage.mount ? `挂载点 ${usage.mount} · ` : '') + '点击展开占用分解'"
      @click="toggleDu"
    >
      <span class="usage-track"><span class="usage-fill" :style="{ width: usagePercent + '%' }"></span></span>
      <span class="usage-text">{{ formatSize(usage.used) }} / {{ formatSize(usage.total) }}（{{ usagePercent }}%）</span>
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
  display: flex;
  align-items: center;
  padding: 6px 10px;
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  overflow-x: auto;
  white-space: nowrap;
  border-bottom: 1px solid var(--border);
}
/* 容器模式的身份徽章：宿主机视图和容器视图原来肉眼分不出 */
.ctr-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  margin-right: 8px;
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: var(--fs-xs);
  font-weight: 600;
}
.archiving {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 10px;
  color: var(--accent-text);
  font-size: var(--fs-xs);
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
/* 磁盘用量条：贴面板底部，>85% 整条转警示色；可点击展开分解 */
.usage-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-top: 1px solid var(--border);
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  cursor: pointer;
}
.usage-bar:hover {
  background: var(--bg-hover);
}
.usage-bar.open {
  background: var(--bg-hover);
}
.usage-track {
  flex: 1;
  height: 4px;
  border-radius: var(--r-pill);
  background: var(--bg-hover);
  overflow: hidden;
}
.usage-fill {
  display: block;
  height: 100%;
  border-radius: var(--r-pill);
  background: var(--accent-text);
}
.usage-bar.warn .usage-fill {
  background: var(--warning-text);
}
.usage-bar.warn .usage-text {
  color: var(--warning-text);
}
.usage-text {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* 用量分解面板：贴在用量条上方，行 = 子项 + 占比条 + 大小 */
.du-panel {
  border-top: 1px solid var(--border);
  max-height: 240px;
  overflow-y: auto;
  padding: 4px 0;
}
.du-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  font-size: var(--fs-xs);
}
.du-row.clickable {
  cursor: pointer;
}
.du-row.clickable:hover {
  background: var(--bg-hover);
}
.du-name {
  width: 40%;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.du-track {
  flex: 1;
  height: 4px;
  border-radius: var(--r-pill);
  background: var(--bg-hover);
  overflow: hidden;
}
.du-fill {
  display: block;
  height: 100%;
  background: var(--accent-text);
  border-radius: var(--r-pill);
}
.du-size {
  flex-shrink: 0;
  width: 64px;
  text-align: right;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
.du-error {
  padding: 8px 10px;
  font-size: var(--fs-xs);
  color: var(--danger-text);
}
.du-note {
  padding: 4px 10px;
  font-size: var(--fs-xs);
  color: var(--fg-muted);
}
</style>
