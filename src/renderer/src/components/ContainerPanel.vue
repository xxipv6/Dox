<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { ContainerInfo, ContainerProbeResult } from '@shared/types'
import { useSessionStore } from '../stores/sessions'
import { errorText } from '../utils/errors'
import { LOCAL_CONTAINER_TARGET } from '@shared/sessionId'
import ContextMenu, { type ContextMenuItem } from './ContextMenu.vue'
import Icon from './Icon.vue'
import Spinner from './Spinner.vue'
import SidebarSection from './SidebarSection.vue'

/**
 * 远端容器列表（Docker / Podman）。
 *
 * 只在只读探测与 `docker exec` 之间往返，不往远端或容器里装任何东西。
 * 列表是取一次 + 手动刷新，不做定时轮询 —— 那等于隔几秒就在远端敲一次
 * `docker ps`，而容器状态是人的时间尺度，不需要秒级新鲜度。
 */

const api = window.api
const store = useSessionStore()

const result = ref<ContainerProbeResult | null>(null)
const loading = ref(false)
const entering = ref<string | null>(null)
/** 正在做生命周期操作的容器名（启动/停止/恢复/删除） */
const controlling = ref<string | null>(null)
const menu = ref<{ x: number; y: number; box: ContainerInfo } | null>(null)

/**
 * 要列哪个会话的容器。
 *
 * 刻意**不**用 `store.activeSessionId`：
 *  - 聚焦在容器标签上时，activeSessionId 是容器会话，拿它去列容器是错的；
 *    容器标签列的是**它里面的嵌套容器**（链 = 当前容器的链 + 它自己），
 *    父会话仍是它的承载会话。容器里没有 docker/podman 就是干净的「没有」。
 *  - 本地终端和「没有标签」都返回 null。
 */
const parentSessionId = computed<string | null>(() => {
  const tab = store.activeTab
  if (!tab) return null
  if (tab.kind === 'container') return tab.container?.parentSessionId ?? null
  /*
   * 本地终端列的是**本机**的容器。
   *
   * 用哨兵而不是 null：null 在这个位置已经被「没有可列的目标」占用了，
   * 拿它兼表「本机」会让两种完全不同的情况塌成同一个界面。
   */
  if (tab.kind === 'local') return LOCAL_CONTAINER_TARGET
  return store.activeSessionId
})

/** 嵌套目标：当前标签是容器 → 列它里面的容器（链 = 它自己的链 + 它自己） */
const nestedChain = computed<string[] | undefined>(() => {
  const tab = store.activeTab
  if (tab?.kind !== 'container' || !tab.container) return undefined
  return [...(tab.container.chain ?? []), tab.container.containerName]
})

/** 目标此刻是否可用。断线期间列表还在，但不能点进去 */
const parentReady = computed(() => {
  const tab = store.activeTab
  if (!tab) return false
  // 容器标签：当前容器的会话活着就能进嵌套（docker exec 链从它出去）
  if (tab.kind === 'container') return tab.panes.some((p) => p.status === 'connected')
  /*
   * 本机恒为 true：这里没有「父会话」这回事。docker exec 是新起一个进程，
   * 本地的那个 shell 死没死都拦不住它 —— 拿本地终端的连接状态来限制进入，
   * 是在用一个不相干的事实做判断。
   */
  if (tab.kind === 'local') return true
  return tab.panes.some((p) => p.status === 'connected')
})

/**
 * 「现在不能进容器」的原因文案。
 *
 * `parentReady` 为 false 的成因要分开说：容器标签里是当前容器会话断了，
 * 说「父会话已断开」是假话。
 */
const blockedHint = computed(() =>
  store.activeTab?.kind === 'container'
    ? '当前容器会话已断开，恢复后即可进入嵌套容器'
    : '父会话已断开，恢复后即可进入容器'
)

const containers = computed(() => (result.value?.ok ? result.value.list.containers : []))
const runtimeLabel = computed(() =>
  result.value?.ok ? (result.value.list.runtime === 'podman' ? 'Podman' : 'Docker') : ''
)

async function refresh(): Promise<void> {
  const sessionId = parentSessionId.value
  if (!sessionId) {
    result.value = null
    return
  }
  // 刷新期间**保留**旧列表（降透明度，见 .container-list.refreshing）：
  // 先清空再加载的话，每次切标签/点刷新面板都要闪一下空态
  loading.value = true
  try {
    result.value = await api.listContainers(sessionId, nestedChain.value)
  } catch (err) {
    result.value = { ok: false, reason: 'error', message: errorText(err) }
  } finally {
    loading.value = false
  }
}

