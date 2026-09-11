<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSessionStore } from '../stores/sessions'
import { LOCAL_CONTAINER_TARGET } from '@shared/sessionId'
import { errorText } from '../utils/errors'
import Icon from './Icon.vue'
import SidebarSection from './SidebarSection.vue'

interface AgentStatus {
  installed: boolean
  version?: string
  osArch?: string
}

const store = useSessionStore()
const status = ref<AgentStatus | null>(null)
const installing = ref(false)
const errorMsg = ref('')

/*
 * 远程助手（dox-agent）面板。
 *
 * 红线的现行口径：允许 agent，但永远 opt-in —— 只有用户在这里显式点
 * 「安装」才会把二进制推到远端 ~/.dox/dox-agent；不点，这台机器零改动。
 * 面板把「装在哪、干什么、怎么卸」写在明处，不藏在后台动作里。
 *
 * 目标解析刻意不用裸 activeSessionId（同 ContainerPanel 的教训）：
 * 聚焦在**容器标签**时 activeSessionId 是 container- 前缀的容器会话，
 * 它没有自己的 SSH 连接（借父会话的 docker exec 通道），拿去装 agent
 * 只会得到「会话已断开」。容器标签下装的是**宿主机**的助手 ——
 * 容器里的端口发现本就由宿主机助手经 docker 完成，不用往容器里装。
 */

/** 安装目标：容器标签 → 父 SSH 会话；普通 SSH 标签 → 自己；其余 → null */
const target = computed<{ sessionId: string; viaContainer: string | null } | null>(() => {
  const id = store.activeSessionId
  if (!id) return null
  const tab = store.tabs.find((t) => t.panes.some((p) => p.sessionId === id))
  if (tab?.kind === 'container' && tab.container) {
    if (tab.container.parentSessionId === LOCAL_CONTAINER_TARGET) return null
    return { sessionId: tab.container.parentSessionId, viaContainer: tab.container.containerName }
  }
  if (tab?.kind === 'local') return null
  return { sessionId: id, viaContainer: null }
})

async function refresh(): Promise<void> {
  status.value = null
  errorMsg.value = ''
  if (!target.value) return
  try {
    status.value = await window.api.agentStatus(target.value.sessionId)
  } catch {
    status.value = { installed: false }
  }
}

async function install(): Promise<void> {
  if (!target.value || installing.value) return
  installing.value = true
  errorMsg.value = ''
  try {
    status.value = await window.api.agentInstall(target.value.sessionId)
  } catch (err) {
    errorMsg.value = errorText(err)
  } finally {
    installing.value = false
  }
}

watch(() => store.activeSessionId, () => void refresh(), { immediate: true })
</script>

<template>
  <SidebarSection
    :title="status?.installed ? `助手 · v${status.version}` : '远程助手'"
    icon="zap"
  >
    <div v-if="!target" class="empty-hint">连接 SSH 会话后可安装远程助手</div>

    <template v-else>
      <div v-if="status === null" class="empty-hint">查询中…</div>

      <div v-else-if="status.installed" class="agent-ok">
        <Icon name="check" :size="13" />
        <span>已安装 v{{ status.version }}<template v-if="status.osArch">（{{ status.osArch }}）</template></span>
      </div>

      <template v-else>
        <p class="agent-desc">
          把 dox-agent（~2MB，Go 静态二进制）安装到远端
          <code>~/.dox/dox-agent</code>，解锁自动端口发现、GPU 监控等能力。
          不装系统目录、不要 root、不开机自启；删除该目录即完全卸载。
        </p>
        <p v-if="target.viaContainer" class="agent-desc">
          当前在容器「{{ target.viaContainer }}」里：助手装到<strong>宿主机</strong>，
          容器内的端口发现由它经 docker 完成，容器里不用装任何东西。
        </p>
        <button class="btn primary" :disabled="installing" @click="install">
          {{ installing ? '安装中…' : target.viaContainer ? '安装到宿主机' : '安装到这台机器' }}
        </button>
      </template>

      <p v-if="errorMsg" class="form-error">{{ errorMsg }}</p>
    </template>
  </SidebarSection>
</template>

<style scoped>
.empty-hint {
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  padding: 4px 2px;
}
.agent-ok {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font-size: var(--fs-sm);
  color: var(--success-text);
}
.agent-desc {
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  margin: 0 0 6px;
  line-height: 1.6;
}
.agent-desc code {
  font-family: Consolas, monospace;
  color: var(--fg);
}
.btn {
  padding: 6px 0;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--bg-hover);
  color: var(--fg);
  font-size: var(--fs-sm);
  cursor: pointer;
}
.btn.primary {
  background: var(--accent-text);
  border-color: var(--accent-text);
  color: var(--bg-panel);
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.form-error {
  font-size: var(--fs-xs);
  color: var(--danger-text);
  margin: 4px 0 0;
  word-break: break-all;
}
</style>
