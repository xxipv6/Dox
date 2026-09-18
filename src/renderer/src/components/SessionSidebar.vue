<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useSessionStore } from '../stores/sessions'
import { useConfirmStore } from '../stores/confirm'
import { useSettingsStore } from '../stores/settings'
import DeviceDialog from './DeviceDialog.vue'
import Icon from './Icon.vue'
import Spinner from './Spinner.vue'
import SidebarSection from './SidebarSection.vue'
import ForwardPanel from './ForwardPanel.vue'
import SnippetPanel from './SnippetPanel.vue'
import ContainerPanel from './ContainerPanel.vue'
import AgentPanel from './AgentPanel.vue'
import DockerManager from './DockerManager.vue'
import ContextMenu, { type ContextMenuItem } from './ContextMenu.vue'
import { vFocus } from '../directives/focus'
import { errorText } from '../utils/errors'
import type { ContainerInfo, SavedSession } from '@shared/types'
import { pushToast } from '../stores/toast'

const store = useSessionStore()
const settings = useSettingsStore()

const collapsed = ref(false)
const dialogVisible = ref(false)
const editing = ref<SavedSession | null>(null)

/** 设备过滤词。只看这一处，不落盘 —— 重启后回到「全部可见」才是可预期的 */
const filter = ref('')

/**
 * 按过滤词筛过的设备。
 *
 * 四个字段一起匹配，因为「记不住自己当初怎么命名的」是常态：
 * 有人记得叫「测试机」，有人记得是那台 10.0.0.5，有人记得登录名。
 * 只匹配名称的话，后两种人会觉得搜索是坏的。
 *
 * 不 trim 到「空则不过滤」以外的程度：输入过程中的空格不该让列表突然全空。
 */
const filteredSessions = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return store.savedSessions
  return store.savedSessions.filter((s) =>
    [s.name, s.host, s.username, String(s.port)].some((v) => v.toLowerCase().includes(q))
  )
})

// ---- 设备分组（group 是设备上的字符串标签；组实体 = distinct 值）----

/** 侧栏行：组头与设备行混排，设备块只有一份模板 */
type DeviceRow = { kind: 'group'; name: string; count: number } | { kind: 'device'; s: SavedSession }

/** 折叠状态持久化（localStorage）：刷新/重启后分组开合维持原样 */
const COLLAPSED_KEY = 'dox-collapsed-groups'
const collapsedGroups = ref<Set<string>>(new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]))

function persistCollapsed(): void {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedGroups.value]))
}

function toggleGroup(name: string): void {
  const next = new Set(collapsedGroups.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  collapsedGroups.value = next
  persistCollapsed()
}

/**
 * 用户显式创建的分组（含空分组）。
 *
 * 分组实体本来是设备上 group 字段的 distinct 值 —— 那「空分组」就不存在，
 * 而 ＋分组 按钮建出来的恰恰先是空的，只能靠这张显式名单记住它。
 * 一旦塞进设备，派生模型会接管；名字留在这里也无害（union 去重）。
 */
const GROUPS_KEY = 'dox-groups'
const knownGroups = ref<string[]>(JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '[]') as string[])

function persistKnownGroups(): void {
  localStorage.setItem(GROUPS_KEY, JSON.stringify(knownGroups.value))
}

/** 全部分组名：显式创建的按创建顺序在前，只在设备上出现的补在后面 */
const groupNames = computed<string[]>(() => {
  const names = [...knownGroups.value]
  for (const s of store.savedSessions) {
    if (s.group && !names.includes(s.group)) names.push(s.group)
  }
  return names
})

/** 未分组的在前（老用户的平铺列表位置不动），分组跟在后面；过滤时不出空组 */
const displayRows = computed<DeviceRow[]>(() => {
  const rows: DeviceRow[] = []
  const byGroup = new Map<string, SavedSession[]>()
  for (const name of groupNames.value) byGroup.set(name, [])
  const filtering = !!filter.value.trim()
  for (const s of filteredSessions.value) {
    if (s.group) byGroup.get(s.group)?.push(s)
    else rows.push({ kind: 'device', s })
  }
  for (const [name, list] of byGroup) {
    if (filtering && !list.length) continue
    rows.push({ kind: 'group', name, count: list.length })
    if (!collapsedGroups.value.has(name)) {
      for (const s of list) rows.push({ kind: 'device', s })
    }
  }
  return rows
})

/** ＋分组：在分组区末尾就地出输入框，空组也立得住（写进 knownGroups） */
const creatingGroup = ref(false)
const createGroupValue = ref('')

function startCreateGroup(): void {
  createGroupValue.value = ''
  creatingGroup.value = true
}