onMounted(refresh)
// 换会话/换嵌套目标都要重新探测
watch([parentSessionId, nestedChain], refresh)
/*
 * 父会话重连回来之后要重新列一次：断线期间列表是灰的，
 * 状态翻回 connected 时用户期望它自己恢复。
 */
watch(
  () => store.activeTab?.panes.map((p) => p.status).join(','),
  (now, before) => {
    if (now?.includes('connected') && !before?.includes('connected')) void refresh()
  }
)

function onRowMenu(e: MouseEvent, box: ContainerInfo): void {
  menu.value = { x: e.clientX, y: e.clientY, box }
}

/**
 * 按容器状态出菜单：
 * - running：进得去、日志在看、可以停
 * - paused：先恢复再说（docker 对 paused 容器 stop/rm 都会报错）
 * - exited：启动、看日志（看它为什么挂）、删除
 * 生命周期操作是用户显式触发的 docker 子命令，与「不装 agent 不建文件」
 * 的远端零改动红线不冲突；stop/remove 落手前弹确认。
 */
const menuItems = computed<ContextMenuItem[]>(() => {
  const box = menu.value?.box
  if (!box) return []
  const ready = parentReady.value
  const busy = controlling.value === box.name
  const items: ContextMenuItem[] = []
  if (box.state === 'running') {
    items.push(
      { id: 'enter', label: '进入', icon: 'terminal', disabled: !ready || busy },
      { id: 'logs', label: '查看日志', icon: 'file', disabled: !ready || busy },
      { id: 'stop', label: '停止', icon: 'square', disabled: !ready || busy }
    )
  } else if (box.state === 'paused') {
    items.push(
      { id: 'unpause', label: '恢复', icon: 'play', disabled: !ready || busy },
      { id: 'logs', label: '查看日志', icon: 'file', disabled: !ready || busy }
    )
  } else {
    items.push(
      { id: 'start', label: '启动', icon: 'play', disabled: !ready || busy },
      { id: 'logs', label: '查看日志', icon: 'file', disabled: !ready || busy },
      { id: 'remove', label: '删除', icon: 'trash', danger: true, disabled: !ready || busy }
    )
  }
  return items
})

/** 停止/删除的确认文案（原生 confirm，走 Playwright 也能捕获的那条 dialog 通道） */
const CONFIRMS: Record<string, (name: string) => string> = {
  stop: (n) => `停止容器「${n}」？其中运行的服务会中断。`,
  remove: (n) => `删除容器「${n}」？此操作不可恢复（镜像与数据卷不受影响）。`
}

async function onMenuSelect(id: string): Promise<void> {
  const target = menu.value?.box
  const sessionId = parentSessionId.value
  menu.value = null
  if (!target || !sessionId) return

  if (id === 'logs') {
    try {
      await store.viewContainerLogs(sessionId, target, undefined, nestedChain.value)
    } catch (err) {
      alert(`查看日志失败：${errorText(err)}`)
    }
    return
  }

  if (id === 'enter') {
    entering.value = target.name
    try {
      // 失败原因（容器已停止 / 没有可用 shell / 被 seccomp 拒绝）由主进程写好，
      // 这里如实抛出来给用户看，不要吞成一句「失败了」
      await store.enterContainer(sessionId, target, undefined, nestedChain.value)
    } catch (err) {
      alert(`进入容器失败：${errorText(err)}`)
    } finally {
      entering.value = null
    }
    return
  }

  // start / stop / unpause / remove
  const ask = CONFIRMS[id]
  if (ask && !confirm(ask(target.name))) return
  controlling.value = target.name
  try {
    await api.controlContainer(sessionId, target.name, id as 'start' | 'stop' | 'unpause' | 'remove', nestedChain.value)
    // 状态变化是异步体现在 docker ps 里的，稍等再刷，否则列表可能还是旧状态
    await new Promise((r) => setTimeout(r, 600))
    await refresh()
  } catch (err) {
    alert(`操作失败：${errorText(err)}`)
    await refresh()
  } finally {
    controlling.value = null
  }
}
</script>

