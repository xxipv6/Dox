<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { FONT_PRESETS, UI_THEME_OPTIONS, useSettingsStore } from '../stores/settings'
import { useUpdaterStore } from '../stores/updater'
import { AUTO_THEME_ID, TERMINAL_THEMES } from '../utils/themes'
import { useEscapeToClose } from '../composables/useEscapeToClose'
import { errorText } from '../utils/errors'
import { formatSize } from '../utils/format'
import type { AiProvider, LocalShellInfo } from '@shared/types'

const settings = useSettingsStore()
const updater = useUpdaterStore()

useEscapeToClose(
  () => settings.dialogVisible,
  () => (settings.dialogVisible = false)
)
const shells = ref<LocalShellInfo[]>([])

/** 本地终端默认目录：弹系统目录选择框，不让用户手输路径 */
async function pickDefaultDir(): Promise<void> {
  const dir = await window.api.pickDirectory('选择本地终端的默认目录')
  if (dir) settings.localDefaultDir = dir
}

/** CLI 伴侣：把 dox 命令装进 PATH（dox . / dox user@host 随手开标签） */
const cliInstallResult = ref<{ path: string; note?: string } | null>(null)
const cliInstallError = ref('')
async function installCli(): Promise<void> {
  cliInstallResult.value = null
  cliInstallError.value = ''
  try {
    cliInstallResult.value = await window.api.cliInstall()
  } catch (err) {
    // errorText 剥掉 Electron 的 IPC 包装（「Error invoking remote method ...」），
    // 用户看到的是安装器自己那句话
    cliInstallError.value = errorText(err)
  }
}

/*
 * 回显真实安装状态：本组件常驻挂载（弹层是内部 v-if），onMounted 只在
 * 应用启动时跑一次，所以盯 dialogVisible —— 每次打开都重新问主进程。
 * 文件在但 PATH 没配时主进程会在 note 里给补救路径。
 */
watch(
  () => settings.dialogVisible,
  async (visible) => {
    if (!visible) return
    try {
      cliInstallResult.value = await window.api.cliStatus()
      cliInstallError.value = ''
    } catch {
      /* 查询失败就当没装，不挡弹窗 */
    }
  }
)

// ---- AI 容量账号（key 走 safeStorage 加密落盘，列表不回显 key）----
interface AiAccountRow {
  id: string
  name: string
  provider: AiProvider
}
const AI_PROVIDERS: { id: AiProvider; name: string }[] = [
  { id: 'kimi', name: 'Kimi Code' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'glm', name: 'GLM（智谱）' }
]
const aiAccounts = ref<AiAccountRow[]>([])
const aiProvider = ref<AiProvider>('kimi')
const aiName = ref('')
const aiKey = ref('')
const aiBusy = ref(false)

async function loadAiAccounts(): Promise<void> {
  aiAccounts.value = await window.api.aiAccountList()
}

async function addAiAccount(): Promise<void> {
  if (!aiKey.value.trim() || aiBusy.value) return
  aiBusy.value = true
  try {
    await window.api.aiAccountSave({
      name: aiName.value.trim() || AI_PROVIDERS.find((p) => p.id === aiProvider.value)?.name || '',
      provider: aiProvider.value,
      apiKey: aiKey.value.trim()
    })
    aiName.value = ''
    aiKey.value = ''
    await loadAiAccounts()
  } finally {
    aiBusy.value = false
  }
}

async function removeAiAccount(id: string): Promise<void> {
  await window.api.aiAccountDelete(id)
  await loadAiAccounts()
}

onMounted(async () => {
  shells.value = await window.api.listLocalShells()
  await loadAiAccounts()
})

// ---- 应用更新（状态机在主进程 updater.ts，这里只做展示与意图转发）----
const sourceLabel = computed(() => (updater.state?.source === 'github' ? 'GitHub' : '镜像'))

