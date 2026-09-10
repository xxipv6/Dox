<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import type { CommandSnippet } from '@shared/types'
import { useSessionStore } from '../stores/sessions'

const api = window.api
const store = useSessionStore()

const snippets = ref<CommandSnippet[]>([])
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
  <div class="section-title">
    快捷命令
    <button
      class="icon-btn"
      :title="formVisible ? '收起' : '新建片段'"
      @click="
        formVisible = !formVisible;
        if (!formVisible) resetForm()
      "
    >{{ formVisible ? '−' : '＋' }}</button>
  </div>

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
      >▶</button>
      <button
        class="icon-btn"
        :class="{ dim: !store.activeSessionId }"
        title="粘贴到命令行（不执行）"
        @click="pasteOnly(s)"
      >⤵</button>
      <button class="icon-btn" title="编辑" @click="edit(s)">✎</button>
      <button class="icon-btn danger" title="删除" @click="remove(s)">×</button>
    </span>
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
.snippet-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}
.snippet-form input,
.snippet-form textarea {
  background: #1f2335;
  border: 1px solid #2a2b3d;
  border-radius: 6px;
  color: #c0caf5;
  padding: 7px 10px;
  font-size: 12px;
  outline: none;
  font-family: Consolas, monospace;
  resize: vertical;
}
.snippet-form input:focus,
.snippet-form textarea:focus {
  border-color: #7aa2f7;
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
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.empty-hint {
  font-size: 12px;
  color: #565f89;
  padding: 4px 2px;
}
.snippet {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 12px;
}
.snippet:hover {
  background: #1f2335;
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
.icon-btn.dim {
  opacity: 0.35;
}
.icon-btn.danger:hover {
  color: #f7768e;
}
</style>
