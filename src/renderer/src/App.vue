<script setup lang="ts">
import {
  defineAsyncComponent,
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type Ref
} from 'vue'
import { useSessionStore, type SessionTab } from './stores/sessions'
import { MIN_TILE_HEIGHT, tileGrid } from './utils/tileGrid'
import { tabbarCompact } from './utils/tabbar'
import { useCloseTabShortcut } from './composables/useCloseTabShortcut'
import { useEditorStore } from './stores/editor'
import { useLayoutStore } from './stores/layout'
import SessionSidebar from './components/SessionSidebar.vue'
import TitleBar from './components/TitleBar.vue'
import TerminalPanel from './components/TerminalPanel.vue'
import FileExplorer from './components/FileExplorer.vue'
import MonitorPanel from './components/MonitorPanel.vue'
import TransferQueue from './components/TransferQueue.vue'
import ComposeDrawer from './components/ComposeDrawer.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import HostKeyDialog from './components/HostKeyDialog.vue'
import Icon from './components/Icon.vue'
import ToastHost from './components/ToastHost.vue'
import ContextMenu, { type ContextMenuItem } from './components/ContextMenu.vue'
import TabListMenu from './components/TabListMenu.vue'

/*
 * 编辑器懒加载：CodeMirror + 15 个语言包是首包里最大的一块死重 ——
 * 只有真打开文件时才用得着。defineAsyncComponent 让它进独立 chunk，
 * 首次双击文件时才下载解析。
 */
const FileEditor = defineAsyncComponent(() => import('./components/FileEditor.vue'))

const store = useSessionStore()
const editor = useEditorStore()
const layout = useLayoutStore()

/*
 * Ctrl+W = 关掉当前标签（终端里按的那次由 TerminalPanel 自己处理，
 * 见 composable 的注释：那样才知道该关哪一个标签）。关到最后一个标签时
 * 与点标签上的 ✕ 完全一致 —— 复用 closeTab，不在这里造特例。
 */
useCloseTabShortcut(() => {
  if (store.activeTab) store.closeTab(store.activeTab)
})

/**
 * 给一个元素挂尺寸/滚动监听，元素出现或消失时自动挂上、摘掉。
 *
 * 不能只在 onMounted 里 observe 一次：`.tab-bar` 是 `v-if="store.tabs.length"`，
 * 首次挂载时（还没恢复出标签）它根本不存在 —— observe 一个 null 就是静默失效，
 * 表现是「标签栏宽度永远是 0，收窄和溢出清单都不工作」。用 watch + immediate
 * 才能等到它真的出现。
 *
 * scroll 也要监听：标签栏会自动把当前标签滚进可视区（App 里那个 watch），
 * 而「谁被挤到视口外」本来就取决于滚动位置 —— 只按尺寸重量会数出个过期数字
 * （实测：滚到底之后有 7 个在外面，数字还停在 5）。
 */
function watchElement(
  elRef: Ref<HTMLElement | null>,
  handlers: { size?: (el: HTMLElement) => void; scroll?: () => void }
): void {
  let observer: ResizeObserver | null = null
  let target: HTMLElement | null = null
  const onScroll = (): void => handlers.scroll?.()
  const detach = (): void => {
    observer?.disconnect()
    observer = null
    target?.removeEventListener('scroll', onScroll)
    target = null
  }
  watch(
    elRef,
    (el) => {
      detach()
      if (!el) return
      target = el
      handlers.size?.(el)
      observer = new ResizeObserver(() => handlers.size?.(el))
      observer.observe(el)
      if (handlers.scroll) el.addEventListener('scroll', onScroll, { passive: true })
    },
    { immediate: true }
  )
  onBeforeUnmount(detach)
}

/*
 * 编辑器面板是否真的占地方。visible 只是用户的展开意愿：
 * 当前会话一个打开的文件都没有时，渲染出来就是一块空白 ——
 * 标签全关掉面板就跟着收掉；切到还有文件的会话它又会回来。
 */
const editorShown = computed(
  () => editor.visible && editor.filesOf(store.activeSessionId).length > 0
)

// Wave 形态：应用启动即开一个本地终端标签页。
// 若上次退出时还有布局，则先按布局恢复；只有恢复不出东西时才开默认本地终端。
onMounted(async () => {
  // CLI 伴侣：dox 命令经主进程转到这里；先挂监听再报 ready，
  // 否则冷启动参数 flush 时监听还没装上
  window.api.onCliCommand((cmd) => store.handleCliCommand(cmd))
  window.api.cliCommandReady()

  /*
   * 量 .terminal-stack 的宽度决定平铺开几列。窗口缩放、侧栏收展、SFTP 面板
   * 开关、编辑器分栏都会改变它，所以交给 ResizeObserver 而不是只在切换时量一次。
   *
   * 注意必须在下面第一个 await 之前调：watchElement 里要注册 onBeforeUnmount，
   * 过了 await 组件实例就被 Vue 摘掉了 —— 钩子注册不上，退出时 observer 也不会
   * 摘（每次启动控制台都会出两条 warn，就是这个）。
   */
  watchElement(stackEl, {
    size: (el) => {
      stackWidth.value = el.clientWidth
    }
  })

  // 标签栏：量宽度决定收不收窄；宽度变了、滚了，都要重量「有几个被挤到视口外」
  watchElement(tabsEl, {
    size: (el) => {
      tabsWidth.value = el.clientWidth
      syncTabChildren()
      measureHiddenTabs()
    },
    scroll: measureHiddenTabs
  })

  let restored = false
  try {
    restored = await layout.restore()
  } catch (err) {
    // 恢复失败也必须让用户落在一个能用的界面上，而不是空白窗口
    console.error('[layout] 恢复上次布局失败，回退到默认本地终端', err)
  }
  if (!restored && store.tabs.length === 0) void store.connectLocal()
  // 恢复期间不写快照，否则重建的中间态会把布局一步步覆盖坏
  layout.startAutoSave()
})

onBeforeUnmount(() => {
  tabChildObserver?.disconnect()
  tabChildObserver = null
})

/** sessionId → TerminalPanel 实例，用于标签页/分屏切换后 refit + focus */
const panelRefs = ref<Record<string, InstanceType<typeof TerminalPanel>>>({})

function setPanelRef(sessionId: string, el: InstanceType<typeof TerminalPanel> | null): void {
  if (el) panelRefs.value[sessionId] = el
  else delete panelRefs.value[sessionId]
}

