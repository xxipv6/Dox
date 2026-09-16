<script setup lang="ts">
import { computed } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useUpdaterStore } from '../stores/updater'

/*
 * 标题栏的更新提示点。
 *
 * 只在「有事可干」时出现：下好了（点它打开设置 → 重启安装）、
 * 正在下载（给个小进度，点不开任何东西，纯告知）。
 * 其余阶段（idle/checking/up-to-date/error）不打扰 —— 更新不该是常驻噪音。
 */
const updater = useUpdaterStore()
const settings = useSettingsStore()

const phase = computed(() => updater.state?.phase)
const percent = computed(() => Math.floor(updater.state?.percent ?? 0))

/** 不支持自动更新的构建（未签名 mac）：提示点直接打开镜像下载页 */
const manualUrl = computed(() =>
  updater.state && !updater.state.supported ? updater.state.manualUrl : undefined
)

function openManual(): void {
  if (manualUrl.value) void window.api.openExternal(manualUrl.value)
}
</script>

<template>
  <button
    v-if="phase === 'downloaded'"
    class="upd-pill ready"
    title="新版本已下载，点击打开设置重启安装"
    @click="settings.dialogVisible = true"
  >
    重启更新 v{{ updater.state?.version }}
  </button>
  <button
    v-else-if="phase === 'available' && manualUrl"
    class="upd-pill ready"
    title="发现新版本，点击下载（当前构建不支持自动更新）"
    @click="openManual"
  >
    新版 v{{ updater.state?.version }}
  </button>
  <span v-else-if="phase === 'downloading'" class="upd-pill" title="正在下载更新">
    下载 v{{ updater.state?.version }} · {{ percent }}%
  </span>
</template>

<style scoped>
.upd-pill {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 var(--sp-2);
  border-radius: var(--r-pill);
  border: 1px solid var(--border);
  background: none;
  color: var(--fg-muted);
  font-size: var(--fs-xs);
  cursor: default;
  /* 标题栏整条是拖拽区，可点的元素必须自己摘出来 */
  -webkit-app-region: no-drag;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.upd-pill.ready {
  cursor: pointer;
  color: var(--accent-text);
  border-color: var(--accent-text);
}
.upd-pill.ready:hover {
  background: var(--accent-soft);
}
.upd-pill.ready:active {
  transform: translateY(0.5px);
}
</style>
