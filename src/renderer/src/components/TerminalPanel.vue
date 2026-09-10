<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { useSessionStore } from '../stores/sessions'
import { useSettingsStore } from '../stores/settings'
import { createZmodemBridge, type ZmodemBridge } from '../zmodem/zmodemService'

const props = defineProps<{ sessionId: string }>()
const store = useSessionStore()
const settings = useSettingsStore()

const container = ref<HTMLDivElement>()
const searchInput = ref<HTMLInputElement>()
const searchVisible = ref(false)
const searchText = ref('')

// 右键菜单
const menu = ref<{ x: number; y: number } | null>(null)
const hasSelection = ref(false)

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let searchAddon: SearchAddon | null = null
let unsubscribeData: (() => void) | null = null
let resizeObserver: ResizeObserver | null = null
let zmodem: ZmodemBridge | null = null

// ---- 终端 cwd 跟踪 ----
// 优先用 shell integration 上报（OSC 7，精确）；没有的 shell 退回解析 cd 命令
let lineBuf = ''
let cwdFromIntegration = false

function normalizePosix(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

/** 把 OSC 7 的 file:// URI 转成本地显示路径 */
function pathFromOsc7(uri: string): string | null {
  const m = /^file:\/\/([^/]*)(\/.*)$/.exec(uri)
  if (!m) return null
  const raw = decodeURIComponent(m[2])
  // Windows 下是 /C:/Users/... → C:\Users\...
  if (/^\/[A-Za-z]:/.test(raw)) return raw.slice(1).replace(/\//g, '\\')
  return raw
}

function handleCommand(line: string): void {
  const m = /^\s*(?:cd|pushd)\s*(.*)$/.exec(line)
  if (!m) return
  let arg = (m[1] ?? '').trim().split(/\s*(?:&&|\|\||[;|])\s*/)[0]?.trim() ?? ''
  arg = arg.replace(/^["']|["']$/g, '')
  if (arg === '-') return

  const home = store.homeBySession[props.sessionId]
  const cur = store.cwdBySession[props.sessionId] ?? home ?? '/'
  let next: string
  if (!arg || arg === '~') {
    if (!home) return
    next = home
  } else if (arg.startsWith('/')) {
    next = normalizePosix(arg)
  } else if (arg.startsWith('~/')) {
    if (!home) return
    next = normalizePosix(home + arg.slice(1))
  } else {
    next = normalizePosix(cur + '/' + arg)
  }
  store.setCwd(props.sessionId, next)
}

function trackInput(data: string): void {
  for (const ch of data) {
    if (ch === '\r') {
      handleCommand(lineBuf)
      lineBuf = ''
    } else if (ch === '\x7f') {
      lineBuf = lineBuf.slice(0, -1)
    } else if (ch === '\x03' || ch === '\x0c') {
      lineBuf = ''
    } else if (ch >= ' ') {
      lineBuf += ch
    }
  }
}

// ---- 搜索 ----
function toggleSearch(): void {
  searchVisible.value = !searchVisible.value
  if (searchVisible.value) {
    void nextTick(() => searchInput.value?.focus())
  } else {
    searchText.value = ''
    searchAddon?.clearDecorations()
    term?.focus()
  }
}

watch(searchText, (q) => {
  if (!searchAddon) return
  if (q) searchAddon.findNext(q, { incremental: true })
  else searchAddon.clearDecorations()
})

function findNext(): void {
  if (searchText.value) searchAddon?.findNext(searchText.value)
}

function findPrevious(): void {
  if (searchText.value) searchAddon?.findPrevious(searchText.value)
}

// ---- 右键菜单（不再盲目粘贴）----
function openMenu(e: MouseEvent): void {
  hasSelection.value = !!term?.hasSelection()
  menu.value = { x: e.clientX, y: e.clientY }
}

function closeMenu(): void {
  menu.value = null
}

async function copySelection(): Promise<void> {
  const sel = term?.getSelection()
  if (sel) await navigator.clipboard.writeText(sel)
  closeMenu()
}

async function pasteClipboard(): Promise<void> {
  closeMenu()
  const text = await navigator.clipboard.readText()
  if (text) window.api.input(props.sessionId, text)
}

function clearTerminal(): void {
  closeMenu()
  term?.clear()
}

function focusTerminal(): void {
  closeMenu()
  term?.focus()
}

onMounted(() => {
  term = new Terminal({
    cursorBlink: true,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    // 连字只有 DOM 渲染器能做（WebGL 逐字形绘制），见下方 renderer 选择
    lineHeight: 1.2,
    scrollback: 10000,
    theme: settings.currentPreset.theme,
    allowProposedApi: true
  })
  fitAddon = new FitAddon()
  searchAddon = new SearchAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(searchAddon)
  term.loadAddon(new WebLinksAddon())
  term.open(container.value!)

  // 连字需要浏览器做字形替换，只有 DOM 渲染器支持；否则用 WebGL（大数据量不卡）
  if (!settings.ligatures) {
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch (err) {
      console.warn('[terminal] WebGL 不可用，使用 DOM 渲染', err)
    }
  }

  fitAddon.fit()

  // ZMODEM：数据流先过 Sentry，识别到 rz/sz 序列时自动接管会话
  zmodem = createZmodemBridge(props.sessionId, (data) => term?.write(data))

  // ---- shell integration：cwd（OSC 7）----
  term.parser.registerOscHandler(7, (payload) => {
    const path = pathFromOsc7(payload)
    if (path) {
      cwdFromIntegration = true
      store.setCwd(props.sessionId, path)
    }
    return true
  })

  // ---- shell integration：命令边界与退出码（OSC 133）----
  term.parser.registerOscHandler(133, (payload) => {
    // 形如 "D;0"、"A"、"B"
    const [kind, code] = payload.split(';')
    if (kind === 'D') store.setLastExitCode(props.sessionId, Number(code) || 0)
    return true
  })

  // Ctrl+F 打开搜索框；Ctrl+Shift+C/V 显式复制粘贴
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true
    const key = e.key.toLowerCase()
    if (e.ctrlKey && !e.shiftKey && key === 'f') {
      toggleSearch()
      return false
    }
    if (e.ctrlKey && e.shiftKey && key === 'c') {
      const sel = term?.getSelection()
      if (sel) void navigator.clipboard.writeText(sel)
      return false
    }
    if (e.ctrlKey && e.shiftKey && key === 'v') {
      void pasteClipboard()
      return false
    }
    return true
  })

  // 选中即复制
  term.onSelectionChange(() => {
    const sel = term?.getSelection()
    if (sel) void navigator.clipboard.writeText(sel)
  })

  // 远端输出 → ZMODEM Sentry → xterm（ZMODEM 会话期间数据被协议接管）
  unsubscribeData = window.api.onData((id, chunk) => {
    if (id === props.sessionId) zmodem?.consume(chunk)
  })
  // 键盘输入 → 远端；ZMODEM 会话期间屏蔽输入，避免污染协议流
  term.onData((data) => {
    if (zmodem?.isActive()) return
    window.api.input(props.sessionId, data)
    if (!cwdFromIntegration) trackInput(data)
  })
  // 尺寸变化 → 远端 PTY（vim/top 依赖正确的行列数）
  term.onResize(({ cols, rows }) => window.api.resize(props.sessionId, cols, rows))

  resizeObserver = new ResizeObserver(() => fitAddon?.fit())
  resizeObserver.observe(container.value!)

  // SSH 会话：主动取一次 home 作为相对路径基准；本地终端不需要
  if (!props.sessionId.startsWith('local-')) {
    void window.api
      .sftpRealpath(props.sessionId, '.')
      .then((home) => {
        store.setHome(props.sessionId, home)
        if (!store.cwdBySession[props.sessionId]) store.setCwd(props.sessionId, home)
      })
      .catch(() => undefined)
  }

  window.addEventListener('click', closeMenu)
  term.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('click', closeMenu)
  unsubscribeData?.()
  resizeObserver?.disconnect()
  term?.dispose()
})

// 配色 / 字号 / 字体变化时实时应用（连字开关需重建渲染器，提示重开标签）
watch(
  () => [settings.themeId, settings.fontSize, settings.fontId],
  () => {
    if (!term) return
    term.options.theme = settings.currentPreset.theme
    term.options.fontSize = settings.fontSize
    term.options.fontFamily = settings.fontFamily
    fitAddon?.fit()
  }
)

/** 标签页重新激活时父组件调用：隐藏期间尺寸可能已变化 */
function refitAndFocus(): void {
  fitAddon?.fit()
  term?.focus()
}

defineExpose({ refitAndFocus })
</script>

<template>
  <div class="terminal-wrap">
    <div ref="container" class="terminal-container" @contextmenu.prevent="openMenu"></div>

    <!-- Ctrl+F 搜索框 -->
    <div v-show="searchVisible" class="search-bar" @keydown.esc="toggleSearch">
      <input
        ref="searchInput"
        v-model="searchText"
        placeholder="搜索终端输出…"
        @keyup.enter="findNext"
        @keyup.shift.enter="findPrevious"
      />
      <button title="上一个 (Shift+Enter)" @click="findPrevious">↑</button>
      <button title="下一个 (Enter)" @click="findNext">↓</button>
      <button title="关闭 (Esc)" @click="toggleSearch">×</button>
    </div>

    <!-- 右键菜单 -->
    <div
      v-if="menu"
      class="context-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
    >
      <button :disabled="!hasSelection" @click="copySelection">复制<span class="hint">Ctrl+Shift+C</span></button>
      <button @click="pasteClipboard">粘贴<span class="hint">Ctrl+Shift+V</span></button>
      <button @click="clearTerminal">清屏<span class="hint">Ctrl+L</span></button>
      <button @click="focusTerminal">聚焦终端</button>
    </div>
  </div>
</template>

<style scoped>
.terminal-wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.terminal-container {
  width: 100%;
  height: 100%;
  padding: 4px 0 0 8px;
  box-sizing: border-box;
}
.search-bar {
  position: absolute;
  top: 8px;
  right: 12px;
  display: flex;
  gap: 4px;
  padding: 6px;
  background: #1f2335;
  border: 1px solid #2a2b3d;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  z-index: 5;
}
.search-bar input {
  background: #16161e;
  border: 1px solid #2a2b3d;
  border-radius: 4px;
  color: #c0caf5;
  padding: 4px 8px;
  font-size: 12px;
  width: 180px;
  outline: none;
}
.search-bar input:focus {
  border-color: #7aa2f7;
}
.search-bar button {
  background: none;
  border: 1px solid #2a2b3d;
  border-radius: 4px;
  color: #565f89;
  cursor: pointer;
  padding: 0 8px;
}
.search-bar button:hover {
  color: #c0caf5;
}
.context-menu {
  position: fixed;
  z-index: 50;
  min-width: 180px;
  padding: 4px;
  background: #1f2335;
  border: 1px solid #2a2b3d;
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
}
.context-menu button {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  background: none;
  border: none;
  border-radius: 5px;
  color: #c0caf5;
  font-size: 13px;
  text-align: left;
  padding: 6px 10px;
  cursor: pointer;
}
.context-menu button:hover:not(:disabled) {
  background: #2a2b3d;
}
.context-menu button:disabled {
  opacity: 0.35;
  cursor: default;
}
.hint {
  color: #565f89;
  font-size: 11px;
}
</style>
