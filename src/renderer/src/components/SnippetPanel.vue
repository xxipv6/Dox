<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { CommandSnippet } from '@shared/types'
import { useSessionStore } from '../stores/sessions'
import Icon from './Icon.vue'
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
      <button class="icon-btn" title="编辑" @click="edit(s)"><Icon name="pencil" /></button>
      <button class="icon-btn danger" title="删除" @click="remove(s)"><Icon name="x" /></button>
    </span>
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
</style>
