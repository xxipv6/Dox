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

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let searchAddon: SearchAddon | null = null
let unsubscribeData: (() => void) | null = null
let resizeObserver: ResizeObserver | null = null
let zmodem: ZmodemBridge | null = null

// ---- 终端 cwd 跟踪（解析 cd/pushd 命令，posix 语义解析相对路径）----
let lineBuf = ''

function normalizePosix(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

function handleCommand(line: string): void {
  const m = /^\s*(?:cd|pushd)\s*(.*)$/.exec(line)
  if (!m) return
  // 去掉管道/连接符之后的部分和外层引号
  let arg = (m[1] ?? '').trim().split(/\s*(?:&&|\|\||[;|])\s*/)[0]?.trim() ?? ''
  arg = arg.replace(/^["']|["']$/g, '')
  if (arg === '-') return // cd - 无法本地推断，跳过

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
      lineBuf = lineBuf.slice(0, -1) // 退格
    } else if (ch === '\x03' || ch === '\x0c') {
      lineBuf = '' // Ctrl+C / Ctrl+L
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

// ---- 右键粘贴 ----
function pasteFromClipboard(): void {
  void navigator.clipboard.readText().then((text) => {
    if (text) window.api.input(props.sessionId, text)
  })
}

onMounted(() => {
  term = new Terminal({
    cursorBlink: true,
    fontSize: settings.fontSize,
    fontFamily: 'Consolas, "Cascadia Mono", "JetBrains Mono", monospace',
    theme: settings.currentPreset.theme,
    allowProposedApi: true
  })
  fitAddon = new FitAddon()
  searchAddon = new SearchAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(searchAddon)
  term.loadAddon(new WebLinksAddon())
  term.open(container.value!)

  // WebGL 渲染，失败（如远程桌面环境）时静默回退到 canvas
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => webgl.dispose())
    term.loadAddon(webgl)
  } catch (err) {
    console.warn('[terminal] WebGL 不可用，使用 canvas 渲染', err)
  }

  fitAddon.fit()

  // ZMODEM：数据流先过 Sentry，识别到 rz/sz 序列时自动接管会话
  zmodem = createZmodemBridge(props.sessionId, (data) => term?.write(data))

  // Ctrl+F 打开搜索框
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type === 'keydown' && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
      toggleSearch()
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
  // 键盘输入 → 远端；ZMODEM 会话期间屏蔽用户输入，避免污染协议流
  term.onData((data) => {
    if (zmodem?.isActive()) return
    window.api.input(props.sessionId, data)
    trackInput(data)
  })
  // 尺寸变化 → 远端 PTY（vim/top 依赖正确的行列数）
  term.onResize(({ cols, rows }) => window.api.resize(props.sessionId, cols, rows))

  resizeObserver = new ResizeObserver(() => fitAddon?.fit())
  resizeObserver.observe(container.value!)

  // 初始化 cwd 为远端 home（跟随功能以此为起点）；本地终端无 SFTP，跳过
  if (!props.sessionId.startsWith('local-')) {
    void window.api
      .sftpRealpath(props.sessionId, '.')
      .then((home) => {
        store.setHome(props.sessionId, home)
        if (!store.cwdBySession[props.sessionId]) store.setCwd(props.sessionId, home)
      })
      .catch(() => undefined)
  }

  term.focus()
})

// 配色 / 字号设置变化时实时应用
watch(
  () => [settings.themeId, settings.fontSize],
  () => {
    if (!term) return
    term.options.theme = settings.currentPreset.theme
    term.options.fontSize = settings.fontSize
    fitAddon?.fit()
  }
)

onBeforeUnmount(() => {
  unsubscribeData?.()
  resizeObserver?.disconnect()
  term?.dispose()
})

/** 标签页重新激活时父组件调用：隐藏期间尺寸可能已变化 */
function refitAndFocus(): void {
  fitAddon?.fit()
  term?.focus()
}

defineExpose({ refitAndFocus })
</script>

<template>
  <div class="terminal-wrap">
    <div
      ref="container"
      class="terminal-container"
      @contextmenu.prevent="pasteFromClipboard"
    ></div>

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
</style>
