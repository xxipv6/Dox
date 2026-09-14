<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { SavedSession } from '@shared/types'
import { useSessionStore } from '../stores/sessions'
import { errorText } from '../utils/errors'
import { useEscapeToClose } from '../composables/useEscapeToClose'
import Spinner from './Spinner.vue'

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
/*
 * 哪个动作在跑。
 *
 * 之前连接/保存期间只有「按钮变灰」——用户分不清是在等还是卡死了，
 * 尤其是连一台连不通的机器（SSH 握手要等到超时，几十秒里界面一动不动）。
 * 现在按钮里会长出转圈并把文案换成「正在连接…」，动作本身也就能看出是哪一条。
 */
const running = ref<null | 'save' | 'connect' | 'saveAndConnect'>(null)
const errorMsg = ref('')

/** 连接/保存进行中时保留弹窗，避免用户误以为请求已取消。 */
function requestClose(): void {
  if (!busy.value) emit('close')
}

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
  running.value = action
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
    running.value = null
  }
}
</script>

<template>
  <!-- Transition 包在遮罩这一层：淡出时里面的弹窗跟着一起淡，不用各自写一份 -->
  <Transition name="pop">
    <div v-if="visible" class="overlay" @click.self="requestClose">
      <div class="dialog pop-surface">
        <div class="dialog-header">
          <span>{{ isEdit ? '编辑设备' : '添加设备' }}</span>
          <button class="close-btn" :disabled="busy" @click="requestClose">×</button>
        </div>

        <div class="grid">
          <label>名称</label>
          <input v-model="form.name" placeholder="留空则用 用户名@主机" />

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
          <button class="btn" :disabled="busy" @click="requestClose">取消</button>
          <button v-if="!isEdit" class="btn" :disabled="!valid || busy" @click="run('connect')">
            <Spinner v-if="running === 'connect'" :size="12" />
            {{ running === 'connect' ? '正在连接…' : '仅连接' }}
          </button>
          <button class="btn" :disabled="!valid || busy" @click="run('save')">
            <Spinner v-if="running === 'save'" :size="12" />
            {{ running === 'save' ? '正在保存…' : '保存' }}
          </button>
          <button class="btn primary" :disabled="!valid || busy" @click="run('saveAndConnect')">
            <Spinner v-if="running === 'saveAndConnect'" :size="12" />
            {{ running === 'saveAndConnect' ? '正在连接…' : '保存并连接' }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/*
 * 只留差异。弹窗/按钮/关闭键的基础长相在 styles.css 的控件词汇表里
 * （.overlay / .dialog / .pop-surface / .btn / .close-btn）——
 * 这几个类曾经在 3~5 个组件里各抄一份，于是内边距和 hover 态慢慢漂开。
 */
.dialog {
  width: 460px;
}
.grid {
  display: grid;
  grid-template-columns: 76px 1fr;
  gap: var(--sp-3);
  align-items: center;
}
.grid > label {
  font-size: var(--fs-sm);
  color: var(--fg-muted);
}
.row {
  display: flex;
  gap: var(--sp-2);
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
  padding: var(--sp-2) var(--sp-3);
  font-size: var(--fs-md);
  outline: none;
  width: 100%;
  box-sizing: border-box;
  transition: border-color var(--dur-fast) var(--ease-out);
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
  gap: var(--sp-2);
}
.segmented label {
  flex: 1;
  text-align: center;
  padding: var(--sp-2) 0;
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  cursor: pointer;
  border: 1px solid var(--border);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.segmented label:hover {
  color: var(--fg);
}
.segmented label.active {
  color: var(--accent-text);
  border-color: var(--accent-text);
  background: var(--accent-soft);
}
.segmented input {
  display: none;
}
.error {
  color: var(--danger-text);
  font-size: var(--fs-sm);
  margin: var(--sp-3) 0 0;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-5);
}
</style>
