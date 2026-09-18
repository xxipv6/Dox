<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { Compartment, EditorState, StateEffect, type Extension } from '@codemirror/state'
import { Decoration, EditorView, keymap, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { indentLess, indentMore, insertTab } from '@codemirror/commands'
import { basicSetup } from 'codemirror'
import { useEditorStore, type OpenFile } from '../stores/editor'
import { useSettingsStore } from '../stores/settings'
import { languageFor } from '../editor/languages'
import { vscodeDarkSyntax, vscodeLightSyntax } from '../editor/vscodeSyntax'
import { formatMtime, formatSize } from '../utils/format'
import { maxCols, parseDelimited } from '../utils/csv'
import Icon from './Icon.vue'
import CsvTable from './CsvTable.vue'

const props = defineProps<{ sessionId: string }>()
const store = useEditorStore()
const settings = useSettingsStore()

/** 快捷键提示按平台显示：CodeMirror 的 Mod-s 在 macOS 上是 ⌘S */
const saveShortcut = window.api.platform === 'darwin' ? '⌘S' : 'Ctrl+S'

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

// ---- 状态栏（行:列 · EOL · 大小 · 修改时间）----
const cursorLine = ref(1)
const cursorCol = ref(1)
/** 模块级复用：dirty 态大小每次按键都要算一次字节数，别在 computed 里反复 new */
const encoder = new TextEncoder()

function updateCursorFrom(state: { doc: { lineAt(pos: number): { number: number; from: number } }; selection: { main: { head: number } } }): void {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  cursorLine.value = line.number
  cursorCol.value = head - line.from + 1
}

const eol = computed(() => (active.value?.content.includes('\r\n') ? 'CRLF' : 'LF'))
/**
 * dirty 内容的字节数缓存（path → bytes）。基线 = 保存时的 file.size，之后按
 * CodeMirror 的 ChangeSet 增量加减（见 updateListener）：每次按键只编码被改动的
 * 片段 —— 整文件 TextEncoder 每键重跑在 MB 级文件上是白烧。保存/重载成功后
 * 基线换新，条目随之作废删除。
 */
const dirtyBytes = new Map<string, number>()
/** dirty 时显示当前编辑内容的字节数（远端 size 已过期），否则显示远端 size */
const fileSize = computed(() => {
  const file = active.value
  if (!file) return 0
  return store.isDirty(file) ? (dirtyBytes.get(file.path) ?? encoder.encode(file.content).length) : file.size
})
const mtimeText = computed(() => formatMtime(active.value?.mtime ?? 0))

// ---- CSV/TSV 表格视图（默认表格，工具栏可切回文本编辑）----
/** 每个文件的视图偏好（true=表格）。关标签时随 cachedStates 一起清；重载不清（偏好跨重载存活） */
const csvTableByPath = reactive<Record<string, boolean>>({})
const CSV_DELIMS: Record<string, string> = { csv: ',', tsv: '\t' }
/** 按扩展名给分隔符；非 csv/tsv 返回 null。name 是 basename，不会踩 Windows 路径反斜杠 */
function csvDelimiter(file: OpenFile | null): string | null {
  const m = /\.([a-z]+)$/i.exec(file?.name ?? '')
  return m ? (CSV_DELIMS[m[1].toLowerCase()] ?? null) : null
}
const isCsvActive = computed(() => csvDelimiter(active.value) !== null)
const tableMode = computed(() => {
  const file = active.value
  return !!file && csvDelimiter(file) !== null && (csvTableByPath[file.path] ?? true)
})
/** 表格态才解析（状态栏的 N 行 × M 列 与 CsvTable 共用这一份）；切回文本时归 null 释放中间结构 */
const parsedRows = computed<string[][] | null>(() => {
  const file = active.value
  if (!file || !tableMode.value) return null
  return parseDelimited(file.content, csvDelimiter(file)!)
})

function toggleViewMode(): void {
  const file = active.value
  if (file && csvDelimiter(file)) csvTableByPath[file.path] = !tableMode.value
}

/**
 * 语法着色的**唯一**会变的部分，所以单独放进 Compartment。
 *
 * 为什么不直接把主题塞进 buildExtensions：EditorState 是按文件缓存下来保留
 * 撤销历史的（见 cachedStates），扩展在 state 建好那一刻就冻住了 —— 用户切一次
 * 深浅色就得重建 state，代价是他所有文件的撤销历史一起清空。
 * Compartment 支持就地 reconfigure，历史不动。
 */
const themeCompartment = new Compartment()

/*
 * VS Code 默认编辑器排版（源码 fontInfo.ts 的 EDITOR_FONT_DEFAULTS）：
 * mac 12px / 行高 16px，Windows/Linux 14px / 行高 19px（lineHeight 0 = round(1.35×字号)）。
 * mac 上 VS Code 还统一开了灰度抗锯齿（workbench css 的 .mac 规则）——
 * 同一个 Menlo 字面，抗锯齿策略不同观感就明显不同，一并跟上。
 */
const isMacPlatform = window.api.platform === 'darwin'
const ED_FONT_SIZE = isMacPlatform ? '12px' : '14px'
const ED_LINE_HEIGHT = isMacPlatform ? '16px' : '19px'

/**
 * 编辑器外框。颜色走 --ed-* 令牌（styles.css 里定义的 VS Code 内置主题原值），
 * 而不是界面令牌：代码区的观感要对齐 VS Code，而不是跟着界面色相走。
 * 变量在**绘制时**才解析，所以同一份主题对象在两套界面主题下各自取到正确的值。
 *
 * 必须排在语法主题**后面**：CodeMirror 里后出现的 theme 扩展优先级更高，
 * 这样它才能盖掉语法主题自带的行内底色（oneDark 时代留下的顺序，保留）。
 */
const chromeTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: ED_FONT_SIZE,
    backgroundColor: 'var(--ed-bg)',
    color: 'var(--ed-fg)'
  },
  // 等宽字体走令牌（与终端、搜索结果同一套字形，顺序即 VS Code 默认字体链）
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: ED_LINE_HEIGHT,
    WebkitFontSmoothing: 'antialiased'
  },
  '.cm-gutters': {
    // VS Code 的 gutter 与正文同底、无边框，只有行号一档色差
    backgroundColor: 'var(--ed-bg)',
    color: 'var(--ed-linenumber)'
  },
  '.cm-activeLine': { backgroundColor: 'var(--ed-activeline)' },
  '.cm-activeLineGutter': { color: 'var(--ed-linenumber-active)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ed-cursor)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--ed-selection)'
  },
  // URL 悬停下划线（UrlHover 插件加的标记）：只加视觉，不改语法配色
  '.cm-url': { textDecoration: 'underline', cursor: 'pointer' }
})