/*
 * ---- 平铺（所有标签同屏，一格一个会话）----
 *
 * 只放在这里、不进 store 也不进设置：它是**会话级的视图状态**，而且容器标签
 * 根本不进布局快照 —— 存下来也恢复不成原样，不如重启重新点一下（和广播开关
 * 是同一个取舍）。
 */
const tileMode = ref(false)
/** .terminal-stack 的实测宽度，决定能开几列 */
const stackWidth = ref(0)
const stackEl = ref<HTMLElement | null>(null)

const grid = computed(() => tileGrid(store.tabs.length, stackWidth.value))
/** 网格的列数与单格高度下限都从这里注入 CSS，保证「下限」只有一处定义 */
const tileStyle = computed(() =>
  tileMode.value
    ? { '--tile-cols': String(grid.value.cols), '--tile-min-h': `${MIN_TILE_HEIGHT}px` }
    : undefined
)
/** 最后一行只剩一个格子时拉通整行；普通模式不给内联样式 */
function tileItemStyle(tab: SessionTab): Record<string, string> | undefined {
  if (!tileMode.value || !grid.value.spanLast) return undefined
  return store.tabs[store.tabs.length - 1]?.tabId === tab.tabId
    ? { 'grid-column': `span ${grid.value.cols}` }
    : undefined
}

/**
 * 铺开/收起后所有面板都要重新量尺寸（隐藏期间尺寸可能已经变了）。
 *
 * 这里逐个走**不抢焦点**的 refit：平铺时 N 个面板同时换尺寸，挨个
 * refitAndFocus 会让焦点一路跳到最后一个格子上，接着敲的字就进错会话了。
 */
function refitAll(): void {
  for (const tab of store.tabs) {
    for (const pane of tab.panes) {
      if (pane.sessionId) panelRefs.value[pane.sessionId]?.refit()
    }
  }
}

async function toggleTile(): Promise<void> {
  tileMode.value = !tileMode.value
  await nextTick()
  refitAll()
  // 只有当前那一格该拿键盘焦点，所以逐个 refit 之后单独 focus 它
  if (tileMode.value && store.activeTab) {
    const sessionId = store.activePane?.sessionId
    if (sessionId) panelRefs.value[sessionId]?.refitAndFocus()
  }
}

/** 只看这一个：退出平铺 + 激活它（格子标题条双击、标题条上的放大按钮都走这里） */
async function zoomTile(tab: SessionTab): Promise<void> {
  tileMode.value = false
  await activate(tab)
}

/**
 * 平铺时点到某一格 —— 不管点的是标题条还是终端本体 —— 都要把**当前标签**切过去。
 *
 * 不切的话：键盘焦点在这一格的终端里，而「当前标签」还停在别处。于是标签栏
 * 高亮的是另一个标签，文件面板 / 快捷命令的目标也还是那一个 —— 看着你在第三格
 * 敲字，一堆「当前目标」却指向第一格。点哪格就该是哪格。
 *
 * 事件挂在格子壳上（`display:contents` 不生成盒子，但子元素的事件照样冒泡上来），
 * 所以标题条自己不用再挂一份。
 */
function focusTile(tab: SessionTab): void {
  if (store.activeTabId !== tab.tabId) store.activeTabId = tab.tabId
}

/*
 * ---- 标签栏撑住很多标签：收窄 + 溢出清单 + 右键批量关 ----
 */

/** 标签栏可用宽度（.tabs-scroll 的实测宽度），决定要不要收窄 */
const tabsWidth = ref(0)
const tabsEl = ref<HTMLElement | null>(null)

/** 标签多到并排排不下 → 收窄（纯估算，见 utils/tabbar.ts 里为什么不量 DOM） */
const tabsCompact = computed(() => tabbarCompact(store.tabs.length, tabsWidth.value))

/** 溢出清单开关 */
const tabListOpen = ref(false)
/** 被挤出可视区的标签个数（▾ 上那个数字） */
const hiddenTabCount = ref(0)

/**
 * 逐个标签的尺寸监听。
 *
 * 光听标签栏自己的宽高是不够的：标签**自身的宽度会变**，而标签栏的宽度不变
 * （它是 flex:1）。最典型的就是本地标签的标题 —— `本地 · <目录名>`，目录是
 * shell 启动后经 shell integration 异步上报的，标签会在建出来之后悄悄换个
 * 长短（实测：同一批标签在几秒内从 118px 变成 128px）。不听它，「有几个在
 * 视口外」就会停在过期数字上（实测卡在 6，实际 7）。
 */
let tabChildObserver: ResizeObserver | null = null
function syncTabChildren(): void {
  const box = tabsEl.value
  if (!box) return
  if (!tabChildObserver) tabChildObserver = new ResizeObserver(() => measureHiddenTabs())
  tabChildObserver.disconnect()
  for (const el of box.querySelectorAll('.tab')) tabChildObserver.observe(el)
}

/**
 * 数一数有几个标签在可视区外。
 *
 * 这个必须**实测**，不能按个数算：标签宽度随标题长短变化，「第几个开始看不见」
 * 只能看真实的矩形。没有反馈环问题 —— ▾ 按钮出现只会让可用宽度更小，
 * 不会把它自己挤没（和收窄不同，收窄是按个数算的，见 utils/tabbar.ts）。
 *
 * 量之前先等一帧（rAF）：这个函数的触发源里就包括「▾ 按钮刚出现导致可用宽度
 * 变窄」，而那一刻 DOM 还没排完版 —— 当场量会数出上一版布局的数字（实测数字
 * 会差 1~2 个）。攒到下一帧再量还有个附带好处：一连串触发只会量一次。
 */
let measureQueued = false
function measureHiddenTabs(): void {
  if (measureQueued) return
  measureQueued = true
  requestAnimationFrame(() => {
    measureQueued = false
    const box = tabsEl.value
    if (!box) return
    const view = box.getBoundingClientRect()
    let hidden = 0
    for (const el of box.querySelectorAll('.tab')) {
      const r = el.getBoundingClientRect()
      if (r.right > view.right + 1 || r.left < view.left - 1) hidden++
    }
    const changed = hiddenTabCount.value !== hidden
    hiddenTabCount.value = hidden
    // 一个都不藏了就把清单收掉，免得留着一个指向空的浮层
    if (hidden === 0) tabListOpen.value = false
    /*
     * 数字变了就再量一帧：这个按钮**自己占宽度** —— 它出现时标签栏可用宽度少
     * 40px，又会有标签被挤到外面去（实测数字会卡在 6，实际是 7）。
     * 再量一次就收敛（按钮只在 hidden>0 时出现，不会来回抖），
     * 而且第二次量出来通常和第一次一样，不会继续排队。
     */
    if (changed) measureHiddenTabs()
  })
}

