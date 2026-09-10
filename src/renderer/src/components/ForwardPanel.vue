<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { ForwardRule } from '@shared/types'
import { useSessionStore } from '../stores/sessions'
import { errorText } from '../utils/errors'

const api = window.api
const store = useSessionStore()

const rules = ref<ForwardRule[]>([])
const formVisible = ref(false)
const form = reactive({
  type: 'local' as 'local' | 'remote',
  listenPort: 8080,
  targetHost: '127.0.0.1',
  targetPort: 80
})

const validPort = (p: number): boolean => Number.isInteger(p) && p > 0 && p < 65536
/** 端口清空会成为 NaN，落盘会被序列化成 null，必须挡住 */
const formValid = computed(
  () =>
    !!store.activeSessionId &&
    !!form.targetHost.trim() &&
    validPort(form.listenPort) &&
    validPort(form.targetPort)
)

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
      targetHost: form.targetHost.trim(),
      targetPort: form.targetPort
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
  <div class="section-title">
    端口转发
    <button
      v-if="store.activeSessionId"
      class="icon-btn"
      :title="formVisible ? '收起' : '添加转发'"
      @click="formVisible = !formVisible"
    >{{ formVisible ? '−' : '＋' }}</button>
  </div>

  <div v-if="formVisible" class="forward-form">
    <div class="form-row type-switch">
      <label :class="{ active: form.type === 'local' }">
        <input v-model="form.type" type="radio" value="local" /> 本地 -L
      </label>
      <label :class="{ active: form.type === 'remote' }">
        <input v-model="form.type" type="radio" value="remote" /> 远程 -R
      </label>
    </div>
    <div class="form-row">
      <input v-model.number="form.listenPort" type="number" min="1" max="65535" placeholder="监听端口" />
      <input v-model="form.targetHost" placeholder="目标主机" />
      <input v-model.number="form.targetPort" type="number" min="1" max="65535" placeholder="目标端口" class="port-input" />
    </div>
    <p class="form-hint">
      {{ form.type === 'local'
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
    <span class="rule-type" :class="rule.type">{{ rule.type === 'local' ? 'L' : 'R' }}</span>
    <span class="rule-desc" :title="rule.error">
      :{{ rule.listenPort }} → {{ rule.targetHost }}:{{ rule.targetPort }}
    </span>
    <span class="rule-status" :class="rule.status">{{ statusText[rule.status] }}</span>
    <button class="icon-btn danger" title="移除" @click="api.removeForward(rule.id)">×</button>
  </div>
</template>

<style scoped>
.section-title {
  font-size: 12px;
  color: #565f89;
  margin: 12px 0 6px;
  text-transform: uppercase;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
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
  background: #1f2335;
  border: 1px solid #2a2b3d;
  border-radius: 6px;
  color: #c0caf5;
  padding: 6px 8px;
  font-size: 12px;
  outline: none;
}
.port-input {
  max-width: 72px;
}
.type-switch label {
  flex: 1;
  text-align: center;
  padding: 5px 0;
  border-radius: 6px;
  font-size: 12px;
  color: #565f89;
  cursor: pointer;
  border: 1px solid #2a2b3d;
}
.type-switch label.active {
  color: #7aa2f7;
  border-color: #7aa2f7;
}
.type-switch input {
  display: none;
}
.form-hint {
  font-size: 11px;
  color: #565f89;
  margin: 0;
}
.form-error {
  font-size: 11px;
  color: #f7768e;
  margin: 0;
  word-break: break-all;
}
.btn {
  padding: 6px 0;
  border-radius: 6px;
  border: 1px solid #2a2b3d;
  background: #1f2335;
  color: #c0caf5;
  font-size: 12px;
  cursor: pointer;
}
.btn.primary {
  background: #7aa2f7;
  border-color: #7aa2f7;
  color: #16161e;
  font-weight: 600;
}
.empty-hint {
  font-size: 12px;
  color: #565f89;
  padding: 4px 2px;
}
.rule {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 12px;
}
.rule:hover {
  background: #1f2335;
}
.rule.inactive {
  opacity: 0.45;
}
.rule-type {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}
.rule-type.local {
  background: rgba(122, 162, 247, 0.15);
  color: #7aa2f7;
}
.rule-type.remote {
  background: rgba(158, 206, 106, 0.15);
  color: #9ece6a;
}
.rule-desc {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: Consolas, monospace;
}
.rule-status {
  font-size: 11px;
  flex-shrink: 0;
}
.rule-status.active {
  color: #9ece6a;
}
.rule-status.error {
  color: #f7768e;
}
.rule-status.stopped {
  color: #565f89;
}
.icon-btn {
  background: none;
  border: none;
  color: #565f89;
  cursor: pointer;
  font-size: 13px;
  padding: 2px 4px;
}
.icon-btn:hover {
  color: #c0caf5;
}
.icon-btn.danger:hover {
  color: #f7768e;
}
</style>