/**
 * 语法配色：VS Code 内置主题的移植（深色 Dark+ / 浅色 Light+），见 editor/vscodeSyntax.ts。
 * 两套都是「标签 → 颜色」的纯映射，底色由上面的 chromeTheme 统一压住。
 */
function syntaxTheme(): Extension {
  return settings.resolvedTheme === 'dark' ? vscodeDarkSyntax : vscodeLightSyntax
}

// ---- URL 链接：修饰键悬停下划线 + Cmd/Ctrl 点击走系统浏览器（与终端的 WebLinksAddon 同一套 UX）----
/** 协议头起、到空白/封口引号括号/句读停（主进程 openExternal 只放行 http/https，正好同口径） */
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\],;]+/g

/** pos 落在某个 URL 上（含端点）时给出它的文档范围；matchAll 内部克隆正则，模块级复用安全 */
function urlRangeAt(view: EditorView, pos: number | null): { from: number; to: number } | null {
  if (pos === null) return null
  const line = view.state.doc.lineAt(pos)
  for (const m of line.text.matchAll(URL_RE)) {
    const from = line.from + (m.index ?? 0)
    const to = from + m[0].length
    if (pos >= from && pos <= to) return { from, to }
  }
  return null
}

/** 重算下划线装饰的信号：鼠标/修饰键变化不产生事务，要自己戳一下编辑器 */
const linkTick = StateEffect.define<void>()

