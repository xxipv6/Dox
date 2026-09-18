<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComposeVerb, DiskUsage, DroppedFile, FileEntry, TransferTask } from '@shared/types'
import { BUNDLED_AGENT_VERSION, FS_MIN_AGENT_VERSION, agentVersionOlder } from '@shared/agentVersion'
import { LOCAL_ID_PREFIX } from '@shared/sessionId'
import { WIN_DRIVES, isWinPath, joinLocal, parentLocal } from '@shared/localPath'
import { formatSize, formatTime } from '../utils/format'
import { useSessionStore } from '../stores/sessions'
import { useEditorStore } from '../stores/editor'
import { useConfirmStore } from '../stores/confirm'
import { useComposeStore } from '../stores/compose'
import { useSettingsStore } from '../stores/settings'
import { panelClipboard, askP2pConsent } from '../stores/fileClipboard'
import { pushToast } from '../stores/toast'
import { errorText } from '../utils/errors'
import { vFocus } from '../directives/focus'
import Icon from './Icon.vue'
import FileIcon from './FileIcon.vue'
import Spinner from './Spinner.vue'
import ContextMenu, { type ContextMenuItem } from './ContextMenu.vue'
import ProjectTree from './ProjectTree.vue'
import SearchPanel from './SearchPanel.vue'

const props = defineProps<{
  /** 面板归属的会话（cwd 跟随/编辑器分组用这个；容器标签 = 容器 pane id） */
  sessionId: string
  /** 容器目标：文件操作经容器里的 dox-agent（fs 调用用 parentSessionId + containerName） */
  container?: { parentSessionId: string; containerName: string }
}>()
const store = useSessionStore()
const editor = useEditorStore()
const composeStore = useComposeStore()
const settings = useSettingsStore()

/** 实际的文件操作会话（容器 = 父 SSH 会话；宿主机 = 自己） */
const fsSessionId = computed(() => props.container?.parentSessionId ?? props.sessionId)
const ctrName = computed(() => props.container?.containerName)

/**
 * 本机面板（本地终端标签）：同一套 IPC，主进程按 local- 前缀分流到 node:fs。
 * 与远端面板的差别都在这一处收口：路径是原生形态（Windows 盘符反斜杠）、
 * 「下载/上传」= 复制、没有 compose / du 分解（那俩是远端 agent 的能力）。
 */
const isLocal = computed(() => !props.container && props.sessionId.startsWith(LOCAL_ID_PREFIX))
const isWinLocal = computed(() => isLocal.value && window.api.platform === 'win32')
/** 平台习惯快捷键：mac 重命名=回车、删除=⌘⌫；win/linux 重命名=F2、删除=Del（VS Code 式） */
const isMacPlatform = window.api.platform === 'darwin'

/** 本机终端的 shell 种类（cmd 不认单引号）：「在终端打开」的引号策略靠它 */
let localShellKind: string | null = null

/** 在指定目录下拼一个名字（本机 Windows 走反斜杠，远端一律 posix） */
function joinIn(dir: string, name: string): string {
  return isLocal.value ? joinLocal(dir, name) : `${dir}/${name}`
}

/** 取父目录（本机 Windows 复用 parentLocal 处理盘符边界，远端 posix 字符串截断） */
function parentOf(path: string): string {
  if (isLocal.value) return parentLocal(path)
  const idx = path.lastIndexOf('/')
  return idx <= 0 ? '/' : path.slice(0, idx)
}

const cwd = ref('')
const entries = ref<FileEntry[]>([])
const loading = ref(false)
let loadSeq = 0
const errorMsg = ref('')
/** 上次失败的那个动作本身（横幅上的「重试」重跑它，而不是刷新目录） */
const retryAction = ref<(() => Promise<unknown>) | null>(null)
const dragOver = ref(false)
/** 拖拽悬停的行（行级 drop：拖到某个文件夹行上 = 传进那个文件夹） */
const dropRowPath = ref<string | null>(null)
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
let usageFetchedKey = ''

