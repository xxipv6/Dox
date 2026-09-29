<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { ForwardRule, ForwardType } from '@shared/types'
import { isLocalId, isContainerId } from '@shared/sessionId'
import { agentVersionOlder, TUNNEL_MIN_AGENT_VERSION } from '@shared/agentVersion'
import { useSessionStore } from '../stores/sessions'
import { errorText } from '../utils/errors'
import Icon from './Icon.vue'
import SidebarSection from './SidebarSection.vue'

const api = window.api
const store = useSessionStore()

const rules = ref<ForwardRule[]>([])

/**
 * 当前标签的转发归属：SSH 标签 = 会话本身；容器标签 = 父会话 + 容器名。
 * 嵌套容器（chain）没有 agent 依赖面，转发也不开放。
 */
const activeTarget = computed<{ sessionId: string; container?: string } | null>(() => {
  const tab = store.activeTab
  if (!tab) return null
  if (tab.kind === 'container') {
    const c = tab.container
    if (!c || c.chain?.length) return null
    return { sessionId: c.parentSessionId, container: c.containerName }
  }
  const sid = store.activeSessionId
  if (!sid || isLocalId(sid) || isContainerId(sid)) return null
  return { sessionId: sid }
})

/** 容器标签：容器助手版本够（tunnel_* 是 0.8.0 才有的方法）才开放 */
const containerAgentOk = ref(false)
watch(
  () => activeTarget.value,
  async (t) => {
    if (!t?.container) {
      containerAgentOk.value = false
      return
    }
    const st = await api.agentStatus(t.sessionId, t.container).catch(() => null)
    containerAgentOk.value = !!st?.installed && !!st.version && !agentVersionOlder(st.version, TUNNEL_MIN_AGENT_VERSION)
  },
  { immediate: true }
)

/** 转发要么走 SSH（SSH 标签），要么走容器助手隧道（容器标签且助手够新） */
const canForward = computed(() => {
  const t = activeTarget.value
  if (!t) return false
  return t.container ? containerAgentOk.value : true
})

/** 收起状态下也能一眼看出当前会话有几条规则在跑，不用展开去数 */
const badge = computed(() => (sortedRules.value.length ? String(sortedRules.value.length) : undefined))
const formVisible = ref(false)
/** 分区头的 + 按钮：开表单时顺带把分区展开（收起状态下点 + 会「什么都没发生」） */
const section = ref<InstanceType<typeof SidebarSection> | null>(null)

function toggleForm(): void {
  formVisible.value = !formVisible.value
  if (formVisible.value) section.value?.expand()
}
const form = reactive({
  type: 'local' as ForwardType,
  listenHost: '127.0.0.1',
  listenPort: 8080,
  targetHost: '127.0.0.1',
  targetPort: 80
})

// 容器标签只有隧道两种形态（经容器助手）；切走容器标签时还原默认
watch(
  () => !!activeTarget.value?.container,
  (isCtr) => {
    if (isCtr && form.type === 'socks') form.type = 'remote'
  },
  { immediate: true }
)

const validPort = (p: number): boolean => Number.isInteger(p) && p > 0 && p < 65536
/** 监听/目标主机：非空、不含空白（0.0.0.0 / :: / 域名 / IP 都合法） */
const validHost = (h: string): boolean => !!h.trim() && !/\s/.test(h.trim())
/** 端口清空会成为 NaN，落盘会被序列化成 null，必须挡住 */
const formValid = computed(() => {
  if (!canForward.value || !validPort(form.listenPort)) return false
  if (!validHost(form.listenHost)) return false
  // SOCKS5 是动态转发：没有固定目标，浏览器/应用自己决定去哪
  if (form.type === 'socks') return true
  return validHost(form.targetHost) && validPort(form.targetPort)
})

let unsubscribe: (() => void) | null = null

/** 只显示当前标签归属的规则：全部列出来会让人以为这条规则属于当前标签（误解之源） */
const sortedRules = computed(() =>
  rules.value.filter((r) => {
    const t = activeTarget.value
    if (!t) return false
    return r.sessionId === t.sessionId && (r.container ?? '') === (t.container ?? '')
  })
)
/** 其他会话/容器还有规则在跑时给一行提示，免得规则藏在别的标签里被遗忘 */
const otherCount = computed(() => rules.value.length - sortedRules.value.length)

