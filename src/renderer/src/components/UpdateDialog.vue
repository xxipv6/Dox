<script setup lang="ts">
import { computed, ref } from 'vue'
import { useUpdaterStore } from '../stores/updater'
import { useEscapeToClose } from '../composables/useEscapeToClose'

/**
 * 「新版本 vX」对话框：更新**前**展示更新内容，看完再决定装不装。
 *
 * 入口：标题栏 UpdaterPill（已下好/发现新版）、设置「关于」页「新版内容」。
 * notes 来自主进程拉取的 release 资产 whatsnew.json；拉不到就降级成一句
 * 说明，不阻塞更新动作。安装动作按阶段出：
 *   downloaded          → 重启并安装（两步确认，与设置页同规则）
 *   available + 不支持   → 下载安装包（镜像直链，手动装）
 *   其余（下载中等）     → 只给「稍后」
 */
const updater = useUpdaterStore()

useEscapeToClose(
  () => updater.dialogOpen,
  () => (updater.dialogOpen = false)
)

const s = computed(() => updater.state)
const notes = computed(() => s.value?.notes ?? [])

/** 「重启并安装」断开所有会话与传输：两步确认，4 秒不点第二次自动退回（同设置页） */
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

function openManual(): void {
  const url = s.value?.manualUrl
  if (url) void window.api.openExternal(url)
}
</script>

<template>
  <Transition name="pop">
    <div v-if="updater.dialogOpen && s" class="overlay" @click.self="updater.dialogOpen = false">
      <div class="dialog pop-surface update-dialog" role="dialog" aria-modal="true">
        <div class="dialog-header">
          <span>新版本 v{{ s.version }}</span>
          <button class="close-btn" @click="updater.dialogOpen = false">×</button>
        </div>
        <ul v-if="notes.length" class="notes">
          <li v-for="(note, i) in notes" :key="i">{{ note }}</li>
        </ul>
        <p v-else class="notes-empty">这个版本没有附带更新说明。</p>
        <div class="actions">
          <button class="btn" @click="updater.dialogOpen = false">稍后</button>
          <button
            v-if="s.phase === 'downloaded'"
            class="btn primary"
            :class="{ confirm: confirmInstall }"
            @click="onInstallClick"
          >
            {{ confirmInstall ? '断开所有会话并重启？' : '重启并安装' }}
          </button>
          <button
            v-else-if="s.phase === 'available' && !s.supported && s.manualUrl"
            class="btn primary"
            @click="openManual"
          >
            下载安装包
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* 基础长相在 styles.css（.overlay/.dialog/.pop-surface/.btn/.close-btn），这里只留差异 */
.update-dialog {
  width: 420px;
}
.notes {
  margin: 0;
  padding-left: var(--sp-5);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  font-size: var(--fs-sm);
  color: var(--fg);
  line-height: var(--lh-base);
}
.notes-empty {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--fg-muted);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-4);
}
.btn.confirm {
  border-color: var(--danger);
  color: var(--danger-text);
}
</style>
