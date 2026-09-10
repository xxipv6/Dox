<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { basicSetup } from 'codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { useEditorStore, type OpenFile } from '../stores/editor'
import { useSettingsStore } from '../stores/settings'
import { languageFor } from '../editor/languages'
import Icon from './Icon.vue'

const props = defineProps<{ sessionId: string }>()
const store = useEditorStore()
const settings = useSettingsStore()

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

/**
 * 语法着色的**唯一**会变的部分，所以单独放进 Compartment。
 *
 * 为什么不直接把主题塞进 buildExtensions：EditorState 是按文件缓存下来保留
 * 撤销历史的（见 cachedStates），扩展在 state 建好那一刻就冻住了 —— 用户切一次
 * 深浅色就得重建 state，代价是他所有文件的撤销历史一起清空。
 * Compartment 支持就地 reconfigure，历史不动。
 */
const themeCompartment = new Compartment()

/**
 * 编辑器外框。颜色全走 CSS 变量 —— 变量在**绘制时**才解析，所以同一份主题对象
 * 在两套界面主题下各自取到正确的值：不用写两遍，也不会跟着主题一起过期。
 *
 * 必须排在语法主题**后面**：CodeMirror 里后出现的 theme 扩展优先级更高，
 * 这样它才能盖掉 oneDark 自带的深色底和 gutter 色。
 */
const chromeTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--fs-md)',
    backgroundColor: 'var(--bg-panel)',
    color: 'var(--fg)'
  },
  '.cm-scroller': { fontFamily: 'Consolas, "Cascadia Mono", monospace' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-sunken)',
    color: 'var(--fg-muted)',
    borderRight: '1px solid var(--border)'
  },
  '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)', color: 'var(--fg-secondary)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--accent-soft)'
  }
})

/**
 * 深色用 oneDark 自带的语法配色；亮色用 CodeMirror 的默认高亮
 * （`defaultHighlightStyle` 本来就是给浅底设计的）。basicSetup 里也带了一份，
 * 这里显式再给一次是为了让「亮色档是什么」在这一个函数里看得全。
 */
function syntaxTheme(): Extension {
  return settings.resolvedTheme === 'dark'
    ? oneDark
    : syntaxHighlighting(defaultHighlightStyle, { fallback: true })
}

function buildExtensions(path: string): Extension[] {
  return [
    basicSetup,
    themeCompartment.of(syntaxTheme()),
    chromeTheme,
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
  // 缓存下来的 state 里冻着**当时**的语法主题，用户中途切过深浅色的话已经过期了，
  // 这里按当前主题就地重配一次（新 state 走 buildExtensions，本来就是对的不受影响）
  view.dispatch({ effects: themeCompartment.reconfigure(syntaxTheme()) })
  mountedPath = file.path
}

// 界面深浅色变化：就地换语法主题。撤销历史、光标、滚动位置都保留。
watch(
  () => settings.resolvedTheme,
  () => {
    view?.dispatch({ effects: themeCompartment.reconfigure(syntaxTheme()) })
  }
)

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
          <Icon name="x" :size="12" />
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
      <button class="bar-btn" title="收起编辑器" @click="store.hide(props.sessionId)">
        <Icon name="x" />
      </button>
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
  border-left: 1px solid var(--border);
  background: var(--bg-panel);
}
.editor-tabs {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  flex-shrink: 0;
}
.etab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  cursor: pointer;
  border-right: 1px solid var(--border);
  white-space: nowrap;
}
.etab.active {
  color: var(--fg);
  background: var(--bg-active);
  box-shadow: inset 0 2px 0 var(--accent);
}
.etab-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dirty-dot {
  color: var(--warning-text);
  font-size: var(--fs-xs);
}
.etab-close {
  display: inline-flex;
  align-items: center;
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  padding: 2px;
  border-radius: var(--r-xs);
}
.etab-close:hover {
  color: var(--danger-text);
}
.spacer {
  flex: 1;
}
.bar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-left: 1px solid var(--border);
  background: none;
  color: var(--fg-muted);
  font-size: var(--fs-sm);
  padding: 0 10px;
  cursor: pointer;
  white-space: nowrap;
}
.bar-btn:hover:not(:disabled) {
  color: var(--fg);
}
.bar-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.editor-path {
  padding: 4px 10px;
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}
.saved-hint {
  color: var(--success-text);
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
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  text-align: center;
}
.editor-error {
  color: var(--danger-text);
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
}
</style>
