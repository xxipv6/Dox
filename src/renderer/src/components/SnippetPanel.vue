<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type { CommandSnippet, ExecResult } from '@shared/types'
import { agentVersionOlder } from '@shared/agentVersion'
import { useSessionStore } from '../stores/sessions'
import { errorText } from '../utils/errors'
import Icon from './Icon.vue'
import Spinner from './Spinner.vue'
import SidebarSection from './SidebarSection.vue'

const api = window.api
const store = useSessionStore()

const snippets = ref<CommandSnippet[]>([])

/** 收起状态下也能一眼看出存了几条 */
const badge = computed(() => (snippets.value.length ? String(snippets.value.length) : undefined))
const formVisible = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({ name: '', command: '' })

onMounted(async () => {
  snippets.value = await api.listSnippets()
})

async function refresh(): Promise<void> {
  snippets.value = await api.listSnippets()
}

/** 注入终端并执行（多行命令逐行发送） */
function run(s: CommandSnippet): void {
  const sessionId = store.activeSessionId
  if (!sessionId) return
  api.input(sessionId, s.command.replace(/\r?\n/g, '\r') + '\r')
}

/** 仅粘贴到命令行，留给用户编辑后自行回车 */
function pasteOnly(s: CommandSnippet): void {
  const sessionId = store.activeSessionId
  if (!sessionId) return
  api.input(sessionId, s.command.replace(/\r?\n/g, '\r'))
}

// ---- 静默执行：不开终端，经 agent exec（argv 不经 shell）跑完拿回输出 ----

/** 静默执行的目标（同进程面板：SSH 标签 → 宿主机；容器标签 → 容器，本机容器经本机 docker） */
const execTarget = computed<{ sessionId: string; containerName?: string } | null>(() => {
  const tab = store.activeTab
  const paneId = store.activePane?.sessionId
  if (!tab || !paneId) return null
  if (tab.kind === 'ssh') return { sessionId: paneId }
  if (tab.kind === 'container' && tab.container && !tab.container.chain?.length) {
    return { sessionId: tab.container.parentSessionId, containerName: tab.container.containerName }
  }
  return null
})

/** 目标装了 agent ≥0.4.0 才有 exec 方法 */
const execCapable = ref(false)
watch(
  execTarget,
  async (t) => {
    if (!t) {
      execCapable.value = false
      return
    }
    const st = await api.agentStatus(t.sessionId, t.containerName).catch(() => null)
    execCapable.value = !!st?.installed && !!st.version && !agentVersionOlder(st.version, '0.4.0')
  },
  { immediate: true }
)

const execRunning = ref(false)
const execResult = ref<{
  name: string
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
} | null>(null)

/**
 * 静默执行：命令按行拆开逐条跑，每行按空白拆成 argv（不经 shell ——
 * 管道/重定向这些 shell 特性用不了，需要它们就用「发送到终端」）。
 * 某行失败（退出码非 0）即停，后面的行不再跑。
 */
async function runSilent(s: CommandSnippet): Promise<void> {
  const t = execTarget.value
  if (!t || execRunning.value) return
  execRunning.value = true
  execResult.value = null
  const lines = s.command.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  let code = 0
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let truncated = false
  try {
    for (const line of lines) {
      const r = (await api.agentCall(t.sessionId, t.containerName, 'exec', {
        argv: line.split(/\s+/)
      })) as ExecResult
      code = r.exit_code
      if (r.stdout) stdout += (stdout ? '\n' : '') + r.stdout
      if (r.stderr) stderr += (stderr ? '\n' : '') + r.stderr
      timedOut ||= r.timed_out
      truncated ||= r.truncated
      if (r.exit_code !== 0 || r.timed_out) break
    }
  } catch (err) {
    code = -1
    stderr += (stderr ? '\n' : '') + errorText(err)
  }
  execResult.value = { name: s.name, code, stdout, stderr, timedOut, truncated }
  execRunning.value = false
}

function copyExecResult(): void {
  const r = execResult.value
  if (!r) return
  void navigator.clipboard.writeText([r.stdout, r.stderr].filter(Boolean).join('\n'))
}

function edit(s: CommandSnippet): void {
  editingId.value = s.id
  form.name = s.name
  form.command = s.command
  formVisible.value = true
}

function resetForm(): void {
  editingId.value = null
  form.name = ''
  form.command = ''
}

async function save(): Promise<void> {
  if (!form.command.trim()) return
  await api.saveSnippet({ id: editingId.value ?? undefined, name: form.name, command: form.command })
  resetForm()
  formVisible.value = false
  await refresh()
}

async function remove(s: CommandSnippet): Promise<void> {
  if (!confirm(`删除片段「${s.name}」？`)) return
  await api.deleteSnippet(s.id)
  await refresh()
}
</script>