onMounted(async () => {
  rules.value = await api.listForwards()
  unsubscribe = api.onForwardUpdate((list) => {
    rules.value = list
  })
})

onBeforeUnmount(() => unsubscribe?.())

const errorMsg = ref('')

async function removeRule(id: string): Promise<void> {
  try {
    await api.removeForward(id)
    errorMsg.value = ''
  } catch (err) {
    errorMsg.value = errorText(err)
  }
}

async function add(): Promise<void> {
  const t = activeTarget.value
  if (!t) return
  if (!formValid.value) {
    errorMsg.value = '请填写合法的监听端口与目标地址/端口'
    return
  }
  errorMsg.value = ''
  try {
    await api.addForward({
      sessionId: t.sessionId,
      container: t.container,
      type: form.type,
      // 127.0.0.1 是主进程的默认值，给 undefined 即可（少一个魔法字符串落库）
      listenHost: form.listenHost.trim() === '127.0.0.1' ? undefined : form.listenHost.trim(),
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
  <SidebarSection ref="section" title="端口转发" icon="link" :badge="badge">
    <template #actions>
      <button
        v-if="canForward"
        class="icon-btn"
        :title="formVisible ? '收起' : '添加转发'"
        @click="toggleForm"
      ><Icon :name="formVisible ? 'minus' : 'plus'" :size="15" /></button>
    </template>

  <div v-if="formVisible" class="forward-form">
    <!-- 容器标签走容器助手隧道：-L 监听在本机/-R 监听在容器内，没有 -D -->
    <div class="form-row type-switch">
      <label :class="{ active: form.type === 'local' }">
        <input v-model="form.type" type="radio" value="local" /> 本地 -L
      </label>
      <label :class="{ active: form.type === 'remote' }">
        <input v-model="form.type" type="radio" value="remote" /> 远程 -R
      </label>
      <label v-if="!activeTarget?.container" :class="{ active: form.type === 'socks' }">
        <input v-model="form.type" type="radio" value="socks" /> 代理 -D
      </label>
    </div>
    <div class="form-row">
      <span class="row-label">监听</span>
      <input
        v-model="form.listenHost"
        placeholder="监听地址"
        class="host-input"
        :title="activeTarget?.container
          ? (form.type === 'local'
            ? '本机绑定地址：127.0.0.1 仅本机；0.0.0.0 局域网可达'
            : '容器内绑定地址：127.0.0.1 仅容器内；0.0.0.0 宿主机/同网络其他容器可达')
          : '绑定地址：127.0.0.1 仅本机；0.0.0.0 局域网可达'"
      />
      <input v-model.number="form.listenPort" type="number" min="1" max="65535" placeholder="监听端口" class="port-input" />
    </div>
    <div v-if="form.type !== 'socks'" class="form-row">
      <span class="row-label">目标</span>
      <input
        v-model="form.targetHost"
        placeholder="目标主机"
        class="host-input"
        :title="activeTarget?.container
          ? (form.type === 'local' ? '容器内去拨的地址（容器当出口）' : '由本机（跑 Dox 的这台）去拨的地址：本机服务或局域网任意机器')
          : '-L 填远端侧可达地址；-R 填本地侧可达地址（含局域网其他机器）'"
      />
      <input v-model.number="form.targetPort" type="number" min="1" max="65535" placeholder="目标端口" class="port-input" />
    </div>
    <p class="form-hint">
      {{ form.type === 'socks'
        ? `SOCKS5 代理 ${form.listenHost}:${form.listenPort} → 全部流量从远端网络出口（浏览器/应用代理指向它）`
        : activeTarget?.container
          ? form.type === 'local'
            ? `本机 ${form.listenHost}:${form.listenPort} → 经容器→ ${form.targetHost || '…'}:${form.targetPort}（容器当出口：目标填容器内才够得到的地址）`
            : `容器内 ${form.listenHost}:${form.listenPort} → 经本机→ ${form.targetHost || '…'}:${form.targetPort}（目标由本机去拨：本机服务或局域网任意机器，如 adb 所在主机）`
          : form.type === 'local'
            ? `${form.listenHost}:${form.listenPort} → 经SSH→ ${form.targetHost || '…'}:${form.targetPort}（目标填远端侧任意可达地址，如服务器内网 192.168.x.x；监听填 0.0.0.0 可让局域网设备使用）`
            : `远端 ${form.listenHost}:${form.listenPort} → 回传→ ${form.targetHost || '…'}:${form.targetPort}（目标可填本地局域网其他机器；远端监听非回环需服务端 sshd 开 GatewayPorts）` }}
    </p>
    <button class="btn primary" :disabled="!formValid" @click="add">启动转发</button>
    <p v-if="errorMsg" class="form-error">{{ errorMsg }}</p>
  </div>

  <div v-if="!sortedRules.length && !formVisible" class="empty-hint">
    {{ canForward
      ? '还没有转发规则，点右上角 + 添加'
      : activeTarget?.container
        ? `容器转发需要容器助手 v${TUNNEL_MIN_AGENT_VERSION}+（侧栏「远程助手」安装/升级）`
        : '转发经 SSH 通道工作，连接 SSH 会话后可添加' }}
  </div>

  <div v-for="rule in sortedRules" :key="rule.id" class="rule">
    <span class="rule-type" :class="[rule.type, { container: !!rule.container }]">{{ rule.type === 'local' ? 'L' : rule.type === 'remote' ? 'R' : 'D' }}</span>
    <span class="rule-desc" :title="rule.error ?? (rule.type === 'socks' ? `socks5://${rule.listenHost}:${rule.listenPort}` : undefined)">
      <template v-if="rule.type === 'socks'">{{ rule.listenHost === '127.0.0.1' ? '' : rule.listenHost }}:{{ rule.listenPort }} → SOCKS5 动态代理</template>
      <template v-else-if="rule.container && rule.type === 'remote'">容器内 {{ rule.listenHost === '127.0.0.1' ? '' : rule.listenHost }}:{{ rule.listenPort }} → 本机 {{ rule.targetHost }}:{{ rule.targetPort }}</template>
      <template v-else-if="rule.container">本机 {{ rule.listenHost === '127.0.0.1' ? '' : rule.listenHost }}:{{ rule.listenPort }} → 容器内 {{ rule.targetHost }}:{{ rule.targetPort }}</template>
      <template v-else>{{ rule.listenHost === '127.0.0.1' ? '' : rule.listenHost }}:{{ rule.listenPort }} → {{ rule.targetHost }}:{{ rule.targetPort }}</template>
    </span>
    <span class="rule-status" :class="rule.status">{{ statusText[rule.status] }}</span>
    <button class="icon-btn danger" title="移除" @click="removeRule(rule.id)">
      <Icon name="x" />
    </button>
  </div>

  <!-- 面板只列当前会话的规则；其他会话在跑的规则用一行提示保持可见 -->
  <div v-if="otherCount > 0" class="other-hint">另有 {{ otherCount }} 条转发在其他会话运行中</div>
  </SidebarSection>
</template>

<style scoped>
.forward-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.form-row {
  display: flex;
  gap: var(--sp-2);
}
/* 「监听」「目标」行首标签：两行本是一条规则的两端，标出来才不会看成两条 */
.row-label {
  width: 28px;
  flex-shrink: 0;
  align-self: center;
  font-size: var(--fs-xs);
  color: var(--fg-muted);
}
.form-row input {
  flex: 1;
  min-width: 0;
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--fg);
  padding: var(--sp-1) var(--sp-2);
  font-size: var(--fs-sm);
  outline: none;
}
.port-input {
  max-width: 72px;
}
.host-input {
  flex: 1;
  min-width: 0;
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
/* 按钮与空态文案的基础长相在 styles.css（全局 .btn / .empty-hint） */
.rule {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
}
.rule:hover {
  background: var(--bg-hover);
}
/* 「另有 N 条在其他会话运行中」提示行：要能被看见（别处的转发忘了关是隐蔽的资源泄漏），
   用警告档而不是弱灰 */
.other-hint {
  font-size: var(--fs-xs);
  color: var(--warning-text);
  background: var(--warning-soft);
  border-radius: var(--r-sm);
  padding: var(--sp-1) var(--sp-2);
  margin-top: var(--sp-1);
}
.rule-type {
  width: 18px;
  height: 18px;
  border-radius: var(--r-xs);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
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
.rule-type.container {
  background: var(--purple-soft);
  color: var(--purple-text);
}
.rule-desc {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
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