const updateLine = computed(() => {
  const s = updater.state
  if (!s) return ''
  if (!s.supported) {
    // 未签名 mac 构建：轻量检查照常跑，发现新版引导手动下载
    if (s.phase === 'available' && s.version) {
      return `发现新版本 v${s.version} · 未签名构建请手动下载安装`
    }
    if (s.phase === 'checking') return '正在检查更新…（镜像源）'
    if (s.phase === 'up-to-date') return `当前版本 v${s.currentVersion} · 已是最新`
    if (s.phase === 'error') return `检查失败：${s.error ?? '未知错误'}`
    return `当前版本 v${s.currentVersion} · 此构建不支持自动更新`
  }
  switch (s.phase) {
    case 'checking':
      return `正在检查更新…（${sourceLabel.value}源）`
    case 'up-to-date':
      return `当前版本 v${s.currentVersion} · 已是最新`
    case 'available':
      return `发现新版本 v${s.version}，开始下载…`
    case 'downloading': {
      const speed = s.bytesPerSecond ? ` · ${formatSize(s.bytesPerSecond)}/s` : ''
      return `正在下载 v${s.version} · ${Math.floor(s.percent ?? 0)}%${speed}（${sourceLabel.value}源）`
    }
    case 'downloaded':
      return `v${s.version} 已下载，重启后生效`
    case 'error':
      return `更新失败：${s.error ?? '未知错误'}`
    default:
      return `当前版本 v${s.currentVersion}`
  }
})

/*
 * 「重启并安装」会断开所有 SSH 会话与传输，必须是个两步动作：
 * 第一次点变成确认态，4 秒不点第二次自动退回。
 */
const confirmInstall = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | undefined
function onInstallClick(): void {
  if (!confirmInstall.value) {
    confirmInstall.value = true
    confirmTimer = setTimeout(() => {
      confirmInstall.value = false
    }, 4000)
    return
  }
  clearTimeout(confirmTimer)
  window.api.updaterQuitAndInstall()
}

function openManualDownload(): void {
  const url = updater.state?.manualUrl
  if (url) void window.api.openExternal(url)
}

function checkUpdates(): void {
  void window.api.updaterCheck()
}
</script>