/*
 * 标签个数 / 当前标签 / 是否收窄 任一变化之后都要重新数「有几个在视口外」。
 * 必须在 nextTick 之后量：标签的增删和收窄都是先改数据、下一帧才反映到 DOM 上。
 *
 * 注意这个 watch 必须写在 tabsCompact 之后：watch 会在 setup 期间立即读一遍
 * 各个 source 来收集依赖，写在前面就是 TDZ 报错（变量还没初始化）。
 */
watch(
  [() => store.tabs.length, () => store.activeTabId, tabsCompact],
  async () => {
    await nextTick()
    // 标签增删/换当前标签后，被观察的那批元素也换了，重新同步一遍
    syncTabChildren()
    measureHiddenTabs()
  }
)

/** 只在真正被点的那一个标签上开菜单（右键的是哪个就关哪个） */
const tabMenu = ref<{ x: number; y: number; tab: SessionTab } | null>(null)

function openTabMenu(tab: SessionTab, e: MouseEvent): void {
  tabMenu.value = { x: e.clientX, y: e.clientY, tab }
}

const tabMenuItems = computed<ContextMenuItem[]>(() => {
  const tab = tabMenu.value?.tab
  if (!tab) return []
  const idx = store.tabs.findIndex((t) => t.tabId === tab.tabId)
  const others = store.tabs.length - 1
  const right = store.tabs.length - idx - 1
  return [
    { id: 'close', label: '关闭当前标签', icon: 'x' },
    { id: 'others', label: others > 0 ? `关闭其他 ${others} 个` : '关闭其他标签', icon: 'x', disabled: others === 0 },
    { id: 'right', label: right > 0 ? `关闭右侧 ${right} 个` : '关闭右侧标签', icon: 'x', disabled: right === 0 },
    { id: 'all', label: `关闭全部 ${store.tabs.length} 个`, icon: 'trash', danger: true }
  ]
})

function runTabMenu(id: string): void {
  const tab = tabMenu.value?.tab
  tabMenu.value = null
  if (!tab) return
  if (id === 'close') store.closeTab(tab)
  else if (id === 'others') store.closeOtherTabs(tab)
  else if (id === 'right') store.closeTabsToRight(tab)
  else if (id === 'all') store.closeAllTabs()
}

/** 溢出清单里跳到一个标签（含把它滚进可视区） */
async function gotoTab(tab: SessionTab): Promise<void> {
  tabListOpen.value = false
  await activate(tab)
}

/** 当前聚焦窗格上一条命令的退出码（shell integration，OSC 133 上报） */
function activeExitCode(tab: SessionTab): number | undefined {
  const sessionId = tab.panes.find((p) => p.paneId === tab.activePaneId)?.sessionId
  const code = sessionId ? store.exitCodeBySession[sessionId] : undefined
  return code ? code : undefined
}

/*
 * 激活标签变化（点击/关闭相邻/平铺里点某一格）后：
 * 滚进可视区 —— 标签多到溢出时，store 里变了用户却看不见它；
 * refit —— 关标签触发的切换原来不 refit，终端行列是关标签前算的旧值。
 */
watch(
  () => store.activeTabId,
  async () => {
    await nextTick()
    document.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const tab = store.activeTab
    if (!tab) return
    /*
     * 平铺时只把焦点交给**当前那个 pane**。
     * refitTab 会遍历标签下所有 pane 并逐个 refitAndFocus，焦点最后落在
     * 数组里最后一个 pane 上 —— 平铺时点了左半格、焦点跑到右半格，就是这里来的。
     * 而且格子尺寸没变，其它 pane 也不需要重新量。
     */
    if (tileMode.value) {
      const sessionId = tab.panes.find((p) => p.paneId === tab.activePaneId)?.sessionId
      if (sessionId) panelRefs.value[sessionId]?.refitAndFocus()
      return
    }
    refitTab(tab)
  }
)

async function activate(tab: SessionTab): Promise<void> {
  store.activeTabId = tab.tabId
  await nextTick()
  // 平铺时焦点由上面那个 watch 统一处理（只聚焦当前 pane），这里不要重复抢
  if (tileMode.value) return
  refitTab(tab)
}

async function focusPane(tab: SessionTab, paneId: string): Promise<void> {
  store.setActivePane(tab, tab.panes.find((p) => p.paneId === paneId)!)
  await nextTick()
  const sessionId = tab.panes.find((p) => p.paneId === paneId)?.sessionId
  if (sessionId) panelRefs.value[sessionId]?.refitAndFocus()
}

async function split(direction: 'row' | 'column'): Promise<void> {
  await store.splitActive(direction)
  await nextTick()
  if (store.activeTab) refitTab(store.activeTab)
}

/*
 * 分栏/标签切换后，该标签下所有 pane 都需要重新 fit。
 *
 * 这里逐个 refitAndFocus 是**非平铺**模式的既有行为（只有一个标签可见，
 * 焦点落在它上面是对的）。平铺模式不走这条路径 —— 见 refitAll/toggleTile。
 */
function refitTab(tab: SessionTab): void {
  for (const pane of tab.panes) {
    if (pane.sessionId) panelRefs.value[pane.sessionId]?.refitAndFocus()
  }
}

async function toggleSftp(): Promise<void> {
  store.toggleSftp()
  // 分栏变化后终端宽度改变，需要重新 fit
  await nextTick()
  if (store.activeTab) refitTab(store.activeTab)
}

function openWelcomeDevice(): void {
  // 复用侧栏的添加设备弹窗；空地址表示不预填主机。
  store.requestAddDevice({ host: '', port: 22, username: 'root' })
}

/**
 * 当前标签的文件面板目标：SSH 标签浏览宿主机；容器标签浏览容器
 * （经容器里的 dox-agent，FileExplorer 内部处理未安装的引导）；
 * 本地终端标签浏览本机（主进程按 local- 前缀分流到 node:fs）。
 * 本机容器也在内（agent 通道走本机 docker CLI）。
 */