function submitCreateGroup(): void {
  const name = createGroupValue.value.trim()
  creatingGroup.value = false
  if (!name) return
  if (!knownGroups.value.includes(name)) {
    knownGroups.value = [...knownGroups.value, name]
    persistKnownGroups()
  }
  // 已存在也当作成功：把它展开，让用户看到「组在这儿」
  if (collapsedGroups.value.has(name)) {
    const next = new Set(collapsedGroups.value)
    next.delete(name)
    collapsedGroups.value = next
    persistCollapsed()
  }
}

/** 分组重命名：组头名字就地变输入框（与 ProjectTree 重命名同一模式） */
const renamingGroup = ref<string | null>(null)
const renameValue = ref('')
/** 「新分组…」：在哪台设备行下面出输入框（提交即把该设备移进去） */
const newGroupFor = ref<string | null>(null)
const newGroupValue = ref('')

/** Enter/blur 提交、Esc 取消：editing 态先置空，输入框卸载时 blur 再进来也是空转 */
function submitGroupRename(): void {
  const old = renamingGroup.value
  renamingGroup.value = null
  const name = renameValue.value.trim()
  if (!old || !name || name === old) return
  // 显式分组名单同步改名 —— 空分组只有这一处记录，store 那边没有设备可改。
  // 新名已存在 = 合并：旧名从名单里去掉，设备由 store.renameGroup 全部迁过去
  const idx = knownGroups.value.indexOf(old)
  if (idx >= 0) {
    const next = knownGroups.value.filter((g) => g !== old && g !== name)
    next.splice(Math.min(idx, next.length), 0, name)
    knownGroups.value = next
    persistKnownGroups()
  }
  // 折叠态跟着名字走，不然改完名组会突然展开/消失
  if (collapsedGroups.value.has(old)) {
    const next = new Set(collapsedGroups.value)
    next.delete(old)
    next.add(name)
    collapsedGroups.value = next
    persistCollapsed()
  }
  void store.renameGroup(old, name)
}

function submitNewGroup(): void {
  const savedId = newGroupFor.value
  newGroupFor.value = null
  const name = newGroupValue.value.trim()
  if (!savedId || !name) return
  const saved = store.savedSessions.find((s) => s.id === savedId)
  if (saved) void store.moveToGroup(saved, name)
}

// ---- 拖拽归组 ----
/*
 * 手势口径（文件管理器惯例）：
 *   拖到组头上          → 进这个组
 *   拖到某台设备上      → 跟它同组（它没组 = 移出分组；两台都没组 = 现场建组）
 * dataTransfer.types 在 dragover 阶段可读（data 不可读），够用来做落点高亮。
 */
const DND_MIME = 'application/x-dox-device'
const dragDeviceId = ref<string | null>(null)
/** 悬停落点：`g:组名` 或设备 id（高亮用） */
const dropTarget = ref<string | null>(null)

function dndOurs(e: DragEvent): boolean {
  return !!e.dataTransfer?.types.includes(DND_MIME)
}