/** Cmd/Ctrl 按住悬停 URL：给那段文本加下划线 + 手型（VS Code 的链接手感） */
class UrlHover {
  decorations: DecorationSet = Decoration.none
  private mod = false
  private hover: { from: number; to: number } | null = null
  private lastSig = ''
  private readonly mark = Decoration.mark({ class: 'cm-url' })

  constructor(private readonly view: EditorView) {
    const dom = view.contentDOM
    dom.addEventListener('mousemove', this.onMove)
    dom.addEventListener('mouseleave', this.onLeave)
    // 修饰键可能在鼠标移出编辑器后按下/松开：挂 window 才不丢状态
    window.addEventListener('keydown', this.onKey)
    window.addEventListener('keyup', this.onKey)
    window.addEventListener('blur', this.onBlur)
  }

  private onMove = (e: MouseEvent): void => {
    this.hover = urlRangeAt(this.view, this.view.posAtCoords({ x: e.clientX, y: e.clientY }))
    // 没按修饰键也没悬在 URL 上时一概不派发：mousemove 频率很高，空转事务是白烧
    if (this.mod || this.hover) this.poke()
  }
  private onLeave = (): void => {
    this.hover = null
    if (this.mod) this.poke()
  }
  private onKey = (e: KeyboardEvent): void => {
    const next = e.metaKey || e.ctrlKey
    if (next !== this.mod) {
      this.mod = next
      this.poke()
    }
  }
  /** 窗口失焦收不到 keyup，修饰键会卡在「按住」：一并复位 */
  private onBlur = (): void => {
    this.mod = false
    this.hover = null
    this.poke()
  }

  update(u: ViewUpdate): void {
    // 编辑后范围会漂移，清掉等下一次 mousemove 重取
    if (u.docChanged) this.hover = null
    this.apply()
  }

  private poke(): void {
    this.view.dispatch({ effects: linkTick.of(undefined) })
  }

  private apply(): void {
    const range = this.mod ? this.hover : null
    const sig = range ? `${range.from}:${range.to}` : ''
    if (sig === this.lastSig) return
    this.lastSig = sig
    this.decorations = range ? Decoration.set([this.mark.range(range.from, range.to)]) : Decoration.none
  }

  destroy(): void {
    const dom = this.view.contentDOM
    dom.removeEventListener('mousemove', this.onMove)
    dom.removeEventListener('mouseleave', this.onLeave)
    window.removeEventListener('keydown', this.onKey)
    window.removeEventListener('keyup', this.onKey)
    window.removeEventListener('blur', this.onBlur)
  }
}

const urlHover = ViewPlugin.fromClass(UrlHover, { decorations: (v) => v.decorations })

/**
 * Cmd/Ctrl + 点击 URL：系统浏览器打开。走 domEventHandlers（跑在 CM 内建处理
 * **之前**）并返回 true 吃掉事件 —— 否则 basicSetup 的多光标会把它当「再加一个光标」。
 */
const openUrlOnClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!(event.metaKey || event.ctrlKey)) return false
    const range = urlRangeAt(view, view.posAtCoords({ x: event.clientX, y: event.clientY }))
    if (!range) return false
    event.preventDefault()
    void window.api.openExternal(view.state.doc.sliceString(range.from, range.to))
    return true
  }
})