const sftpTarget = computed<{ sessionId: string; container?: { parentSessionId: string; containerName: string } } | null>(() => {
  const tab = store.activeTab
  const paneId = store.activePane?.sessionId
  if (!tab || !paneId) return null
  if (tab.kind === 'ssh') return { sessionId: paneId }
  if (tab.kind === 'local') return { sessionId: paneId }
  if (tab.kind === 'container' && tab.container && !tab.container.chain?.length) {
    return {
      sessionId: paneId,
      container: {
        parentSessionId: tab.container.parentSessionId,
        containerName: tab.container.containerName
      }
    }
  }
  return null
})
</script>

<template>
  <div class="layout">
    <TitleBar class="title-slot" />

    <SessionSidebar />

    <div class="main-area">
      <!-- 标签栏 -->
      <div v-if="store.tabs.length" class="tab-bar">
        <div ref="tabsEl" class="tabs-scroll" :class="{ compact: tabsCompact }">
          <div
            v-for="tab in store.tabs"
            :key="tab.tabId"
            class="tab"
            :class="{ active: tab.tabId === store.activeTabId }"
            :title="store.tabLabel(tab)"
            @click="activate(tab)"
            @auxclick.middle.prevent="store.closeTab(tab)"
            @contextmenu.prevent="openTabMenu(tab, $event)"
          >
            <span class="status-dot" :class="store.tabStatus(tab)"></span>
            <!--
              广播勾选框。只在广播开着时出现，平时不占地方。
              @click.stop 是必须的：勾选不该顺带把标签切过去（要看的目标标签
              往往不是当前标签，一点就走人就勾不了了）。
            -->
            <button
              v-if="store.broadcastEnabled"
              class="tab-bc"
              :class="{ on: store.broadcastTabIds.has(tab.tabId) }"
              :title="
                store.broadcastTabIds.has(tab.tabId)
                  ? '这个标签会接收广播（点击取消）'
                  : '勾选后接收广播'
              "
              @click.stop="store.toggleBroadcastTab(tab.tabId)"
            >
              <Icon v-if="store.broadcastTabIds.has(tab.tabId)" name="check" :size="10" />
            </button>
            <span class="tab-title">{{ store.tabLabel(tab) }}</span>
            <!-- 上一条命令失败时留个记号：滚屏后也能看出刚才那条命令挂了 -->
            <span
              v-if="activeExitCode(tab)"
              class="exit-badge"
              :title="`上一条命令退出码 ${activeExitCode(tab)}`"
            >✗{{ activeExitCode(tab) }}</span>
            <button class="tab-close" aria-label="关闭标签" title="关闭" @click.stop="store.closeTab(tab)">
              <Icon name="x" :size="12" />
            </button>
          </div>

          <button class="tab-new" aria-label="新建本地终端" title="新建本地终端" @click="store.connectLocal()">
            <Icon name="plus" :size="15" />
          </button>
        </div>

        <!--
          溢出清单。只在真有标签被挤到视口外时出现，数字就是「看不见的那几个」——
          横向滚动条不难发现，但点到某个具体标签仍要先猜它在哪一边，这个清单
          直接把它们按顺序列出来（点一行跳过去，✕ 直接关）。
        -->
        <button
          v-if="hiddenTabCount > 0"
          class="bar-btn tab-overflow"
          :class="{ on: tabListOpen }"
          :title="`还有 ${hiddenTabCount} 个标签在视口外：点开列出全部标签`"
          @click="tabListOpen = !tabListOpen"
        >
          <Icon name="chevron-down" />
          {{ hiddenTabCount }}
        </button>

        <!--
          广播开关。放在动作组最左边（离标签最近）：它管的是「标签之间」的事，
          分屏 / SFTP 管的是当前标签自己的事，两类中间隔开一点。
          按钮上直接写目标数 —— 开着广播却没勾任何标签时，那个 0 就是答案。
        -->
        <button
          class="bar-btn"
          :class="{ on: store.broadcastEnabled }"
          :title="
            store.broadcastEnabled
              ? `广播开着：当前 ${store.broadcastTargets.length} 个会话会一起收到输入（点击关闭）`
              : '广播下发：一次输入同时发给多个标签（点击开启，然后勾选目标标签）'
          "
          @click="store.toggleBroadcast()"
        >
          <Icon name="broadcast" />
          <template v-if="store.broadcastEnabled">广播 {{ store.broadcastTargets.length }}</template>
        </button>

        <!--
          批量勾选。开着广播时才有意义：一键「全不选 → 挑两个」或者「全选」，
          不用挨个标签点。文案跟着当前状态走（已全选就写「全不选」），
          所以它永远是「点一下会变成另一种状态」的那个动作。
        -->
        <button
          v-if="store.broadcastEnabled"
          class="bar-btn bc-bulk"
          :title="
            store.broadcastAllChecked
              ? '取消所有标签的勾选（广播目标清零，输入就不会外发了）'
              : '勾上所有标签，全部会话一起执行'
          "
          @click="store.toggleBroadcastAll()"
        >
          {{ store.broadcastAllChecked ? '全不选' : '全选' }}
        </button>

        <!--
          平铺开关。和广播是同一类（都是「标签之间」的事），所以挨着放。
          只有一个标签时铺开等于没铺，但仍然允许 —— 少一个「为什么点了没反应」。
        -->
        <button
          class="bar-btn"
          :class="{ on: tileMode }"
          :title="
            tileMode
              ? '正在平铺：所有标签同屏各占一格（点击收起，回到单标签视图）'
              : '平铺：所有标签铺成一屏，一眼看全（双击格子标题条只看某一个）'
          "
          @click="toggleTile()"
        >
          <Icon name="grid" />
          <template v-if="tileMode">平铺 {{ store.tabs.length }}</template>
        </button>

        <template v-if="store.activePane?.sessionId">
          <button
            v-if="store.activeTab!.split === 'none'"
            class="bar-btn"
            title="向右分屏（同主机新会话）"
            @click="split('row')"
          ><Icon name="split-right" /></button>
          <button
            v-if="store.activeTab!.split === 'none'"
            class="bar-btn"
            title="向下分屏（同主机新会话）"
            @click="split('column')"
          ><Icon name="split-down" /></button>
          <button
            v-if="sftpTarget"
            class="bar-btn"
            :class="{ on: store.sftpVisible }"
            :title="
              store.activeTab!.kind === 'container'
                ? '容器文件面板（经容器助手）'
                : store.activeTab!.kind === 'local'
                  ? '本机文件面板'
                  : 'SFTP 文件面板'
            "
            @click="toggleSftp"
          ><Icon name="folder" /> {{ store.activeTab!.kind === 'local' ? '文件' : 'SFTP' }}</button>
        </template>
      </div>

      <!--
        终端 + SFTP 分栏，传输队列停靠在最下方。

        队列原来是绝对定位浮在右下角的，而 SFTP 面板正好在右侧 ——
        传几个文件后队列一出现，文件列表底部那几十行就被盖住点不动了
        （双击、悬停、拖拽全被截走）。改成一整条底部停靠，占自己的高度，
        不再遮任何东西。
      -->
      <div class="terminal-area" :class="{ 'editor-open': editorShown }">
        <div class="workspace">
          <div v-if="!store.tabs.length" class="welcome">
            <div class="welcome-mark"><Icon name="terminal" :size="28" /></div>
            <h2>欢迎使用 Dox</h2>
            <p class="welcome-subtitle">在本地终端、SSH 会话和容器之间快速切换</p>
            <div class="welcome-actions">
              <button class="welcome-card primary" @click="store.connectLocal()">
                <Icon name="terminal" :size="20" />
                <span><strong>打开本地终端</strong><small>使用当前系统 Shell</small></span>
              </button>
              <button class="welcome-card" @click="openWelcomeDevice">
                <Icon name="server" :size="20" />
                <span><strong>添加 SSH 设备</strong><small>密码或私钥登录</small></span>
              </button>
            </div>
            <p class="welcome-tip">也可以从左侧设备列表双击打开已保存的会话</p>
          </div>

          <div ref="stackEl" class="terminal-stack" :class="{ tiled: tileMode }" :style="tileStyle">
            <!--
              格子壳。**普通模式下它是 display:contents**，不生成盒子 ——
              `.tab-content` 依旧等价于 .terminal-stack 的直接 flex 子项，
              布局和加这层壳之前逐像素一致（一堆验证脚本正是靠
              `.tab-content:not([style*="display: none"])` 挑当前标签的）。
              平铺时它才变成真盒子（卡片 + 标题条）。
            -->
            <div
              v-for="tab in store.tabs"
              :key="tab.tabId"
              class="tile"
              :class="{ focused: tileMode && tab.tabId === store.activeTabId }"
              :style="tileItemStyle(tab)"
              @mousedown="tileMode && focusTile(tab)"
            >
              <!--
                格子标题条：平铺时唯一能区分各格的东西（标签栏离得远，一眼扫不到）。
                单击切焦点（由外层格子壳的 mousedown 统一处理，点终端本体也一样），
                双击只看这一个。标题条上的勾选框要 stop：取消勾选不该顺带切标签。
              -->
              <div v-if="tileMode" class="tile-head" @dblclick="zoomTile(tab)">
                <span class="status-dot" :class="store.tabStatus(tab)"></span>
                <span class="tile-title" :title="store.tabLabel(tab)">{{ store.tabLabel(tab) }}</span>
                <button
                  v-if="store.broadcastEnabled"
                  class="tab-bc"
                  :class="{ on: store.broadcastTabIds.has(tab.tabId) }"
                  :title="
                    store.broadcastTabIds.has(tab.tabId)
                      ? '这个标签会接收广播（点击取消）'
                      : '勾选后接收广播'
                  "
                  @mousedown.stop
                  @click.stop="store.toggleBroadcastTab(tab.tabId)"
                >
                  <Icon v-if="store.broadcastTabIds.has(tab.tabId)" name="check" :size="10" />
                </button>
                <!--
                  标题条右上角是**关闭**：平铺时每个格子都有自己的标题条，
                  最常做的动作是「这一格看完了，关掉」——而关标签得回标签栏、
                  还要在 20 个标签里找到它。放大（只看这一个）留在双击标题条上，
                  两个动作各有各的入口，互不挤占。
                -->
                <button
                  class="tile-close"
                  title="关闭这个标签"
                  @click.stop="store.closeTab(tab)"
                ><Icon name="x" :size="12" /></button>
              </div>
              <div
                v-show="tileMode || tab.tabId === store.activeTabId"
                class="tab-content"
                :class="{
                  'split-row': tab.split === 'row',
                  'split-column': tab.split === 'column'
                }"
              >
                <div
                  v-for="pane in tab.panes"
                  :key="pane.paneId"
                  class="pane"
                  :class="{ focused: pane.paneId === tab.activePaneId }"
                  @mousedown="store.setActivePane(tab, pane)"
                >
                  <TerminalPanel
                    v-if="pane.sessionId"
                    :ref="(el) => setPanelRef(pane.sessionId!, el as InstanceType<typeof TerminalPanel> | null)"
                    :session-id="pane.sessionId"
                  />
                  <!--
                    会话还在但已经死了（重连耗尽/对端关闭/本地 exit）：
                    覆盖一个原地复活入口 —— 不然唯一的出路是关掉标签去侧栏重新找设备。
                    自动重连进行中（reconnecting）不出现，不和重连条打架。
                  -->
                  <div
                    v-if="pane.sessionId && (pane.status === 'closed' || pane.status === 'error')"
                    class="pane-revive"
                  >
                    <p class="revive-text">
                      {{ pane.status === 'error' && pane.error ? `连接失败：${pane.error}` : '连接已断开' }}
                    </p>
                    <div class="revive-actions">
                      <button class="btn primary" @click="store.reconnectPane(tab, pane)">重新连接</button>
                      <button class="btn" @click="store.closePane(tab, pane)">关闭标签</button>
                    </div>
                  </div>
                  <div v-else-if="!pane.sessionId" class="tab-placeholder">
                    <template v-if="pane.status === 'connecting'">正在连接 {{ tab.title }} …</template>
                    <template v-else-if="pane.status === 'error'">
                      <div class="placeholder-error">
                        <p>连接失败：{{ pane.error }}</p>
                        <!-- 未保存的恢复标签没有凭证，重试无意义 —— 它有自己的重新认证入口 -->
                        <button
                          v-if="tab.kind !== 'ssh' || tab.config"
                          class="btn primary"
                          @click="store.reconnectPane(tab, pane)"
                        >重试</button>
                      </div>
                    </template>
                    <!-- 重启后恢复出来的临时连接：没有凭证，必须用户重新认证 -->
                    <template v-else-if="tab.pendingPrefill">
                      <div class="resume-hint">
                        <p>这是上次未保存的会话（密码未存储）</p>
                        <button class="resume-btn" @click="store.requestAddDevice(tab.pendingPrefill!)">
                          重新连接 {{ tab.pendingPrefill.username }}@{{ tab.pendingPrefill.host }}
                        </button>
                      </div>
                    </template>
                    <template v-else>已断开</template>
                  </div>
                  <button
                    v-if="tab.panes.length > 1"
                    class="pane-close"
                    title="关闭此窗格"
                    @click.stop="store.closePane(tab, pane)"
                  ><Icon name="x" :size="12" /></button>
                </div>
              </div>
            </div>
          </div>

          <FileExplorer
            v-if="store.sftpVisible && sftpTarget"
            :key="sftpTarget.sessionId"
            :session-id="sftpTarget.sessionId"
            :container="sftpTarget.container"
          />

          <!-- 性能监控面板（终端右键「性能监控」打开；目标随打开时的标签定） -->
          <MonitorPanel
            v-if="store.monitorTarget"
            :key="store.monitorTarget.sessionId + ':' + (store.monitorTarget.containerName ?? '')"
            :session-id="store.monitorTarget.sessionId"
            :container-name="store.monitorTarget.containerName"
            :label="store.monitorTarget.label"
            :initial-tab="store.monitorTarget.tab"
            :initial-filter="store.monitorTarget.filter"
          />

          <!-- 双击文件后在此编辑；key 绑定会话，切会话不串内容 -->
          <FileEditor
            v-if="store.sftpVisible && editorShown && store.activeSessionId"
            :key="`ed-${store.activeSessionId}`"
            :session-id="store.activeSessionId"
          />
        </div>

        <ComposeDrawer />
        <TransferQueue />
      </div>
    </div>

    <SettingsDialog />
    <HostKeyDialog />
    <ToastHost />

    <!-- 标签右键菜单：批量关闭（关闭当前 / 其他 / 右侧 / 全部） -->
    <ContextMenu
      v-if="tabMenu"
      :x="tabMenu.x"
      :y="tabMenu.y"
      :items="tabMenuItems"
      @select="runTabMenu"
      @close="tabMenu = null"
    />
    <!-- 溢出清单：全部标签，点行跳过去、✕ 直接关（可连着关） -->
    <TabListMenu
      v-if="tabListOpen"
      @select="gotoTab"
      @close="tabListOpen = false"
    />
  </div>
