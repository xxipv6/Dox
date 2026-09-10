<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { HostKeyDecision, HostKeyVerifyRequest } from '@shared/types'
import Icon from './Icon.vue'
import { useEscapeToClose } from '../composables/useEscapeToClose'

const api = window.api

/** 并发连接可能同时触发多个指纹确认，排队逐个展示 */
const queue = ref<HostKeyVerifyRequest[]>([])
let unsubscribe: (() => void) | null = null

const current = computed(() => queue.value[0] ?? null)

onMounted(() => {
  unsubscribe = api.onHostKeyVerify((req) => {
    queue.value.push(req)
  })
})

onBeforeUnmount(() => unsubscribe?.())

function answer(decision: HostKeyDecision): void {
  const req = current.value
  if (!req) return
  api.answerHostKey(req.requestId, decision)
  queue.value.shift()
}

/*
 * Esc 等同于「拒绝」——三个选项里唯一不会授予信任的那个（fail closed）。
 * 让 Esc 什么都不做更糟：用户会以为弹窗卡死了，然后去点「信任」。
 */
useEscapeToClose(
  () => current.value !== null,
  () => answer('reject')
)
</script>

<template>
  <div v-if="current" class="overlay">
    <div class="dialog" :class="{ danger: current.status === 'changed' }">
      <div class="dialog-header">
        <span v-if="current.status === 'new'" class="title-line">
          <Icon name="key" :size="16" /> 首次连接到新主机
        </span>
        <span v-else class="title-line danger">
          <Icon name="alert" :size="16" /> 主机指纹已变更
        </span>
      </div>

      <div class="host-line">
        <strong>{{ current.host }}:{{ current.port }}</strong>
      </div>

      <div v-if="current.status === 'changed'" class="warning">
        该主机的密钥指纹与已保存的记录<b>不一致</b>。可能是服务器重装/更换了密钥，
        也可能正在遭遇中间人攻击。请通过带外渠道核实新指纹后再决定是否信任。
        <div class="fp-row">旧：<code>{{ current.storedFingerprint }}</code></div>
      </div>
      <div v-else class="hint-text">
        请核对服务器指纹（可在服务器上执行 <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> 查看）：
      </div>

      <div class="fp-row">{{ current.status === 'changed' ? '新：' : '' }}<code>{{ current.fingerprint }}</code></div>

      <div class="actions">
        <button class="btn primary" @click="answer('trust')">信任并保存</button>
        <button class="btn" @click="answer('once')">仅本次连接</button>
        <button class="btn reject" @click="answer('reject')">拒绝</button>
      </div>

      <div v-if="queue.length > 1" class="more">还有 {{ queue.length - 1 }} 台主机待确认</div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.dialog {
  width: 440px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: 18px;
}
.dialog.danger {
  border-color: var(--danger-text);
}
.dialog-header {
  font-size: var(--fs-lg);
  font-weight: 600;
  margin-bottom: 10px;
}
.title-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.title-line.danger {
  color: var(--danger-text);
}
.host-line {
  font-size: var(--fs-md);
  margin-bottom: 10px;
  color: var(--accent-text);
}
.warning {
  font-size: var(--fs-sm);
  color: var(--danger-text);
  background: var(--danger-soft);
  border-radius: var(--r-sm);
  padding: 8px 10px;
  margin-bottom: 10px;
  line-height: 1.6;
}
.hint-text {
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  margin-bottom: 10px;
  line-height: 1.6;
}
.fp-row {
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  margin: 4px 0;
  word-break: break-all;
}
.fp-row code {
  color: var(--fg);
  font-family: Consolas, monospace;
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}
.btn {
  flex: 1;
  padding: 8px 0;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--bg-hover);
  color: var(--fg);
  font-size: var(--fs-md);
  cursor: pointer;
}
.btn.primary {
  background: var(--accent-text);
  border-color: var(--accent-text);
  color: var(--bg-panel);
  font-weight: 600;
}
.btn.reject:hover {
  border-color: var(--danger-text);
  color: var(--danger-text);
}
.more {
  margin-top: 10px;
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  text-align: center;
}
</style>