<template>
  <Transition name="pop">
    <div
      v-if="settings.dialogVisible"
      class="overlay"
      @click.self="settings.dialogVisible = false"
    >
      <div class="dialog pop-surface">
        <div class="dialog-header">
          <span>设置</span>
          <button class="close-btn" @click="settings.dialogVisible = false">×</button>
        </div>

        <div class="field">
          <label>界面主题</label>
          <div class="segmented">
            <button
              v-for="opt in UI_THEME_OPTIONS"
              :key="opt.id"
              :class="{ active: settings.uiTheme === opt.id }"
              @click="settings.uiTheme = opt.id"
            >
              {{ opt.name }}
            </button>
          </div>
          <p class="sub-note">
            跟随系统时，切换操作系统的深浅色设置会实时生效。侧栏顶部的按钮可以随时一键切换。
          </p>
        </div>

        <div class="field">
          <label>终端配色方案</label>
          <div class="theme-list">
            <div
              class="theme-item"
              :class="{ active: settings.themeId === AUTO_THEME_ID }"
              @click="settings.themeId = AUTO_THEME_ID"
            >
              <!--
                用 currentPreset 取色：themeId 是 auto 时它已经解析成了当前界面主题
                对应的那套，所以这一格显示的正是「选它会得到什么」。
              -->
              <span
                class="swatch"
                :style="{
                  background: settings.currentPreset.theme.background,
                  color: settings.currentPreset.theme.foreground,
                  borderColor: settings.currentPreset.theme.selectionBackground
                }"
                >A$</span
              >
              <span>跟随界面主题</span>
            </div>

            <div class="divider"></div>

            <div
              v-for="preset in TERMINAL_THEMES"
              :key="preset.id"
              class="theme-item"
              :class="{ active: settings.themeId === preset.id }"
              @click="settings.themeId = preset.id"
            >
              <span
                class="swatch"
                :style="{
                  background: preset.theme.background,
                  color: preset.theme.foreground,
                  borderColor: preset.theme.selectionBackground
                }"
                >A$</span
              >
              <span>{{ preset.name }}</span>
            </div>
          </div>
        </div>

        <div class="field">
          <label>终端字体</label>
          <select v-model="settings.fontId">
            <option v-for="f in FONT_PRESETS" :key="f.id" :value="f.id">{{ f.name }}</option>
          </select>
          <label class="checkbox">
            <input v-model="settings.ligatures" type="checkbox" />
            启用字体连字（<code>-&gt;</code> <code>=&gt;</code> 等合字）
          </label>
          <p class="sub-note">
            连字需要切换到 DOM 渲染器，大数据量输出时性能低于 WebGL；切换后需重开标签页生效。
          </p>
          <label class="checkbox">
            <input v-model="settings.suggestPortForward" type="checkbox" />
            检测到服务监听时建议端口转发
          </label>
          <p class="sub-note">
            终端输出里出现 localhost:端口号 这类服务横幅时，右下角弹出「转发到本机」一键建议。
          </p>
          <label class="checkbox">
            <input v-model="settings.portSentinel" type="checkbox" />
            端口哨兵：新出现的监听端口弹警告
          </label>
          <p class="sub-note">
            需要安装远程助手。连接建立后**新出现**的监听端口会弹警告并反查进程名，点击直达性能监控的连接表；已有服务不打扰。
          </p>
        </div>

        <div class="field">
          <label class="checkbox">
            <input v-model="settings.outputHighlight" type="checkbox" />
            输出高亮：IP / 日志级别 / error 关键字
          </label>
          <p class="sub-note">
            给输出里匹配到的片段上色（内置规则，配色跟随终端主题）。只影响显示、不改写输出字节；
            vim / tmux 这类全屏程序走备用屏，自动不生效，不会跟它们自己的重绘打架。
          </p>
        </div>

        <div class="field">
          <label>终端字号：{{ settings.fontSize }}px</label>
          <input v-model.number="settings.fontSize" type="range" min="10" max="24" step="1" />
        </div>

        <div class="field">
          <label>本地终端 Shell</label>
          <select v-model="settings.localShellId">
            <option value="">自动（Windows 优先 cmd，macOS/Linux 跟随 $SHELL）</option>
            <option v-for="s in shells" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <p class="sub-note">
            新开的本地终端生效。支持 shell integration 的 shell 会实时上报工作目录与命令退出码；
            cmd 只能上报目录（无退出码），WSL 暂不支持。
          </p>
        </div>

        <div class="field">
          <label>本地终端默认目录</label>
          <div class="dir-pick-row">
            <span class="dir-pick-value" :title="settings.localDefaultDir || '跟随系统（家目录）'">
              {{ settings.localDefaultDir || '跟随系统（家目录）' }}
            </span>
            <button class="dir-pick-btn" @click="pickDefaultDir">选择目录…</button>
            <button
              v-if="settings.localDefaultDir"
              class="dir-pick-clear"
              title="清除（回到家目录）"
              @click="settings.localDefaultDir = ''"
            >×</button>
          </div>
          <p class="sub-note">
            设置后新开本地终端一律从这个目录启动；不设置则回家目录。
            目录后来被删了会自动落回家目录。
          </p>
        </div>

        <div class="field">
          <label>命令行工具（dox 命令）</label>
          <div class="dir-pick-row">
            <span class="dir-pick-value">
              {{ cliInstallResult ? `已装到 ${cliInstallResult.path}` : 'dox . 当前目录开标签 · dox root@1.2.3.4 直连' }}
            </span>
            <button class="dir-pick-btn" @click="installCli">
              {{ cliInstallResult ? '重新安装' : '安装' }}
            </button>
          </div>
          <p v-if="cliInstallResult?.note" class="sub-note">{{ cliInstallResult.note }}</p>
          <p v-else-if="cliInstallError" class="sub-note error">安装失败：{{ cliInstallError }}</p>
          <p v-else class="sub-note">
            在任意终端里敲 <code>dox .</code> 让 Dox 在当前目录开标签，<code>dox user@host</code> 直接连设备
            （已保存的设备用库存凭证直连，没存过会预填表单）。
          </p>
        </div>

        <div class="field">
          <label>应用更新</label>
          <div class="dir-pick-row">
            <span class="dir-pick-value" :title="updateLine">{{ updateLine }}</span>
            <button
              v-if="updater.state?.phase === 'downloaded'"
              class="dir-pick-btn"
              :class="{ 'upd-confirm': confirmInstall }"
              @click="onInstallClick"
            >
              {{ confirmInstall ? '断开所有会话并重启？' : '重启并安装' }}
            </button>
            <button
              v-else-if="updater.state"
              class="dir-pick-btn"
              :disabled="updater.state?.phase === 'checking' || updater.state?.phase === 'downloading'"
              @click="checkUpdates"
            >
              {{ updater.state?.phase === 'error' ? '重试' : '检查更新' }}
            </button>
            <button
              v-if="updater.state?.manualUrl && (updater.state.phase === 'error' || !updater.state.supported)"
              class="dir-pick-btn"
              @click="openManualDownload"
            >
              {{ updater.state.version ? `下载 v${updater.state.version}` : '手动下载' }}
            </button>
          </div>
          <div
            v-if="updater.state?.phase === 'downloading'"
            class="upd-bar"
            role="progressbar"
            :aria-valuenow="Math.floor(updater.state.percent ?? 0)"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <i :style="{ width: `${updater.state.percent ?? 0}%` }"></i>
          </div>
          <p class="sub-note">
            更新包由 GitHub Releases 分发，国内自动走 gh-proxy 镜像（校验 sha512，镜像篡改装不上）。
            macOS 未签名构建暂不支持自动更新，请手动下载 dmg。
          </p>
        </div>

        <div class="field">
          <label>AI 容量（标题栏速览）</label>
          <div v-if="aiAccounts.length" class="ai-acc-list">
            <div v-for="a in aiAccounts" :key="a.id" class="ai-acc-row">
              <span class="ai-acc-name">{{ a.name }}</span>
              <span class="ai-acc-provider">{{ AI_PROVIDERS.find((p) => p.id === a.provider)?.name ?? a.provider }}</span>
              <button class="ai-del" title="删除账号" @click="removeAiAccount(a.id)">×</button>
            </div>
          </div>
          <div class="ai-add">
            <select v-model="aiProvider" class="ai-provider-select">
              <option v-for="p in AI_PROVIDERS" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <input v-model="aiName" class="ai-name-input" placeholder="备注名（可空）" spellcheck="false" />
            <input
              v-model="aiKey"
              class="ai-key-input"
              type="password"
              placeholder="API Key"
              spellcheck="false"
              @keydown.enter="addAiAccount"
            />
            <button class="ai-add-btn" :disabled="!aiKey.trim() || aiBusy" @click="addAiAccount">
              添加
            </button>
          </div>
          <p class="sub-note">
            配置后标题栏显示已用容量（Kimi/GLM 看 5 小时滚动窗与每周窗，DeepSeek 看余额），
            每 5 分钟自动刷新；Key 经系统钥匙串加密存储，只用于配额查询。
            有多个同平台账号时，用「备注名」区分（标题栏显示的是备注名）。
          </p>
        </div>

        <p class="note">快捷键自定义在后续版本提供。</p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/*
 * 只留差异：遮罩/弹窗/关闭键的基础长相在 styles.css 的控件词汇表里
 * （.overlay / .dialog / .pop-surface / .close-btn）。
 */
