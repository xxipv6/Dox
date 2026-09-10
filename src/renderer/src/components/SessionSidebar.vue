<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useSessionStore } from '../stores/sessions'
import { useSettingsStore } from '../stores/settings'
import ForwardPanel from './ForwardPanel.vue'
import SnippetPanel from './SnippetPanel.vue'
import type { SshSessionConfig } from '@shared/types'

const store = useSessionStore()
const settings = useSettingsStore()

const collapsed = ref(false)
const form = reactive({
  host: '',
  port: 22,
  username: 'root',
  authType: 'password' as 'password' | 'key',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  jumpHostId: ''
})

onMounted(() => store.refreshSaved())

function buildConfig(): SshSessionConfig {
  return {
    host: form.host.trim(),
    port: form.port,
    username: form.username.trim(),
    auth:
      form.authType === 'password'
        ? { type: 'password', password: form.password }
        : { type: 'key', privateKeyPath: form.privateKeyPath.trim(), passphrase: form.passphrase || undefined },
    jumpHostId: form.jumpHostId || undefined
  }
}

function valid(): boolean {
  if (!form.host.trim() || !form.username.trim()) return false
  if (form.authType === 'key' && !form.privateKeyPath.trim()) return false
  return true
}

async function quickConnect(): Promise<void> {
  if (!valid()) return
  await store.connect(buildConfig())
}

async function saveAndConnect(): Promise<void> {
  if (!valid()) return
  await window.api.saveSession({
    name: `${form.username}@${form.host}`,
    host: form.host.trim(),
    port: form.port,
    username: form.username.trim(),
    authType: form.authType,
    password: form.password || undefined,
    privateKeyPath: form.privateKeyPath.trim() || undefined,
    passphrase: form.passphrase || undefined,
    jumpHostId: form.jumpHostId || undefined
  })
  await store.refreshSaved()
  await store.connect(buildConfig())
}
</script>

<template>
  <aside class="sidebar" :class="{ collapsed }">
    <div class="sidebar-header">
      <span v-if="!collapsed" class="logo">Dox</span>
      <span class="header-actions">
        <button v-if="!collapsed" class="icon-btn" title="设置" @click="settings.openDialog()">⚙</button>
        <button class="icon-btn" :title="collapsed ? '展开' : '收起'" @click="collapsed = !collapsed">
          {{ collapsed ? '»' : '«' }}
        </button>
      </span>
    </div>

    <template v-if="!collapsed">
      <button class="btn local-term-btn" @click="store.connectLocal()">💻 本地终端</button>

      <!-- 已保存会话 -->
      <div class="section-title">会话</div>
      <div v-if="!store.savedSessions.length" class="empty-hint">暂无保存的会话</div>
      <div
        v-for="s in store.savedSessions"
        :key="s.id"
        class="saved-item"
        :title="`${s.username}@${s.host}:${s.port}`"
        @dblclick="store.connectSaved(s)"
      >
        <span class="saved-name">
          <span v-if="s.jumpHostId" class="jump-badge" title="经跳板机连接">⛓</span>{{ s.name }}
        </span>
        <button class="icon-btn connect-btn" title="连接" @click.stop="store.connectSaved(s)">▶</button>
        <button class="icon-btn delete-btn" title="删除" @click.stop="store.deleteSaved(s.id)">×</button>
      </div>

      <!-- 快速连接 -->
      <div class="section-title">快速连接</div>
      <form class="connect-form" @submit.prevent="quickConnect">
        <input v-model="form.host" placeholder="主机 IP / 域名" required />
        <div class="form-row">
          <input v-model.number="form.port" type="number" min="1" max="65535" placeholder="端口" />
          <input v-model="form.username" placeholder="用户名" required />
        </div>

        <div class="form-row auth-switch">
          <label :class="{ active: form.authType === 'password' }">
            <input v-model="form.authType" type="radio" value="password" /> 密码
          </label>
          <label :class="{ active: form.authType === 'key' }">
            <input v-model="form.authType" type="radio" value="key" /> 私钥
          </label>
        </div>

        <template v-if="form.authType === 'password'">
          <input v-model="form.password" type="password" placeholder="密码" />
        </template>
        <template v-else>
          <input v-model="form.privateKeyPath" placeholder="私钥路径，如 ~/.ssh/id_rsa" />
          <input v-model="form.passphrase" type="password" placeholder="密码短语（可选）" />
        </template>

        <!-- 跳板机：复用已保存的会话作为跳板 -->
        <select v-if="store.savedSessions.length" v-model="form.jumpHostId" class="jump-select">
          <option value="">无跳板机（直连）</option>
          <option v-for="s in store.savedSessions" :key="s.id" :value="s.id">
            ⛓ 经 {{ s.name }} 跳转
          </option>
        </select>

        <div class="form-row">
          <button type="submit" class="btn primary" :disabled="!valid()">连接</button>
          <button type="button" class="btn" :disabled="!valid()" @click="saveAndConnect">
            保存并连接
          </button>
        </div>
      </form>

      <!-- 端口转发 -->
      <ForwardPanel />

      <!-- 快捷命令 -->
      <SnippetPanel />
    </template>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #16161e;
  border-right: 1px solid #2a2b3d;
  padding: 8px;
  overflow-y: auto;
  transition: width 0.15s;
}
.sidebar.collapsed {
  width: 40px;
  align-items: center;
}
.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.header-actions {
  display: flex;
  gap: 2px;
}
.logo {
  font-weight: 700;
  font-size: 16px;
  color: #7aa2f7;
}
.section-title {
  font-size: 12px;
  color: #565f89;
  margin: 12px 0 6px;
  text-transform: uppercase;
}
.empty-hint {
  font-size: 12px;
  color: #565f89;
  padding: 4px 2px;
}
.saved-item {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.saved-item:hover {
  background: #1f2335;
}
.saved-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.delete-btn:hover {
  color: #f7768e;
}
.connect-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.form-row {
  display: flex;
  gap: 6px;
}
.form-row input {
  flex: 1;
  min-width: 0;
}
input[type='text'],
input[type='password'],
input[type='number'],
input:not([type]) {
  background: #1f2335;
  border: 1px solid #2a2b3d;
  border-radius: 6px;
  color: #c0caf5;
  padding: 7px 10px;
  font-size: 13px;
  outline: none;
}
input:focus {
  border-color: #7aa2f7;
}
.auth-switch label {
  flex: 1;
  text-align: center;
  padding: 5px 0;
  border-radius: 6px;
  font-size: 12px;
  color: #565f89;
  cursor: pointer;
  border: 1px solid #2a2b3d;
}
.auth-switch label.active {
  color: #7aa2f7;
  border-color: #7aa2f7;
}
.auth-switch input {
  display: none;
}
.jump-select {
  background: #1f2335;
  border: 1px solid #2a2b3d;
  border-radius: 6px;
  color: #c0caf5;
  padding: 7px 10px;
  font-size: 12px;
  outline: none;
}
.jump-badge {
  margin-right: 4px;
  font-size: 11px;
}
.btn {
  flex: 1;
  padding: 7px 0;
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
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.local-term-btn {
  width: 100%;
  margin-bottom: 4px;
  text-align: left;
  padding: 7px 10px;
}
</style>
