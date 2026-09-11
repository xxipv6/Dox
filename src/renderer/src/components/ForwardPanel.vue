<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { ForwardRule } from '@shared/types'
import { useSessionStore } from '../stores/sessions'
import { errorText } from '../utils/errors'
import Icon from './Icon.vue'
import SidebarSection from './SidebarSection.vue'

const api = window.api
const store = useSessionStore()

const rules = ref<ForwardRule[]>([])

/** 收起状态下也能一眼看出有几条规则在跑，不用展开去数 */
const badge = computed(() => (rules.value.length ? String(rules.value.length) : undefined))
const formVisible = ref(false)
const form = reactive({
  type: 'local' as 'local' | 'remote' | 'socks',
  listenPort: 8080,
  targetHost: '127.0.0.1',
  targetPort: 80
})

const validPort = (p: number): boolean => Number.isInteger(p) && p > 0 && p < 65536
/** 端口清空会成为 NaN，落盘会被序列化成 null，必须挡住 */
const formValid = computed(() => {
  if (!store.activeSessionId || !validPort(form.listenPort)) return false
  // SOCKS5 是动态转发：没有固定目标，浏览器/应用自己决定去哪
  if (form.type === 'socks') return true
  return !!form.targetHost.trim() && validPort(form.targetPort)
})

let unsubscribe: (() => void) | null = null

/** 当前会话的规则排在前面 */
const sortedRules = computed(() =>
  [...rules.value].sort((a, b) => {
    const aActive = a.sessionId === store.activeSessionId ? 0 : 1
    const bActive = b.sessionId === store.activeSessionId ? 0 : 1
    return aActive - bActive
  })
)

onMounted(async () => {
  rules.value = await api.listForwards()
  unsubscribe = api.onForwardUpdate((list) => {
    rules.value = list
  })
})

onBeforeUnmount(() => unsubscribe?.())

const errorMsg = ref('')

async function add(): Promise<void> {
  if (!store.activeSessionId) return
  if (!formValid.value) {
    errorMsg.value = '请填写合法的监听端口与目标地址/端口'
    return
  }
  errorMsg.value = ''
  try {
    await api.addForward({
      sessionId: store.activeSessionId,
      type: form.type,
      listenPort: form.listenPort,
      // socks 没有固定目标，占位字段给空值（类型要求是 string/number）
      targetHost: form.type === 'socks' ? '' : form.targetHost.trim(),
      targetPort: form.type === 'socks' ? 0 : form.targetPort
    })
    formVisible.value = false
  } catch (err) {
    // 之前这里是 fire-and-forget：端口被占用等错误完全无声，用户只看到没反应
    errorMsg.value = errorText(err)
  }
}

const statusText: Record<ForwardRule['status'], string> = {
  active: '运行中',
  error: '失败',
  stopped: '已停止'
}
</script>

<template>
  <SidebarSection title="端口转发" icon="link" :badge="badge">
    <template #actions>
      <button
        v-if="store.activeSessionId"
        class="icon-btn"
        :title="formVisible ? '收起' : '添加转发'"
        @click="formVisible = !formVisible"
      ><Icon :name="formVisible ? 'minus' : 'plus'" :size="15" /></button>
    </template>

  <div v-if="formVisible" class="forward-form">
    <div class="form-row type-switch">
      <label :class="{ active: form.type === 'local' }">
        <input v-model="form.type" type="radio" value="local" /> 本地 -L
      </label>
      <label :class="{ active: form.type === 'remote' }">
        <input v-model="form.type" type="radio" value="remote" /> 远程 -R
      </label>
      <label :class="{ active: form.type === 'socks' }">
        <input v-model="form.type" type="radio" value="socks" /> 代理 -D
      </label>
    </div>
    <div class="form-row">
      <input v-model.number="form.listenPort" type="number" min="1" max="65535" placeholder="监听端口" />
      <template v-if="form.type !== 'socks'">
        <input v-model="form.targetHost" placeholder="目标主机" />
        <input v-model.number="form.targetPort" type="number" min="1" max="65535" placeholder="目标端口" class="port-input" />
      </template>
    </div>
    <p class="form-hint">
      {{ form.type === 'socks'
        ? `SOCKS5 代理 本机 :${form.listenPort} → 全部流量从远端网络出口（浏览器/应用代理指向它）`
        : form.type === 'local'
          ? `本机 :${form.listenPort} → 经SSH→ ${form.targetHost || '…'}:${form.targetPort}`
          : `远端 :${form.listenPort} → 回传→ ${form.targetHost || '…'}:${form.targetPort}（本地可达地址）` }}
    </p>
    <button class="btn primary" :disabled="!formValid" @click="add">启动转发</button>
    <p v-if="errorMsg" class="form-error">{{ errorMsg }}</p>
  </div>

  <div v-if="!rules.length && !formVisible" class="empty-hint">
    需先连接会话，随后可添加端口转发
  </div>

  <div v-for="rule in sortedRules" :key="rule.id" class="rule" :class="{ inactive: rule.sessionId !== store.activeSessionId }">
    <span class="rule-type" :class="rule.type">{{ rule.type === 'local' ? 'L' : rule.type === 'remote' ? 'R' : 'D' }}</span>
    <span class="rule-desc" :title="rule.error ?? (rule.type === 'socks' ? `socks5://${rule.listenHost}:${rule.listenPort}` : undefined)">
      <template v-if="rule.type === 'socks'">:{{ rule.listenPort }} → SOCKS5 动态代理</template>
      <template v-else>:{{ rule.listenPort }} → {{ rule.targetHost }}:{{ rule.targetPort }}</template>
    </span>
    <span class="rule-status" :class="rule.status">{{ statusText[rule.status] }}</span>
    <button class="icon-btn danger" title="移除" @click="api.removeForward(rule.id)">
      <Icon name="x" />
    </button>
  </div>
  </SidebarSection>
</template>

<style scoped>
.forward-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}
.form-row {
  display: flex;
  gap: 6px;
}
.form-row input {
  flex: 1;
  min-width: 0;
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--fg);
  padding: 6px 8px;
  font-size: var(--fs-sm);
  outline: none;
}
.port-input {
  max-width: 72px;
}
.type-switch label {
  flex: 1;
  text-align: center;
  padding: 5px 0;
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  cursor: pointer;
  border: 1px solid var(--border);
}
.type-switch label.active {
  color: var(--accent-text);
  border-color: var(--accent-text);
}
.type-switch input {
  display: none;
}
.form-hint {
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  margin: 0;
}
.form-error {
  font-size: var(--fs-xs);
  color: var(--danger-text);
  margin: 0;
  word-break: break-all;
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
.empty-hint {
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  padding: 4px 2px;
}
.rule {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
}
.rule:hover {
  background: var(--bg-hover);
}
.rule.inactive {
  opacity: 0.45;
}
.rule-type {
  width: 18px;
  height: 18px;
  border-radius: var(--r-xs);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-xs);
  font-weight: 700;
  flex-shrink: 0;
}
.rule-type.local {
  background: var(--accent-soft);
  color: var(--accent-text);
}
.rule-type.remote {
  background: var(--success-soft);
  color: var(--success-text);
}
.rule-type.socks {
  background: var(--warning-soft, var(--accent-soft));
  color: var(--warning-text, var(--accent-text));
}
.rule-desc {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: Consolas, monospace;
}
.rule-status {
  font-size: var(--fs-xs);
  flex-shrink: 0;
}
.rule-status.active {
  color: var(--success-text);
}
.rule-status.error {
  color: var(--danger-text);
}
.rule-status.stopped {
  color: var(--fg-muted);
}
</style>
