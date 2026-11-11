<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSessionStore } from '../stores/sessions'
import { BUNDLED_AGENT_VERSION, agentVersionOlder } from '@shared/agentVersion'
import { errorText } from '../utils/errors'
import { useConfirmStore } from '../stores/confirm'
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
const uninstalling = ref(false)
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
 * 它没有自己的 SSH 连接（借父会话的 docker exec 通道）——容器目标统一
 * 解析成（父会话, 容器名）；本机容器的父会话是 LOCAL_CONTAINER_TARGET
 * 哨兵，AgentManager 对它走本机 docker CLI，一样能装。
 */

/** 安装目标：容器标签 → 容器内（父会话承载传输）；普通 SSH 标签 → 宿主机；其余 → null */
const target = computed<{ sessionId: string; containerName?: string } | null>(() => {
  const id = store.activeSessionId
  if (!id) return null
  const tab = store.tabs.find((t) => t.panes.some((p) => p.sessionId === id))
  if (tab?.kind === 'container' && tab.container) {
    // 嵌套容器（外层里的内层）不在安装面：docker cp 链没有嵌套实现
    if (tab.container.chain?.length) return null
    // 本机容器（LOCAL_CONTAINER_TARGET）也允许：AgentManager 对它走本机 docker CLI，不经 SSH
    return { sessionId: tab.container.parentSessionId, containerName: tab.container.containerName }
  }
  if (tab?.kind === 'local') return null
  return { sessionId: id }
})

let refreshSeq = 0
const targetIdentity = (value: typeof target.value): string =>
  value ? `${value.sessionId}::${value.containerName ?? ''}` : ''

async function refresh(): Promise<void> {
  const seq = ++refreshSeq
  const current = target.value
  status.value = null
  errorMsg.value = ''
  probeFailed.value = false
  if (!current) return
  try {
    // fresh=true 真探一次：外部手删了二进制 / 容器重建之后，主进程缓存的
    // 「已安装」不绕开就永远显示已安装，只能重启应用才能重装（踩过）
    const next = await window.api.agentStatus(current.sessionId, current.containerName, true)
    if (seq === refreshSeq) status.value = next
  } catch (err) {
    if (seq !== refreshSeq) return
    probeFailed.value = true
    errorMsg.value = errorText(err)
  }
}

async function install(): Promise<void> {
  const current = target.value
  if (!current || installing.value || uninstalling.value) return
  installing.value = true
  errorMsg.value = ''
  try {
    const next = await window.api.agentInstall(current.sessionId, current.containerName)
    if (targetIdentity(current) === targetIdentity(target.value)) status.value = next
    // 通知开着的终端标签重试 agent 通道（mount 时还是「未安装」，已走轮询兜底）
    store.markAgentInstalled()
  } catch (err) {
    if (targetIdentity(current) === targetIdentity(target.value)) errorMsg.value = errorText(err)
  } finally {
    installing.value = false
  }
}

async function uninstall(): Promise<void> {
  const current = target.value
  if (!current || installing.value || uninstalling.value) return
  const destination = current.containerName
    ? `容器「${current.containerName}」里的 /tmp/dox-agent`
    : '这台机器上的 ~/.dox/dox-agent'
  const confirmed = await useConfirmStore().ask(
    `确认停止并卸载 ${destination}？依赖助手的文件操作、监控和端口转发会中断。`,
    { danger: true, confirmText: '卸载' }
  )
  if (!confirmed) return
  uninstalling.value = true
  errorMsg.value = ''
  try {
    const next = await window.api.agentUninstall(current.sessionId, current.containerName)
    if (targetIdentity(current) === targetIdentity(target.value)) status.value = next
  } catch (err) {
    if (targetIdentity(current) !== targetIdentity(target.value)) return
    const message = errorText(err)
    // 删除可能只完成了一半；以目标真实状态为准，同时保留本次失败原因。
    await refresh()
    if (!probeFailed.value) errorMsg.value = message
  } finally {
    uninstalling.value = false
  }
}

/** 已安装但低于应用内置版本：提示升级（升级 = 覆盖安装 + 通道自动重启） */
const outdated = computed(
  () => !!status.value?.installed && !!status.value.version &&
    agentVersionOlder(status.value.version, BUNDLED_AGENT_VERSION)
)

watch(() => targetIdentity(target.value), () => void refresh(), { immediate: true })
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
          <button class="btn primary" :disabled="installing || uninstalling" @click="install">
            <Spinner v-if="installing" :size="12" />
            {{ installing ? '升级中…' : `升级到 v${BUNDLED_AGENT_VERSION}` }}
          </button>
        </div>
        <div class="agent-actions">
          <button class="btn danger" :disabled="installing || uninstalling" @click="uninstall">
            <Spinner v-if="uninstalling" :size="12" />
            {{ uninstalling ? '卸载中…' : '卸载助手' }}
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
        <button class="btn primary" :disabled="installing || uninstalling" @click="install">
          <Spinner v-if="installing" :size="12" />
          {{ installing ? '安装中…' : target.containerName ? `安装到容器 ${target.containerName}` : '安装到这台机器' }}
        </button>
      </template>

      <p v-if="errorMsg && !probeFailed" class="form-error">{{ errorMsg }}</p>
    </template>
  </SidebarSection>
</template>

<style scoped>
/* 空态文案用 styles.css 的全局 .empty-hint */
.agent-ok {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  font-size: var(--fs-sm);
  color: var(--success-text);
}
.agent-upgrade,
.agent-actions {
  padding: 0 var(--sp-2) var(--sp-1) 26px;
}
.agent-actions {
  display: flex;
  gap: var(--sp-2);
}
.agent-desc {
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  margin: 0 0 var(--sp-1);
  line-height: var(--lh-base);
}
.agent-desc code {
  font-family: var(--font-mono);
  color: var(--fg);
}
.agent-details {
  margin: 0 0 var(--sp-1);
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
  padding: var(--sp-1) 2px;
}
.probe-fail-text {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--danger-text);
  word-break: break-all;
}
/* 按钮基础长相在 styles.css（全局 .btn / .btn.primary） */
.form-error {
  font-size: var(--fs-xs);
  color: var(--danger-text);
  margin: 4px 0 0;
  word-break: break-all;
}
</style>