<template>
  <SidebarSection title="快捷命令" icon="zap" :badge="badge">
    <template #actions>
      <button
        class="icon-btn"
        :title="formVisible ? '收起' : '新建片段'"
        @click="
          formVisible = !formVisible;
          if (!formVisible) resetForm()
        "
      ><Icon :name="formVisible ? 'minus' : 'plus'" :size="15" /></button>
    </template>


  <div v-if="formVisible" class="snippet-form">
    <input v-model="form.name" placeholder="名称（可留空）" />
    <textarea
      v-model="form.command"
      placeholder="命令内容，支持多行"
      rows="3"
    ></textarea>
    <button class="btn primary" :disabled="!form.command.trim()" @click="save">
      {{ editingId ? '保存修改' : '添加片段' }}
    </button>
  </div>

  <div v-if="!snippets.length && !formVisible" class="empty-hint">
    保存常用命令，一键注入当前终端
  </div>

  <div v-for="s in snippets" :key="s.id" class="snippet" :title="s.command">
    <span class="snippet-name">{{ s.name }}</span>
    <span class="snippet-actions">
      <button
        class="icon-btn"
        :class="{ dim: !store.activeSessionId }"
        title="发送到终端并执行"
        @click="run(s)"
      ><Icon name="play" /></button>
      <button
        class="icon-btn"
        :class="{ dim: !store.activeSessionId }"
        title="粘贴到命令行（不执行）"
        @click="pasteOnly(s)"
      ><Icon name="paste" /></button>
      <button
        class="icon-btn"
        :class="{ dim: !execCapable }"
        :title="execCapable ? '静默执行（经远程助手，不开终端；不支持管道/重定向）' : '静默执行需要目标装有远程助手 v0.4.0'"
        :disabled="!execCapable || execRunning"
        @click="runSilent(s)"
      ><Icon name="zap" /></button>
      <button class="icon-btn" title="编辑" @click="edit(s)"><Icon name="pencil" /></button>
      <button class="icon-btn danger" title="删除" @click="remove(s)"><Icon name="x" /></button>
    </span>
  </div>

  <!-- 静默执行结果块：退出码 + 输出预览，可复制 -->
  <div v-if="execRunning" class="exec-result"><Spinner :size="12" text="静默执行中…" /></div>
  <div v-else-if="execResult" class="exec-result" :class="{ failed: execResult.code !== 0 }">
    <div class="exec-head">
      <span class="exec-code">「{{ execResult.name || '片段' }}」退出码 {{ execResult.code }}<template v-if="execResult.timedOut">（超时）</template></span>
      <button class="icon-btn" title="复制输出" @click="copyExecResult"><Icon name="paste" /></button>
      <button class="icon-btn" title="关闭" @click="execResult = null"><Icon name="x" /></button>
    </div>
    <pre v-if="execResult.stdout" class="exec-out">{{ execResult.stdout }}</pre>
    <pre v-if="execResult.stderr" class="exec-out err">{{ execResult.stderr }}</pre>
    <div v-if="execResult.truncated" class="exec-note">输出过长，已截断（64KB 上限）</div>
    <div v-if="!execResult.stdout && !execResult.stderr && execResult.code === 0" class="exec-note">执行成功，无输出</div>
  </div>
  </SidebarSection>
</template>

<style scoped>
.snippet-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}
.snippet-form input,
.snippet-form textarea {
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--fg);
  padding: 7px 10px;
  font-size: var(--fs-sm);
  outline: none;
  font-family: Consolas, monospace;
  resize: vertical;
}
.snippet-form input:focus,
.snippet-form textarea:focus {
  border-color: var(--accent-text);
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
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.empty-hint {
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  padding: 4px 2px;
}
.snippet {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
}
.snippet:hover {
  background: var(--bg-hover);
}
.snippet-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.snippet-actions {
  display: flex;
  flex-shrink: 0;
}
/* 静默执行结果块 */
.exec-result {
  margin-top: 6px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-hover);
  font-size: var(--fs-xs);
}
.exec-result.failed {
  border-color: var(--danger);
}
.exec-head {
  display: flex;
  align-items: center;
  gap: 4px;
}
.exec-code {
  flex: 1;
  color: var(--fg-muted);
}
.failed .exec-code {
  color: var(--danger-text);
}
.exec-out {
  margin: 4px 0 0;
  padding: 4px 6px;
  background: var(--bg-panel);
  border-radius: var(--r-xs);
  max-height: 140px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: var(--font-mono, monospace);
  user-select: text;
}
.exec-out.err {
  color: var(--danger-text);
}
.exec-note {
  margin-top: 4px;
  color: var(--fg-muted);
}
</style>