async function refreshUsage(): Promise<void> {
  // 10s 缓存：用量变化慢，每次 cd 都问一次远端是浪费
  const key = `${fsSessionId.value}|${ctrName.value ?? ''}|${cwd.value}`
  if (key === usageFetchedKey && Date.now() - usageFetchedAt < 10_000) return
  usageFetchedKey = key
  usageFetchedAt = Date.now()
  const value = await window.api
    .sftpDiskUsage(fsSessionId.value, cwd.value || '/', ctrName.value)
    .catch(() => null)
  // 导航期间旧请求可能晚于新请求返回，不能把旧目录的用量写回当前面板。
  if (key === `${fsSessionId.value}|${ctrName.value ?? ''}|${cwd.value}`) {
    usage.value = value
  }
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

// 内联新建文件夹 / 重命名（browse 模式的状态；项目模式的内联编辑在 ProjectTree 内部）
const creatingDir = ref(false)
const newDirName = ref('')
const renamingPath = ref<string | null>(null)
const renameValue = ref('')

// ---- 项目模式：面板整体切到「以某文件夹为根」的树形视图（VS Code explorer 语义）----
// browse 的 cwd/entries/history 在项目模式期间从不被触碰，退出即精确回到进入前的目录。
const mode = ref<'browse' | 'project'>('browse')
const projectRoot = ref('')
const treeRef = ref<InstanceType<typeof ProjectTree> | null>(null)
/** 项目模式下树的焦点行（cwd 跟踪/「在终端打开」用） */
const treeSelected = ref<FileEntry | null>(null)
/** 项目模式下树的多选快照（右键菜单/复制/删除的动作对象，selection-change 事件冻结进来） */
const treeSelection = ref<FileEntry[]>([])
/** 全文搜索面板（与树同位切换；树用 v-show 保活，懒加载缓存不能打回冷启动） */
const searchOpen = ref(false)
const searchPanelRef = ref<InstanceType<typeof SearchPanel> | null>(null)
/** 搜索范围（右键「从文件夹中查找」缩到子目录；空 = 项目根） */
const searchRoot = ref('')
/** 设备级持久化 key：同一台设备重连/新开标签算出同一个（规则见 sessions store） */
const deviceKey = computed(() => store.deviceKeyForSession(props.sessionId))
/** 顶部栏展示的根名（完整路径放 title） */
const rootName = computed(() => projectRoot.value.split(/[\\/]/).filter(Boolean).pop() ?? projectRoot.value)

function enterProject(path: string): void {
  closeFilter()
  mode.value = 'project'
  projectRoot.value = path
  treeSelected.value = null
  treeSelection.value = []
  searchOpen.value = false
  searchRoot.value = ''
  settings.setProjectRoot(deviceKey.value, path)
  // 与终端 cwd 跟踪保持同步（cwdBySession 的语义 = 「面板在看哪」）
  panelSetCwd = path
  store.setCwd(props.sessionId, path)
}

async function exitProject(): Promise<void> {
  mode.value = 'browse'
  projectRoot.value = ''
  treeSelected.value = null
  treeSelection.value = []
  // 面板发的 cwd 标记一并清：留着会让 followTerminal 恰好 cd 到同一目录时误判「自己发的」而不跟随
  panelSetCwd = ''
  searchOpen.value = false
  searchRoot.value = ''
  settings.setProjectRoot(deviceKey.value, null)
  // cwd 一直没动过，load() 刷新即回到进入项目模式前的那个目录
  await load()
}

/** 操作后刷新：browse 重列当前目录；project 只重列受影响的树目录（缓存仍在的不碰） */
async function refreshAfterOp(affectedDirs: string[]): Promise<void> {
  if (mode.value === 'project') {
    const tree = treeRef.value
    if (!tree) return
    await Promise.all([...new Set(affectedDirs)].map((d) => tree.refreshDir(d)))
  } else {
    await load()
  }
}

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
    // 下标按当前可见列表（过滤后）取，和 v-for 的 index 同源
    for (let i = from; i <= to; i++) {
      const item = visibleEntries.value[i]
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

// ---- 键盘快捷键（面板聚焦后 Cmd/Ctrl+A/C/V/F）----
/**
 * 面板内剪贴板，模块级单例：跨标签实例共享（同服务器换个标签也能粘）。
 * key 相同（同会话同容器）走同面板快路（就地 cp / 本机复制）；
 * 不同则跨面板：远端→本机静默下载、本机→远端上传、远端A→远端B 互传中继
 * （见 pasteAcrossPanels）。
 */
const panelKey = computed(() => `${fsSessionId.value}|${ctrName.value ?? ''}`)

/** 过滤框（Ctrl+F）：客户端按名过滤当前目录（entries 本来就在手边，零往返） */
const filterOpen = ref(false)
const filterText = ref('')
const filterInput = ref<HTMLInputElement>()
const visibleEntries = computed(() => {
  const q = filterText.value.trim().toLowerCase()
  if (!q) return entries.value
  return entries.value.filter((x) => x.name.toLowerCase().includes(q))
})

const canPaste = computed(() => panelClipboard.value !== null && !props.container)

function selectAll(): void {
  selected.value = new Set(visibleEntries.value.map((x) => x.path))
}

function copySelection(): void {
  if (!selected.value.size) return
  panelClipboard.value = { key: panelKey.value, paths: [...selected.value], isLocal: isLocal.value }
}

async function pasteClipboard(dir = cwd.value): Promise<void> {
  const clip = panelClipboard.value
  if (!clip) return
  if (clip.key !== panelKey.value) {
    await pasteAcrossPanels(clip, dir)
    return
  }
  if (props.container) {
    errorMsg.value = '容器面板暂不支持粘贴'
    return
  }
  await guard(async () => {
    if (isLocal.value) {
      // 本机：走传输队列（撞名避让/进度/取消同一套），DroppedFile 只用到 path
      await window.api.enqueueDropped(
        fsSessionId.value,
        dir,
        clip.paths.map((p) => ({ path: p, name: p, size: 0 }))
      )
    } else {
      // 远端：服务端 cp -a 就地复制（不经本机中转），完事刷新
      await window.api.sftpCopyWithin(fsSessionId.value, clip.paths, dir)
      await refreshAfterOp([dir])
    }
  })
}

/**
 * 跨面板粘贴（剪贴板来自另一台设备/另一种面板）：
 *  - 远端 → 本机：静默下载进当前目录（不弹保存框；本机面板刷新靠 fs.watch）
 *  - 本机 → 远端：走上传队列（与拖入同路）
 *  - 远端 A → 远端 B：主进程 tar 整流中继，两端不落盘；任务记目的端会话，
 *    目标面板「传完自动刷新」零改动生效
 * 容器相关（源或目标是容器面板）维持 v1 口径：提示不支持。
 */
async function pasteAcrossPanels(
  clip: { key: string; paths: string[]; isLocal: boolean },
  dir: string
): Promise<void> {
  if (props.container) {
    errorMsg.value = '容器面板暂不支持粘贴'
    return
  }
  const [srcSession, srcCtr] = clip.key.split('|')
  if (srcCtr) {
    errorMsg.value = '容器里的内容暂不支持粘到别的面板'
    return
  }
  await guard(async () => {
    if (isLocal.value) {
      const stats = await Promise.all(clip.paths.map((p) => window.api.sftpStat(srcSession, p)))
      const items = clip.paths.map((p, i) => ({
        remotePath: p,
        name: p.split('/').filter(Boolean).pop() ?? 'download',
        isDir: !!stats[i]?.isDir
      }))
      await window.api.transferDownloadTo(srcSession, items, dir)
    } else if (clip.isLocal) {
      await window.api.enqueueDropped(
        fsSessionId.value,
        dir,
        clip.paths.map((p) => ({ path: p, name: p, size: 0 }))
      )
    } else {
      // clip.paths 是 Vue 响应式代理数组，直接过 IPC 会被结构化克隆拒绝
      // （"An object could not be cloned"）—— 摊平成普通数组再传
      await window.api.transferServerCopy(srcSession, [...clip.paths], fsSessionId.value, dir, await askP2pConsent())
    }
  })
}

function openFilter(): void {
  filterOpen.value = true
  void nextTick(() => filterInput.value?.focus())
}

function closeFilter(): void {
  filterOpen.value = false
  filterText.value = ''
}

/**
 * 复制路径到系统剪贴板（多选换行分隔）。
 * relative 仅项目模式有意义：相对项目根裁剪前缀，裁不动（根外）回退文件名。
 */
async function copyPaths(targets: FileEntry[], relative: boolean): Promise<void> {
  const sepChar = isWinLocal.value ? '\\' : '/'
  const text = targets
    .map((t) => {
      if (!relative) return t.path
      const root = projectRoot.value
      const prefix = root.endsWith(sepChar) ? root : root + sepChar
      return t.path.startsWith(prefix) ? t.path.slice(prefix.length) : t.name
    })
    .join('\n')
  if (!text) return
  try {
    await window.api.writeClipboardText(text)
    pushToast('已复制路径', 'success', 1600)
  } catch (err) {
    pushToast(`复制到剪贴板失败：${errorText(err)}`)
  }
}

/** 当前「删除快捷键」的动作对象（browse = selected；项目模式 = 树的多选快照） */
function keyDeleteTargets(): FileEntry[] {
  return mode.value === 'project'
    ? treeSelection.value
    : entries.value.filter((en) => selected.value.has(en.path))
}

/** 键盘删除入口：确认弹窗已经开着时不叠加（ask 会顶掉上一个，连按等于自己取消自己） */
function deleteByKeyboard(e: KeyboardEvent): void {
  const confirmStore = useConfirmStore()
  if (confirmStore.visible) return
  const targets = keyDeleteTargets()
  if (!targets.length) return
  e.preventDefault()
  void removeTargets(targets)
}

/**
 * 键盘入口挂在 .explorer 根上（tabindex=0，点面板任意处即聚焦）。
 * 输入框（重命名/新建/过滤）里的按键归输入框自己，不拦截 —— 守卫必须在所有分支之前，
 * 否则裸键（Enter/F2/Delete）根本进不来。
 *
 * 平台习惯（VS Code 式）：mac 重命名=回车、删除=⌘⌫、打开=⌘↓；
 * win/linux 重命名=F2、删除=Del。项目模式的同类按键由 ProjectTree 自己消费
 * （stopPropagation 到不了这里）；这里是「焦点不在树上」（点过工具栏等）时的兜底。
 */
function onKeydown(e: KeyboardEvent): void {
  const tag = (e.target as HTMLElement).tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  // 确认弹窗开着时快捷键归弹窗（Enter=确定 / Esc=取消），面板不响应
  if (useConfirmStore().visible) return

  // ---- 裸键（无修饰）：重命名 / 删除 ----
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    const isRenameKey = isMacPlatform ? e.key === 'Enter' : e.key === 'F2'
    if (isRenameKey) {
      const target =
        mode.value === 'project'
          ? treeSelected.value
          : selected.value.size === 1
            ? entries.value.find((en) => selected.value.has(en.path))
            : undefined
      if (target) {
        e.preventDefault()
        startRename(target)
      }
      return
    }
    // mac 裸 Backspace 不响应（防误删）；win/linux 的 Del 是系统习惯
    if (!isMacPlatform && e.key === 'Delete') deleteByKeyboard(e)
    return
  }

  // mac：⌘⌫ = 删除（系统习惯）；要在通用字母分支之前判断
  if (isMacPlatform && e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'Backspace') {
    deleteByKeyboard(e)
    return
  }

  // mac：⌘↓ = 打开选中项（对齐 Finder / VS Code mac 打开方式）
  if (isMacPlatform && e.metaKey && e.key === 'ArrowDown') {
    if (mode.value === 'browse' && selected.value.size) {
      const entry = entries.value.find((en) => selected.value.has(en.path))
      if (entry) {
        e.preventDefault()
        openEntry(entry)
      }
    }
    return
  }

  if (!(e.ctrlKey || e.metaKey)) return
  const key = e.key.toLowerCase()
  if (key === 'a') {
    e.preventDefault()
    if (mode.value === 'project') treeRef.value?.selectAll()
    else selectAll()
  } else if (key === 'c') {
    e.preventDefault()
    if (mode.value === 'project') {
      if (treeSelection.value.length) {
        panelClipboard.value = { key: panelKey.value, paths: treeSelection.value.map((t) => t.path), isLocal: isLocal.value }
      }
    } else {
      copySelection()
    }
  } else if (key === 'v') {
    e.preventDefault()
    void pasteClipboard(mode.value === 'project' ? treeRef.value?.selectedDirOrRoot() : undefined)
  } else if (key === 'f') {
    e.preventDefault()
    // browse 的 Ctrl+F 过滤在项目模式无对应物；映射到项目搜索最自然（Shift+F 同路）
    if (mode.value === 'project') {
      if (!searchOpen.value) toggleSearch()
      else searchPanelRef.value?.focusInput()
    } else {
      openFilter()
    }
  }
}

/**
 * 面包屑的各级目录。
 *
 * 这里**不再**塞一个 name 为 '/' 的根节点：模板会为每级的下一项补一个
 * '/' 分隔符，根节点占着第 0 位却自己渲染成 '/'，于是 /root 显示成 / / root。
 * 根由模板单独渲染一次。
 */
const breadcrumbs = computed(() => {
  // 本机 Windows：第一级是盘符（路径补反斜杠），根那一格由模板渲染成「此电脑」
  if (isWinLocal.value) {
    if (cwd.value === WIN_DRIVES) return []
    const parts = cwd.value.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean)
    return parts.map((name, i) => ({
      name,
      path: i === 0 ? `${name}\\` : parts.slice(0, i + 1).join('\\')
    }))
  }
  const parts = cwd.value.split('/').filter(Boolean)
  return parts.map((name, i) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }))
})