function onDeviceDragStart(e: DragEvent, s: SavedSession): void {
  dragDeviceId.value = s.id
  e.dataTransfer?.setData(DND_MIME, s.id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDeviceDragEnd(): void {
  dragDeviceId.value = null
  dropTarget.value = null
}

function onGroupDragOver(e: DragEvent, name: string): void {
  if (!dndOurs(e)) return
  e.preventDefault()
  dropTarget.value = `g:${name}`
}

function onDeviceDragOver(e: DragEvent, s: SavedSession): void {
  if (!dndOurs(e) || s.id === dragDeviceId.value) return
  e.preventDefault()
  dropTarget.value = s.id
}

/** dragleave 在子元素间乱冒：relatedTarget 还在行内就不算离开 */
function onRowDragLeave(e: DragEvent, key: string): void {
  if (
    e.relatedTarget instanceof Node &&
    e.currentTarget instanceof HTMLElement &&
    e.currentTarget.contains(e.relatedTarget)
  ) {
    return
  }
  if (dropTarget.value === key) dropTarget.value = null
}

function draggedSession(): SavedSession | undefined {
  return store.savedSessions.find((s) => s.id === dragDeviceId.value)
}

async function onDropOnGroup(e: DragEvent, name: string): Promise<void> {
  if (!dndOurs(e)) return
  e.preventDefault()
  const s = draggedSession()
  onDeviceDragEnd()
  if (s && s.group !== name) await store.moveToGroup(s, name)
}

async function onDropOnDevice(e: DragEvent, target: SavedSession): Promise<void> {
  if (!dndOurs(e)) return
  e.preventDefault()
  const s = draggedSession()
  onDeviceDragEnd()
  if (!s || s.id === target.id) return
  if (target.group) {
    if (s.group !== target.group) await store.moveToGroup(s, target.group)
    return
  }
  if (s.group) {
    await store.moveToGroup(s, undefined)
    return
  }
  // 两台都没组：拖到一起 = 现场建组（两台都进），名字马上可改
  const name = uniqueGroupName()
  await store.moveToGroup(target, name)
  await store.moveToGroup(s, name)
  renameValue.value = name
  renamingGroup.value = name
}

function uniqueGroupName(): string {
  let name = '新分组'
  let i = 2
  while (groupNames.value.includes(name)) name = `新分组 ${i++}`
  return name
}

function isDeviceActive(session: SavedSession): boolean {
  return store.tabs.some((tab) => tab.kind === 'ssh' && tab.savedSessionId === session.id)
}

onMounted(() => store.refreshSaved())

/** 未保存会话的「重新连接」：把地址预填进添加设备弹窗，密码仍需用户输入 */
const prefill = ref<{ host: string; port: number; username: string } | null>(null)

watch(
  () => store.addDevicePrefill,
  (req) => {
    if (!req) return
    editing.value = null
    prefill.value = req
    dialogVisible.value = true
    store.clearAddDeviceRequest()
  }
)

// 密码解密失败（钥匙串身份变更）→ 自动打开该设备的编辑框，重输密码即自愈
watch(
  () => store.editSessionRequest,
  (req) => {
    if (!req) return
    openEdit(req)
    store.clearEditSessionRequest()
  }
)

function closeDialog(): void {
  dialogVisible.value = false
  prefill.value = null
}

function openAdd(): void {
  editing.value = null
  prefill.value = null
  dialogVisible.value = true
}

function openEdit(s: SavedSession): void {
  editing.value = s
  prefill.value = null
  dialogVisible.value = true
}

async function remove(s: SavedSession): Promise<void> {
  if (!(await useConfirmStore().ask(`删除设备「${s.name}」？`))) return
  await store.deleteSaved(s.id)
}

// ---- 设备行右键菜单：容器管理抽屉的入口 ----

const deviceMenu = ref<{ x: number; y: number; saved: SavedSession } | null>(null)
/** 容器管理抽屉开着哪台设备（null = 没开） */
const dockerManagerFor = ref<SavedSession | null>(null)

const deviceMenuItems = computed<ContextMenuItem[]>(() => {
  const s = deviceMenu.value?.saved
  if (!s) return []
  const items: ContextMenuItem[] = [
    { id: 'connect', label: '连接', icon: 'play' },
    { id: 'docker', label: '容器管理', icon: 'box' },
    { id: 'edit', label: '编辑', icon: 'pencil' },
    { separator: true, id: 'sep-group', label: '' }
  ]
  // 移动到分组：已有分组逐个列出（自己所在的组除外），加「新分组…」入口
  for (const g of groupNames.value) {
    if (g !== s.group) items.push({ id: `move:${g}`, label: `移动到「${g}」`, icon: 'folder' })
  }
  items.push({ id: 'move:new', label: '新分组…', icon: 'folder-plus' })
  if (s.group) items.push({ id: 'move:out', label: '移出分组', icon: 'x' })
  items.push(
    { separator: true, id: 'sep-danger', label: '' },
    { id: 'remove', label: '删除', icon: 'trash', danger: true }
  )
  return items
})

function onDeviceMenu(e: MouseEvent, s: SavedSession): void {
  deviceMenu.value = { x: e.clientX, y: e.clientY, saved: s }
}

async function onDeviceMenuSelect(id: string): Promise<void> {
  const s = deviceMenu.value?.saved
  deviceMenu.value = null
  if (!s) return
  if (id.startsWith('move:')) {
    const g = id.slice(5)
    // 「新分组…」不落库：分组由设备反推，空组不存在 —— 先出输入框，填了名才算数
    if (g === 'new') {
      newGroupValue.value = ''
      newGroupFor.value = s.id
    }
    else if (g === 'out') await store.moveToGroup(s, undefined)
    else await store.moveToGroup(s, g)
    return
  }
  if (id === 'connect') await store.connectSaved(s)
  else if (id === 'docker') dockerManagerFor.value = s
  else if (id === 'edit') openEdit(s)
  else if (id === 'remove') await remove(s)
}

// ---- 分组头右键菜单 ----

const groupMenu = ref<{ x: number; y: number; name: string } | null>(null)

const groupMenuItems = computed<ContextMenuItem[]>(() => [
  { id: 'rename', label: '重命名分组', icon: 'pencil' },
  { id: 'ungroup', label: '解散分组', icon: 'x' }
])

function onGroupMenu(e: MouseEvent, name: string): void {
  groupMenu.value = { x: e.clientX, y: e.clientY, name }
}

async function onGroupMenuSelect(id: string): Promise<void> {
  const name = groupMenu.value?.name
  groupMenu.value = null
  if (!name) return
  if (id === 'rename') {
    renameValue.value = name
    renamingGroup.value = name
  }
  // 解散只是把设备移回未分组，设备本身不删 —— 可逆，不劳确认弹窗
  else if (id === 'ungroup') {
    knownGroups.value = knownGroups.value.filter((g) => g !== name)
    persistKnownGroups()
    if (collapsedGroups.value.has(name)) {
      const next = new Set(collapsedGroups.value)
      next.delete(name)
      collapsedGroups.value = next
      persistCollapsed()
    }
    await store.ungroup(name)
  }
}

// ---- 设备行展开的容器列表：右键菜单（与 ContainerPanel 同一套动作）----

/** 容器行的右键菜单状态：哪台设备、哪个容器、在哪 */
const ctrMenu = ref<{ x: number; y: number; saved: SavedSession; box: ContainerInfo } | null>(null)
/** 正在做生命周期操作的容器名（启动/停止/恢复/删除） */
const ctrControlling = ref<string | null>(null)

/** 与 ContainerPanel 相同：按容器状态出菜单，stop/remove 落手前有确认 */
const ctrMenuItems = computed<ContextMenuItem[]>(() => {
  const box = ctrMenu.value?.box
  if (!box) return []
  const busy = ctrControlling.value === box.name
  const items: ContextMenuItem[] = []
  if (box.state === 'running') {
    items.push(
      { id: 'enter', label: '进入', icon: 'terminal', disabled: busy },
      { id: 'logs', label: '查看日志', icon: 'file', disabled: busy },
      { id: 'stop', label: '停止', icon: 'square', disabled: busy }
    )
  } else if (box.state === 'paused') {
    items.push(
      { id: 'unpause', label: '恢复', icon: 'play', disabled: busy },
      { id: 'logs', label: '查看日志', icon: 'file', disabled: busy }
    )
  } else {
    items.push(
      { id: 'start', label: '启动', icon: 'play', disabled: busy },
      { id: 'logs', label: '查看日志', icon: 'file', disabled: busy },
      { id: 'remove', label: '删除', icon: 'trash', danger: true, disabled: busy }
    )
  }
  return items
})

const CTR_CONFIRMS: Record<string, (name: string) => string> = {
  stop: (n) => `停止容器「${n}」？其中运行的服务会中断。`,
  remove: (n) => `删除容器「${n}」？此操作不可恢复（镜像与数据卷不受影响）。`
}

function onCtrRowMenu(e: MouseEvent, saved: SavedSession, box: ContainerInfo): void {
  ctrMenu.value = { x: e.clientX, y: e.clientY, saved, box }
}

async function onCtrMenuSelect(id: string): Promise<void> {
  const target = ctrMenu.value
  ctrMenu.value = null
  if (!target) return
  const { saved, box } = target
  // 容器操作骑在这台设备的传输会话上（就是列它们用的那条）
  const tid = store.transports[saved.id]
  if (!tid) return

  if (id === 'enter') {
    await store.enterContainerDirect(saved, box)
    return
  }
  if (id === 'logs') {
    try {
      await store.viewContainerLogs(tid, box, saved.id)
    } catch (err) {
      pushToast(`查看日志失败：${errorText(err)}`)
    }
    return
  }

  const ask = CTR_CONFIRMS[id]
  if (ask && !(await useConfirmStore().ask(ask(box.name)))) return
  ctrControlling.value = box.name
  try {
    await window.api.controlContainer(tid, box.name, id as 'start' | 'stop' | 'unpause' | 'remove')
    // 状态变化异步体现在 docker ps 里，稍等再刷
    await new Promise((r) => setTimeout(r, 600))
    await store.loadDeviceContainers(saved.id)
  } catch (err) {
    pushToast(`操作失败：${errorText(err)}`)
    await store.loadDeviceContainers(saved.id)
  } finally {
    ctrControlling.value = null
  }
}
</script>

<template>
  <aside class="sidebar" :class="{ collapsed }">
    <div class="sidebar-header">
      <!--
        这里**不再**放标记和字标 —— 品牌已经由最上面的自绘标题栏承担
        （那里也有 logo + Dox），两处都放就是同一个词在 47px 内出现两遍。
        空出来的位置给设备过滤：设备一多，这个比一个重复的标题有用得多。
      -->
      <label v-if="!collapsed" class="header-search">
        <Icon class="search-icon" name="search" :size="14" />
        <input
          v-model="filter"
          class="search-input"
          type="text"
          placeholder="搜索设备"
          spellcheck="false"
          autocomplete="off"
        />
        <button
          v-if="filter"
          class="icon-btn search-clear"
          type="button"
          title="清空"
          @click.prevent="filter = ''"
        >
          <Icon name="x" :size="12" />
        </button>
      </label>

      <span class="header-actions">
        <!--
          主题一键切。图标显示的是**将要切到**的目标（当前是亮色就显示月亮），
          和标题文案一致，不会出现「点太阳结果变亮了」这种歧义。
        -->
        <button
          class="icon-btn theme-toggle"
          :title="settings.resolvedTheme === 'dark' ? '切换到亮色主题' : '切换到深色主题'"
          @click="settings.toggleTheme()"
        >
          <Icon :name="settings.resolvedTheme === 'dark' ? 'sun' : 'moon'" :size="16" />
        </button>
        <button v-if="!collapsed" class="icon-btn" title="设置" @click="settings.openDialog()">
          <Icon name="settings" :size="16" />
        </button>
        <button class="icon-btn" :title="collapsed ? '展开' : '收起'" @click="collapsed = !collapsed">
          <Icon :name="collapsed ? 'chevron-right' : 'panel-left'" :size="16" />
        </button>
      </span>
    </div>

    <div v-if="!collapsed" class="sidebar-body">
      <!--
        侧栏只保留一种标题形状（SidebarSection）：可点的行 + 图标 + 箭头。
        原先是一个「工具」大标题下面并排三个同级小标题，四行字视觉重量差不多，
        分不清哪层是分组哪层是内容 —— 现在层级由折叠表达。
      -->
      <SidebarSection title="设备" icon="server" :open="true">
        <template #actions>
          <button class="icon-btn" title="新建分组（把设备拖进来归组）" @click="startCreateGroup">
            <Icon name="folder-plus" :size="15" />
          </button>
          <button class="icon-btn" title="添加设备" @click="openAdd">
            <Icon name="plus" :size="15" />
          </button>
        </template>

        <div class="device-list">
          <!-- 「一台都没有」和「都被过滤掉了」是两回事，文案不能共用；
               空态整行可点 —— 「点右侧 ＋」那个按钮 hover 才显形，新用户未必找得到 -->
          <div
            v-if="!store.savedSessions.length"
            class="empty-hint clickable"
            title="添加设备"
            @click="openAdd"
          >
            还没有设备，点这里添加
          </div>
          <div v-else-if="!filteredSessions.length" class="empty-hint">
            没有匹配「{{ filter.trim() }}」的设备
          </div>
          <template v-for="row in displayRows" :key="row.kind === 'group' ? `g:${row.name}` : row.s.id">
            <!-- 分组头：点击折叠/展开（状态落 localStorage），右键重命名/解散；
                 也是拖拽落点 —— 设备拖上来即进组 -->
            <div
              v-if="row.kind === 'group'"
              class="group-head"
              :class="{ 'drop-target': dropTarget === `g:${row.name}` }"
              @click="toggleGroup(row.name)"
              @contextmenu.prevent="onGroupMenu($event, row.name)"
              @dragover="onGroupDragOver($event, row.name)"
              @dragleave="onRowDragLeave($event, `g:${row.name}`)"
              @drop="onDropOnGroup($event, row.name)"
            >
              <span class="group-chevron" :class="{ open: !collapsedGroups.has(row.name) }">
                <Icon name="chevron-right" :size="12" />
              </span>
              <input
                v-if="renamingGroup === row.name"
                v-model="renameValue"
                v-focus
                class="rename-input"
                @keydown.enter="!$event.isComposing && submitGroupRename()"
                @keyup.esc="renamingGroup = null"
                @blur="submitGroupRename()"
                @click.stop
              />
              <template v-else>
                <span class="group-name">{{ row.name }}</span>
                <span class="group-count">{{ row.count }}</span>
              </template>
            </div>
            <div
              v-else
              class="device-block"
              :class="{ 'in-group': !!row.s.group }"
            >
            <div
              class="device"
              :class="{ active: isDeviceActive(row.s), 'drop-target': dropTarget === row.s.id }"
              :title="`${row.s.username}@${row.s.host}:${row.s.port} — 双击连接 · 可拖拽归组`"
              draggable="true"
              @dragstart="onDeviceDragStart($event, row.s)"
              @dragend="onDeviceDragEnd"
              @dragover="onDeviceDragOver($event, row.s)"
              @dragleave="onRowDragLeave($event, row.s.id)"
              @drop="onDropOnDevice($event, row.s)"
              @dblclick="store.connectSaved(row.s)"
              @contextmenu.prevent="onDeviceMenu($event, row.s)"
            >
              <!--
                展开容器列表（直连容器，Dev Containers 式）：箭头单独一个按钮，
                不抢整行的双击连接；展开期间设备底下列出运行中的容器，点名字直接进。
              -->
              <button
                class="icon-btn device-expand"
                :class="{ open: store.expandedDevices.has(row.s.id) }"
                :title="store.expandedDevices.has(row.s.id) ? '收起容器列表' : '列出容器（直连进容器）'"
                @click.stop="store.toggleDeviceContainers(row.s)"
                @dblclick.stop
              >
                <Icon name="chevron-right" :size="12" />
              </button>
              <Icon class="device-icon" name="server" :size="15" />
              <span class="device-info">
                <span class="device-name">
                  <span v-if="row.s.jumpHostId" class="jump-badge" title="经跳板机连接">
                    <Icon name="link" :size="12" />
                  </span>{{ row.s.name }}
                </span>
                <span class="device-host">{{ row.s.username }}@{{ row.s.host }}:{{ row.s.port }}</span>
              </span>
              <!-- 同时拦截 click 与 dblclick：只 stop click 的话，连点两下 × 会
                   触发整行的 dblclick（去连接），看起来就像「删除没反应」 -->
              <span class="device-actions" @dblclick.stop>
                <button class="icon-btn" title="连接" @click.stop="store.connectSaved(row.s)">
                  <Icon name="play" />
                </button>
                <button class="icon-btn" title="编辑" @click.stop="openEdit(row.s)">
                  <Icon name="pencil" />
                </button>
                <button class="icon-btn danger" title="删除" @click.stop="remove(row.s)">
                  <Icon name="x" />
                </button>
              </span>
            </div>

            <!-- 「新分组…」的就地输入框：挂在发起设备行下面，填名即把该设备移进去 -->
            <div v-if="newGroupFor === row.s.id" class="group-new-row">
              <input
                v-model="newGroupValue"
                v-focus
                class="rename-input"
                placeholder="分组名"
                spellcheck="false"
                @keydown.enter="!$event.isComposing && submitNewGroup()"
                @keyup.esc="newGroupFor = null"
                @blur="submitNewGroup()"
              />
            </div>

            <!-- 直连容器：不开宿主机终端标签，点容器名直接进（后台传输会话承载） -->
            <div v-if="store.expandedDevices.has(row.s.id)" class="device-containers">
              <div class="containers-head">
                <span class="containers-title">容器</span>
                <button
                  class="icon-btn"
                  :class="{ dim: store.deviceContainers[row.s.id]?.status === 'loading' }"
                  title="刷新容器列表"
                  @click="store.loadDeviceContainers(row.s.id)"
                >
                  <Icon name="refresh" :size="12" />
                </button>
              </div>
              <div v-if="store.deviceContainers[row.s.id]?.status === 'loading'" class="container-hint">
                <Spinner text="正在列出容器…" />
              </div>
              <div v-else-if="store.deviceContainers[row.s.id]?.status === 'error'" class="container-hint">
                <span class="container-error">{{ store.deviceContainers[row.s.id].error }}</span>
                <button class="container-retry retry" type="button" @click="store.loadDeviceContainers(row.s.id)">
                  重试
                </button>
              </div>
              <template v-else>
                <div v-if="!store.deviceContainers[row.s.id]?.list.length" class="container-hint">
                  这台设备上没有容器
                </div>
                <div
                  v-for="c in store.deviceContainers[row.s.id]?.list ?? []"
                  :key="c.id"
                  class="device-container"
                  :class="{ paused: c.state === 'paused' }"
                  :title="`${c.name}\n${c.image}\n${c.status}\n单击进入 · 右键更多操作`"
                  @click="c.state === 'running' && store.enterContainerDirect(row.s, c)"
                  @contextmenu.prevent="onCtrRowMenu($event, row.s, c)"
                >
                  <span class="dot" :class="[c.state, c.health]"></span>
                  <span class="container-name">{{ c.name }}</span>
                  <span v-if="ctrControlling === c.name" class="container-image">处理中…</span>
                  <span v-else class="container-image">{{ c.image }}</span>
                </div>
              </template>
            </div>
          </div>
          </template>
          <!-- ＋分组 的就地输入框：跟在分组区末尾，建出来就是个（可以为空的）组 -->
          <div v-if="creatingGroup" class="group-head">
            <span class="group-chevron open">
              <Icon name="chevron-right" :size="12" />
            </span>
            <input
              v-model="createGroupValue"
              v-focus
              class="rename-input"
              placeholder="分组名"
              spellcheck="false"
              @keydown.enter="!$event.isComposing && submitCreateGroup()"
              @keyup.esc="creatingGroup = false"
              @blur="submitCreateGroup()"
              @click.stop
            />
          </div>
        </div>
      </SidebarSection>

      <div class="sidebar-tools">
        <div class="tools-label">工具</div>
        <ForwardPanel />
        <ContainerPanel />
        <AgentPanel />
        <SnippetPanel />
      </div>
    </div>

    <DeviceDialog
      :visible="dialogVisible"
      :editing="editing"
      :prefill="prefill"
      @close="closeDialog"
    />

    <ContextMenu
      v-if="ctrMenu"
      :x="ctrMenu.x"
      :y="ctrMenu.y"
      :items="ctrMenuItems"
      @select="onCtrMenuSelect"
      @close="ctrMenu = null"
    />

    <ContextMenu
      v-if="deviceMenu"
      :x="deviceMenu.x"
      :y="deviceMenu.y"
      :items="deviceMenuItems"
      @select="onDeviceMenuSelect"
      @close="deviceMenu = null"
    />

    <ContextMenu
      v-if="groupMenu"
      :x="groupMenu.x"
      :y="groupMenu.y"
      :items="groupMenuItems"
      @select="onGroupMenuSelect"
      @close="groupMenu = null"
    />

    <DockerManager
      v-if="dockerManagerFor"
      :saved="dockerManagerFor"
      @close="dockerManagerFor = null"
    />
  </aside>
</template>

<style scoped>
.sidebar {
  width: 288px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  transition: width var(--dur-slow) var(--ease-out);
  /*
   * 它是网格项：默认 min-height: auto 会让长内容（几十台容器/设备）把
   * 1fr 行轨顶出视口 —— 表现为「滚轮滚不动、下面的分区看不见」，其实是
   * 整条侧栏长到了窗口外，sidebar-body 的 overflow 根本没机会生效。
   */
  min-height: 0;
  /* 同理：宽度也被网格管着，别让自己的内容顶破 */
  min-width: 0;
}
.sidebar.collapsed {
  width: 52px;
  align-items: center;
}
/*
 * 应用标题栏：固定高度 + 下边框，和下面的内容切成两块。
 * 原来是整条侧栏一起滚 —— 内容一长，「Dox」和那几个按钮就滚没了，
 * 想切主题还得先滚回顶部。标题栏现在不参与滚动。
 */
.sidebar-header {
  flex-shrink: 0;
  height: 44px;
  padding: 0 var(--sp-2) 0 var(--sp-3);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  /* 过滤框占满剩余宽度，动作按钮靠右收尾 */
  justify-content: flex-end;
  border-bottom: 1px solid var(--border);
}
.sidebar.collapsed .sidebar-header {
  height: auto;
  padding: var(--sp-3) 0;
  border-bottom: none;
  flex-direction: column;
  gap: var(--sp-1);
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

/*
 * 设备过滤框。
 *
 * 底色用 --bg 而不是 --bg-panel：这一条本身就在 --bg-panel 上，
 * 输入框要比它「凹进去」一点才像个可输入的槽。
 * 聚焦时边框转主色 —— 界面上唯一会亮起来的主色信号，不会认错。
 */
.header-search {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 var(--sp-2);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  transition:
    border-color var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out);
}
.header-search:focus-within {
  border-color: var(--accent);
  background: var(--bg-panel);
}
.search-icon {
  color: var(--fg-muted);
}
.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  outline: none;
  padding: 0;
  font-family: inherit;
  font-size: var(--fs-sm);
  color: var(--fg);
}
.search-input::placeholder {
  color: var(--fg-muted);
}
/* 28px 的槽里塞不下 22px 的按钮再留左右内边距，清空按钮自己收窄 */
.search-clear {
  width: 18px;
  height: 18px;
  padding: 0;
}
/*
 * 顶栏那几枚按钮给足点击区：.icon-btn 默认 padding 3px，
 * 配 16px 图标只有约 22px，比这一排的视觉重量小、也比别处的行高小，
 * 点起来要瞄。这里放到 28×28（图标不变，只加留白）。
 */
.sidebar-header .icon-btn {
  width: 28px;
  height: 28px;
  padding: 0;
}
/* 滚动只发生在这一层 */
.sidebar-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-3) var(--sp-2) var(--sp-2);
  display: flex;
  flex-direction: column;
}
.sidebar-tools {
  margin-top: auto;
  padding-top: var(--sp-4);
}
.tools-label {
  padding: 0 var(--sp-3) var(--sp-2);
  color: var(--fg-muted);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.device-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.device {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: 48px;
  padding: var(--sp-2);
  border-radius: var(--r-md);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.device:hover {
  background: var(--bg-hover);
}
.device:active {
  background: var(--bg-active);
}
.device.active {
  background: var(--bg-active);
  box-shadow: inset 3px 0 0 var(--accent);
}
.device.active .device-name {
  color: var(--fg);
}
/*
 * 行首的容器展开箭头：常驻低透明度（hover 才显形 = 这个功能等于不存在），
 * 悬停行/已展开时全亮。展开后箭头顺时针倒下（▸ → ▾）。
 * 22px：这枚箭头是「展开/收起容器列表」的唯一入口，16px 很难点。
 */
.device-expand {
  width: 22px;
  height: 22px;
  padding: 0;
  flex-shrink: 0;
  color: var(--fg-muted);
  opacity: 0.45;
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out);
}
.device-expand:hover {
  background: var(--bg-active);
}
.device:hover .device-expand,
.device-expand.open {
  opacity: 1;
}
.device-expand.open {
  transform: rotate(90deg);
}
/* 设备行底下缩进一层的容器列表（直连容器入口） */
.device-containers {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 1px 0 3px 26px;
}
.containers-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--sp-2) 1px;
}
.containers-title {
  font-size: var(--fs-xs);
  color: var(--fg-muted);
}
.containers-head .icon-btn {
  /* 24px 那一档：侧栏里的小刷新键也得不费力才点得中 */
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--fg-muted);
}
.containers-head .icon-btn.dim {
  opacity: 0.45;
  pointer-events: none;
}
.device-container {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.device-container:hover {
  background: var(--bg-hover);
}
.device-container:active {
  background: var(--bg-active);
}
/* 暂停的容器进不去：淡一档 + 恢复默认光标（右键菜单里有「恢复」） */
.device-container.paused {
  opacity: 0.62;
  cursor: context-menu;
}
.device-container .dot {
  width: 7px;
  height: 7px;
  border-radius: var(--r-pill);
  flex-shrink: 0;
  background: var(--fg-muted);
}
.device-container .dot.running {
  background: var(--success-text);
}
.device-container .dot.paused,
.device-container .dot.starting {
  background: var(--warning-text);
}
.device-container .dot.unhealthy {
  background: var(--danger-text);
}
.container-name {
  font-size: var(--fs-sm);
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.container-image {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}
.container-hint {
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  padding: 4px var(--sp-2);
  line-height: 1.6;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.container-error {
  flex: 1;
  min-width: 0;
}
.container-retry {
  /* 沿用全局 .retry 的长相（小号描边按钮只该有一种） */
  flex-shrink: 0;
}
.device-icon {
  color: var(--fg-muted);
  flex-shrink: 0;
}
.device-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.device-name {
  font-size: var(--fs-md);
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.device-host {
  font-size: var(--fs-xs);
  color: var(--fg-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.jump-badge {
  display: inline-flex;
  vertical-align: -2px;
  margin-right: var(--sp-1);
  color: var(--accent-text);
}
/*
 * 同 FileExplorer：绝对定位悬浮，不用 visibility —— 后者只是不画出来，
 * 照样占着宽度，把设备名和主机地址挤窄。
 */
.device-actions {
  display: none;
  position: absolute;
  right: 5px;
  top: 50%;
  transform: translateY(-50%);
  padding-left: var(--sp-2);
  background: var(--bg-hover);
  box-shadow: -8px 0 8px var(--bg-hover);
}
.device:hover .device-actions {
  display: flex;
}
/* 空态文案（含 .clickable 那一档）是 styles.css 里的全局 .empty-hint，
   五个面板共用一个定义 —— 之前这里各写一份，padding 有 4px 2px 也有 8px */

/* ---- 设备分组 ---- */
/*
 * 组头：比设备行矮、字重小，箭头旋转表达开合（与 device-expand 同一套动效）。
 * 整行可点（折叠/展开），右键出菜单 —— 不与设备行的双击连接抢手势。
 */
.group-head {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  margin-top: var(--sp-1);
  border-radius: var(--r-sm);
  cursor: pointer;
  color: var(--fg-muted);
  transition: background-color var(--dur-fast) var(--ease-out);
}
.group-head:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.group-chevron {
  display: inline-flex;
  width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  transition: transform var(--dur-fast) var(--ease-out);
}
.group-chevron.open {
  transform: rotate(90deg);
}
.group-name {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-count {
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  background: var(--bg);
  border-radius: var(--r-pill);
  padding: 0 var(--sp-1);
  min-width: 18px;
  text-align: center;
}
/* 组内设备行整体右缩一档：谁属于哪组一眼可见 */
.device-block.in-group {
  margin-left: var(--sp-3);
}
/*
 * 拖拽落点高亮：inset 描边不改布局（outline 在某些缩放比下会糊），
 * 底色垫一层 accent-soft，组头和设备行共用同一个信号。
 */
.group-head.drop-target,
.device.drop-target {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 2px var(--accent);
}
/* 「新分组…」的就地输入框：与组头同高、同缩进（它马上就会变成一个新组） */
.group-new-row {
  display: flex;
  align-items: center;
  padding: var(--sp-1) var(--sp-2);
}
.rename-input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sm);
  padding: 1px var(--sp-1);
  border: 1px solid var(--accent);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--fg);
}
</style>
