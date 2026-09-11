<script setup lang="ts">
import { ref, watch } from 'vue'
import { useSessionStore } from '../stores/sessions'
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
 */
async function refresh(): Promise<void> {
  status.value = null
  errorMsg.value = ''
  if (!store.activeSessionId) return
  try {
    status.value = await window.api.agentStatus(store.activeSessionId)
  } catch {
    status.value = { installed: false }
  }
}

async function install(): Promise<void> {
  if (!store.activeSessionId || installing.value) return
  installing.value = true
  errorMsg.value = ''
  try {
    status.value = await window.api.agentInstall(store.activeSessionId)
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
    <div v-if="!store.activeSessionId" class="empty-hint">连接 SSH 会话后可安装远程助手</div>

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
        <button class="btn primary" :disabled="installing" @click="install">
          {{ installing ? '安装中…' : '安装到这台机器' }}
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