function buildExtensions(path: string): Extension[] {
  return [
    basicSetup,
    themeCompartment.of(syntaxTheme()),
    chromeTheme,
    languageFor(path),
    urlHover,
    openUrlOnClick,
    // 配置文件常有超长行，不折行会把内容推出屏幕外
    EditorView.lineWrapping,
    // 最高优先级：否则会被 basicSetup 里的默认键位吃掉
    keymap.of([
      /*
       * Tab 语义对齐 VS Code（官方 indentWithTab 是无选区也整行缩进，不一样）：
       * 无选区 → 在光标处插入缩进字符；有选区 → 触及的行整批缩进。
       * Shift+Tab 一律反缩进当前行。
       */
      {
        key: 'Tab',
        preventDefault: true,
        run: (v) => (v.state.selection.main.empty ? insertTab(v) : indentMore(v)),
        shift: indentLess
      },
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
      // 光标追踪要在 docChanged 早退之前：拖选、键盘移动只置 selectionSet
      if (u.selectionSet || u.docChanged) updateCursorFrom(u.state)
      if (!u.docChanged) return
      // 按路径查当前文件对象：标签关掉再打开时拿到的是新对象，
      // 闭包里捕获旧对象会把编辑写到已经没人看的地方
      const file = store.filesOf(props.sessionId).find((f) => f.path === path)
      if (file) {
        file.content = u.state.doc.toString()
        // 状态栏的 dirty 字节数走增量：只编码本次改动的片段，不整文件重跑
        const base = dirtyBytes.get(path) ?? file.size
        let delta = 0
        u.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          delta += encoder.encode(inserted.toString()).length
          delta -= encoder.encode(u.startState.doc.sliceString(fromA, toA)).length
        })
        dirtyBytes.set(path, base + delta)
        // 编辑即转正：预览只是「看一眼」，动手改了就说明要留下
        if (file.preview) store.pinPreview(props.sessionId, path)
      }
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
  // 内容还没到（或打开就失败/是二进制）时不建视图，模板里的 v-if 也不会给容器。
  // 注意「保存级错误」不在此列：文件已成功读过（有内容），保存被拒只是
  // 顶上一道横幅，编辑器必须留在原地 —— 那是用户未保存的工作。
  const loadFailed = !!file?.error && file.content === '' && file.savedContent === ''
  if (!file || file.loading || loadFailed || !hostEl.value) {
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
  // updateListener 不会在 EditorView 创建时触发：切回标签要手动读一次缓存
  // state 里的光标，否则状态栏停留在上一个文件的位置
  updateCursorFrom(view.state)
  mountedPath = file.path
}

// 界面深浅色变化：就地换语法主题。撤销历史、光标、滚动位置都保留。
watch(
  () => settings.resolvedTheme,
  () => {
    view?.dispatch({ effects: themeCompartment.reconfigure(syntaxTheme()) })
  }
)

/** revealLine 的防重放序号。必须声明在下面的 watch **之前**：immediate 会在 setup 期同步跑一次回调 */
let lastRevealedSeq = 0

watch(
  () => [active.value?.path, active.value?.loading, active.value?.error, active.value?.revealLine?.seq, tableMode.value],
  async () => {
    // 搜索跳行落在表格态：line 是物理行号，表格没有可跳的行 —— 先切回文本，
    // 让本轮稍后的 sync()+revealIfRequested() 消费掉它。revealIfRequested 在
    // view 为空时早退且**不消费 seq**，所以这里先改模式、再走原流程正好接上。
    const f = active.value
    if (f && tableMode.value && f.revealLine && f.revealLine.seq !== lastRevealedSeq) {
      csvTableByPath[f.path] = false
      await nextTick()
    }
    await nextTick()
    sync()
    revealIfRequested()
  },
  { immediate: true }
)

/*
 * 搜索结果点进来：跳到指定行。
 *
 * 必须 dispatch（selection + 滚动效果）不能重建 state —— cachedStates 保
 * 撤销历史是本组件的头号设计承诺，跳行不碰文档与历史。
 * lastRevealedSeq 防重放：切走再切回标签会因 path 变化重跑 watch，
 * 不能把早就消费过的跳转再放一遍（用户可能早已滚到别处）。
 */
function revealIfRequested(): void {
  const file = active.value
  const req = file?.revealLine
  if (!file || !req || req.seq === lastRevealedSeq) return
  if (!view || mountedPath !== file.path) return
  lastRevealedSeq = req.seq
  const ln = Math.max(1, Math.min(req.line, view.state.doc.lines))
  const pos = view.state.doc.line(ln).from
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: 'center' })
  })
  view.focus()
}