async function load(dir?: string): Promise<void> {
  const seq = ++loadSeq
  loading.value = true
  errorMsg.value = ''
  // 换目录后旧路径已经没意义，留着会选中一个看不见的东西
  clearSelection()
  const prev = cwd.value
  try {
    if (dir) cwd.value = dir
    const nextEntries = await window.api.sftpList(fsSessionId.value, cwd.value, ctrName.value)
    // 用户快速连续导航时，较早请求可能晚返回；只接受最后一次结果，避免
    // 旧目录列表覆盖当前目录。
    if (seq !== loadSeq) return
    entries.value = nextEntries
    // 与终端的 cwd 跟踪保持同步（作为下次 cd 相对路径的基准）
    store.setCwd(props.sessionId, cwd.value)
  } catch (err) {
    if (seq !== loadSeq) return
    // 进不去目标目录：回滚路径、保留旧列表 —— 否则面包屑指着新路径、
    // 行却是旧目录的，用户会以为自己在删/改另一个目录的东西
    cwd.value = prev
    errorMsg.value = (dir ? '无法进入目录：' : '') + errorText(err)
    // 进不去多半是掉的连接或临时权限问题，重试就是把这次导航再做一遍
    retryAction.value = () => load(dir)
  } finally {
    if (seq === loadSeq) loading.value = false
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
    // 状态查询在容器会话刚建立时会偶发失败（通道/运行时还没就绪）——
    // 一次失败就判「没装」会把面板永久卡死在指路页，重试两次再下结论
    let st = await window.api
      .agentStatus(props.container.parentSessionId, props.container.containerName)
      .catch(() => null)
    for (let i = 0; !st?.installed && i < 2; i++) {
      await new Promise((r) => setTimeout(r, 1200))
      st = await window.api
        .agentStatus(props.container.parentSessionId, props.container.containerName)
        .catch(() => null)
    }
    if (!st?.installed) {
      agentMissing.value = true
      return
    }
    // 版本过旧（没有 fs_* 方法的老助手）：糊 unknown method 原文不如指路升级。
    // 门槛是 fs 能力的最低版本而非内置最新版 —— 升 BUNDLED 不能把老助手的
    // 文件面板整个关掉（fs_* 齐全就该能用，只有搜索这类新方法才有更高门槛）
    if (st.version && agentVersionOlder(st.version, FS_MIN_AGENT_VERSION)) {
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
    // 这台设备上次停在项目模式：直接恢复（cwd 先备好 home，退出项目模式时从那里继续）。
    // 恢复是热路径 —— 切标签会重挂载本组件（App.vue 按 sessionId 作 key）
    const savedRoot = settings.projectRoots[deviceKey.value]
    if (savedRoot) {
      cwd.value = home
      enterProject(savedRoot)
      return
    }
    await load(home)
  } catch {
    await load('/')
  }
}

// ---- 目录历史：主动导航才入栈（load() 无参刷新 / 后退前进本身不入栈）----
const historyBack = ref<string[]>([])
const historyFwd = ref<string[]>([])

function nav(dir: string): void {
  if (dir === cwd.value) return
  historyBack.value.push(cwd.value)
  historyFwd.value = []
  void load(dir)
}
function historyGoBack(): void {
  const dir = historyBack.value.pop()
  if (dir === undefined) return
  historyFwd.value.push(cwd.value)
  void load(dir)
}
function historyGoForward(): void {
  const dir = historyFwd.value.pop()
  if (dir === undefined) return
  historyBack.value.push(cwd.value)
  void load(dir)
}

/** 鼠标侧键：Mouse4 = 后退，Mouse5 = 前进（面板挂载即生效，卸载摘掉） */
function onMouseNav(e: MouseEvent): void {
  if (e.button === 3) {
    e.preventDefault()
    historyGoBack()
  } else if (e.button === 4) {
    e.preventDefault()
    historyGoForward()
  }
}

function goUp(): void {
  if (isLocal.value) {
    nav(parentLocal(cwd.value))
    return
  }
  const parts = cwd.value.split('/').filter(Boolean)
  parts.pop()
  nav('/' + parts.join('/') || '/')
}

/** 打开编辑器的统一入口：收口三处调用点重复的容器 fs 参数拼接 */
function openInEditor(path: string, opts?: { line?: number; preview?: boolean }): void {
  void editor.open(
    props.sessionId,
    path,
    props.container
      ? { sessionId: props.container.parentSessionId, containerName: props.container.containerName }
      : undefined,
    opts
  )
}

function openEntry(entry: FileEntry): void {
  // 目录进目录；文件交给内置编辑器（二进制/超限由主编解读取时判定并报错）。
  // browse 双击 = 固定打开（单击是多选语义，不掺预览）
  if (entry.isDir) nav(entry.path)
  else openInEditor(entry.path)
}

// ---- 新建文件夹 ----
/** 内联编辑（新建/重命名）用键盘结束后把焦点还给面板：输入框卸载会把焦点扔到 body，快捷键全哑 */
const explorerEl = ref<HTMLElement | null>(null)
function refocusExplorer(): void {
  void nextTick(() => explorerEl.value?.focus())
}

/** 在指定目录下建文件夹（browse 传 cwd；项目模式传树的发起目录） */
async function createDirIn(dir: string, name: string): Promise<void> {
  if (!name) return
  // 「新建」失败多半是权限或重名：把这一段交给 guard，重试才有东西可重跑
  await guard(async () => {
    await window.api.sftpMkdir(fsSessionId.value, joinIn(dir, name), ctrName.value)
    await refreshAfterOp([dir])
  })
}

async function submitNewDir(refocus = false): Promise<void> {
  await createDirIn(cwd.value, newDirName.value.trim())
  creatingDir.value = false
  newDirName.value = ''
  if (refocus) refocusExplorer()
}

function cancelNewDir(): void {
  creatingDir.value = false
  newDirName.value = ''
  refocusExplorer()
}

// ---- 重命名 ----
function startRename(entry: FileEntry): void {
  // 项目模式的内联输入框在树里，委托给它（重命名提交走 tree 的 renameSubmit 事件）
  if (mode.value === 'project') {
    treeRef.value?.beginRename(entry.path)
    return
  }
  renamingPath.value = entry.path
  renameValue.value = entry.name
}

/** 改名执行体：新路径拼在**被改名项的父目录**下（browse 下等价于拼在 cwd） */
async function renameTo(entry: FileEntry, name: string): Promise<void> {
  if (!name || name === entry.name) return
  await guard(async () => {
    await window.api.sftpRename(fsSessionId.value, entry.path, joinIn(parentOf(entry.path), name), ctrName.value)
    await refreshAfterOp([parentOf(entry.path)])
    // 选区跟随新路径：不跟的话重命名后按删除/复制，目标还是那个已不存在的旧路径 —— 静默没反应
    remapSelectionAfterRename(entry.path, joinIn(parentOf(entry.path), name))
  })
}

/** 重命名后把两处选区（browse 的 Set、项目树的选中/焦点/锚点）改指新路径 */
function remapSelectionAfterRename(oldPath: string, newPath: string): void {
  const sep = isWinLocal.value ? '\\' : '/'
  const remap = (p: string): string =>
    p === oldPath ? newPath : p.startsWith(oldPath + sep) ? newPath + p.slice(oldPath.length) : p
  if ([...selected.value].some((p) => remap(p) !== p)) {
    selected.value = new Set([...selected.value].map(remap))
  }
  treeRef.value?.remapSelection(oldPath, newPath)
}

async function submitRename(entry: FileEntry, refocus = false): Promise<void> {
  await renameTo(entry, renameValue.value.trim())
  renamingPath.value = null
  if (refocus) refocusExplorer()
}

/** Esc 取消重命名：不提交，但焦点同样要还给面板 */
function cancelRename(): void {
  renamingPath.value = null
  refocusExplorer()
}

// ---- 删除 / 下载 / 上传 ----
/** 删一次（不含确认）。拆出来是为了让「重试」复用同一段，不必再问一遍 */
async function deleteNow(entry: FileEntry): Promise<void> {
  await window.api.sftpDelete(fsSessionId.value, entry.path, entry.isDir, ctrName.value)
  await refreshAfterOp([parentOf(entry.path)])
}

async function removeEntry(entry: FileEntry): Promise<void> {
  const hint = entry.isDir ? `目录 ${entry.name} 及其全部内容（递归删除，不可恢复）` : `文件 ${entry.name}`
  if (!(await useConfirmStore().ask(`确认删除${hint}？`))) return
  await guard(() => deleteNow(entry))
}

/**
 * 统一收口：之前这些调用是 fire-and-forget，出错时界面上完全没反应。
 *
 * 失败时除了写错误文案，还把**这次动作本身**记下来给横幅上的「重试」——
 * 重试必须是「重做刚才那件事」，不是「刷新目录」（后者看起来像重试，
 * 实际什么也没重做，用户会以为问题解决了）。
 */
async function guard(action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
    errorMsg.value = ''
    retryAction.value = null
  } catch (err) {
    errorMsg.value = errorText(err)
    retryAction.value = action
  }
}

