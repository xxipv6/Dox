<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { SavedSession } from '@shared/types'
import { useSessionStore } from '../stores/sessions'

const store = useSessionStore()

const props = defineProps<{
  visible: boolean
  /** 传入则是编辑模式 */
  editing?: SavedSession | null
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const busy = ref(false)
const errorMsg = ref('')

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
  () => [props.visible, props.editing] as const,
  ([visible]) => {
    if (!visible) return
    errorMsg.value = ''
    const e = props.editing
    form.name = e?.name ?? ''
    form.host = e?.host ?? ''
    form.port = e?.port ?? 22
    form.username = e?.username ?? 'root'
    form.authType = e?.authType ?? 'password'
    form.password = ''
    form.privateKeyPath = e?.privateKeyPath ?? ''
    form.passphrase = ''
    form.jumpHostId = e?.jumpHostId ?? ''
  },
  { immediate: true }
)

const valid = computed(
  () =>
    !!form.host.trim() &&
    !!form.username.trim() &&
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
    errorMsg.value = err instanceof Error ? err.message : String(err)
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
          <input v-model.number="form.port" type="number" min="1" max="65535" class="port" />
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
              ⛓ 经 {{ s.name }} 跳转
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
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.dialog {
  width: 460px;
  background: #16161e;
  border: 1px solid #2a2b3d;
  border-radius: 10px;
  padding: 18px;
}
.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 16px;
}
.close-btn {
  background: none;
  border: none;
  color: #565f89;
  font-size: 18px;
  cursor: pointer;
}
.close-btn:hover {
  color: #c0caf5;
}
.grid {
  display: grid;
  grid-template-columns: 76px 1fr;
  gap: 10px 12px;
  align-items: center;
}
.grid > label {
  font-size: 12px;
  color: #565f89;
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
  background: #1f2335;
  border: 1px solid #2a2b3d;
  border-radius: 6px;
  color: #c0caf5;
  padding: 7px 10px;
  font-size: 13px;
  outline: none;
  width: 100%;
  box-sizing: border-box;
}
input:focus,
select:focus {
  border-color: #7aa2f7;
}
.segmented {
  display: flex;
  gap: 8px;
}
.segmented label {
  flex: 1;
  text-align: center;
  padding: 6px 0;
  border-radius: 6px;
  font-size: 12px;
  color: #565f89;
  cursor: pointer;
  border: 1px solid #2a2b3d;
}
.segmented label.active {
  color: #7aa2f7;
  border-color: #7aa2f7;
}
.segmented input {
  display: none;
}
.error {
  color: #f7768e;
  font-size: 12px;
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
  border-radius: 6px;
  border: 1px solid #2a2b3d;
  background: #1f2335;
  color: #c0caf5;
  font-size: 13px;
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  border-color: #3d59a1;
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
</style>
