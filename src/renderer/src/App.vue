<script setup lang="ts">
import { defineAsyncComponent, computed, nextTick, onMounted, ref, watch } from 'vue'
import { useSessionStore, type SessionTab } from './stores/sessions'
import { useEditorStore } from './stores/editor'
import { useLayoutStore } from './stores/layout'
import SessionSidebar from './components/SessionSidebar.vue'
import TitleBar from './components/TitleBar.vue'
import TerminalPanel from './components/TerminalPanel.vue'
import FileExplorer from './components/FileExplorer.vue'
import ProcessPanel from './components/ProcessPanel.vue'
import TransferQueue from './components/TransferQueue.vue'
import ComposeDrawer from './components/ComposeDrawer.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import HostKeyDialog from './components/HostKeyDialog.vue'
import Icon from './components/Icon.vue'

/*
 * 编辑器懒加载：CodeMirror + 15 个语言包是首包里最大的一块死重 ——
 * 只有真打开文件时才用得着。defineAsyncComponent 让它进独立 chunk，
 * 首次双击文件时才下载解析。
 */
const FileEditor = defineAsyncComponent(() => import('./components/FileEditor.vue'))

const store = useSessionStore()
const editor = useEditorStore()
const layout = useLayoutStore()

// Wave 形态：应用启动即开一个本地终端标签页。
// 若上次退出时还有布局，则先按布局恢复；只有恢复不出东西时才开默认本地终端。
onMounted(async () => {
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

/** sessionId → TerminalPanel 实例，用于标签页/分屏切换后 refit + focus */
const panelRefs = ref<Record<string, InstanceType<typeof TerminalPanel>>>({})

function setPanelRef(sessionId: string, el: InstanceType<typeof TerminalPanel> | null): void {
  if (el) panelRefs.value[sessionId] = el
  else delete panelRefs.value[sessionId]
}

/** 当前聚焦窗格上一条命令的退出码（shell integration，OSC 133 上报） */
function activeExitCode(tab: SessionTab): number | undefined {
  const sessionId = tab.panes.find((p) => p.paneId === tab.activePaneId)?.sessionId
  const code = sessionId ? store.exitCodeBySession[sessionId] : undefined
  return code ? code : undefined
}

/** 标签标题：本地终端显示当前目录（shell integration 上报） */
function tabLabel(tab: SessionTab): string {
  const sessionId = tab.panes.find((p) => p.paneId === tab.activePaneId)?.sessionId
  const cwd = sessionId ? store.cwdBySession[sessionId] : undefined
  if (tab.kind === 'local' && cwd) {
    const name = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    return name ? `本地 · ${name}` : '本地终端'
  }
  return tab.title
}

/**
 * 分屏标签的状态点取**所有** pane 中最差的状态：
 * 后台 pane（没聚焦的那半个）死了不能无声无息 —— 原来状态点只读
 * activePane，后台 pane 挂了要等用户切过去才发现屏幕早就冻住了。
 */
const STATUS_RANK: Record<string, number> = {
  error: 0,
  reconnecting: 1,
  connecting: 2,
  connected: 3,
  closed: 4
}
function tabStatus(tab: SessionTab): string {
  let worst = 'closed'
  for (const p of tab.panes) {
    if ((STATUS_RANK[p.status] ?? 4) < (STATUS_RANK[worst] ?? 4)) worst = p.status
  }
  return worst
}

/*
 * 激活标签变化（点击/关闭相邻/键盘）后：
 * 滚进可视区 —— 标签多到溢出时，store 里变了用户却看不见它；
 * refit —— 关标签触发的切换原来不 refit，终端行列是关标签前算的旧值。
 */
watch(
  () => store.activeTabId,
  async () => {
    await nextTick()
    document.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (store.activeTab) refitTab(store.activeTab)
  }
)

async function activate(tab: SessionTab): Promise<void> {
  store.activeTabId = tab.tabId
  await nextTick()
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

/** 分栏/标签切换后，该标签下所有 pane 都需要重新 fit */
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

/**
 * 当前标签的文件面板目标：SSH 标签浏览宿主机；容器标签浏览容器
 * （经容器里的 dox-agent，FileExplorer 内部处理未安装的引导）。
 * 本机容器也在内（agent 通道走本机 docker CLI）；本地终端没有可浏览的目标。
 */
const sftpTarget = computed<{ sessionId: string; container?: { parentSessionId: string; containerName: string } } | null>(() => {
  const tab = store.activeTab
  const paneId = store.activePane?.sessionId
  if (!tab || !paneId) return null
  if (tab.kind === 'ssh') return { sessionId: paneId }
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
        <div class="tabs-scroll">
          <div
            v-for="tab in store.tabs"
            :key="tab.tabId"
            class="tab"
            :class="{ active: tab.tabId === store.activeTabId }"
            @click="activate(tab)"
            @auxclick.middle.prevent="store.closeTab(tab)"
          >
            <span class="status-dot" :class="tabStatus(tab)"></span>
            <span class="tab-title">{{ tabLabel(tab) }}</span>
            <!-- 上一条命令失败时留个记号：滚屏后也能看出刚才那条命令挂了 -->
            <span
              v-if="activeExitCode(tab)"
              class="exit-badge"
              :title="`上一条命令退出码 ${activeExitCode(tab)}`"
            >✗{{ activeExitCode(tab) }}</span>
            <button class="tab-close" title="关闭" @click.stop="store.closeTab(tab)">
              <Icon name="x" :size="12" />
            </button>
          </div>

          <button class="tab-new" title="新建本地终端" @click="store.connectLocal()">
            <Icon name="plus" :size="15" />
          </button>
        </div>

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
            :title="store.activeTab!.kind === 'container' ? '容器文件面板（经容器助手）' : 'SFTP 文件面板'"
            @click="toggleSftp"
          ><Icon name="folder" /> SFTP</button>
        </template>
      </div>

      <!--
        终端 + SFTP 分栏，传输队列停靠在最下方。

        队列原来是绝对定位浮在右下角的，而 SFTP 面板正好在右侧 ——
        传几个文件后队列一出现，文件列表底部那几十行就被盖住点不动了
        （双击、悬停、拖拽全被截走）。改成一整条底部停靠，占自己的高度，
        不再遮任何东西。
      -->
      <div class="terminal-area" :class="{ 'editor-open': editor.visible }">
        <div class="workspace">
          <div v-if="!store.tabs.length" class="welcome">
            <h2>Dox 终端</h2>
            <p>本地终端启动中… SSH 会话请从左侧连接。</p>
          </div>

          <div class="terminal-stack">
            <div
              v-for="tab in store.tabs"
              :key="tab.tabId"
              v-show="tab.tabId === store.activeTabId"
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

          <FileExplorer
            v-if="store.sftpVisible && sftpTarget"
            :key="sftpTarget.sessionId"
            :session-id="sftpTarget.sessionId"
            :container="sftpTarget.container"
          />

          <!-- 进程管理面板（终端右键「进程管理」打开；目标随打开时的标签定） -->
          <ProcessPanel
            v-if="store.procTarget"
            :key="store.procTarget.sessionId + ':' + (store.procTarget.containerName ?? '')"
            :session-id="store.procTarget.sessionId"
            :container-name="store.procTarget.containerName"
            :label="store.procTarget.label"
            :initial-filter="store.procTarget.filter"
          />

          <!-- 双击文件后在此编辑；key 绑定会话，切会话不串内容 -->
          <FileEditor
            v-if="store.sftpVisible && editor.visible && store.activeSessionId"
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
  grid-template-rows: auto 1fr;
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
  height: 48px;
  padding: 0 var(--sp-2);
  gap: var(--sp-2);
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
  height: 32px;
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
    color var(--dur-base) var(--ease-out);
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
/*
 * 右侧那排动作按钮（分屏 / SFTP）。
 * 和标签一样是圆角块，不再用 border-left 划竖线 —— 竖线会把它们和标签
 * 混成同一排「格子」，它们是**动作**，不是可切换的标签。
 */
.bar-btn {
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  border: none;
  border-radius: var(--r-sm);
  background: none;
  color: var(--fg-muted);
  font-size: var(--fs-md);
  padding: 0 10px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.bar-btn:hover {
  color: var(--fg);
  background: var(--bg-hover);
}
.bar-btn.on {
  color: var(--accent-text);
  background: var(--bg-hover);
  box-shadow: inset 0 -2px 0 var(--accent);
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
  width: 22px;
  height: 22px;
  border-radius: var(--r-sm);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.tab-close:hover {
  color: var(--fg-on-accent);
  background: var(--danger-text);
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
  margin-left: 3px;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.tab-new:hover {
  color: var(--accent-text);
  background: var(--bg-hover);
}
.exit-badge {
  font-size: var(--fs-xs);
  color: var(--danger-text);
  background: var(--danger-soft);
  border-radius: var(--r-xs);
  padding: 0 4px;
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
  top: 4px;
  right: 6px;
  z-index: 6;
  background: color-mix(in srgb, var(--bg-panel) 80%, transparent);
  border: 1px solid var(--border);
  border-radius: var(--r-xs);
  color: var(--fg-muted);
  cursor: pointer;
  font-size: var(--fs-md);
  padding: 0 6px;
}
.pane-close:hover {
  color: var(--danger-text);
}
.welcome {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--fg-muted);
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
  gap: 12px;
  padding: 20px;
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
  padding: 6px 14px;
}
.resume-btn:hover {
  border-color: var(--accent-text);
  background: var(--bg-hover);
}
/*
 * 死 pane 的原地复活覆盖层：居中浮在冻住的终端上。
 * 半透明底 + 模糊，看得出后面是死掉的终端内容（那是上下文，不该遮没）。
 */
.pane-revive {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: color-mix(in srgb, var(--bg) 62%, transparent);
  backdrop-filter: blur(2px);
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
.pane-revive .btn,
.placeholder-error .btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--fg);
  border-radius: var(--r-sm);
  padding: 6px 16px;
  font-size: var(--fs-md);
  cursor: pointer;
}
.pane-revive .btn:hover,
.placeholder-error .btn:hover {
  background: var(--bg-hover);
}
.pane-revive .btn.primary,
.placeholder-error .btn.primary {
  background: var(--accent-text);
  border-color: var(--accent-text);
  color: var(--bg-panel);
  font-weight: 600;
}
.placeholder-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
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