/** 重跑上次失败的动作（确认过的那次删除不再二次确认） */
async function retryLast(): Promise<void> {
  const action = retryAction.value
  if (action) await guard(action)
}

/** 手动关掉错误横幅（有些错误用户看完就够了，不需要占着地方） */
function dismissError(): void {
  errorMsg.value = ''
  retryAction.value = null
}

/**
 * 正在等「保存到哪」这一行的路径。
 *
 * 单文件下载会先弹系统保存框，再开始传输 —— 弹框之前浏览器/Electron 不给任何
 * 信号，用户点了「下载」以后界面一动不动，很容易以为没点中而再点一次。
 * 这里把那颗按钮换成转圈，等框弹出来为止（后面的进度归传输队列管）。
 */
const pendingDownload = ref<string | null>(null)

async function downloadEntry(entry: FileEntry): Promise<void> {
  pendingDownload.value = entry.path
  try {
    await guard(() =>
      entry.isDir
        ? window.api.downloadDir(fsSessionId.value, entry.path, ctrName.value)
        : window.api.download(fsSessionId.value, entry.path, entry.name, ctrName.value)
    )
  } finally {
    pendingDownload.value = null
  }
}

async function pickUpload(dir = cwd.value): Promise<void> {
  await guard(() => window.api.pickUpload(fsSessionId.value, dir, ctrName.value))
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
  menu.value = { x: e.clientX, y: e.clientY, items: buildRowMenuItems(targets) }
}

/** 树（项目模式）行右键：目标从事件载荷冻结（右键同时改选中，时序不可靠） */
function onTreeRowContextMenu(p: { entry: FileEntry; targets: FileEntry[]; x: number; y: number }): void {
  treeSelected.value = p.entry
  menuTargets = p.targets
  menu.value = { x: p.x, y: p.y, items: buildProjectRowMenuItems(p.targets) }
}

/** 树空白处右键 = 项目根的菜单 */
function onTreeBlankContextMenu(p: { x: number; y: number }): void {
  treeSelected.value = null
  menuTargets = []
  menu.value = {
    x: p.x,
    y: p.y,
    items: joinMenuGroups([
      [
        { id: 'search-in-folder', label: '从文件夹中查找', icon: 'search' },
        { id: 'open-terminal', label: '在终端打开此目录', icon: 'terminal' }
      ],
      [
        { id: 'new-folder', label: '新建文件夹', icon: 'folder-plus' },
        { id: 'paste', label: '粘贴到项目根', icon: 'paste', disabled: !canPaste.value }
      ],
      [{ id: 'exit-project', label: '退出项目模式', icon: 'x' }]
    ])
  }
}

/** 菜单分组拼接：非空组之间插分隔线（VS Code 式分组；空组不留下孤线） */
function joinMenuGroups(groups: ContextMenuItem[][]): ContextMenuItem[] {
  const out: ContextMenuItem[] = []
  let n = 0
  for (const g of groups) {
    if (!g.length) continue
    if (out.length) out.push({ id: `sep-${n++}`, label: '', separator: true })
    out.push(...g)
  }
  return out
}

/**
 * 行菜单项（browse/项目模式共用一份词汇；项目模式单选语义，外层再包项目项）。
 * targets = 开菜单那一刻冻结的操作对象。
 */
function buildRowMenuItems(targets: FileEntry[]): ContextMenuItem[] {
  const many = targets.length > 1
  return joinMenuGroups([
    [
      // 项目模式的入口：正好就是「以这个文件夹为根」
      ...(!many && targets[0].isDir && mode.value === 'browse'
        ? [{ id: 'enter-project', label: '进入项目模式', icon: 'folder' as const }]
        : []),
      // SFTP⇥终端的显式入口：目录行 → 进那个目录；文件行 → 它所在的当前目录
      ...(!many
        ? [
            {
              id: 'open-terminal',
              label: targets[0].isDir ? '在终端打开此文件夹' : '在终端打开此目录',
              icon: 'terminal' as const
            }
          ]
        : [])
    ],
    [
      {
        id: 'download',
        // 本机面板没有「下载」：落地动作是复制到另一个目录（主进程走本机复制队列）
        label: isLocal.value
          ? many
            ? `复制这 ${targets.length} 项到…`
            : '复制到…'
          : many
            ? `下载这 ${targets.length} 项`
            : '下载',
        icon: 'download'
      },
      {
        // 就地打包：当前目录生成 .tar.gz，出现在面板里；下载走单独的「下载」。
        // 容器里也能打 —— 由容器里的 agent 用 Go 标准库产包，不依赖容器里有 tar
        id: 'archive',
        label: many ? `打包这 ${targets.length} 项` : '打包',
        icon: 'box'
      }
    ],
    [
      // 复制进面板剪贴板；粘贴只接受同源（同会话同容器），跨面板给提示
      { id: 'copy', label: many ? `复制这 ${targets.length} 项` : '复制', icon: 'copy' },
      {
        id: 'paste',
        label: mode.value === 'project' ? '粘贴到此目录' : '粘贴到当前目录',
        icon: 'paste',
        disabled: !canPaste.value || (mode.value === 'project' && !(targets.length === 1 && targets[0].isDir))
      }
    ],
    [
      { id: 'copy-path', label: many ? `复制这 ${targets.length} 项的路径` : '复制路径', icon: 'link' },
      ...(mode.value === 'project'
        ? [{ id: 'copy-rel-path', label: '复制相对路径', icon: 'link' as const }]
        : [])
    ],
    [
      // 重命名只能对一项，多选时给个禁用项比整条去掉更好读
      { id: 'rename', label: '重命名', icon: 'pencil', disabled: many, hint: isMacPlatform ? '↩' : 'F2' },
      {
        id: 'delete',
        label: many ? `删除这 ${targets.length} 项` : '删除',
        icon: 'trash',
        danger: true,
        hint: isMacPlatform ? '⌘⌫' : 'Del'
      }
    ],
    // compose 文件特供：右键直接编排（down 落手前在 runCompose 里确认）。
    // 本机面板没有这一项 —— compose 走的是远端 exec / agent 通道
    isComposeTarget(targets) && !isLocal.value
      ? [
          { id: 'compose-up', label: 'Compose: up -d', icon: 'play' as const },
          { id: 'compose-restart', label: 'Compose: restart', icon: 'refresh' as const },
          { id: 'compose-down', label: 'Compose: down', icon: 'square' as const, danger: true }
        ]
      : []
  ])
}

/** 项目模式行菜单：共用语义一份，头部加「从文件夹中查找」、尾部加退出 */
function buildProjectRowMenuItems(targets: FileEntry[]): ContextMenuItem[] {
  return joinMenuGroups([
    targets.length === 1 && targets[0].isDir
      ? [{ id: 'search-in-folder', label: '从文件夹中查找', icon: 'search' as const }]
      : [],
    buildRowMenuItems(targets),
    [{ id: 'exit-project', label: '退出项目模式', icon: 'x' as const }]
  ])
}

