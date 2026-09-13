<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { FONT_PRESETS, UI_THEME_OPTIONS, useSettingsStore } from '../stores/settings'
import { AUTO_THEME_ID, TERMINAL_THEMES } from '../utils/themes'
import { useEscapeToClose } from '../composables/useEscapeToClose'
import type { AiProvider, LocalShellInfo } from '@shared/types'

const settings = useSettingsStore()

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
</script>

<template>
  <div v-if="settings.dialogVisible" class="overlay" @click.self="settings.dialogVisible = false">
    <div class="dialog">
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
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.dialog {
  width: 380px;
  max-height: 88vh;
  overflow-y: auto;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-lg);
}
.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
  margin-bottom: var(--sp-4);
  color: var(--fg);
}
.close-btn {
  background: none;
  border: none;
  color: var(--fg-muted);
  font-size: var(--fs-xl);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-out);
}
.close-btn:hover {
  color: var(--fg);
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
  padding: 5px 0;
  border: none;
  background: none;
  border-radius: var(--r-sm);
  color: var(--fg-muted);
  font-size: var(--fs-md);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.segmented button:hover {
  color: var(--fg);
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
  padding: 6px var(--sp-2);
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
  font-family: monospace;
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
  padding: 7px 10px;
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
  width: 14px;
  height: 14px;
  cursor: pointer;
}
.checkbox code {
  font-family: Consolas, monospace;
  color: var(--accent-text);
}
.sub-note {
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  margin: var(--sp-2) 0 0;
  line-height: 1.6;
}
/* 默认目录：只读展示 + 选择按钮（路径手输容易错，只给目录框） */
.dir-pick-row {
  display: flex;
  align-items: center;
  gap: 6px;
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
  padding: 5px 8px;
}
.dir-pick-btn {
  flex-shrink: 0;
  font-size: var(--fs-sm);
  padding: 5px 10px;
  border-radius: var(--r-sm);
  background: var(--accent-soft);
  color: var(--accent-text);
  cursor: pointer;
}
.dir-pick-btn:hover {
  filter: brightness(1.05);
}
.dir-pick-clear {
  flex-shrink: 0;
  font-size: var(--fs-sm);
  padding: 5px 9px;
  border-radius: var(--r-sm);
  color: var(--fg-muted);
  cursor: pointer;
}
.dir-pick-clear:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

/* AI 容量账号管理 */
.ai-acc-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: var(--sp-2);
}
.ai-acc-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 5px var(--sp-2);
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
  padding: 0 4px;
  border-radius: var(--r-xs);
}
.ai-del:hover {
  color: var(--danger-text);
  background: var(--danger-soft);
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
  padding: 6px 8px;
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
  padding: 6px 12px;
  cursor: pointer;
}
.ai-add-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.note {
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  margin: 0;
}
</style>
