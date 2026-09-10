<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { useSessionStore, type SessionTab } from './stores/sessions'
import { useEditorStore } from './stores/editor'
import SessionSidebar from './components/SessionSidebar.vue'
import TerminalPanel from './components/TerminalPanel.vue'
import FileExplorer from './components/FileExplorer.vue'
import FileEditor from './components/FileEditor.vue'
import TransferQueue from './components/TransferQueue.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import HostKeyDialog from './components/HostKeyDialog.vue'

const store = useSessionStore()
const editor = useEditorStore()

// Wave 形态：应用启动即开一个本地终端标签页
onMounted(() => {
  if (store.tabs.length === 0) void store.connectLocal()
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
</script>

<template>
  <div class="layout">
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
          >
            <span
              class="status-dot"
              :class="tab.panes.find((p) => p.paneId === tab.activePaneId)?.status"
            ></span>
            <span class="tab-title">{{ tabLabel(tab) }}</span>
            <!-- 上一条命令失败时留个记号：滚屏后也能看出刚才那条命令挂了 -->
            <span
              v-if="activeExitCode(tab)"
              class="exit-badge"
              :title="`上一条命令退出码 ${activeExitCode(tab)}`"
            >✗{{ activeExitCode(tab) }}</span>
            <button class="tab-close" title="关闭" @click.stop="store.closeTab(tab)">×</button>
          </div>

          <button class="tab-new" title="新建本地终端" @click="store.connectLocal()">＋</button>
        </div>

        <template v-if="store.activePane?.sessionId">
          <button
            v-if="store.activeTab!.split === 'none'"
            class="bar-btn"
            title="向右分屏（同主机新会话）"
            @click="split('row')"
          >◧</button>
          <button
            v-if="store.activeTab!.split === 'none'"
            class="bar-btn"
            title="向下分屏（同主机新会话）"
            @click="split('column')"
          >⬓</button>
          <button
            v-if="store.activeTab!.kind === 'ssh'"
            class="bar-btn"
            :class="{ on: store.sftpVisible }"
            title="SFTP 文件面板"
            @click="toggleSftp"
          >📂 SFTP</button>
        </template>
      </div>

      <!-- 终端 + SFTP 分栏 -->
      <div class="terminal-area" :class="{ 'editor-open': editor.visible }">
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
              <div v-else class="tab-placeholder">
                <template v-if="pane.status === 'connecting'">正在连接 {{ tab.title }} …</template>
                <template v-else-if="pane.status === 'error'">连接失败：{{ pane.error }}</template>
              </div>
              <button
                v-if="tab.panes.length > 1"
                class="pane-close"
                title="关闭此窗格"
                @click.stop="store.closePane(tab, pane)"
              >×</button>
            </div>
          </div>
        </div>

        <FileExplorer
          v-if="store.sftpVisible && store.activeTab?.kind === 'ssh' && store.activeSessionId"
          :key="store.activeSessionId"
          :session-id="store.activeSessionId"
        />

        <!-- 双击文件后在此编辑；key 绑定会话，切会话不串内容 -->
        <FileEditor
          v-if="store.sftpVisible && editor.visible && store.activeSessionId"
          :key="`ed-${store.activeSessionId}`"
          :session-id="store.activeSessionId"
        />

        <TransferQueue />
      </div>
    </div>

    <SettingsDialog />
    <HostKeyDialog />
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  width: 100vw;
  height: 100vh;
}
.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.tab-bar {
  display: flex;
  background: #16161e;
  border-bottom: 1px solid #2a2b3d;
  flex-shrink: 0;
}
.tabs-scroll {
  flex: 1;
  display: flex;
  overflow-x: auto;
  min-width: 0;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 13px;
  color: #565f89;
  cursor: pointer;
  border-right: 1px solid #2a2b3d;
  white-space: nowrap;
}
.tab.active {
  color: #c0caf5;
  background: #1a1b26;
}
.bar-btn {
  border: none;
  border-left: 1px solid #2a2b3d;
  background: none;
  color: #565f89;
  font-size: 13px;
  padding: 0 12px;
  cursor: pointer;
  white-space: nowrap;
}
.bar-btn:hover {
  color: #c0caf5;
}
.bar-btn.on {
  color: #7aa2f7;
  background: #1a1b26;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #565f89;
}
.status-dot.connecting {
  background: #e0af68;
  animation: pulse 1s infinite alternate;
}
.status-dot.connected {
  background: #9ece6a;
}
.status-dot.error,
.status-dot.closed {
  background: #f7768e;
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
  background: none;
  border: none;
  color: #565f89;
  cursor: pointer;
  font-size: 14px;
  padding: 0 2px;
}
.tab-close:hover {
  color: #f7768e;
}
.tab-new {
  border: none;
  border-right: 1px solid #2a2b3d;
  background: none;
  color: #565f89;
  font-size: 15px;
  padding: 0 14px;
  cursor: pointer;
  flex-shrink: 0;
  line-height: 1;
}
.tab-new:hover {
  color: #7aa2f7;
  background: #1f2335;
}
.exit-badge {
  font-size: 10px;
  color: #f7768e;
  background: rgba(247, 118, 142, 0.14);
  border-radius: 3px;
  padding: 0 4px;
  line-height: 15px;
}
.terminal-area {
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
  border-left: 1px solid #2a2b3d;
}
.split-column .pane + .pane {
  border-left: none;
  border-top: 1px solid #2a2b3d;
}
.pane.focused {
  outline: 1px solid #3d59a1;
  outline-offset: -1px;
}
.pane-close {
  position: absolute;
  top: 4px;
  right: 6px;
  z-index: 6;
  background: rgba(22, 22, 30, 0.8);
  border: 1px solid #2a2b3d;
  border-radius: 4px;
  color: #565f89;
  cursor: pointer;
  font-size: 13px;
  padding: 0 6px;
}
.pane-close:hover {
  color: #f7768e;
}
.welcome {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #565f89;
}
.tab-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #565f89;
  font-size: 14px;
}
</style>
