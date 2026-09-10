<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { SavedSession } from '@shared/types'
import { useSessionStore } from '../stores/sessions'
import { errorText } from '../utils/errors'
import { useEscapeToClose } from '../composables/useEscapeToClose'

const store = useSessionStore()

const props = defineProps<{
  visible: boolean
  /** 传入则是编辑模式 */
  editing?: SavedSession | null
  /** 只预填地址（未保存会话的「重新连接」用）。密码永远要用户重新输入 */
  prefill?: { host: string; port: number; username: string } | null
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const busy = ref(false)
const errorMsg = ref('')

// 正在连接时不让 Esc 关掉：请求已经发出去了，关掉弹窗会让用户
// 以为操作被取消了，实际连接还在后台建
useEscapeToClose(
  () => props.visible && !busy.value,
  () => emit('close')
)

const form = reactive({
  name: '',
  host: '',
  port: 22,
  username: 'root',
  authType: 'password' as 'password' | 'key',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  jumpHostId: ''
})

const isEdit = computed(() => !!props.editing)
const isJumpTarget = (s: SavedSession): boolean => s.id === props.editing?.id

watch(
  () => [props.visible, props.editing, props.prefill] as const,
  ([visible]) => {
    if (!visible) return
    errorMsg.value = ''
    const e = props.editing
    const p = props.prefill
    form.name = e?.name ?? ''
    form.host = e?.host ?? p?.host ?? ''
    form.port = e?.port ?? p?.port ?? 22
    form.username = e?.username ?? p?.username ?? 'root'
    form.authType = e?.authType ?? 'password'
    form.password = ''
    form.privateKeyPath = e?.privateKeyPath ?? ''
    form.passphrase = ''
    form.jumpHostId = e?.jumpHostId ?? ''
  },
  { immediate: true }
)

const validPort = computed(() => Number.isInteger(form.port) && form.port > 0 && form.port < 65536)
const valid = computed(
  () =>
    !!form.host.trim() &&
    !!form.username.trim() &&
    validPort.value &&
    (form.authType === 'password' ? true : !!form.privateKeyPath.trim())
)

function payload(): Parameters<typeof store.saveSession>[0] {
  return {
    id: props.editing?.id,
    name: form.name.trim() || `${form.username.trim()}@${form.host.trim()}`,
    host: form.host.trim(),
    port: form.port,
    username: form.username.trim(),
    authType: form.authType,
    password: form.password || undefined,
    privateKeyPath: form.privateKeyPath.trim() || undefined,
    passphrase: form.passphrase || undefined,
    jumpHostId: form.jumpHostId || undefined
  }
}

async function run(action: 'save' | 'connect' | 'saveAndConnect'): Promise<void> {
  if (!valid.value) return
  busy.value = true
  errorMsg.value = ''
  try {
    if (action === 'connect') {
      // 仅连接：直接用表单内容建会话，不落盘（之前这条分支在新增模式下是空操作）
      await store.connect({
        host: form.host.trim(),
        port: form.port,
        username: form.username.trim(),
        auth:
          form.authType === 'password'
            ? { type: 'password', password: form.password }
            : {
                type: 'key',
                privateKeyPath: form.privateKeyPath.trim(),
                passphrase: form.passphrase || undefined
              },
        jumpHostId: form.jumpHostId || undefined
      })
      emit('close')
      return
    }

    const saved = await store.saveSession(payload())
    if (action === 'saveAndConnect') await store.connectSaved(saved)
    emit('close')
  } catch (err) {
    errorMsg.value = errorText(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="visible" class="overlay" @click.self="emit('close')">
    <div class="dialog">
      <div class="dialog-header">
        <span>{{ isEdit ? '编辑设备' : '添加设备' }}</span>
        <button class="close-btn" @click="emit('close')">×</button>
      </div>

      <div class="grid">
        <label>主机地址</label>
        <div class="row">
          <input v-model="form.host" placeholder="192.168.1.10 或 example.com" class="grow" />
          <input
            v-model.number="form.port"
            type="number"
            min="1"
            max="65535"
            class="port"
            :class="{ invalid: !validPort }"
          />
        </div>

        <label>用户名</label>
        <input v-model="form.username" placeholder="root" />

        <label>名称</label>
        <input v-model="form.name" placeholder="留空则用 用户名@主机" />

        <label>认证方式</label>
        <div class="segmented">
          <label :class="{ active: form.authType === 'password' }">
            <input v-model="form.authType" type="radio" value="password" /> 密码
          </label>
          <label :class="{ active: form.authType === 'key' }">
            <input v-model="form.authType" type="radio" value="key" /> 私钥
          </label>
        </div>

        <template v-if="form.authType === 'password'">
          <label>密码</label>
          <input
            v-model="form.password"
            type="password"
            :placeholder="isEdit ? '留空表示不修改' : '登录密码'"
          />
        </template>
        <template v-else>
          <label>私钥路径</label>
          <input v-model="form.privateKeyPath" placeholder="~/.ssh/id_rsa" />
          <label>密码短语</label>
          <input
            v-model="form.passphrase"
            type="password"
            :placeholder="isEdit ? '留空表示不修改' : '可选'"
          />
        </template>

        <template v-if="store.savedSessions.length">
          <label>跳板机</label>
          <select v-model="form.jumpHostId">
            <option value="">直连（不使用跳板机）</option>
            <option
              v-for="s in store.savedSessions.filter((x) => !isJumpTarget(x))"
              :key="s.id"
              :value="s.id"
            >
              经 {{ s.name }} 跳转
            </option>
          </select>
        </template>
      </div>

      <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

      <div class="actions">
        <button class="btn" @click="emit('close')">取消</button>
        <button v-if="!isEdit" class="btn" :disabled="!valid || busy" @click="run('connect')">
          仅连接
        </button>
        <button class="btn" :disabled="!valid || busy" @click="run('save')">保存</button>
        <button class="btn primary" :disabled="!valid || busy" @click="run('saveAndConnect')">
          保存并连接
        </button>
      </div>
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
  z-index: 100;
}
.dialog {
  width: 460px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: 18px;
}
.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--fs-lg);
  font-weight: 600;
  margin-bottom: 16px;
}
.close-btn {
  background: none;
  border: none;
  color: var(--fg-muted);
  font-size: var(--fs-xl);
  cursor: pointer;
}
.close-btn:hover {
  color: var(--fg);
}
.grid {
  display: grid;
  grid-template-columns: 76px 1fr;
  gap: 10px 12px;
  align-items: center;
}
.grid > label {
  font-size: var(--fs-sm);
  color: var(--fg-muted);
}
.row {
  display: flex;
  gap: 8px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.port {
  width: 78px;
  flex-shrink: 0;
}
input,
select {
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--fg);
  padding: 7px 10px;
  font-size: var(--fs-md);
  outline: none;
  width: 100%;
  box-sizing: border-box;
}
input:focus,
select:focus {
  border-color: var(--accent-text);
}
input.invalid {
  border-color: var(--danger-text);
}
.segmented {
  display: flex;
  gap: 8px;
}
.segmented label {
  flex: 1;
  text-align: center;
  padding: 6px 0;
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  cursor: pointer;
  border: 1px solid var(--border);
}
.segmented label.active {
  color: var(--accent-text);
  border-color: var(--accent-text);
}
.segmented input {
  display: none;
}
.error {
  color: var(--danger-text);
  font-size: var(--fs-sm);
  margin: 12px 0 0;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
.btn {
  padding: 7px 16px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--bg-hover);
  color: var(--fg);
  font-size: var(--fs-md);
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  border-color: var(--focus-ring);
}
.btn.primary {
  background: var(--accent-text);
  border-color: var(--accent-text);
  color: var(--bg-panel);
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