.dialog {
  width: 380px;
}
.field {
  margin-bottom: var(--sp-4);
}
.field label {
  display: block;
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  margin-bottom: var(--sp-2);
}

/* 主题三选。跟下面按行排布的预设列表在形状上刻意区分开，
   免得两处都是「一列可点的行」，看不出哪个是开关哪个是列表 */
.segmented {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}
.segmented button {
  flex: 1;
  padding: var(--sp-1) 0;
  border: none;
  background: none;
  border-radius: var(--r-sm);
  color: var(--fg-muted);
  font-size: var(--fs-md);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.segmented button:hover {
  color: var(--fg);
}
.segmented button:active {
  transform: translateY(0.5px);
}
.segmented button.active {
  background: var(--bg-panel);
  color: var(--accent-text);
  font-weight: var(--fw-medium);
  box-shadow: var(--shadow-sm);
}

.theme-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.divider {
  height: 1px;
  background: var(--border);
  margin: var(--sp-1) 0;
}
.theme-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border-radius: var(--r-md);
  border: 1px solid transparent;
  font-size: var(--fs-md);
  color: var(--fg);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}
.theme-item:hover {
  background: var(--bg-hover);
}
.theme-item:active {
  background: var(--bg-active);
}
.theme-item.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.swatch {
  width: 36px;
  height: 24px;
  border-radius: var(--r-xs);
  border: 1px solid;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-xs);
  font-family: var(--font-mono);
  flex-shrink: 0;
}
/*
 * 滑块。只写 accent-color 是不够的：Chromium 对未显式定高/定轨的 range
 * 会用它自己的默认外观，配上 color-scheme 之后整条轨道变成纯黑，
 * 和「晴空」的浅色界面完全不搭。这里把轨道和滑块都画出来。
 */
