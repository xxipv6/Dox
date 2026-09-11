<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import Icon from './Icon.vue'
import Logo from './Logo.vue'
import AiUsagePill from './AiUsagePill.vue'

/**
 * 自绘标题栏。
 *
 * 窗口在 Windows / Linux 上是无边框的（主进程 frame: false），系统不再画标题栏，
 * 「最小化 / 最大化 / 关闭」这三件事因此要由这里发起。
 *
 * 整条是拖拽区（-webkit-app-region: drag），三枚按钮单独标 no-drag ——
 * 不标的话点在按钮上会被当成拖窗口，按钮就按不动了。
 * 双击拖拽区最大化、边缘拖拽缩放由 Electron/Chromium 提供，不用自己实现。
 */
const api = window.api

/**
 * macOS 用系统的红绿灯（主进程 titleBarStyle: 'hiddenInset'），
 * 所以那边不画右边的三枚按钮，改为在左侧留出红绿灯的位置。
 */
const isMac = api.platform === 'darwin'

const maximized = ref(false)
let off: (() => void) | null = null

onMounted(async () => {
  // 初值必须主动问一次：只订阅事件的话，「启动时窗口已经是最大化」这种情况
  // （上次退出时是最大化，系统还原了窗口尺寸）就永远收不到通知，图标一直是 □。
  maximized.value = await api.windowIsMaximized()
  off = api.onWindowState((state) => {
    maximized.value = state.maximized
  })
})

onUnmounted(() => off?.())
</script>

<template>
  <header class="title-bar" :class="{ mac: isMac }">
    <span class="tb-brand">
      <Logo :size="16" />
      <span class="tb-title">Dox</span>
    </span>

    <span class="tb-right">
      <!-- AI 容量速览：没配账号时它自己不渲染，不占地方 -->
      <AiUsagePill />

      <!-- macOS 有系统红绿灯，这三枚不画 -->
      <span v-if="!isMac" class="tb-controls">
        <button class="tb-btn" title="最小化" @click="api.windowMinimize()">
          <Icon name="minus" :size="15" />
        </button>
        <button
          class="tb-btn"
          :title="maximized ? '向下还原' : '最大化'"
          @click="api.windowToggleMaximize()"
        >
          <Icon :name="maximized ? 'restore' : 'square'" :size="13" />
        </button>
        <button class="tb-btn close" title="关闭" @click="api.windowClose()">
          <Icon name="x" :size="15" />
        </button>
      </span>
    </span>
  </header>
</template>

<style scoped>
.title-bar {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-left: var(--sp-3);
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  /* 整条可拖窗口 */
  -webkit-app-region: drag;
  user-select: none;
}
/* macOS：给系统红绿灯让位（它们在左上角，约 70px 宽） */
.title-bar.mac {
  padding-left: 78px;
}
.tb-brand {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}
.tb-title {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--fg-secondary);
  letter-spacing: 0.01em;
}

.tb-controls {
  display: flex;
  align-items: stretch;
  height: 100%;
  /* 按钮必须自己可点，否则会被上面整条的拖拽区吃掉 */
  -webkit-app-region: no-drag;
}
/* 右侧组合：容量挂件 + 窗口按钮，挂件自己已标 no-drag */
.tb-right {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding-right: var(--sp-2);
  height: 100%;
}
.tb-right .tb-controls {
  padding-right: 0;
}
.tb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 100%;
  border: none;
  background: none;
  color: var(--fg-muted);
  cursor: pointer;
  padding: 0;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.tb-btn:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
/*
 * 关闭：悬停时红底。用 --danger-text 而不是 --danger ——
 * 反相的图标色要压在它上面，得挑那个「无论亮暗都够深」的档，
 * 否则深色主题下浅红底配浅色图标会糊成一片。
 */
.tb-btn.close:hover {
  background: var(--danger-text);
  color: var(--fg-on-accent);
}
</style>