</template>

<style scoped>
/*
 * 布局 = 两行两列：
 *   [ 标题栏（横跨两列） ]
 *   [ 侧栏 ][ 主区       ]
 *
 * 用 grid 而不是「上下两个 flex 容器」：标题栏横跨侧栏和主区，
 * 套一层 flex 就得把整个模板再包一层、缩进全动一遍；grid 只要给自己的行。
 * 左列是 auto 而不是定宽 —— 侧栏收起时宽度会变（264 → 44），写死就对不上了。
 */
.layout {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: 42px 1fr;
  width: 100vw;
  height: 100vh;
}
/* 标题栏铺满一整行（类名落在 TitleBar 的根元素上） */
.title-slot {
  grid-column: 1 / -1;
}
.main-area {
  display: flex;
  flex-direction: column;
  /* 两个 min-* 都是给网格项用的：默认 min-width/min-height: auto 会让
     内容（终端、文件列表）把网格轨道顶大，撑破窗口而不是自己滚动 */
  min-width: 0;
  min-height: 0;
}
/*
 * 标签栏做成**凹陷**的一条，活动标签用抬升的 --bg-panel。
 *
 * 这样活动标签和下方的终端区域是同一个面，看起来是「从标签栏里长出来、
 * 连到内容上」，这是标签页最容易被一眼读懂的形状。反过来（浅栏+深色活动标签）
 * 也分得清，但读起来像"选中的那块被按下去了"，语义是反的。
 */