input[type='range'] {
  width: 100%;
  appearance: none;
  height: 4px;
  border-radius: var(--r-pill);
  background: var(--bg-active);
  cursor: pointer;
  outline: none;
}
input[type='range']::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: var(--r-pill);
  background: var(--accent-text);
  /* 一圈底色描边，滑块压在轨道上才有层次 */
  border: 2px solid var(--bg-panel);
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur-fast) var(--ease-out);
}
input[type='range']:hover::-webkit-slider-thumb {
  transform: scale(1.12);
}
select {
  width: 100%;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  color: var(--fg);
  padding: var(--sp-2) var(--sp-3);
  font-size: var(--fs-md);
  outline: none;
  transition: border-color var(--dur-fast) var(--ease-out);
}
select:focus {
  border-color: var(--accent);
}
.checkbox {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
  font-size: var(--fs-md);
  color: var(--fg);
  cursor: pointer;
}
/* 用 -text 那一档：白色对勾压在 --accent（#0ea5e9）上只有 2.8:1，看不清 */
.checkbox input {
  accent-color: var(--accent-text);
  width: 16px;
  height: 16px;
  cursor: pointer;
}
.checkbox code {
  font-family: var(--font-mono);
  color: var(--accent-text);
}
.sub-note {
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  margin: var(--sp-2) 0 0;
  line-height: var(--lh-base);
}
/* 默认目录：只读展示 + 选择按钮（路径手输容易错，只给目录框） */
.dir-pick-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.dir-pick-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-sm);
  color: var(--fg-secondary);
  background: var(--bg-inset, var(--bg-hover));
  border-radius: var(--r-sm);
  padding: var(--sp-1) var(--sp-2);
}
.dir-pick-btn {
  flex-shrink: 0;
  font-size: var(--fs-sm);
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--r-sm);
  background: var(--accent-soft);
  color: var(--accent-text);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.dir-pick-btn:hover {
  filter: brightness(1.05);
}
.dir-pick-btn:active {
  transform: translateY(0.5px);
}
.dir-pick-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
/* 确认态的「重启并安装」：从主色淡底切到警示语义，避免误点 */
.dir-pick-btn.upd-confirm {
  background: var(--danger-text);
  color: var(--fg-on-accent);
}
/* 更新下载进度条：--accent 是颜料档（进度条正是它的职责，见 styles.css 令牌注释） */
.upd-bar {
  margin-top: var(--sp-1);
  height: 4px;
  border-radius: var(--r-pill);
  background: var(--bg-hover);
  overflow: hidden;
}
.upd-bar > i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width var(--dur-fast) linear;
}
.dir-pick-clear {
  flex-shrink: 0;
  font-size: var(--fs-sm);
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--r-sm);
  color: var(--fg-muted);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.dir-pick-clear:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.dir-pick-clear:active {
  background: var(--bg-active);
}

/* AI 容量账号管理 */
.ai-acc-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin-bottom: var(--sp-2);
}
.ai-acc-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
}
.ai-acc-row:hover {
  background: var(--bg-hover);
}
.ai-acc-name {
  color: var(--fg);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-acc-provider {
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  flex-shrink: 0;
}
.ai-del {
  background: none;
  border: none;
  color: var(--fg-muted);
  font-size: var(--fs-md);
  cursor: pointer;
  /* 命中区：13px 的字 + 1px 上下内边距才够到 24px 那一档 */
  padding: var(--sp-1) 6px;
  border-radius: var(--r-sm);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.ai-del:hover {
  color: var(--danger-text);
  background: var(--danger-soft);
}
.ai-del:active {
  transform: translateY(0.5px);
}
.ai-add {
  display: flex;
  gap: var(--sp-1);
  align-items: center;
}
.ai-provider-select {
  width: auto;
  flex-shrink: 0;
}
.ai-add input {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  color: var(--fg);
  padding: var(--sp-1) var(--sp-2);
  font-size: var(--fs-sm);
  outline: none;
  min-width: 0;
}
.ai-add input:focus {
  border-color: var(--accent);
}
.ai-name-input {
  width: 90px;
}
.ai-key-input {
  flex: 1;
}
.ai-add-btn {
  flex-shrink: 0;
  background: var(--accent);
  border: none;
  border-radius: var(--r-md);
  color: var(--fg-on-accent);
  font-size: var(--fs-sm);
  padding: var(--sp-1) var(--sp-3);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.ai-add-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}
.ai-add-btn:active:not(:disabled) {
  transform: translateY(0.5px);
}
.ai-add-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.note {
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  margin: 0;
}
/* 说明句里的错误态：比普通 --fg-muted 更重，但不喧宾夺主 */
.sub-note.error {
  color: var(--danger-text);
}
</style>