<template>
  <!--
    运行时（Docker/Podman）放在徽标位、刷新放在动作位：两者在**收起状态**下
    都要看得见 —— 收起时正是最需要「有几台容器」和「刷一下」的时候。
  -->
  <SidebarSection :title="containers.length ? `容器 · ${containers.length}` : '容器'" icon="box" :badge="runtimeLabel">
    <template #actions>
      <button
        class="icon-btn"
        :class="{ dim: !parentSessionId || loading }"
        title="刷新容器列表"
        @click="refresh"
      >
        <Icon name="refresh" :size="15" />
      </button>
    </template>

  <div v-if="!parentSessionId" class="empty-hint">
    打开一个本地终端，或连接一台设备，这里会列出它们上面的容器
  </div>
  <div v-else-if="loading && !containers.length" class="empty-hint">
    <Spinner text="正在探测远端容器…" />
  </div>

  <!-- 没装运行时 = 正常状态不是错误：淡色提示，不带重试 -->
  <div v-else-if="result && !result.ok && result.reason === 'no-binary'" class="empty-hint">
    {{ result.message }}
  </div>

  <!-- 真错误：一句话人话 + 原始报错折叠进「详细信息」 -->
  <div v-else-if="result && !result.ok" class="empty-hint error">
    {{ result.message }}
    <button class="retry" @click="refresh">重试</button>
    <details v-if="result.detail" class="err-detail">
      <summary>详细信息</summary>
      <pre>{{ result.detail }}</pre>
    </details>
  </div>

  <div v-else-if="!containers.length" class="empty-hint">
    {{ nestedChain ? '这个容器里没有容器' : '这台设备上没有容器' }}
  </div>

  <template v-else>
    <div v-if="result?.ok && result.list.formatDowngraded" class="empty-hint">
      远端 {{ runtimeLabel }} 版本较旧，状态信息不可用
    </div>
    <!-- 父会话断开时列表变灰不可点：还能看见有什么，但不能假装进得去 -->
    <div class="container-list" :class="{ stale: !parentReady, refreshing: loading }">
      <div
        v-for="box in containers"
        :key="box.id"
        class="container"
        :class="{ stopped: box.state !== 'running' && box.state !== 'paused' }"
        :title="`${box.name}\n${box.image}\n${box.status}\n${box.id}`"
        @contextmenu.prevent="onRowMenu($event, box)"
      >
        <span class="dot" :class="[box.state, box.health]"></span>
        <span class="container-info">
          <span class="container-name">{{ box.name }}</span>
          <span class="container-meta">{{ box.image }} · {{ box.status }}</span>
        </span>
        <span v-if="entering === box.name" class="entering">进入中…</span>
        <span v-else-if="controlling === box.name" class="entering">处理中…</span>
      </div>
    </div>
    <div v-if="!parentReady" class="empty-hint">{{ blockedHint }}</div>
  </template>

  <ContextMenu
    v-if="menu"
    :x="menu.x"
    :y="menu.y"
    :items="menuItems"
    @select="onMenuSelect"
    @close="menu = null"
  />
  </SidebarSection>
</template>

<style scoped>
.empty-hint {
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  padding: 4px 2px;
  line-height: 1.6;
}
.empty-hint.error {
  color: var(--warning-text);
}
.retry {
  margin-left: 6px;
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--r-xs);
  color: var(--accent-text);
  font-size: var(--fs-xs);
  padding: 1px 6px;
  cursor: pointer;
}
.retry:hover {
  border-color: var(--accent-text);
}
/* 原始报错折叠区：默认收起，不糊主文案 */
.err-detail {
  margin-top: 4px;
  font-size: var(--fs-xs);
}
.err-detail summary {
  cursor: pointer;
  user-select: none;
  color: var(--fg-muted);
}
.err-detail pre {
  margin: 4px 0 0;
  padding: 6px 8px;
  background: var(--bg-hover);
  border-radius: var(--r-xs);
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--fg-muted);
  max-height: 120px;
  overflow-y: auto;
  user-select: text;
}
.container-list.stale {
  opacity: 0.5;
}
/* 刷新中：旧列表降透明度留在原地（不闪空态），但不可点 */
.container-list.refreshing {
  opacity: 0.55;
  pointer-events: none;
}
/* 已停止的容器淡一档：还在列表里（能启动/删除），但视觉上不和在跑的抢 */
.container.stopped {
  opacity: 0.62;
}
.container {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--r-sm);
  cursor: context-menu;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.container:hover {
  background: var(--bg-hover);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: var(--r-pill);
  flex-shrink: 0;
  background: var(--fg-muted);
}
.dot.running {
  background: var(--success-text);
}
.dot.paused,
.dot.starting {
  background: var(--warning-text);
}
.dot.unhealthy {
  background: var(--danger-text);
}
.container-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.container-name {
  font-size: var(--fs-sm);
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.container-meta {
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entering {
  flex-shrink: 0;
  font-size: var(--fs-xs);
  color: var(--accent-text);
}
</style>