/*
 * 标签栏。
 *
 * 高度与侧栏顶栏一致（48px）：两者都在标题栏正下方、左右并排，
 * 中间那条分隔线对不齐会非常明显。
 *
 * 标签做成有间距的圆角块，而不是原先「等高、靠 border-right 切开」的矩形 ——
 * 后者每个标签都被两条竖线夹着，整条看上去是一排格子；前者靠形状分组，
 * 哪几个是一组、哪个是当前，一眼就分得出来。
 */
.tab-bar {
  display: flex;
  align-items: center;
  height: 44px;
  padding: 0 var(--sp-3);
  gap: var(--sp-1);
  background: var(--bg-sunken);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.tabs-scroll {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 3px;
  overflow-x: auto;
  min-width: 0;
}
.tab {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  /*
   * 定高 + 居中，而不是靠上下 padding 撑出来：图标、标题、关闭按钮三者的
   * 垂直中线这样才对得齐。也顺带让标签栏高度不随内容（比如退出码徽标）跳动。
   */
  height: 30px;
  padding: 0 var(--sp-2) 0 var(--sp-3);
  font-size: var(--fs-md);
  color: var(--fg-secondary);
  cursor: pointer;
  border-radius: var(--r-md);
  white-space: nowrap;
  /* 标签多了要能横向滚，但不能被 flex 压扁成一个点 */
  flex-shrink: 0;
  transition:
    background-color var(--dur-base) var(--ease-out),
    color var(--dur-base) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
/*
 * 活动标签。
 *
 * 历史教训留在这儿：旧版只把标签底色往亮里提了一档，四个通道各差 4/255，
 * 跟没写一样。所以现在除了抬升的面，还叠一条顶部高亮线，两个信号一起给。
 *
 * 高亮线用 --accent 而不是 --accent-text：它是纯装饰，位置信息已经由
 * 背景和相邻关系给足了，不需要为了对比度把它压暗。
 */
.tab.active {
  color: var(--fg);
  font-weight: var(--fw-medium);
  background: var(--bg-panel);
  /* 两个信号一起给：抬升的面 + 顶部高亮线，再加一点投影把圆角块从底槽上托起来 */
  box-shadow:
    inset 0 2px 0 var(--accent),
    var(--shadow-sm);
}
.tab.active:hover {
  background: var(--bg-panel);
}
.tab:not(.active):hover {
  background: var(--bg-hover);
  color: var(--fg-secondary);
}
/* 按下：再深一档 + 半个像素的下沉。整条标签都是点击目标，
   没有反馈时「点中了没」只能靠切换结果去猜 */
.tab:not(.active):active {
  background: var(--bg-active);
}
.tab.active:active {
  transform: translateY(0.5px);
}
/*
 * 标签宽度封顶 + 标题截断。
 *
 * `deploy@10.0.0.1`、`本地 · 某个很长的目录名` 这类标题能把一个标签撑到 200px+，
 * 十来个标签就铺满了整条标签栏。封顶之后标题自己让位（min-width:0 才会截断），
 * 状态点 / 勾选框 / 关闭键都是 flex-shrink:0，不许被挤没 —— 它们是操作目标，
 * 挤掉了就点不着了。
 */
.tab {
  /*
   * min-width:0 是必须的：flex 项的自动最小尺寸是「内容宽度」，不写它标题就没法
   * 截断（它会把标签撑到内容那么宽）。
   * box-sizing:border-box 也是必须的：本项目没有全局 border-box，默认的
   * content-box 下 max-width 只算内容 —— 写 128 实际会得到 128+内边距 = 148，
   * 「封顶 128」这句话就成了假的（实测标签停在 133 而不是 128）。
   */
  min-width: 0;
  box-sizing: border-box;
  max-width: 190px;
}
.tab.active {
  max-width: 260px;
}
.tab-title {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.tab .status-dot,
.tab .tab-bc,
.tab .tab-close,
.tab .exit-badge {
  flex-shrink: 0;
}
/*
 * 收窄：标签多到并排排不下时（判定见 utils/tabbar.ts）再压一档，
 * 这样「20 个标签」看到的仍是尽可能多的标签，而不是几个被截断的长标题。
 * 当前标签留宽一点 —— 它是要读的那个。
 */
.tabs-scroll.compact .tab {
  max-width: 128px;
}
.tabs-scroll.compact .tab.active {
  max-width: 200px;
}
/* 溢出清单按钮上的数字是次要信息，压小一档别抢标签的位置 */
.tab-overflow {
  font-size: var(--fs-sm);
  padding: 0 var(--sp-2);
}
/*
 * 右侧那排动作按钮（分屏 / SFTP）。
 * 和标签一样是圆角块，不再用 border-left 划竖线 —— 竖线会把它们和标签
 * 混成同一排「格子」，它们是**动作**，不是可切换的标签。
 */
.bar-btn {
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  height: 30px;
  border: none;
  border-radius: var(--r-sm);
  background: none;
  color: var(--fg-muted);
  font-size: var(--fs-md);
  padding: 0 var(--sp-2);
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.bar-btn:hover {
  color: var(--fg);
  background: var(--bg-hover);
}
.bar-btn:active:not(:disabled) {
  background: var(--bg-active);
  transform: translateY(0.5px);
}
.bar-btn.on {
  color: var(--accent-text);
  background: var(--bg-hover);
  box-shadow: inset 0 -2px 0 var(--accent);
}
/*
 * 批量勾选按钮：它是广播的**从属**动作，不是并列的第四个功能，
 * 所以压一档字号、换个更轻的底色 —— 一眼看出「这个按钮属于旁边那个」。
 */
.bc-bulk {
  font-size: var(--fs-sm);
  color: var(--fg-secondary);
}
.bc-bulk:hover {
  color: var(--accent-text);
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--r-pill);
  background: var(--fg-muted);
}
.status-dot.connecting,
.status-dot.reconnecting {
  background: var(--warning-text);
  animation: pulse 1s infinite alternate;
}
.status-dot.connected {
  background: var(--success-text);
}
/* 只有 error 配红：主动 exit/对端关闭的 closed 用灰——红色留给「出事了」 */
.status-dot.error {
  background: var(--danger-text);
}
.status-dot.closed {
  background: var(--fg-muted);
}
@keyframes pulse {
  from {
    opacity: 0.4;
  }
  to {
    opacity: 1;
  }
}
/*
 * 广播勾选框：勾上时填 --accent。
 * 尺寸刻意比 tab-close 小 —— 它是个「状态标记 + 小开关」，不是并列的动作按钮，
 * 太大反而会跟关闭键抢点击。但也不能小到点不中：18px 是这套界面里
 * 「最小但还点得着」的那一档（标签高 30px，上下各留 6px 不挤）。
 */
.tab-bc {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1.5px solid var(--border-strong);
  border-radius: var(--r-xs);
  background: none;
  color: var(--fg-on-accent);
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.tab-bc:hover {
  border-color: var(--accent);
}
.tab-bc:active {
  transform: translateY(0.5px);
}
.tab-bc.on {
  background: var(--accent);
  border-color: var(--accent);
}
.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  /* 24×24 的点击区：原来只有 2px padding（约 16px），比 Fitts 定律允许的
     最小值还小，误点成「切标签」的概率很高 */
  width: 24px;
  height: 24px;
  border-radius: var(--r-sm);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.tab-close:hover {
  color: var(--fg-on-accent);
  background: var(--danger-text);
}
.tab-close:active {
  transform: translateY(0.5px);
}
.tab-new {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--r-sm);
  background: none;
  color: var(--fg-muted);
  width: 28px;
  height: 28px;
  margin-left: var(--sp-1);
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.tab-new:hover {
  color: var(--accent-text);
  background: var(--bg-hover);
}
.tab-new:active {
  background: var(--bg-active);
  transform: translateY(0.5px);
}
.exit-badge {
  font-size: var(--fs-xs);
  color: var(--danger-text);
  background: var(--danger-soft);
  border-radius: var(--r-xs);
  padding: 0 var(--sp-1);
  line-height: 15px;
}
/* 纵向：上面是工作区（终端 + SFTP + 编辑器），下面是传输队列停靠条 */
.terminal-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.workspace {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
}
.terminal-stack {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
/*
 * 格子壳。
 *
 * **普通模式必须等于「不存在」**：display:contents 让这层壳不生成盒子，
 * `.tab-content` 依旧等价于 .terminal-stack 的直接 flex 子项 —— 加壳前后
 * 布局逐像素一致，靠 `.tab-content:not([style*="display: none"])` 挑当前标签的
 * 那一堆验证脚本才不会被我顺手打坏。显隐也仍然留在 .tab-content 上（v-show）。
 */
.tile {
  display: contents;
}
/*
 * 平铺：所有标签同屏各占一格。
 *
 * 列数由 JS 按可用宽度算（--tile-cols，见 utils/tileGrid.ts），这里只负责摆。
 * `grid-auto-rows` 的下限是关键：格子**绝不能被压到 safeFit 的 120×60 以下** ——
 * 低于那条线 fit 会被静默拒绝，格子会停在旧尺寸上（界面上完全看不出来，
 * pty 那边尺寸是错的）。所以放不下时宁可让这一层滚动，也不缩格子。
 */
.terminal-stack.tiled {
  display: grid;
  grid-template-columns: repeat(var(--tile-cols, 1), minmax(0, 1fr));
  grid-auto-rows: minmax(var(--tile-min-h, 200px), 1fr);
  gap: var(--sp-2);
  padding: var(--sp-2);
  overflow: auto;
}
.terminal-stack.tiled .tile {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}
/* 平铺时「当前格子」靠这一圈，而不是里面每个 pane 自己的焦点环 —— 四格全亮环
   就等于没有信号。非当前格子里的 pane 环隐掉；分屏的格子内部仍看得出哪一半。 */
.terminal-stack.tiled .tile.focused {
  outline: 1px solid var(--focus-ring);
  outline-offset: -1px;
}
.terminal-stack.tiled .tile:not(.focused) .pane.focused {
  outline: none;
}
.tile-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: 0 0 auto;
  height: 26px;
  padding: 0 var(--sp-2);
  background: var(--bg-sunken);
  border-bottom: 1px solid var(--border);
  color: var(--fg-secondary);
  font-size: var(--fs-sm);
  cursor: pointer;
  user-select: none;
}
/* 标题会被 tabLabel 拼成「本地 · 某个很长的目录名」，必须自己截断，
   否则它要么撑破格子、要么把右边的按钮挤出可视区 */
.tile-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.tile-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  /* 24px 命中区：格子的标题条不高，这枚按钮要是点不中，就只能在 20 个标签里找它 */
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--r-sm);
  background: none;
  color: var(--fg-muted);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
/* 关闭是破坏性动作：悬停用危险色，跟标签栏上的关闭键同一套读法 */
.tile-close:hover {
  color: var(--fg-on-accent);
  background: var(--danger-text);
}
.tile-close:active {
  transform: translateY(0.5px);
}
/* 编辑器打开时重新分配宽度：文件列表退成窄导航条，编辑器拿到能写代码的宽度。
   列表收窄必须同时把固定宽度的「时间」列藏掉 —— 否则尺寸+时间就占满整行，
   文件名被挤成 0 宽（列表变成一排只有图标的空行）。 */
.terminal-area.editor-open .terminal-stack {
  flex: 0 1 33%;
}
.terminal-area.editor-open :deep(.explorer) {
  width: 250px;
}
.terminal-area.editor-open :deep(.explorer .file-time) {
  display: none;
}
.terminal-area.editor-open :deep(.explorer .file-size) {
  width: 52px;
}
.tab-content {
  flex: 1;
  min-height: 0;
  display: flex;
}
.tab-content.split-row {
  flex-direction: row;
}
.tab-content.split-column {
  flex-direction: column;
}
.pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
  display: flex;
}
.pane + .pane {
  border-left: 1px solid var(--border);
}
.split-column .pane + .pane {
  border-left: none;
  border-top: 1px solid var(--border);
}
.pane.focused {
  outline: 1px solid var(--focus-ring);
  outline-offset: -1px;
}
.pane-close {
  position: absolute;
  top: var(--sp-1);
  right: var(--sp-2);
  /* 压在终端画面之上，所以比面板内的 sticky 层高一档 */
  z-index: calc(var(--z-sticky) + 1);
  background: color-mix(in srgb, var(--bg-panel) 80%, transparent);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--fg-muted);
  cursor: pointer;
  font-size: var(--fs-md);
  /* 命中区到 24px 那一档（原来上下没有内边距，只有 18 左右） */
  padding: var(--sp-1) var(--sp-2);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.pane-close:hover {
  color: var(--danger-text);
  border-color: var(--danger-text);
}
.pane-close:active {
  transform: translateY(0.5px);
}
.welcome {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--fg);
  background:
    radial-gradient(circle at 50% 38%, var(--accent-soft), transparent 34%),
    var(--bg);
}
.welcome-mark {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  margin-bottom: var(--sp-4);
  color: var(--accent-text);
  background: var(--accent-soft);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-md);
}
.welcome h2 {
  margin: 0;
  font-size: var(--fs-2xl);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.02em;
}
.welcome-subtitle {
  margin: var(--sp-2) 0 var(--sp-5);
  color: var(--fg-secondary);
  font-size: var(--fs-lg);
}
.welcome-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(210px, 1fr));
  gap: var(--sp-3);
  width: min(520px, calc(100% - 40px));
}
.welcome-card {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-height: 72px;
  padding: 0 var(--sp-4);
  color: var(--fg);
  text-align: left;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.welcome-card:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
  transform: translateY(-1px);
}
.welcome-card:active {
  transform: translateY(0.5px);
}
.welcome-card.primary {
  color: var(--fg-on-accent);
  background: var(--accent-text);
  border-color: var(--accent-text);
}
.welcome-card.primary:hover {
  background: var(--accent-hover);
}
.welcome-card span {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.welcome-card strong {
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
}
.welcome-card small {
  color: inherit;
  opacity: 0.72;
  font-size: var(--fs-xs);
}
.welcome-tip {
  margin: 18px 0 0;
  color: var(--fg-muted);
  font-size: var(--fs-sm);
}
.tab-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-muted);
  font-size: var(--fs-md);
}
.resume-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-5);
  text-align: center;
}
.resume-hint p {
  margin: 0;
  font-size: var(--fs-md);
}
.resume-btn {
  background: none;
  border: 1px dashed var(--fg-muted);
  border-radius: var(--r-sm);
  color: var(--accent-text);
  cursor: pointer;
  font-size: var(--fs-md);
  padding: var(--sp-2) var(--sp-4);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.resume-btn:hover {
  border-color: var(--accent-text);
  background: var(--bg-hover);
}
.resume-btn:active {
  transform: translateY(0.5px);
}
/*
 * 死 pane 的原地复活覆盖层：居中浮在冻住的终端上。
 * 半透明底 + 模糊，看得出后面是死掉的终端内容（那是上下文，不该遮没）。
 */
.pane-revive {
  position: absolute;
  inset: 0;
  z-index: var(--z-sticky);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  background: color-mix(in srgb, var(--bg) 62%, transparent);
  backdrop-filter: var(--blur-veil);
}
.revive-text {
  margin: 0;
  max-width: 70%;
  font-size: var(--fs-md);
  color: var(--fg);
  text-align: center;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.revive-actions {
  display: flex;
  gap: var(--sp-2);
}
/* 复活覆盖层里的按钮直接用全局 .btn / .btn.primary（原先是本地又抄了一份） */
.placeholder-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  max-width: 70%;
  text-align: center;
}
.placeholder-error p {
  margin: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
</style>
