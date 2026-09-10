<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { useEditorStore, type OpenFile } from '../stores/editor'
import { languageFor } from '../editor/languages'

const props = defineProps<{ sessionId: string }>()
const store = useEditorStore()

const files = computed(() => store.filesOf(props.sessionId))
const active = computed(() => store.activeFile(props.sessionId))

const hostEl = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null
let mountedPath: string | null = null

/**
 * 每个文件保留自己的 EditorState，切换标签时来回 setState。
 * 只用一个 EditorView 重建文档的话，切走再切回来撤销历史就没了。
 */
const cachedStates = new Map<string, EditorState>()

/**
 * 保存成功后的短暂提示。用时间戳而不是布尔量，
 * 这样连续保存两次第二次也能重新触发显示。
 */
const savedAt = ref(0)

function buildExtensions(path: string): Extension[] {
  return [
    basicSetup,
    oneDark,
    languageFor(path),
    // 配置文件常有超长行，不折行会把内容推出屏幕外
    EditorView.lineWrapping,
    // 最高优先级：否则会被 basicSetup 里的默认键位吃掉
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          void save()
          return true
        }
      }
    ]),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return
      // 按路径查当前文件对象：标签关掉再打开时拿到的是新对象，
      // 闭包里捕获旧对象会把编辑写到已经没人看的地方
      const file = store.filesOf(props.sessionId).find((f) => f.path === path)
      if (file) file.content = u.state.doc.toString()
    }),
    EditorView.theme({
      '&': { height: '100%', fontSize: '13px', backgroundColor: '#1a1b26' },
      '.cm-scroller': { fontFamily: 'Consolas, "Cascadia Mono", monospace' },
      '.cm-gutters': { backgroundColor: '#16161e', borderRight: '1px solid #2a2b3d' }
    })
  ]
}

function teardown(): void {
  if (view && mountedPath) cachedStates.set(mountedPath, view.state)
  view?.destroy()
  view = null
  mountedPath = null
}

function sync(): void {
  const file = active.value
  // 内容还没到（或读失败/是二进制）时不建视图，模板里的 v-if 也不会给容器
  if (!file || file.loading || file.error || !hostEl.value) {
    teardown()
    return
  }
  if (view && mountedPath === file.path) return

  teardown()
  const state =
    cachedStates.get(file.path) ??
    EditorState.create({ doc: file.content, extensions: buildExtensions(file.path) })
  view = new EditorView({ state, parent: hostEl.value })
  mountedPath = file.path
}

watch(
  () => [active.value?.path, active.value?.loading, active.value?.error],
  async () => {
    await nextTick()
    sync()
  },
  { immediate: true }
)

// 标签关闭后清掉缓存的 state，否则重新打开会看到上次的旧内容
watch(
  () => files.value.map((f) => f.path).join('\n'),
  () => {
    const alive = new Set(files.value.map((f) => f.path))
    for (const path of cachedStates.keys()) {
      if (!alive.has(path)) cachedStates.delete(path)
    }
  }
)

async function save(): Promise<void> {
  const file = active.value
  if (!file || file.saving) return
  if (await store.save(props.sessionId, file.path)) savedAt.value = Date.now()
}

async function reload(): Promise<void> {
  const file = active.value
  if (!file) return
  cachedStates.delete(file.path)
  teardown()
  await store.reload(props.sessionId, file.path)
  await nextTick()
  sync()
}

/** 保存提示显示 1.5 秒 */
const justSaved = computed(() => Date.now() - savedAt.value < 1500)

onBeforeUnmount(teardown)

// savedAt 变化后需要一个计时器把提示收掉
watch(savedAt, () => {
  if (savedAt.value) setTimeout(() => (savedAt.value = 0), 1600)
})

/** 模板里 active 可能为 null（没有打开任何文件） */
function dirty(file: OpenFile | null | undefined): boolean {
  return !!file && store.isDirty(file)
}
</script>

<template>
  <div class="editor-panel">
    <div class="editor-tabs">
      <div
        v-for="file in files"
        :key="file.path"
        class="etab"
        :class="{ active: file.path === active?.path }"
        :title="file.path"
        @click="store.setActive(props.sessionId, file.path)"
      >
        <span v-if="dirty(file)" class="dirty-dot" title="有未保存的修改">●</span>
        <span class="etab-name">{{ file.name }}</span>
        <button class="etab-close" title="关闭" @click.stop="store.close(props.sessionId, file.path)">
          ×
        </button>
      </div>
      <span class="spacer"></span>
      <button
        class="bar-btn"
        :disabled="!active || active.saving || !dirty(active)"
        :title="dirty(active) ? '保存到远端 (Ctrl+S)' : '没有未保存的修改'"
        @click="save"
      >
        保存
      </button>
      <button class="bar-btn" title="放弃本地修改，重新从远端读取" @click="reload">重载</button>
      <button class="bar-btn" title="收起编辑器" @click="store.hide(props.sessionId)">✕</button>
    </div>

    <div class="editor-path" :title="active?.path">
      {{ active?.path }}
      <span v-if="justSaved" class="saved-hint">已保存</span>
    </div>

    <div v-if="active?.loading" class="editor-hint">读取中…</div>
    <div v-else-if="active?.error" class="editor-error">
      {{ active.error }}
      <button class="bar-btn" @click="reload">重试</button>
    </div>
    <div v-else ref="hostEl" class="editor-host"></div>

    <div v-if="active && !active.error && !active.loading && active.saving" class="editor-hint">
      保存中…
    </div>
  </div>
</template>

<style scoped>
.editor-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid #2a2b3d;
  background: #1a1b26;
}
.editor-tabs {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid #2a2b3d;
  overflow-x: auto;
  flex-shrink: 0;
}
.etab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  font-size: 12px;
  color: #565f89;
  cursor: pointer;
  border-right: 1px solid #2a2b3d;
  white-space: nowrap;
}
.etab.active {
  color: #c0caf5;
  background: #1a1b26;
}
.etab-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dirty-dot {
  color: #e0af68;
  font-size: 10px;
}
.etab-close {
  background: none;
  border: none;
  color: #565f89;
  cursor: pointer;
  font-size: 13px;
  padding: 0 1px;
}
.etab-close:hover {
  color: #f7768e;
}
.spacer {
  flex: 1;
}
.bar-btn {
  border: none;
  border-left: 1px solid #2a2b3d;
  background: none;
  color: #565f89;
  font-size: 12px;
  padding: 0 10px;
  cursor: pointer;
  white-space: nowrap;
}
.bar-btn:hover:not(:disabled) {
  color: #c0caf5;
}
.bar-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.editor-path {
  padding: 4px 10px;
  font-size: 11px;
  color: #565f89;
  border-bottom: 1px solid #2a2b3d;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}
.saved-hint {
  color: #9ece6a;
  margin-left: 8px;
}
.editor-host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.editor-host :deep(.cm-editor) {
  height: 100%;
}
.editor-hint,
.editor-error {
  padding: 16px;
  font-size: 12px;
  color: #565f89;
  text-align: center;
}
.editor-error {
  color: #f7768e;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
}
</style>