/** 空白处右键：当前目录的菜单（和资源管理器一致，先清掉选区） */
function onBlankContextMenu(e: MouseEvent): void {
  clearSelection()
  menuTargets = []
  menu.value = {
    x: e.clientX,
    y: e.clientY,
    items: joinMenuGroups([
      [
        { id: 'enter-project', label: '以此处进入项目模式', icon: 'folder' },
        { id: 'open-terminal', label: '在终端打开此目录', icon: 'terminal' }
      ],
      [{ id: 'paste', label: '粘贴到当前目录', icon: 'paste', disabled: !canPaste.value }]
    ])
  }
}

/** compose 文件名口径：docker-compose.yml / compose.yaml 及其排列 */
const COMPOSE_FILE_RE = /^(?:docker-)?compose\.ya?ml$/
function isComposeTarget(targets: FileEntry[]): boolean {
  return targets.length === 1 && !targets[0].isDir && COMPOSE_FILE_RE.test(targets[0].name)
}

/**
 * compose 右键动作：交给全局 compose store —— 输出进底部抽屉实时滚动。
 * 放 store 的理由：用户跑完 up 多半顺手关掉文件面板去看终端，
 * 结果卡挂在这个组件上就会跟着面板一起消失。
 */
async function runCompose(verb: ComposeVerb, file: FileEntry): Promise<void> {
  if (verb === 'down') {
    if (!(await useConfirmStore().ask(`compose down 会停止并删除 ${file.name} 定义的全部容器与网络（数据卷保留）。确认？`))) {
      return
    }
  }
  try {
    await composeStore.start({
      sessionId: fsSessionId.value,
      filePath: file.path,
      fileName: file.name,
      verb,
      containerName: ctrName.value
    })
  } catch (err) {
    errorMsg.value = `compose 启动失败：${errorText(err)}`
  }
}

async function onMenuSelect(id: string): Promise<void> {
  const targets = menuTargets
  closeMenu()
  if (id === 'enter-project') {
    // 行上 = 以该文件夹为根；空白处（targets 为空）= 以当前目录为根
    enterProject(targets[0]?.path ?? cwd.value)
    return
  }
  if (id === 'search-in-folder') {
    // 空白处 = 项目根（范围 chip 不显示，就是全项目搜索）
    searchInFolder(targets[0]?.isDir ? targets[0].path : projectRoot.value)
    return
  }
  if (id === 'exit-project') {
    void exitProject()
    return
  }
  if (id === 'new-folder') {
    // 项目模式：在树里就地开内联输入（目录行 → 它里面；空白 → 项目根）
    const dir = targets[0]?.isDir ? targets[0].path : projectRoot.value
    treeRef.value?.beginCreate(dir)
    return
  }
  if (id === 'open-terminal') {
    // 目录行 → 进它；文件行 → 它所在目录；空白处 → 当前目录（项目模式 = 项目根）
    const dir =
      mode.value === 'project'
        ? targets.length === 1
          ? targets[0].isDir
            ? targets[0].path
            : parentOf(targets[0].path)
          : projectRoot.value
        : targets.length === 1 && targets[0].isDir
          ? targets[0].path
          : cwd.value
    openInTerminal(dir)
    return
  }
  if (id === 'paste') {
    // 项目模式：目录行 → 粘进它；其余（空白）→ 项目根。browse 口径不变：当前目录
    const dir =
      mode.value === 'project'
        ? targets.length === 1 && targets[0].isDir
          ? targets[0].path
          : projectRoot.value
        : cwd.value
    await pasteClipboard(dir)
    return
  }
  if (!targets.length) return
  if (id === 'copy-path') void copyPaths(targets, false)
  else if (id === 'copy-rel-path') void copyPaths(targets, true)
  else if (id === 'download') await downloadTargets(targets)
  else if (id === 'archive') await archiveTargets(targets)
  else if (id === 'copy') {
    panelClipboard.value = { key: panelKey.value, paths: targets.map((t) => t.path), isLocal: isLocal.value }
    clearSelection()
  } else if (id === 'rename') startRename(targets[0])
  else if (id === 'delete') await removeTargets(targets)
  else if (id.startsWith('compose-')) await runCompose(id.slice('compose-'.length) as ComposeVerb, targets[0])
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
      // 产物 .tar.gz 落在第一个目标的同级目录（sftpArchive 的落点口径）
      await refreshAfterOp([parentOf(targets[0].path)])
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
  if (!(await useConfirmStore().ask(`确认删除选中的 ${targets.length} 项？${hint}。不可恢复。`))) return
  try {
    // 批量一条命令删（rm 逐操作数独立：一项失败不耽误其他项，失败原因进错误信息）
    await window.api.sftpDeleteMany(
      fsSessionId.value,
      targets.map((t) => ({ path: t.path, isDir: t.isDir })),
      ctrName.value
    )
  } catch (err) {
    errorMsg.value = `删除过程中出错：${errorText(err)}`
    // 重试整批（每一项独立成败，重跑一遍不会重复删已删掉的：rm 对不存在的路径只报错）
    retryAction.value = () =>
      window.api.sftpDeleteMany(
        fsSessionId.value,
        targets.map((t) => ({ path: t.path, isDir: t.isDir })),
        ctrName.value
      )
  } finally {
    clearSelection()
    await refreshAfterOp(targets.map((t) => parentOf(t.path)))
  }
}

/**
 * 在终端中 cd 到指定目录（默认当前目录）。
 * 唯一改动终端 cwd 的入口 —— 面板里翻目录只是「找文件」，
 * 主动导航永远不动终端（见 load/history，均无终端副作用）。
 */