// 标签关闭后清掉缓存的 state，否则重新打开会看到上次的旧内容（csv 视图偏好、dirty 字节缓存一并清）
watch(
  () => files.value.map((f) => f.path).join('\n'),
  () => {
    const alive = new Set(files.value.map((f) => f.path))
    for (const path of cachedStates.keys()) {
      if (!alive.has(path)) cachedStates.delete(path)
    }
    for (const path of Object.keys(csvTableByPath)) {
      if (!alive.has(path)) delete csvTableByPath[path]
    }
    for (const path of dirtyBytes.keys()) {
      if (!alive.has(path)) dirtyBytes.delete(path)
    }
  }
)

async function save(): Promise<void> {
  const file = active.value
  if (!file || file.saving) return
  if (await store.save(props.sessionId, file.path)) {
    // 保存成功 = 基线换新（store 已把 file.size 更新为写回字节数），增量缓存作废
    dirtyBytes.delete(file.path)
    savedAt.value = Date.now()
  }
}

/** 冲突横幅的「强制覆盖」：用户已明确选择，跳过 mtime 检测 */
async function forceSave(): Promise<void> {
  const file = active.value
  if (!file || file.saving) return
  if (await store.save(props.sessionId, file.path, { force: true })) {
    dirtyBytes.delete(file.path)
    savedAt.value = Date.now()
  }
}

/** 冲突横幅的「重新加载」：放弃本地改动重读远端（选择已在横幅里做过，不再二次确认） */
async function discardReload(): Promise<void> {
  const file = active.value
  if (!file) return
  cachedStates.delete(file.path)
  dirtyBytes.delete(file.path)
  teardown()
  await store.reload(props.sessionId, file.path, { discard: true })
  await nextTick()
  sync()
}

/** 普通保存错误横幅的关闭：错误看完就散，编辑器本来就没动 */
function dismissError(): void {
  const file = active.value
  if (file) file.error = ''
}

