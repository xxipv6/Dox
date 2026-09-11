<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSessionStore } from '../stores/sessions'
import { LOCAL_CONTAINER_TARGET } from '@shared/sessionId'
import { BUNDLED_AGENT_VERSION, agentVersionOlder } from '@shared/agentVersion'
import { errorText } from '../utils/errors'
import Icon from './Icon.vue'
import Spinner from './Spinner.vue'
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
/** 查询本身失败（连接问题）：和「未安装」是两回事，断线机器不该看到安装游说 */
const probeFailed = ref(false)

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

/** 安装目标：容器标签 → 容器内（父会话承载传输）；普通 SSH 标签 → 宿主机；其余 → null */
const target = computed<{ sessionId: string; containerName?: string } | null>(() => {
  const id = store.activeSessionId
  if (!id) return null
  const tab = store.tabs.find((t) => t.panes.some((p) => p.sessionId === id))
  if (tab?.kind === 'container' && tab.container) {
    if (tab.container.parentSessionId === LOCAL_CONTAINER_TARGET) return null
    return { sessionId: tab.container.parentSessionId, containerName: tab.container.containerName }
  }
  if (tab?.kind === 'local') return null
  return { sessionId: id }
})

async function refresh(): Promise<void> {
  status.value = null
  errorMsg.value = ''
  probeFailed.value = false
  if (!target.value) return
  try {
    status.value = await window.api.agentStatus(target.value.sessionId, target.value.containerName)
  } catch (err) {
    probeFailed.value = true
    errorMsg.value = errorText(err)
  }
}

async function install(): Promise<void> {
  if (!target.value || installing.value) return
  installing.value = true
  errorMsg.value = ''
  try {
    status.value = await window.api.agentInstall(target.value.sessionId, target.value.containerName)
    // 通知开着的终端标签重试 agent 通道（mount 时还是「未安装」，已走轮询兜底）
    store.markAgentInstalled()
  } catch (err) {
    errorMsg.value = errorText(err)
  } finally {
    installing.value = false
  }
}

/** 已安装但低于应用内置版本：提示升级（升级 = 覆盖安装 + 通道自动重启） */
const outdated = computed(
  () => !!status.value?.installed && !!status.value.version &&
    agentVersionOlder(status.value.version, BUNDLED_AGENT_VERSION)
)

watch(() => store.activeSessionId, () => void refresh(), { immediate: true })
</script>

<template>
  <SidebarSection
    :title="status?.installed ? `助手 · v${status.version}` : '远程助手'"
    icon="zap"
  >
    <div v-if="!target" class="empty-hint">连接 SSH 会话后可安装远程助手</div>

    <template v-else>
      <div v-if="status === null && !probeFailed" class="empty-hint">
        <Spinner text="查询中…" />
      </div>

      <!-- 查询失败（连接问题）：给重试，而不是摆出「未安装」的安装游说 -->
      <div v-else-if="probeFailed" class="agent-probe-fail">
        <span class="probe-fail-text">查询失败：{{ errorMsg }}</span>
        <button class="btn" @click="refresh">重试</button>
      </div>

      <template v-else-if="status?.installed">
        <div class="agent-ok">
          <Icon name="check" :size="13" />
          <span>
            已安装 v{{ status.version }}
            <template v-if="target.containerName">（容器 {{ target.containerName }}）</template>
            <template v-else-if="status.osArch">（{{ status.osArch }}）</template>
          </span>
        </div>
        <!-- 版本过旧：新应用 + 老助手，新能力（文件管理等）在老二进制上不存在 -->
        <div v-if="outdated" class="agent-upgrade">
          <button class="btn primary" :disabled="installing" @click="install">
            <Spinner v-if="installing" :size="12" />
            {{ installing ? '升级中…' : `升级到 v${BUNDLED_AGENT_VERSION}` }}
          </button>
        </div>
      </template>

      <template v-else>
        <p class="agent-desc">
          装一个小助手到<template v-if="target.containerName">容器「{{ target.containerName }}」里</template><template v-else>这台机器上</template>，
          解锁文件浏览上传、自动端口发现和系统状态监控。
          不装系统目录、不要 root、不开机自启。
        </p>
        <details class="agent-details">
          <summary>详情</summary>
          <p v-if="target.containerName" class="agent-desc">
            dox-agent（~2MB Go 静态二进制）经 docker cp 注入容器的 <code>/tmp/dox-agent</code>；
            容器删除即消失，stop/start 不影响，rm/重建后需重装。
          </p>
          <p v-else class="agent-desc">
            dox-agent（~2MB Go 静态二进制）安装到远端 <code>~/.dox/dox-agent</code>；
            删除该目录即完全卸载。
          </p>
        </details>
        <button class="btn primary" :disabled="installing" @click="install">
          <Spinner v-if="installing" :size="12" />
          {{ installing ? '安装中…' : target.containerName ? `安装到容器 ${target.containerName}` : '安装到这台机器' }}
        </button>
      </template>

      <p v-if="errorMsg && !probeFailed" class="form-error">{{ errorMsg }}</p>
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
.agent-upgrade {
  padding: 0 8px 4px 26px;
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
.agent-details {
  margin: 0 0 6px;
  font-size: var(--fs-xs);
  color: var(--fg-muted);
}
.agent-details summary {
  cursor: pointer;
  user-select: none;
}
.agent-probe-fail {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 4px 2px;
}
.probe-fail-text {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--danger-text);
  word-break: break-all;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 10px;
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