function openInTerminal(dir?: string): void {
  const target = dir ?? cwd.value
  if (isLocal.value && localShellKind === 'cmd') {
    // cmd 跨盘符必须 /d：cd "D:\…" 只改 D: 的记录目录，不切当前盘（同盘也兼容）
    window.api.input(props.sessionId, `cd /d "${target}"\r`)
  } else if (isLocal.value && localShellKind === 'none' && isWinPath(target)) {
    // WSL（integration 'none' 且面板给的是盘符路径）：bash 不认 `D:\…`，翻成 /mnt/d/…
    const m = target.match(/^([A-Za-z]):[\\/]+(.*)$/)!
    const mnt = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
    window.api.input(props.sessionId, `cd '${mnt.replace(/'/g, `'\\''`)}'\r`)
  } else {
    // 引号按 shell 种类选：cmd 不认单引号；PowerShell 单引号内单引号写两个。
    // Git Bash 归 posix 分支：MSYS 运行时的 cd 认 `D:\…`（实测）
    const quoted = isLocal.value && localShellKind === 'powershell'
      ? `'${target.replace(/'/g, "''")}'`
      : `'${target.replace(/'/g, `'\\''`)}'`
    window.api.input(props.sessionId, `cd ${quoted}\r`)
  }
  // cd 打过去还得让用户看见：聚焦到挂着这个会话的终端标签，
  // 否则点了像没反应（SFTP 面板开着时终端可能在别的标签）
  const tab = store.tabs.find((t) => t.panes.some((p) => p.sessionId === props.sessionId))
  if (tab) store.activeTabId = tab.tabId
}

// ---- 拖拽上传 ----
/** DataTransfer → DroppedFile（webUtils 解析真实路径；行 drop 与面板 drop 共用） */
function droppedFilesOf(e: DragEvent): DroppedFile[] {
  return [...(e.dataTransfer?.files ?? [])].map((f) => ({
    path: window.api.getPathForFile(f),
    name: f.name,
    size: f.size
  }))
}

function enqueueTo(dir: string, files: DroppedFile[]): void {
  // 会话已断/远端不可写时不能静默失败，否则用户以为拖进去了
  if (files.length) void guard(() => window.api.enqueueDropped(fsSessionId.value, dir, files, ctrName.value))
}

function onDrop(e: DragEvent): void {
  dragOver.value = false
  dropRowPath.value = null
  const files = droppedFilesOf(e)
  // 项目模式落到树的选中目录（或根），browse 落当前目录
  const dir = mode.value === 'project' ? (treeRef.value?.selectedDirOrRoot() ?? projectRoot.value) : cwd.value
  enqueueTo(dir, files)
}

// ---- 行级 drop：拖到某个文件夹行上 = 传进那个文件夹（文件行 = 它所在目录）----
function onRowDragOver(e: DragEvent, entry: FileEntry): void {
  e.preventDefault()
  // 自己高亮自己，不让根面板再画整框虚线
  e.stopPropagation()
  dropRowPath.value = entry.path
}

function onRowDragLeave(e: DragEvent): void {
  // dragleave 在子元素间移动也会触发，relatedTarget 还在行内就不清高亮（防闪烁）
  const row = e.currentTarget as HTMLElement
  if (e.relatedTarget instanceof Node && row.contains(e.relatedTarget)) return
  dropRowPath.value = null
}

function onRowDrop(e: DragEvent, entry: FileEntry): void {
  e.preventDefault()
  // 关键：不能冒泡到 .explorer 根的 @drop —— 否则一次拖拽入队两批任务
  e.stopPropagation()
  dragOver.value = false
  dropRowPath.value = null
  enqueueTo(entry.isDir ? entry.path : parentOf(entry.path), droppedFilesOf(e))
}

/** 项目树行抛上来的 drop（树组件不碰 IPC，落点目录已算好） */
function onTreeDropFiles(p: { dir: string; files: DroppedFile[] }): void {
  dragOver.value = false
  enqueueTo(p.dir, p.files)
}

/** 拖拽中止（Esc / 拖出窗口）没有 drop 事件，残留的悬停高亮靠它兜底清掉 */
function onDragEnd(): void {
  dragOver.value = false
  dropRowPath.value = null
}

// ---- 项目模式：树的事件回调 ----
/**
 * 面板自己同步给终端的 cwd（「在终端打开」/新标签继承靠它）。
 * followTerminal watch 收到同一个值时必须跳过 —— 否则形成回环：
 * 点选 → setCwd → watch 当「终端 cd」→ reveal → select 单选 ——
 * 多选刚点上就被自己的 reveal 塌缩掉（只有开着「跟随终端」才踩得到）。
 */
let panelSetCwd = ''

/** 树选中变化：记住焦点行，并把 cwd 跟踪同步过去 */
function onTreeSelect(entry: FileEntry | null): void {
  treeSelected.value = entry
  if (entry) {
    panelSetCwd = entry.isDir ? entry.path : parentOf(entry.path)
    store.setCwd(props.sessionId, panelSetCwd)
  }
}

/** 树单击文件 → 预览打开（斜体标签，会被下一个预览替换） */
function onTreePreviewFile(entry: FileEntry): void {
  openInEditor(entry.path, { preview: true })
}

/** 树双击文件 → 固定打开（与 browse 的 openEntry 文件分支同一条路） */
function onTreeOpenFile(entry: FileEntry): void {
  openInEditor(entry.path)
}

// ---- 项目模式：全文搜索 ----
function toggleSearch(): void {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value) void nextTick(() => searchPanelRef.value?.focusInput())
}

/** 右键「从文件夹中查找」：搜索范围缩到那个子目录（顶栏搜索按钮始终是全项目） */
function searchInFolder(dir: string): void {
  searchRoot.value = dir
  if (!searchOpen.value) searchOpen.value = true
  void nextTick(() => searchPanelRef.value?.focusInput())
}

/** 点搜索结果 → 预览打开并跳到该行（搜索是翻找的重灾区，标签不再爆炸） */
function onSearchOpenMatch(p: { path: string; line: number }): void {
  openInEditor(p.path, { line: p.line, preview: true })
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

/** 落地路径是否在面板正在看的范围里（browse = 当前目录；项目模式 = 项目根）—— 别处的上传没必要刷这一屏 */
function isUnderBase(remotePath: string): boolean {
  const base = mode.value === 'project' ? projectRoot.value : cwd.value
  const sepChar = isWinLocal.value ? '\\' : '/'
  const prefix = base.endsWith(sepChar) ? base : `${base}${sepChar}`
  return remotePath.startsWith(prefix)
}

/** 这条任务是不是「我这个面板」的上传：容器认 containerName（remotePath 是中转路径，认不了目录），宿主机认目录归属 */
function isMyUpload(t: TransferTask): boolean {
  if (t.direction !== 'upload') return false
  if (props.container) return t.containerName === props.container.containerName
  return !t.containerName && isUnderBase(t.remotePath)
}

/** 项目模式下待刷新的树目录（debounce 期间攒着）；'all' = 容器的任务认不出落点目录，整树重列 */
let pendingTreeRefresh: Set<string> | 'all' = new Set()

function scheduleRefresh(): void {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    if (creatingDir.value || renamingPath.value) return
    if (mode.value === 'project') {
      const pend = pendingTreeRefresh
      pendingTreeRefresh = new Set()
      if (pend === 'all') void treeRef.value?.refreshAll()
      else for (const d of pend) void treeRef.value?.refreshDir(d)
    } else {
      pendingTreeRefresh = new Set()
      void load()
    }
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
        if (mode.value === 'project') {
          if (props.container) pendingTreeRefresh = 'all'
          else if (pendingTreeRefresh !== 'all') pendingTreeRefresh.add(parentOf(t.remotePath))
        }
      }
    }
    lastStatus = next
    if (touched) scheduleRefresh()
  })
}

// ---- 目录变更推送：终端里建/删文件，面板即时可见（VS Code 同款）----
/*
 * 链路：远端/容器 = agent fs_watch（inotify，复用 serve 通道）；本机 = 主进程 fs.watch。
 * 监听集合 = 「看得见的目录」（browse 的 cwd / 项目树根 + 已展开目录），
 * cd/展开/折叠时整组替换（幂等）。老 agent 没有这个方法 → 降级回手动刷新。
 */
/** 降级标记：agent 太老/没装时不再重试（面板回到点刷新的旧体验） */
let fsWatchDegraded = false
let fsWatchArmed = false
let fsWatchTimer: number | null = null
let unsubscribeFsWatch: (() => void) | null = null
/** 组件已卸载：syncFsWatch 的 IPC 在飞时撞上卸载，靠它在 await 后补退订 */
let disposed = false

/** 当前「看得见的目录」全量集合 */
function visibleDirs(): string[] {
  if (mode.value === 'project') return treeRef.value?.expandedDirs() ?? []
  return cwd.value ? [cwd.value] : []
}

/** 监听集合同步（300ms 防抖：cd/展开/折叠连串变化只发一次整组替换） */
function scheduleFsWatchSync(): void {
  if (fsWatchDegraded) return
  if (fsWatchTimer !== null) window.clearTimeout(fsWatchTimer)
  fsWatchTimer = window.setTimeout(() => {
    fsWatchTimer = null
    void syncFsWatch()
  }, 300)
}

async function syncFsWatch(): Promise<void> {
  const dirs = visibleDirs()
  try {
    if (isLocal.value) {
      await window.api.localFsWatch(fsSessionId.value, dirs)
      if (disposed) {
        // IPC 在飞时组件卸载了：本地监听是 (owner, sessionId) 键控，补退自己这份
        void window.api.localFsWatch(fsSessionId.value, [])
        return
      }
      fsWatchArmed = true
      return
    }
    if (fsWatchArmed) await window.api.agentUpdateFsWatch(fsSessionId.value, ctrName.value, dirs)
    else {
      await window.api.agentWatchFs(fsSessionId.value, ctrName.value, dirs)
      fsWatchArmed = true
    }
    if (disposed) {
      // 同上：arm 落在死组件上没人会退订，补一发
      void window.api.agentUnwatchFs(fsSessionId.value, ctrName.value)
      return
    }
  } catch (err) {
    // 只对「老 agent 没有这个方法」降级（不再重试）；
    // 重连窗口/通道抖动是瞬时的，保持现状让下次 sync 自然重试
    if (err instanceof Error && /unknown method/i.test(err.message)) fsWatchDegraded = true
  }
}

/** 变更事件 → 走上传刷新同一套防抖：项目模式重列受影响的树目录，browse 重列 cwd */
function watchFsEvents(): void {
  unsubscribeFsWatch = window.api.onAgentFsEvent((sid, ctr, data) => {
    if (sid !== fsSessionId.value) return
    if ((ctr ?? undefined) !== ctrName.value) return
    if (data.event === 'agent_closed') {
      // 通道死了：主进程按订阅意图在重连后自动重建，这里只需下次同步时重发集合
      fsWatchArmed = false
      return
    }
    if (data.event !== 'fs' || !data.dirs?.length) return
    if (mode.value === 'project') {
      if (pendingTreeRefresh !== 'all') for (const d of data.dirs) pendingTreeRefresh.add(d)
    }
    // browse 只盯了 cwd，有事件就是它变了（scheduleRefresh 的 browse 分支走 load()）
    scheduleRefresh()
  })
}

// 会话切换时重新加载
watch(() => props.sessionId, (newId, oldId) => {
  // 先退订旧会话的监听（组件不重挂载，旧泳道的 owner 一直占着，
  // 主进程归零判断永远过不了 → 远端 inotify 挂到窗口销毁）
  if (oldId && oldId !== newId) {
    if (oldId.startsWith(LOCAL_ID_PREFIX)) void window.api.localFsWatch(oldId, [])
    else if (fsWatchArmed) void window.api.agentUnwatchFs(oldId, ctrName.value)
  }
  // 新会话的 agent 情况未知：监听状态与降级标记都重来
  fsWatchArmed = false
  fsWatchDegraded = false
  void init()
})

// cd / 模式切换 → 监听集合跟着换（展开/折叠由树的 dirs-change 事件报上来）
watch([cwd, mode], scheduleFsWatchSync)

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
    if (!dir) return
    // 面板自己同步过去的值：不是终端在 cd，不能绕回去 reveal（会把多选塌缩成单选）
    if (dir === panelSetCwd) return
    if (mode.value === 'project') {
      // 根外目录不跳：待在项目里是「项目模式」的存在意义（要出去就退出项目模式）
      void treeRef.value?.reveal(dir)
    } else if (dir !== cwd.value) {
      nav(dir)
    }
  }
)

onMounted(() => {
  window.addEventListener('mousedown', onMouseNav, true)
  window.addEventListener('dragend', onDragEnd)
  watchTransfers()
  watchFsEvents()
  scheduleFsWatchSync()
  // 本机面板：解析终端跑的是哪种 shell（「在终端打开」的引号策略靠它，同 TerminalPanel）
  if (isLocal.value) {
    void window.api
      .listLocalShells()
      .then((shells) => {
        const cur = shells.find((sh) => sh.id === settings.localShellId) ?? shells[0]
        localShellKind = cur?.integration ?? null
      })
      .catch(() => undefined)
  }
  void init()
})
onBeforeUnmount(() => {
  disposed = true
  window.removeEventListener('mousedown', onMouseNav, true)
  window.removeEventListener('dragend', onDragEnd)
  unsubscribeTransfers?.()
  unsubscribeFsWatch?.()
  if (fsWatchTimer !== null) window.clearTimeout(fsWatchTimer)
  // 退订目录监听：本机清空集合，远端/容器摘泳道（通道是否收归 AgentManager 归零判断）
  if (isLocal.value) void window.api.localFsWatch(fsSessionId.value, [])
  else if (fsWatchArmed) void window.api.agentUnwatchFs(fsSessionId.value, ctrName.value)
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
    ref="explorerEl"
    class="explorer"
    :class="{ 'drag-over': dragOver }"
    tabindex="0"
    @keydown="onKeydown"
    @dragover.prevent="dragOver = true"
    @dragleave.prevent="((dragOver = false), (dropRowPath = null))"
    @drop.prevent="onDrop"
  >
    <!-- 工具栏（后退/前进/上一级/过滤是 browse 概念，项目模式下隐藏） -->
    <div class="toolbar">
      <button v-if="mode === 'browse'" class="icon-btn" title="后退（鼠标侧键）" :disabled="!historyBack.length" @click="historyGoBack">
        <Icon name="chevron-left" />
      </button>
      <button v-if="mode === 'browse'" class="icon-btn" title="前进（鼠标侧键）" :disabled="!historyFwd.length" @click="historyGoForward">
        <Icon name="chevron-right" />
      </button>
      <button v-if="mode === 'browse'" class="icon-btn" title="上一级" @click="goUp"><Icon name="arrow-up" /></button>
      <button class="icon-btn" title="刷新" @click="mode === 'project' ? treeRef?.refreshAll() : load()"><Icon name="refresh" /></button>
      <button
        class="icon-btn"
        title="新建文件夹"
        @click="mode === 'project' ? treeRef?.beginCreate(treeRef.selectedDirOrRoot()) : (creatingDir = true)"
      >
        <Icon name="folder-plus" />
      </button>
      <button
        class="icon-btn"
        :title="isLocal ? '选文件复制进当前目录' : '上传文件'"
        @click="pickUpload(mode === 'project' ? treeRef?.selectedDirOrRoot() : undefined)"
      ><Icon name="upload" /></button>
      <span class="spacer"></span>
      <!-- 过滤（Ctrl+F）：只过滤当前目录已加载的条目，客户端零往返 -->
      <input
        v-if="filterOpen && mode === 'browse'"
        ref="filterInput"
        v-model="filterText"
        class="filter-input"
        placeholder="过滤当前目录…"
        @keyup.esc="closeFilter"
      />
      <button
        v-if="mode === 'browse'"
        class="icon-btn"
        :class="{ active: filterOpen }"
        title="过滤当前目录（Ctrl/Cmd+F）"
        @click="filterOpen ? closeFilter() : openFilter()"
      ><Icon name="search" /></button>
      <button
        class="icon-btn"
        title="在终端中打开此目录"
        @click="openInTerminal(mode === 'project' ? treeRef?.selectedDirOrRoot() : undefined)"
      >
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
    <div v-if="mode === 'browse'" class="breadcrumb">
      <span v-if="props.container" class="ctr-badge" :title="`容器 ${props.container.containerName} 内的文件（经容器助手）`">
        <Icon name="box" :size="12" />{{ props.container.containerName }}
      </span>
      <span v-else-if="isLocal" class="ctr-badge" title="本机文件（本地终端标签）">
        <Icon name="monitor" :size="12" />本机
      </span>
      <!-- 本机 Windows 的根是「此电脑」（盘符列表），posix/远端的根是 / -->
      <template v-if="isWinLocal">
        <a class="crumb" title="此电脑" @click="nav(WIN_DRIVES)">此电脑</a>
        <template v-for="(crumb, i) in breadcrumbs" :key="crumb.path">
          <span class="sep">\</span>
          <a class="crumb" @click="nav(crumb.path)">{{ crumb.name }}</a>
        </template>
      </template>
      <template v-else>
        <a class="crumb" title="/" @click="nav('/')">/</a>
        <template v-for="(crumb, i) in breadcrumbs" :key="crumb.path">
          <span v-if="i > 0" class="sep">/</span>
          <a class="crumb" @click="nav(crumb.path)">{{ crumb.name }}</a>
        </template>
      </template>
      <!-- 打包期间的不确定进度：远端 tar 最长 5 分钟，没反馈就像卡死 -->
      <span v-if="archiving" class="archiving" title="正在远端打包…">
        <Spinner :size="12" />打包中…
      </span>
    </div>

    <!-- 项目模式顶栏：根名 + 退出（完整路径在 title） -->
    <div v-else class="project-bar">
      <span v-if="props.container" class="ctr-badge" :title="`容器 ${props.container.containerName} 内的文件（经容器助手）`">
        <Icon name="box" :size="12" />{{ props.container.containerName }}
      </span>
      <span v-else-if="isLocal" class="ctr-badge" title="本机文件（本地终端标签）">
        <Icon name="monitor" :size="12" />本机
      </span>
      <Icon name="folder" :size="13" />
      <span class="project-root" :title="projectRoot">{{ rootName }}</span>
      <span v-if="archiving" class="archiving" title="正在远端打包…">
        <Spinner :size="12" />打包中…
      </span>
      <span class="spacer"></span>
      <button class="icon-btn" title="退出项目模式" @click="exitProject">
        <Icon name="x" />
      </button>
    </div>

    <div v-if="errorMsg" class="error-banner">
      <span class="banner-text">{{ errorMsg }}</span>
      <button v-if="retryAction" class="retry" @click="retryLast">重试</button>
      <button class="icon-btn" title="关闭" @click="dismissError">
        <Icon name="x" :size="12" />
      </button>
    </div>

    <!-- 容器标签但没装容器助手：指路比报错好 -->
    <div v-if="agentMissing" class="hint">
      浏览容器文件需要容器里的 dox-agent。<br />
      请在侧栏「远程助手」点「安装到容器 {{ props.container?.containerName }}」。
    </div>

    <!-- 容器助手版本过旧：低于 fs 能力门槛（fs_* 方法不全的老二进制） -->
    <div v-else-if="agentOutdated" class="hint">
      容器助手 v{{ agentOutdated }} 过旧，文件管理需要 v{{ FS_MIN_AGENT_VERSION }}。<br />
      请在侧栏「远程助手」点「升级到 v{{ BUNDLED_AGENT_VERSION }}」。
    </div>

    <div v-else-if="loading && mode === 'browse'" class="hint"><Spinner text="加载中…" /></div>

    <!-- 文件列表；点空白处取消选中（和资源管理器一致） -->
    <div
      v-else-if="mode === 'browse'"
      class="file-list"
      @click.self="clearSelection"
      @contextmenu.self.prevent="onBlankContextMenu($event)"
    >
      <div v-if="creatingDir" class="row editing">
        <Icon class="file-icon" name="folder" :size="15" />
        <input
          v-model="newDirName"
          v-focus
          class="rename-input"
          placeholder="文件夹名"
          @keydown.enter="!$event.isComposing && submitNewDir(true)"
          @keyup.esc="cancelNewDir"
          @blur="submitNewDir()"
        />
      </div>

      <!-- 过滤命中 0 条要给话，不然像目录空了 -->
      <div v-if="filterText && !visibleEntries.length" class="hint">没有匹配「{{ filterText }}」的条目</div>
      <div
        v-for="(entry, index) in visibleEntries"
        :key="entry.path"
        class="row"
        :class="{ selected: isSelected(entry), 'drop-target': dropRowPath === entry.path }"
        @click="onRowClick($event, entry, index)"
        @contextmenu.prevent="onRowContextMenu($event, entry, index)"
        @dblclick="openEntry(entry)"
        @dragover="onRowDragOver($event, entry)"
        @dragleave="onRowDragLeave"
        @drop="onRowDrop($event, entry)"
      >
        <FileIcon :entry="entry" :size="15" />
        <input
          v-if="renamingPath === entry.path"
          v-model="renameValue"
          v-focus
          class="rename-input"
          @keydown.enter="!$event.isComposing && submitRename(entry, true)"
          @keyup.esc="cancelRename"
          @blur="submitRename(entry)"
        />
        <span v-else class="file-name" :title="entry.path">{{ entry.name }}</span>
        <span class="file-size">{{ entry.isDir ? '' : formatSize(entry.size) }}</span>
        <span class="file-time">{{ formatTime(entry.mtime) }}</span>
        <span class="row-actions">
          <button
            class="icon-btn"
            :title="isLocal ? '复制到…' : entry.isDir ? '下载文件夹（递归）' : '下载'"
            :disabled="pendingDownload === entry.path"
            @click.stop="downloadEntry(entry)"
          >
            <Spinner v-if="pendingDownload === entry.path" :size="13" />
            <Icon v-else name="download" />
          </button>
          <button class="icon-btn" title="重命名" @click.stop="startRename(entry)">
            <Icon name="pencil" />
          </button>
          <button class="icon-btn danger" title="删除" @click.stop="removeEntry(entry)">
            <Icon name="trash" />
          </button>
        </span>
      </div>

      <div v-if="!entries.length && !creatingDir" class="hint">
        {{ isLocal ? '空目录，拖拽文件到此处复制进来' : '空目录，拖拽文件到此处上传' }}
      </div>
    </div>

    <!-- 项目模式：左栏图标轨（项目/查找，VS Code 活动栏语义）+ 视图区。
         树用 v-show 保活 —— 懒加载缓存不能因开搜索打回冷启动 -->
    <template v-else>
      <div class="project-body">
        <div class="project-rail">
          <button
            class="rail-btn"
            :class="{ active: !searchOpen }"
            title="项目文件"
            @click="searchOpen = false"
          >
            <Icon name="folder" :size="16" />
          </button>
          <button
            class="rail-btn"
            :class="{ active: searchOpen }"
            title="在项目中搜索（Ctrl/Cmd+Shift+F）"
            @click="toggleSearch"
          >
            <Icon name="search" :size="16" />
          </button>
        </div>
        <ProjectTree
          v-show="!searchOpen"
          ref="treeRef"
          :root="projectRoot"
          :fs-session-id="fsSessionId"
          :container-name="ctrName"
          :is-win="isWinLocal"
          @select="onTreeSelect"
          @selection-change="treeSelection = $event"
          @preview-file="onTreePreviewFile"
          @open-file="onTreeOpenFile"
          @request-delete="removeTargets($event)"
          @row-contextmenu="onTreeRowContextMenu"
          @blank-contextmenu="onTreeBlankContextMenu"
          @rename-submit="renameTo($event.entry, $event.name)"
          @create-submit="createDirIn($event.dir, $event.name)"
          @drop-files="onTreeDropFiles"
          @dirs-change="scheduleFsWatchSync"
        />
        <SearchPanel
          v-show="searchOpen"
          ref="searchPanelRef"
          :root="searchRoot || projectRoot"
          :base-root="projectRoot"
          :fs-session-id="fsSessionId"
          :container-name="ctrName"
          :is-win="isWinLocal"
          :active="searchOpen"
          @close="searchOpen = false"
          @open-match="onSearchOpenMatch"
          @reset-scope="searchRoot = ''"
        />
      </div>
    </template>

    <!-- 磁盘用量分解（点用量条展开）：谁占的、各占多少，点目录直接跳进去 -->
    <div v-if="duOpen && usage && mode === 'browse'" class="du-panel">
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

    <!--
      磁盘用量条：目标不支持（无 statvfs 也无 agent）时整条不出现；点击展开分解。
      分解（du）是 agent 的能力 —— 本机面板的用量条只看不展开。
    -->
    <div
      v-if="usage && mode === 'browse'"
      class="usage-bar"
      :class="{ warn: usagePercent >= 85, open: duOpen }"
      :title="isLocal ? '' : (usage.mount ? `挂载点 ${usage.mount} · ` : '') + '点击展开占用分解'"
      @click="isLocal ? undefined : toggleDu()"
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
/* 键盘焦点环不外显：选中态本身可见，焦点只是快捷键的载体 */
.explorer:focus {
  outline: none;
}
.filter-input {
  width: 140px;
  padding: 3px 8px;
  font-size: var(--fs-sm);
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  outline: none;
}
.filter-input:focus {
  border-color: var(--focus-ring);
}
.explorer {
  width: 360px;
  position: relative; /* compose 结果卡 absolute 定位的锚 */
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
  margin-right: var(--sp-2);
  padding: 1px var(--sp-2);
  border-radius: var(--r-pill);
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
}
.archiving {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  margin-left: var(--sp-2);
  color: var(--accent-text);
  font-size: var(--fs-xs);
}
/* 项目模式：左栏图标轨 + 视图区（VS Code 活动栏语义） */
.project-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.project-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-1);
  width: 34px;
  flex-shrink: 0;
  padding-top: var(--sp-2);
  border-right: 1px solid var(--border);
}
.rail-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 32px;
  padding: 0;
  /* 无框图标：不要全局按钮的灰底边框，激活条先占住位置（切换不跳） */
  background: none;
  border: none;
  border-left: 2px solid transparent;
  border-radius: 0;
  color: var(--fg-muted);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.rail-btn:hover {
  background: var(--bg-hover);
}
.rail-btn:active {
  background: var(--bg-active);
  transform: translateY(0.5px);
}
.rail-btn.active {
  color: var(--accent-text);
  border-left-color: var(--accent-text);
}
/* 项目模式顶栏：与面包屑同高同位（切换模式时布局不跳） */
.project-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px 10px;
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  white-space: nowrap;
  border-bottom: 1px solid var(--border);
}
.project-root {
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: var(--fw-semibold);
  color: var(--fg);
}
.crumb {
  color: var(--accent-text);
  cursor: pointer;
  padding: 0 var(--sp-1);
  border-radius: var(--r-xs);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.crumb:hover {
  background: var(--bg-hover);
}
.crumb:active {
  background: var(--bg-active);
  transform: translateY(0.5px);
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
  gap: var(--sp-2);
  /* 左侧留出选中条的宽度，选中时内容不会整体右移 */
  padding: var(--sp-1) var(--sp-3) var(--sp-1) var(--sp-3);
  font-size: var(--fs-md);
  cursor: default;
  border-radius: var(--r-sm);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.row:hover {
  background: var(--bg-hover);
}
/* 按下：和全局控件同一套（深一档 + 半像素下沉）。原来是 scale(0.995)，
   在同一行里点会连带把文字一起缩放，看着发虚 */
.row:active {
  background: var(--bg-active);
  transform: translateY(0.5px);
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
/* 行级 drop 目标：拖到哪个文件夹行上就高亮哪一行（区别于整面板的虚线框） */
.row.drop-target {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
  background: var(--bg-hover);
}
/* 按下态统一在上面的 .row:active 里（深一档 + 半像素下沉） */
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
/* 横幅的长相在 styles.css 的全局 .error-banner（两边面板共用一个） */
.banner-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
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
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-3);
  transition: background-color var(--dur-fast) var(--ease-out);
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
  gap: var(--sp-2);
  padding: 3px var(--sp-3);
  transition: background-color var(--dur-fast) var(--ease-out);
  font-size: var(--fs-xs);
}
.du-row.clickable {
  cursor: pointer;
}
.du-row.clickable:hover {
  background: var(--bg-hover);
}
.du-row.clickable:active {
  background: var(--bg-active);
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