async function reload(): Promise<void> {
  const file = active.value
  if (!file) return
  cachedStates.delete(file.path)
  dirtyBytes.delete(file.path)
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
        :class="{ active: file.path === active?.path, preview: file.preview }"
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
        :title="dirty(active) ? `保存到远端 (${saveShortcut})` : '没有未保存的修改'"
        @click="save"
      >
        保存
      </button>
      <!-- 只在 csv/tsv 上出现；按钮文字 = 要切到的那个模式 -->
      <button
        v-if="isCsvActive"
        class="bar-btn"
        :title="tableMode ? '切换到文本模式编辑' : '切换到表格视图'"
        @click="toggleViewMode"
      >{{ tableMode ? '文本' : '表格' }}</button>
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
    <!-- 打开就失败/二进制：没有内容可编，整个区域给错误 + 重试 -->
    <div
      v-else-if="active?.error && !active?.content && !active?.savedContent"
      class="editor-error"
    >
      {{ active.error }}
      <button class="bar-btn" @click="reload">重试</button>
    </div>
    <template v-else>
      <!--
        保存级问题不动编辑器：冲突给「强制覆盖 / 重新加载」两个明确出路，
        普通保存错误给可关的横幅 —— 编辑器里是一屏没保存的工作，不能替用户藏起来。
      -->
      <div v-if="active?.conflict" class="editor-banner conflict">
        <span class="banner-text">远端文件在你编辑期间已被修改，直接保存会覆盖掉别人的改动。</span>
        <span class="banner-actions">
          <button class="banner-btn danger" :disabled="active.saving" @click="forceSave">强制覆盖</button>
          <button class="banner-btn" :disabled="active.saving" @click="discardReload">放弃本地并重新加载</button>
        </span>
      </div>
      <div v-else-if="active?.error" class="editor-banner">
        <span class="banner-text">{{ active.error }}</span>
        <button class="banner-btn" @click="dismissError">知道了</button>
      </div>
      <!-- 二选一：表格态用 CsvTable（hostEl 消失 → sync() 走 teardown 分支，撤销历史照常缓存）；
           parsedRows 兜底为 null 时退回编辑器，防御解析异常 -->
      <CsvTable v-if="tableMode && parsedRows" :rows="parsedRows" />
      <div v-else ref="hostEl" class="editor-host"></div>
      <!-- 状态栏：跟有内容的分支走，loading / 加载失败 / 二进制态自动隐藏 -->
      <div class="editor-status">
        <!-- 表格态没有光标概念，行:列 原位换成数据规模 -->
        <span v-if="tableMode" title="数据规模（行 × 列）"
          >{{ parsedRows?.length ?? 0 }} 行 × {{ parsedRows ? maxCols(parsedRows) : 0 }} 列</span
        >
        <span v-else title="光标位置（行:列）">{{ cursorLine }}:{{ cursorCol }}</span>
        <span class="spacer"></span>
        <span>UTF-8</span>
        <span :title="eol === 'CRLF' ? 'Windows 换行（CRLF）' : 'Unix 换行（LF）'">{{ eol }}</span>
        <span>{{ formatSize(fileSize) }}</span>
        <span v-if="mtimeText">修改于 {{ mtimeText }}</span>
      </div>
    </template>

    <div v-if="active && active.saving" class="editor-hint">
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
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-3);
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  cursor: pointer;
  border-right: 1px solid var(--border);
  white-space: nowrap;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
/* 编辑器标签原来没有任何 hover 态：一排标签长得一模一样，鼠标划过也不知道会切到哪个 */
.etab:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.etab:active {
  background: var(--bg-active);
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
  justify-content: center;
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  /* 24px 命中区：关文件是这一排里最容易被误点的动作 */
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: var(--r-sm);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.etab-close:hover {
  color: var(--fg-on-accent);
  background: var(--danger-text);
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
  padding: 0 var(--sp-3);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.bar-btn:hover:not(:disabled) {
  color: var(--fg);
  background: var(--bg-hover);
}
.bar-btn:active:not(:disabled) {
  background: var(--bg-active);
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
/* 预览标签：斜体文件名（VS Code preview tab） */
.etab.preview .etab-name {
  font-style: italic;
}
/* 底部状态栏：密度对齐 .editor-path */
.editor-status {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 4px 10px;
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  border-top: 1px solid var(--border);
  white-space: nowrap;
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
/* 保存级问题的内联横幅：编辑器保持挂载，横幅只是顶上一条 */
.editor-banner {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px 10px;
  font-size: var(--fs-sm);
  color: var(--fg);
  background: var(--accent-soft);
  border-bottom: 1px solid var(--border);
}
.editor-banner.conflict {
  background: color-mix(in srgb, var(--warning-text) 12%, var(--bg-panel));
}
.banner-text {
  flex: 1;
  min-width: 0;
}
.banner-actions {
  display: flex;
  gap: var(--sp-2);
  flex-shrink: 0;
}
.banner-btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--fg);
  border-radius: var(--r-sm);
  padding: 3px var(--sp-3);
  font-size: var(--fs-xs);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.banner-btn:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}
.banner-btn:active {
  background: var(--bg-active);
  transform: translateY(0.5px);
}
.banner-btn.danger {
  border-color: var(--danger-text);
  color: var(--danger-text);
}
.banner-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
