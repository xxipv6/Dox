<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { HostKeyDecision, HostKeyVerifyRequest } from '@shared/types'

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
</script>

<template>
  <div v-if="current" class="overlay">
    <div class="dialog" :class="{ danger: current.status === 'changed' }">
      <div class="dialog-header">
        <span v-if="current.status === 'new'">🔑 首次连接到新主机</span>
        <span v-else>⚠️ 主机指纹已变更</span>
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
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.dialog {
  width: 440px;
  background: #16161e;
  border: 1px solid #2a2b3d;
  border-radius: 10px;
  padding: 18px;
}
.dialog.danger {
  border-color: #f7768e;
}
.dialog-header {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 10px;
}
.host-line {
  font-size: 14px;
  margin-bottom: 10px;
  color: #7aa2f7;
}
.warning {
  font-size: 12px;
  color: #f7768e;
  background: rgba(247, 118, 142, 0.08);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 10px;
  line-height: 1.6;
}
.hint-text {
  font-size: 12px;
  color: #565f89;
  margin-bottom: 10px;
  line-height: 1.6;
}
.fp-row {
  font-size: 12px;
  color: #565f89;
  margin: 4px 0;
  word-break: break-all;
}
.fp-row code {
  color: #c0caf5;
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
  border-radius: 6px;
  border: 1px solid #2a2b3d;
  background: #1f2335;
  color: #c0caf5;
  font-size: 13px;
  cursor: pointer;
}
.btn.primary {
  background: #7aa2f7;
  border-color: #7aa2f7;
  color: #16161e;
  font-weight: 600;
}
.btn.reject:hover {
  border-color: #f7768e;
  color: #f7768e;
}
.more {
  margin-top: 10px;
  font-size: 12px;
  color: #565f89;
  text-align: center;
}
</style>
