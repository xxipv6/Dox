<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { LocalShellInfo, WslDistroState } from '@shared/types'
import { useSessionStore } from '../stores/sessions'
import { errorText } from '../utils/errors'
import { pushToast } from '../stores/toast'
import Icon from './Icon.vue'
import Spinner from './Spinner.vue'
import SidebarSection from './SidebarSection.vue'
import ContextMenu, { type ContextMenuItem } from './ContextMenu.vue'

const store = useSessionStore()
const distros = ref<LocalShellInfo[]>([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const selectedId = ref('')
const menu = ref<{ x: number; y: number; shell: LocalShellInfo } | null>(null)
const menuItems: ContextMenuItem[] = [
  { id: 'open-terminal', label: '打开终端', icon: 'terminal' },
  { id: 'copy-name', label: '复制发行版名称', icon: 'copy' },
  { id: 'refresh', label: '刷新状态', icon: 'refresh' }
]
let requestSeq = 0
let disposed = false
let refreshTimer: ReturnType<typeof setTimeout> | null = null

const stateLabels: Record<WslDistroState, string> = {
  running: '后台运行',
  stopped: '未运行',
  unknown: '状态未知'
}

function stateOf(shell: LocalShellInfo): WslDistroState {
  return shell.wsl?.state ?? 'unknown'
}

function nameOf(shell: LocalShellInfo): string {
  return shell.wsl?.distro ?? shell.name
}

async function refresh(forceRefresh = false): Promise<void> {
  const seq = ++requestSeq
  loading.value = true
  error.value = ''
  try {
    const shells = await window.api.listLocalShells(forceRefresh)
    if (disposed || seq !== requestSeq) return
    distros.value = shells.filter((shell) => shell.wsl)
    if (!distros.value.some((shell) => shell.id === selectedId.value)) selectedId.value = ''
    if (menu.value && !distros.value.some((shell) => shell.id === menu.value?.shell.id)) menu.value = null
    loaded.value = true
  } catch (err) {
    if (disposed || seq !== requestSeq) return
    error.value = errorText(err)
  } finally {
    if (!disposed && seq === requestSeq) loading.value = false
  }
}

// 打开、连接完成、分屏/重连和关闭 WSL 标签后，重新取一次后台状态。
// 标签事件只触发查询，不会替用户 shutdown WSL；短暂连续变化合并为一次刷新。
watch(
  () =>
    store.tabs
      .filter((tab) => tab.kind === 'local' && tab.localShellId?.startsWith('wsl:'))
      .flatMap((tab) =>
        tab.panes.map(
          (pane) => `${tab.tabId}:${tab.localShellId}:${pane.sessionId ?? ''}:${pane.status}`
        )
      )
      .join('|'),
  () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refresh(true)
    }, 400)
  }
)

function select(shell: LocalShellInfo): void {
  selectedId.value = shell.id
}

function open(shell: LocalShellInfo): void {
  select(shell)
  menu.value = null
  // 仍走普通本地标签，只给这个标签显式固定发行版，不碰全局默认 Shell
  void store.connectLocal(undefined, shell.id)
}

function showMenu(event: MouseEvent, shell: LocalShellInfo): void {
  select(shell)
  menu.value = { x: event.clientX, y: event.clientY, shell }
}

async function onMenuSelect(id: string): Promise<void> {
  const shell = menu.value?.shell
  if (!shell) return
  if (id === 'open-terminal') open(shell)
  else if (id === 'refresh') {
    menu.value = null
    await refresh(true)
  } else if (id === 'copy-name') {
    menu.value = null
    try {
      await window.api.writeClipboardText(nameOf(shell))
      pushToast('已复制发行版名称', 'success', 1600)
    } catch (err) {
      pushToast(`复制失败：${errorText(err)}`)
    }
  }
}

onMounted(() => void refresh())
onBeforeUnmount(() => {
  disposed = true
  requestSeq++
  if (refreshTimer) clearTimeout(refreshTimer)
})
</script>

<template>
  <SidebarSection
    title="本机 WSL"
    icon="terminal"
    :badge="distros.length ? String(distros.length) : undefined"
    :open="true"
  >
    <template #actions>
      <button
        class="icon-btn"
        :class="{ dim: loading }"
        title="刷新 WSL 发行版"
        @click="refresh(true)"
      >
        <Icon name="refresh" :size="15" />
      </button>
    </template>

    <div v-if="loading && !loaded && !distros.length" class="empty-hint">
      <Spinner text="正在发现 WSL 发行版…" />
    </div>
    <div v-else-if="error && !distros.length" class="empty-hint error">
      无法获取 WSL 列表：{{ error }}
      <button class="retry" @click="refresh(true)">重试</button>
    </div>
    <div v-else-if="!distros.length" class="empty-hint wsl-empty">
      未发现 WSL 发行版
    </div>

    <template v-else>
      <div v-if="error" class="empty-hint error">
        刷新失败：{{ error }}
        <button class="retry" @click="refresh(true)">重试</button>
      </div>
      <div class="wsl-list" :class="{ refreshing: loading }">
        <button
          v-for="shell in distros"
          :key="shell.id"
          type="button"
          class="wsl-row"
          :class="{ selected: selectedId === shell.id }"
          :title="`${nameOf(shell)} · ${stateLabels[stateOf(shell)]}\n双击打开终端，右键查看更多操作`"
          @click="select(shell)"
          @dblclick="open(shell)"
          @keydown.enter.prevent="open(shell)"
          @contextmenu.prevent="showMenu($event, shell)"
        >
          <span class="wsl-dot" :class="stateOf(shell)"></span>
          <span class="wsl-info">
            <span class="wsl-name-line">
              <span class="wsl-name">{{ nameOf(shell) }}</span>
              <span v-if="shell.wsl?.isDefault" class="wsl-default">默认</span>
            </span>
            <span class="wsl-state">{{ stateLabels[stateOf(shell)] }}</span>
          </span>
        </button>
      </div>
    </template>
  </SidebarSection>
  <ContextMenu
    v-if="menu"
    :x="menu.x"
    :y="menu.y"
    :items="menuItems"
    @select="onMenuSelect"
    @close="menu = null"
  />
</template>

<style scoped>
.retry {
  margin-left: var(--sp-2);
}
.wsl-list.refreshing {
  opacity: 0.55;
  pointer-events: none;
}
.wsl-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.wsl-row:hover {
  background: var(--bg-hover);
}
.wsl-row.selected,
.wsl-row.selected:hover {
  background: var(--bg-active);
}
.wsl-row:focus-visible {
  outline: 1px solid var(--accent-text);
  outline-offset: -1px;
}
.wsl-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--r-pill);
  flex-shrink: 0;
  background: var(--fg-muted);
}
.wsl-dot.running {
  background: var(--success-text);
}
.wsl-dot.stopped {
  background: var(--fg-muted);
}
.wsl-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.wsl-name-line {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}
.wsl-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-sm);
  color: var(--fg);
}
.wsl-default {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: var(--r-pill);
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: var(--fs-xs);
}
.wsl-state {
  color: var(--fg-muted);
  font-size: var(--fs-xs);
}
</style>
